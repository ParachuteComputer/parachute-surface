/**
 * CLI → daemon admin auth: mint a short-lived `surface:admin` bearer.
 *
 * `parachute-surface add/remove/list/...` call the running daemon's HTTP admin
 * endpoints (see `auth.ts`), which require a hub-issued JWT with `aud:
 * "surface"` and a `surface:*` scope. The operator credential on disk
 * (`~/.parachute/operator.token`) is `aud: "operator"` carrying host-authority
 * scopes — presenting it directly fails the daemon's audience check
 * (`hub JWT audience mismatch: expected "surface", got "operator"`).
 *
 * The fix follows the ecosystem's capability-attenuation model — the same path
 * the admin SPA uses (session → mint → present): exchange the operator token
 * for a narrow, short-lived `surface:admin` token at the hub's
 * `POST /api/auth/mint-token`. The operator token holds `parachute:host:auth`
 * (the default "admin" scope-set), which per the hub's `canGrant` rule 1 may
 * mint any *requestable* scope — and `surface:admin` is requestable (only the
 * `parachute:host:*` scopes are non-requestable). The hub's `inferAudience`
 * stamps the mint with `aud: "surface"`, exactly what the daemon validates.
 *
 * This keeps the daemon's admin auth unchanged — no extra accepted audience,
 * no weakening: the daemon still demands `aud: "surface"` + `surface:admin`,
 * and a caller with no operator token (or one lacking minting authority) still
 * can't reach it.
 */

import { getHubOrigin } from "./auth.ts";
import { readOperatorToken } from "./operator-token.ts";

/**
 * Scope the CLI mints. `surface:admin` implies `surface:read` (the daemon's
 * `hasReadAccess` accepts admin for read-only endpoints), so one mint covers
 * every verb — the mutating `add`/`remove`/`reload` and the read-only
 * `list`/`info`. The operator running the CLI already holds host admin, so the
 * minted token grants nothing it couldn't otherwise obtain.
 */
export const CLI_MINT_SCOPE = "surface:admin" as const;

/**
 * TTL for the minted CLI token. A single CLI invocation runs one or two daemon
 * calls then exits, so a few minutes is ample. Short-lived keeps the token
 * registry tidy and the credential's exposure window small.
 */
export const CLI_MINT_TTL_SECONDS = 300;

export type CliTokenErrorCode = "hub_unreachable" | "mint_rejected" | "bad_response";

/**
 * Raised when an operator token IS present but exchanging it for a surface
 * token failed (hub down, token expired, insufficient authority, malformed
 * response). The CLI prints `.message` and exits non-zero. Absence of an
 * operator token is NOT an error — `mintCliToken` returns `undefined` so the
 * caller falls back to an unauthenticated request and the daemon answers 401.
 */
export class CliTokenError extends Error {
  readonly code: CliTokenErrorCode;
  constructor(code: CliTokenErrorCode, message: string) {
    super(message);
    this.name = "CliTokenError";
    this.code = code;
  }
}

export type MintCliTokenOpts = {
  /** Operator bearer override (tests). Defaults to `readOperatorToken()`. */
  operatorToken?: string;
  /** Hub origin override (tests). Defaults to `getHubOrigin()`. */
  hubOrigin?: string;
  /** Scope to request. Defaults to `CLI_MINT_SCOPE`. */
  scope?: string;
  /** Token lifetime in seconds. Defaults to `CLI_MINT_TTL_SECONDS`. */
  ttlSeconds?: number;
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
};

/**
 * Mint a `surface:admin` bearer from the operator credential.
 *
 * Returns `undefined` when no operator token is present — the caller then sends
 * the request unauthenticated and lets the daemon answer 401, preserving the
 * pre-existing "no credential" behavior. Throws {@link CliTokenError} for every
 * other failure so the CLI can surface an actionable message.
 */
export async function mintCliToken(opts: MintCliTokenOpts = {}): Promise<string | undefined> {
  const operatorToken = opts.operatorToken ?? readOperatorToken();
  if (!operatorToken) return undefined;

  const hubOrigin = (opts.hubOrigin ?? getHubOrigin()).replace(/\/$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${hubOrigin}/api/auth/mint-token`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        scope: opts.scope ?? CLI_MINT_SCOPE,
        expires_in: opts.ttlSeconds ?? CLI_MINT_TTL_SECONDS,
      }),
    });
  } catch (e) {
    throw new CliTokenError(
      "hub_unreachable",
      `couldn't reach the hub at ${url} to mint a surface admin token: ${(e as Error).message}\nIs the hub running? Set PARACHUTE_HUB_ORIGIN if it isn't at the loopback default.`,
    );
  }

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string };
      detail = parsed.error_description ?? parsed.error ?? text;
    } catch {
      // Non-JSON body — keep the raw text.
    }
    const hint =
      res.status === 401
        ? " — the operator token may be expired; run `parachute auth rotate-operator`"
        : res.status === 403
          ? " — the operator token lacks minting authority (parachute:host:auth); run `parachute auth rotate-operator`"
          : "";
    throw new CliTokenError(
      "mint_rejected",
      `hub refused to mint a surface admin token (HTTP ${res.status}): ${detail}${hint}`,
    );
  }

  let token: string | undefined;
  try {
    token = (JSON.parse(text) as { token?: string }).token;
  } catch (e) {
    throw new CliTokenError(
      "bad_response",
      `hub mint response wasn't valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new CliTokenError("bad_response", "hub mint response had no `token` field");
  }
  return token;
}
