/**
 * `AccountClient` — browser-side SDK for the Parachute account/door contract.
 *
 * This is the CLIENT half of the `/account/*` wire contract (Phase-2 breakdown
 * §1, CONCEPT-2 §7). One door — Hub (self-hosted) or Cloud (hosted) — answers
 * at `doorOrigin`; the SDK is door-agnostic and reads
 * {@link AccountClient.discoverCapabilities} to know which features exist.
 *
 * The contract in one breath:
 *
 *   1. **Capability discovery.** `discoverCapabilities()` reads the public
 *      `GET /.well-known/parachute-account` descriptor (memoized) — the app
 *      gates UI on `features.*` and `caps_writable` instead of hard-coding
 *      per-door behavior.
 *
 *   2. **The account credential, held in memory ONLY.** `getAccountToken()`
 *      exchanges the same-origin session cookie for a short-TTL account bearer
 *      (`POST /account/token`, cookie-authed + CSRF). The token lives in a
 *      private field and is **never** written to `localStorage` — a
 *      non-negotiable security invariant (Phase-2 risk #2 / F6: an XSS
 *      foothold must not read account authority at rest). The SDK silently
 *      re-mints on near-expiry (and once reactively on a 401) while the cookie
 *      lives; when the cookie is gone the mint 401s and the caller re-auths.
 *
 *   3. **Vault lifecycle over the bearer.** `listVaults` / `createVault` /
 *      `deleteVault` / `mintVaultToken` drive the `/account/*` REST surface,
 *      each `Authorization: Bearer <account token>`. `createVault` returns a
 *      ready-to-use vault token so the app lands the user IN the vault with no
 *      extra OAuth round-trip — and transparently falls back to a per-vault
 *      mint when the door returns an empty `vault_token` (§1 Hub caveat / risk
 *      #5).
 *
 *   4. **Capability-gated plan/billing.** `getPlan()` returns `null` on a door
 *      without billing (the honest 404 → null); `openBilling()` returns the
 *      Stripe redirect URL.
 *
 * The server endpoints do not exist yet (Hub H2 / Cloud C3 build them). This
 * package is written against the SPEC so those implementations have a fixed
 * client to satisfy; the unit tests assert the exact method/path/headers/body
 * per endpoint against a mocked `fetch`.
 *
 * Mirrors surface-client's `VaultClient` archetype: a single class constructed
 * once per page, injected `fetchImpl`/`now` test seams, and a structured error
 * hierarchy (see `errors.ts`).
 */

import {
  AccountNotFoundError,
  AccountServerError,
  AccountUnreachableError,
  classifyErrorResponse,
} from "./errors.js";
import type {
  AccountCapabilities,
  AccountInfo,
  AccountTokenResponse,
  BillingKind,
  CreateVaultOptions,
  CreatedVault,
  PlanInfo,
  VaultSummary,
  VaultToken,
} from "./types.js";

/**
 * The double-submit CSRF field name both doors already use (`csrf.ts`
 * `CSRF_FIELD_NAME`). The account-token mint is cookie-authed, so it carries
 * the CSRF token — the SDK submits it under this key in the JSON body. The
 * token value is delivered to the app out-of-band (the CSRF cookie is
 * HttpOnly; the value rides a JSON bootstrap like `/api/me` or a page
 * injection) and passed in via the `csrfToken` option.
 */
export const CSRF_FIELD_NAME = "__csrf";

/**
 * Re-mint the account token this many ms BEFORE its stated expiry, so a
 * request never rides a token that expires mid-flight. 30s covers clock skew
 * + request latency for a ~10-minute token.
 */
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/** Resolver for the CSRF token — a static string or a (possibly async) getter. */
export type CsrfTokenSource =
  | string
  | (() => string | null | undefined | Promise<string | null | undefined>);

export interface AccountClientOptions {
  /**
   * The door origin the account contract answers at (e.g.
   * `https://cloud.parachute.computer` or a self-hosted hub origin). The app
   * resolves this from `getHubOrigin()` (surface-client's `mount.ts`) and
   * passes it in — account-client stays dependency-free of surface-client so
   * it can never leak a `workspace:` protocol into its published manifest.
   */
  doorOrigin: string;
  /** Override `fetch` (tests / non-DOM). Defaults to the runtime global. */
  fetchImpl?: typeof fetch;
  /** Override the clock (tests). Defaults to `Date.now`. Drives near-expiry re-mint. */
  now?: () => number;
  /**
   * The double-submit CSRF token for `POST /account/token`. A string or a
   * (possibly async) getter, resolved on each mint so a rotated token is
   * picked up. When omitted, the mint sends no CSRF field — the door will
   * reject it unless it runs without CSRF (local/dev).
   */
  csrfToken?: CsrfTokenSource;
}

/** Options for an authenticated request. */
interface AuthedRequestOptions {
  /** JSON body — serialized and sent with `Content-Type: application/json`. */
  body?: unknown;
}

export class AccountClient {
  private readonly doorOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly csrfToken?: CsrfTokenSource;

  /** The account bearer — IN MEMORY ONLY. Never persisted (F6). */
  private accountToken: string | null = null;
  /** Absolute ms expiry of {@link accountToken}, or `null` when unknown. */
  private accountTokenExpiresAt: number | null = null;
  /** Memoized capability descriptor — static per door. */
  private capabilities: AccountCapabilities | null = null;

  constructor(opts: AccountClientOptions) {
    if (!opts.doorOrigin) {
      throw new TypeError("AccountClient: `doorOrigin` is required.");
    }
    this.doorOrigin = opts.doorOrigin.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    if (opts.csrfToken !== undefined) this.csrfToken = opts.csrfToken;
  }

  // ---------- capability discovery ----------

  /**
   * Read the public `GET /.well-known/parachute-account` descriptor. Memoized
   * — the descriptor is static per door, so repeated calls return the cached
   * value (one network fetch). Drives honest per-door UI.
   */
  async discoverCapabilities(): Promise<AccountCapabilities> {
    if (this.capabilities) return this.capabilities;
    const caps = await this.publicRequest<AccountCapabilities>(
      "GET",
      "/.well-known/parachute-account",
    );
    this.capabilities = caps;
    return caps;
  }

  // ---------- the account credential ----------

  /**
   * Return a valid account bearer, minting one from the session cookie when
   * none is held or the current one is near expiry. Idempotent to call before
   * every action; the SDK's vault-lifecycle methods call it internally, so
   * apps rarely need this directly (use it to warm the token, or to surface a
   * "signed in" state).
   */
  async getAccountToken(): Promise<string> {
    return this.ensureToken();
  }

  /**
   * Drop the in-memory account token (e.g. on logout). The next call re-mints
   * from the cookie — or 401s if the session is gone.
   */
  clearAccountToken(): void {
    this.accountToken = null;
    this.accountTokenExpiresAt = null;
  }

  // ---------- vault lifecycle ----------

  /** `GET /account/vaults` — the account's vaults (name, url, usage, caps). */
  async listVaults(): Promise<VaultSummary[]> {
    const res = await this.authedRequest<{ vaults: VaultSummary[] }>("GET", "/account/vaults");
    return res.vaults ?? [];
  }

  /**
   * `POST /account/vaults` — create a vault and land IN it. Returns a
   * ready-to-use `vault_token` (`aud=vault.<name>`, `read`+`write`). When the
   * door returns an empty `vault_token` (the Hub's post-`pvt_*`-drop edge,
   * §1 / risk #5), transparently mints one via `POST …/token` so callers
   * always receive a usable token.
   */
  async createVault(opts: CreateVaultOptions): Promise<CreatedVault> {
    const body: { name: string; seed_pack?: string } = { name: opts.name };
    if (opts.seedPack !== undefined) body.seed_pack = opts.seedPack;
    const created = await this.authedRequest<CreatedVault>("POST", "/account/vaults", { body });
    if (created.vault_token) return created;
    // Empty vault_token → fall back to the per-vault mint (§1 Hub caveat).
    const minted = await this.mintVaultToken(created.name);
    const filled: CreatedVault = {
      ...created,
      vault_token: minted.vault_token,
    };
    if (minted.services !== undefined) filled.services = minted.services;
    return filled;
  }

  /**
   * `DELETE /account/vaults/<name>` — tear a vault down. Sends the
   * `{ confirm: <name> }` retype body both doors require for parity (§1).
   */
  async deleteVault(name: string): Promise<void> {
    await this.authedRequest<void>("DELETE", `/account/vaults/${encodeURIComponent(name)}`, {
      body: { confirm: name },
    });
  }

  /**
   * `POST /account/vaults/<name>/token` — mint a vault token (the OAuth-redirect
   * bypass, CONCEPT-2 §4). Defaults to `read`+`write` scopes when none given.
   */
  async mintVaultToken(name: string, scopes?: string[]): Promise<VaultToken> {
    const body = { scopes: scopes ?? defaultVaultScopes(name) };
    return this.authedRequest<VaultToken>(
      "POST",
      `/account/vaults/${encodeURIComponent(name)}/token`,
      { body },
    );
  }

  // ---------- account bootstrap + plan/billing ----------

  /** `GET /account` — the account bootstrap (`account_id`, email, plan?, door). */
  async getAccount(): Promise<AccountInfo> {
    return this.authedRequest<AccountInfo>("GET", "/account");
  }

  /**
   * `GET /account/plan` — the plan tier + usage + options. Returns `null` on a
   * door without billing, where the endpoint answers an honest 404 (§1). Any
   * other error propagates.
   */
  async getPlan(): Promise<PlanInfo | null> {
    try {
      return await this.authedRequest<PlanInfo>("GET", "/account/plan");
    } catch (err) {
      if (err instanceof AccountNotFoundError) return null;
      throw err;
    }
  }

  /**
   * `POST /account/billing/<kind>` — open a Stripe checkout or portal session.
   * Returns the redirect URL the app sends the browser to.
   */
  async openBilling(kind: BillingKind): Promise<{ url: string }> {
    const res = await this.authedRequest<{ redirect_url: string }>(
      "POST",
      `/account/billing/${kind}`,
    );
    return { url: res.redirect_url };
  }

  // ---------- internals ----------

  /**
   * Return the held token if it's comfortably unexpired; otherwise mint a
   * fresh one from the cookie. A `null` expiry (the door didn't report
   * `expires_in`) reuses the held token until a 401 forces a re-mint.
   */
  private async ensureToken(): Promise<string> {
    if (this.accountToken) {
      if (
        this.accountTokenExpiresAt === null ||
        this.accountTokenExpiresAt - this.now() > TOKEN_EXPIRY_SKEW_MS
      ) {
        return this.accountToken;
      }
    }
    return this.mintAccountToken();
  }

  /**
   * `POST /account/token` — exchange the session cookie for an account bearer.
   * Sends `credentials: "include"` (so the session + CSRF cookies ride along)
   * and the double-submit CSRF token in the body. Updates the in-memory token
   * + derived expiry. Read-tolerant on the token field so it accepts a mint
   * that reuses the doors' OAuth signers (`access_token`).
   */
  private async mintAccountToken(): Promise<string> {
    const csrf = await this.resolveCsrf();
    const bodyObj: Record<string, string> = {};
    if (csrf) bodyObj[CSRF_FIELD_NAME] = csrf;
    const context = "POST /account/token";
    const res = await this.doFetch(
      "/account/token",
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(bodyObj),
      },
      context,
    );
    const parsed = await this.parseJsonResponse<
      AccountTokenResponse & { access_token?: string; token?: string }
    >(res, context);
    const token = parsed.account_token ?? parsed.access_token ?? parsed.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new AccountServerError(
        `${context} → ${res.status} but no account token in response`,
        res.status,
      );
    }
    this.accountToken = token;
    this.accountTokenExpiresAt =
      typeof parsed.expires_in === "number" ? this.now() + parsed.expires_in * 1000 : null;
    return token;
  }

  /** Resolve the CSRF token from the option (string or async getter). */
  private async resolveCsrf(): Promise<string | undefined> {
    const src = this.csrfToken;
    if (src === undefined) return undefined;
    const value = typeof src === "function" ? await src() : src;
    return value ?? undefined;
  }

  /** A bearer-authed request with a single silent re-mint + retry on 401. */
  private authedRequest<T>(
    method: string,
    path: string,
    opts: AuthedRequestOptions = {},
  ): Promise<T> {
    return this.authedRequestInner<T>(method, path, opts, true);
  }

  private async authedRequestInner<T>(
    method: string,
    path: string,
    opts: AuthedRequestOptions,
    allowRemint: boolean,
  ): Promise<T> {
    const token = await this.ensureToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const context = `${method} ${path}`;
    const res = await this.doFetch(path, init, context);
    if (res.status === 401 && allowRemint) {
      // The held token was rejected — force a fresh mint from the cookie and
      // retry once. If the cookie is gone, the mint itself throws
      // AccountAuthError ("sign in again"), which propagates.
      await this.mintAccountToken();
      return this.authedRequestInner<T>(method, path, opts, false);
    }
    return this.parseJsonResponse<T>(res, context);
  }

  /** An unauthenticated request (capability discovery). */
  private async publicRequest<T>(method: string, path: string): Promise<T> {
    const context = `${method} ${path}`;
    const res = await this.doFetch(
      path,
      { method, headers: { Accept: "application/json" } },
      context,
    );
    return this.parseJsonResponse<T>(res, context);
  }

  /** Run the fetch, normalizing a network-level failure to `AccountUnreachableError`. */
  private async doFetch(path: string, init: RequestInit, context: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.doorOrigin}${path}`, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AccountUnreachableError(`${context} failed: ${message}`, 0);
    }
  }

  /** Classify a non-2xx into the typed hierarchy; parse a 2xx JSON body (or void). */
  private async parseJsonResponse<T>(res: Response, context: string): Promise<T> {
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyErrorResponse(res.status, bodyText, context);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

/** The default `read`+`write` scope pair for a vault name. */
export function defaultVaultScopes(name: string): string[] {
  return [`vault:${name}:read`, `vault:${name}:write`];
}
