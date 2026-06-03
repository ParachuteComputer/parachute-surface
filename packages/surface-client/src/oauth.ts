/**
 * `ParachuteOAuth` — OAuth 2.1 + PKCE client for parachute-app-hosted UIs.
 *
 * The shape generalizes what parachute-notes hand-rolled inline (see
 * `parachute-notes/src/lib/vault/oauth.ts`). Each hosted UI under
 * parachute-surface gets its own OAuth client_id (per design doc section 6 —
 * "Per-UI client_id"). The UI's JS reads its `client_id` at boot from
 * `/surface/<name>/oauth-client`, then drives the OAuth dance through this
 * class.
 *
 * Lifecycle the class assumes:
 *
 *   1. `getClientId(appName)` — fetches `/surface/<name>/oauth-client`,
 *      caches in-memory. Subsequent calls in the same page load reuse
 *      the cached id.
 *   2. `beginFlow(vaultScope)` — starts OAuth: discover AS, get a
 *      client_id (cache → fetch), generate PKCE, save pending state,
 *      redirect (or return URL — caller can choose).
 *   3. `handleCallback(code, state)` — verify state, POST to token
 *      endpoint, persist via `token-storage`.
 *   4. `getToken(vaultScope)` — returns the stored token or `null`.
 *      Callers use this to decide whether to dispatch a fresh OAuth
 *      flow vs. attach the bearer.
 *   5. `clearToken(vaultScope)` — single-vault logout.
 *
 * The class is intentionally **storage-agnostic above the token-storage
 * layer**. PendingOAuthState lives in sessionStorage (Notes did this);
 * cached client_ids live in-memory only (UI bundles get rebuilt; the
 * `/oauth-client` endpoint is cheap; in-memory cache is sufficient).
 *
 * Same-hub auto-trust (design doc section 6) is a hub-side affordance:
 * for `vault:*:read|write` scopes app's DCR registration carries the
 * operator bearer, hub marks `same_hub: true`, and the consent screen
 * skips. From this class's perspective, the flow is unchanged — the
 * hub silently completes the authorize step instead of rendering UI.
 */

import { discoverAuthServer } from "./discovery.js";
import {
  type InsecureContextError,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "./pkce.js";
import {
  clearToken as clearStoredToken,
  loadToken,
  saveToken,
  storedFromTokenResponse,
} from "./token-storage.js";
import type {
  AuthorizationServerMetadata,
  PendingOAuthState,
  StoredToken,
  TokenResponse,
} from "./types.js";

export { InsecureContextError } from "./pkce.js";

/**
 * Thrown by `handleCallback` when the hub responds with
 * `error: "invalid_client"` because the client is registered but
 * awaiting operator approval (hub#74 / hub#240). Carries the
 * `approveUrl` so the UI can render a "approve in hub" CTA.
 */
export class PendingApprovalError extends Error {
  readonly approveUrl: string;
  constructor(approveUrl: string) {
    super("Your hub needs to approve this app before sign-in can complete.");
    this.name = "PendingApprovalError";
    this.approveUrl = approveUrl;
  }
}

/**
 * Thrown by `refreshAccessToken` when the hub returns non-2xx —
 * distinct from a network error so callers can tell "server rejected
 * our refresh token" apart from "couldn't reach the hub at all".
 */
export class RefreshHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly oauthError?: string;
  constructor(status: number, body: string) {
    let oauthError: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // body wasn't JSON — fine.
    }
    super(`Token refresh failed (${status}): ${body}`);
    this.name = "RefreshHttpError";
    this.status = status;
    this.body = body;
    this.oauthError = oauthError;
  }
}

export type ParachuteOAuthOpts = {
  /**
   * Stable identifier for this app — matches the `name` in meta.json
   * and the `<name>` segment in `/surface/<name>/oauth-client`. Becomes the
   * app-segment of token storage keys.
   */
  appName: string;
  /**
   * Hub origin (or path-rooted issuer URL) the app discovers OAuth
   * metadata against. Typically the parent origin when the app is
   * served from `/surface/<name>/`.
   */
  hubUrl: string;
  /** Override for the fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Override the sessionStorage backend (tests). Falls back to the
   * page's `window.sessionStorage` when present, else a no-op store.
   */
  sessionStorage?: SessionStorageLike;
  /**
   * Override the persistent token-storage backend (tests). Falls back
   * to `window.localStorage`.
   */
  tokenStorage?: TokenStorageLike;
  /** Override the clock (tests). Defaults to `Date.now`. */
  now?: () => number;
};

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage-like that matches the API surface `token-storage` accepts. */
export interface TokenStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type BeginFlowOpts = {
  /**
   * Scope to request. Defaults to `"vault:read vault:write"` —
   * matches Notes' default for the multi-vault case.
   */
  scope?: string;
  /**
   * Concrete vault name (e.g. `"gitcoin"`) to narrow a wildcard
   * `vault:*:read` declaration down to. The result is the scope string
   * sent on `/oauth/authorize`. Caller-set, NOT derived from meta —
   * the choice happens at vault-pick time in the UI.
   */
  vaultName?: string;
  /**
   * Override the redirect URI the AS bounces back to. Defaults to
   * `<window.location.origin>/<app-mount>/oauth/callback`. Pass when
   * the caller serves the app under a non-trivial base path.
   */
  redirectUri?: string;
  /** Extra params appended to the authorize URL (hints the hub may consume). */
  extraAuthorizeParams?: Record<string, string>;
};

export type BeginFlowResult = {
  authorizeUrl: string;
  pending: PendingOAuthState;
};

const PENDING_KEY = "parachute_app_oauth_pending";
const DEFAULT_SCOPE = "vault:read vault:write";

/**
 * Public client identity for the hosted app, surfaced by app's
 * `/surface/<name>/oauth-client` endpoint.
 */
export type OAuthClientInfo = {
  client_id: string;
  scopes: string[];
  discovery_url?: string;
  hub_url?: string;
};

/**
 * OAuth driver for one hosted app. Caller constructs one per app and
 * reuses it for the lifetime of the page.
 */
export class ParachuteOAuth {
  private readonly appName: string;
  private readonly hubUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sessionStorage: SessionStorageLike;
  private readonly tokenStorage?: TokenStorageLike;
  private readonly now: () => number;
  /** In-memory cache of `{appName: OAuthClientInfo}` so DCR runs at most once per page. */
  private clientInfoCache: OAuthClientInfo | null = null;
  /** In-memory cache of `AS metadata` so discovery runs at most once per page. */
  private metadataCache: AuthorizationServerMetadata | null = null;

  constructor(opts: ParachuteOAuthOpts) {
    this.appName = opts.appName;
    this.hubUrl = opts.hubUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.sessionStorage = opts.sessionStorage ?? resolveSessionStorage();
    if (opts.tokenStorage !== undefined) this.tokenStorage = opts.tokenStorage;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Inject a pre-resolved client identity — the **standalone** bootstrap.
   *
   * A standalone surface (served from GitHub Pages / any static host, with
   * no Parachute surface-host in front of it) has no
   * `/surface/<name>/oauth-client` endpoint to fetch. It instead registers
   * itself as a public client via RFC 7591 Dynamic Client Registration
   * (`registerClient` from `./discovery`) and hands the resulting
   * `client_id` to this method. `beginFlow` / `handleCallback` /
   * `refreshAccessToken` then use it directly and **never** call the hosted
   * `getClientId()` endpoint.
   *
   * Seeds the same in-memory cache `getClientId()` populates, so the two
   * bootstraps are interchangeable from every downstream call site. Returns
   * the cached info for chaining.
   *
   * Example (standalone DCR):
   *
   *   const md = await discoverAuthServer(hubUrl);
   *   const { client_id } = await registerClient(md.registration_endpoint, {
   *     clientName: "My Vault UI",
   *     redirectUri,
   *   });
   *   oauth.useClientId({ client_id, scopes: ["vault:read", "vault:write"] });
   */
  useClientId(info: OAuthClientInfo): OAuthClientInfo {
    if (!info.client_id) {
      throw new Error("useClientId requires a non-empty client_id");
    }
    const normalized: OAuthClientInfo = {
      ...info,
      scopes: Array.isArray(info.scopes) ? info.scopes : [],
    };
    this.clientInfoCache = normalized;
    return normalized;
  }

  /**
   * Fetch `/surface/<name>/oauth-client` — the **hosted** bootstrap. Only
   * works when a Parachute surface-host serves this bundle (it exposes the
   * endpoint). Standalone surfaces must instead self-register via DCR and
   * call {@link useClientId}; calling this off-host throws because the
   * endpoint doesn't exist.
   *
   * Cached for the lifetime of this instance (one discovery per page load).
   * If a client_id was already provided via {@link useClientId}, the cached
   * value is returned and no fetch happens.
   */
  async getClientId(): Promise<OAuthClientInfo> {
    if (this.clientInfoCache) return this.clientInfoCache;
    const endpoint = `${this.hubUrl}/surface/${encodeURIComponent(this.appName)}/oauth-client`;
    const res = await this.fetchImpl(endpoint, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Could not fetch OAuth client info from ${endpoint} (${res.status}): ${text}`,
      );
    }
    const data = (await res.json()) as OAuthClientInfo;
    if (!data.client_id) {
      throw new Error(`OAuth client response missing client_id (from ${endpoint})`);
    }
    if (!Array.isArray(data.scopes)) {
      // Be liberal — older app versions may not surface `scopes`.
      data.scopes = [];
    }
    this.clientInfoCache = data;
    return data;
  }

  /**
   * Begin the OAuth dance. Discovers the AS, reads our client_id,
   * generates PKCE state, stashes pending state in sessionStorage, and
   * returns the URL the caller should redirect the browser to.
   *
   * The caller decides how to navigate (full-page redirect, popup,
   * embedded iframe). We don't `location.assign` because that ties us
   * to a DOM the caller may not want.
   */
  async beginFlow(opts: BeginFlowOpts = {}): Promise<BeginFlowResult> {
    const clientInfo = await this.getClientId();
    const metadata = await this.getMetadata();

    const redirectUri = opts.redirectUri ?? this.defaultRedirectUri();
    const scope = opts.scope ?? DEFAULT_SCOPE;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    const state = generateState();

    const pending: PendingOAuthState = {
      issuerUrl: this.hubUrl,
      issuer: metadata.issuer,
      tokenEndpoint: metadata.token_endpoint,
      clientId: clientInfo.client_id,
      codeVerifier,
      state,
      redirectUri,
      scope,
      startedAt: new Date().toISOString(),
    };
    this.savePending(pending);

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientInfo.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("scope", scope);
    if (opts.vaultName) authorizeUrl.searchParams.set("vault", opts.vaultName);
    // Append-last so caller-supplied params never overwrite OAuth/PKCE params.
    if (opts.extraAuthorizeParams) {
      for (const [k, v] of Object.entries(opts.extraAuthorizeParams)) {
        if (!authorizeUrl.searchParams.has(k)) {
          authorizeUrl.searchParams.set(k, v);
        }
      }
    }
    return { authorizeUrl: authorizeUrl.toString(), pending };
  }

  /**
   * Complete the OAuth flow: verify state, POST the auth code + PKCE
   * verifier to the token endpoint, persist the token. Returns the
   * stored shape.
   *
   * `vaultScope` is the storage key segment for the resulting token —
   * typically `vaultIdFromUrl(vault.url)` for multi-vault apps, or a
   * stable label for single-vault apps. We can't derive it from the
   * token response because the response may not include a vault URL,
   * and the canonical id is the URL-derived form, not whatever name
   * the hub chose.
   */
  async handleCallback(
    code: string,
    state: string,
    vaultScope: string,
  ): Promise<{ pending: PendingOAuthState; token: TokenResponse; stored: StoredToken }> {
    const pending = this.loadPending();
    if (!pending) {
      throw new Error("No pending OAuth flow. Start the connect flow from the app first.");
    }
    if (pending.state !== state) {
      this.clearPending();
      throw new Error("OAuth state mismatch. The flow was likely interrupted; please try again.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.codeVerifier,
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
    });

    const res = await this.fetchImpl(pending.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      this.clearPending();
      const pendingApproval = parsePendingApproval(text);
      if (pendingApproval) {
        throw new PendingApprovalError(pendingApproval.approveUrl);
      }
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    const token = (await res.json()) as TokenResponse;
    if (!token.access_token) {
      this.clearPending();
      throw new Error("Token response missing access_token");
    }

    const stored = storedFromTokenResponse(token, this.now());
    this.persistToken(vaultScope, stored);
    this.clearPending();
    return { pending, token, stored };
  }

  /**
   * Read the current token for `vaultScope`. Returns null when no
   * token is stored, the stored value is malformed, or the token is
   * expired AND has no refresh token (the token-storage layer prunes
   * those proactively).
   */
  getToken(vaultScope: string): StoredToken | null {
    return loadToken(
      this.appName,
      vaultScope,
      this.tokenStorage ? { storage: this.tokenStorage, now: this.now } : { now: this.now },
    );
  }

  /**
   * Clear the token for one vault. The caller is responsible for the
   * UX (banner, in-app sign-out CTA). This is a local clear only —
   * hub-side revocation is a separate call (the hub's `/oauth/revoke`
   * endpoint), which the caller can drive when it knows the token was
   * compromised vs just stale.
   */
  clearToken(vaultScope: string): void {
    clearStoredToken(
      this.appName,
      vaultScope,
      this.tokenStorage ? { storage: this.tokenStorage, now: this.now } : { now: this.now },
    );
  }

  /**
   * Refresh the access token via the refresh_token grant. Returns the
   * fresh TokenResponse — the caller is responsible for persisting it
   * (typically by calling `storedFromTokenResponse` + `saveToken`).
   * Mirrors RFC 6749 §6 with refresh-token rotation: each successful
   * call returns a new `refresh_token` that supersedes the prior one.
   */
  async refreshAccessToken(
    refreshToken: string,
    vaultScope: string,
  ): Promise<{ token: TokenResponse; stored: StoredToken }> {
    const clientInfo = await this.getClientId();
    const metadata = await this.getMetadata();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientInfo.client_id,
    });
    const res = await this.fetchImpl(metadata.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new RefreshHttpError(res.status, text);
    }
    const token = (await res.json()) as TokenResponse;
    if (!token.access_token) {
      throw new Error("Refresh response missing access_token");
    }
    const stored = storedFromTokenResponse(token, this.now());
    this.persistToken(vaultScope, stored);
    return { token, stored };
  }

  /** Discover (or return cached) AS metadata for the hub. */
  async getMetadata(): Promise<AuthorizationServerMetadata> {
    if (this.metadataCache) return this.metadataCache;
    this.metadataCache = await discoverAuthServer(this.hubUrl, this.fetchImpl);
    return this.metadataCache;
  }

  /**
   * Reset the in-memory caches. Useful for tests + the rare case where
   * the operator rotates the hub URL / app's client_id at runtime.
   */
  resetCaches(): void {
    this.clientInfoCache = null;
    this.metadataCache = null;
  }

  private defaultRedirectUri(): string {
    // Walk up to `/<app-mount>/oauth/callback`. We assume the app's
    // top-level path is `/surface/<name>/` and the callback lives directly
    // under it — the same shape Notes uses today.
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/surface/${encodeURIComponent(this.appName)}/oauth/callback`;
  }

  private savePending(state: PendingOAuthState): void {
    try {
      this.sessionStorage.setItem(PENDING_KEY, JSON.stringify(state));
    } catch {
      // best-effort
    }
  }

  private loadPending(): PendingOAuthState | null {
    try {
      const raw = this.sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as PendingOAuthState;
    } catch {
      return null;
    }
  }

  private clearPending(): void {
    try {
      this.sessionStorage.removeItem(PENDING_KEY);
    } catch {
      // best-effort
    }
  }

  private persistToken(vaultScope: string, stored: StoredToken): void {
    saveToken(
      this.appName,
      vaultScope,
      stored,
      this.tokenStorage ? { storage: this.tokenStorage, now: this.now } : { now: this.now },
    );
  }
}

function parsePendingApproval(text: string): { approveUrl: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (body.error !== "invalid_client") return null;
  const approveUrl = safeApproveUrl(body.approve_url);
  if (!approveUrl) return null;
  return { approveUrl };
}

function safeApproveUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  return raw;
}

function resolveSessionStorage(): SessionStorageLike {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // sessionStorage access can throw in some sandboxed contexts.
  }
  // No-op fallback for SSR + restricted contexts.
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

// Type re-export (so `import type { InsecureContextError } from ...` works
// without the runtime export path needing to be threaded explicitly).
export type { InsecureContextError as InsecureContextErrorType };
