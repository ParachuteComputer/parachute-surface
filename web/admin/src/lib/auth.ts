/**
 * Hub-session auth for the surface admin SPA (boundary C4 — its planned
 * Phase 1.3).
 *
 * Behind the hub proxy the SPA is served same-origin at `/surface/admin/`,
 * so the operator's `parachute_hub_session` cookie rides along on a fetch to
 * the hub's cookie-gated mint endpoint `GET /admin/module-token/surface`.
 * That endpoint (first-admin gated) returns a short-lived JWT carrying
 * `surface:admin` with `aud: "surface"` — exactly what surface-host's
 * `enforceScope` validates. Page loads → silent mint → you're in, zero
 * paste.
 *
 * Mirrors `parachute-vault/web/ui/src/lib/auth.ts` (the canonical
 * silent-mint implementation), with one deliberate simplification: instead
 * of a background proactive-refresh timer + visibilitychange wiring, we
 * check freshness at call time. Every API call resolves its bearer through
 * `ensureToken()`, which re-mints when the cached token is inside the
 * near-expiry margin — same guarantee (no API call rides a nearly-dead
 * token), fewer moving parts. The 401-retry in `lib/api.ts` covers the
 * residual races (revocation, hub restart).
 *
 * Storage: module-scoped variable, NEVER `localStorage` / `sessionStorage`.
 * Page snapshots can't carry it past a refresh (the silent mint IS the
 * refresh story), and the XSS surface is the narrowest possible. The legacy
 * pasted-token fallback in `lib/api.ts` still reads localStorage — that's
 * the explicit no-hub path, not this one.
 */

/** Hub mint endpoint — origin-rooted, same-origin under the hub proxy.
 *  Served by the hub, not by surface-host: direct-on-:1946 deployments get a
 *  404 here, which surfaces as `auth-required` and lights up the pasted-token
 *  fallback. */
export const MINT_PATH = "/admin/module-token/surface";

/**
 * Re-mint when fewer than this many ms remain on the cached token. The hub
 * mints 10-minute tokens; a 90s margin means no API call is ever issued with
 * a bearer that could expire mid-flight, while still reusing each mint for
 * ~8.5 minutes.
 */
export const NEAR_EXPIRY_MARGIN_MS = 90_000;

let cachedToken: string | null = null;
/** Absolute expiry, ms since epoch. `null` when no token cached, or when the
 *  mint response didn't carry a parseable `expires_at` (then we treat the
 *  token as opaque-but-usable and rely on the api layer's 401-retry). */
let cachedExpiresAtMs: number | null = null;

/**
 * Result of an attempted silent mint. Callers branch on `kind`:
 *   - `ok` — proceed with the token.
 *   - `auth-required` — no hub session (or no hub at all: direct-on-:1946
 *     404s the mint path). Surface the sign-in banner + pasted-token
 *     fallback.
 *   - `network-error` — hub reachable-but-failing or fetch threw. Surface a
 *     retry affordance rather than the sign-in banner.
 */
export type RefreshResult =
  | { kind: "ok"; token: string }
  | { kind: "auth-required"; status: number }
  | { kind: "network-error"; message: string };

interface MintResponseBody {
  token?: string;
  /** ISO timestamp — the hub returns absolute, not relative. */
  expires_at?: string;
  scopes?: string[];
}

/** Read the currently cached token without triggering a mint. */
export function getSessionToken(): string | null {
  return cachedToken;
}

/** Drop the cached token. The api layer calls this before its 401-retry so
 *  the retry path mints fresh instead of replaying the rejected bearer. */
export function clearSessionToken(): void {
  cachedToken = null;
  cachedExpiresAtMs = null;
}

/** Test seam: install a token + expiry directly. */
export function _setSessionTokenForTest(token: string | null, expiresAtMs?: number | null): void {
  cachedToken = token;
  cachedExpiresAtMs = expiresAtMs ?? null;
}

/**
 * Call the hub's cookie-gated mint endpoint. On 200, caches token + expiry.
 * `credentials: "include"` so the hub session cookie is attached — the
 * cookie IS the auth; no Authorization header exists yet at this point.
 */
async function mintFromHubSession(): Promise<RefreshResult> {
  let res: Response;
  try {
    res = await fetch(MINT_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "network-error", message };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // 401/403 — hub reachable, no (admin) session. 404 — no hub in front of
    // us at all (surface-host doesn't serve /admin/*). Both mean "the silent
    // path can't work here": show sign-in guidance + the pasted fallback.
    return { kind: "auth-required", status: res.status };
  }
  if (!res.ok) {
    return { kind: "network-error", message: `hub returned ${res.status}` };
  }
  let body: MintResponseBody;
  try {
    body = (await res.json()) as MintResponseBody;
  } catch (err) {
    return {
      kind: "network-error",
      message: err instanceof Error ? err.message : "could not parse mint response",
    };
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    return { kind: "network-error", message: "mint response missing token" };
  }
  cachedToken = body.token;
  cachedExpiresAtMs = body.expires_at ? parseExpiresAt(body.expires_at) : null;
  return { kind: "ok", token: body.token };
}

/** Parse the ISO `expires_at` into ms since epoch; `null` for junk input
 *  (treated the same as a missing field — rely on 401-retry). */
function parseExpiresAt(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Ensure the SPA has a usable session token, minting silently if needed.
 *
 * - Cached token outside the near-expiry margin → returned as-is, no
 *   network call.
 * - No token, or token inside the margin (or past expiry) → hit the mint
 *   endpoint and return its result.
 *
 * Callers: the TokenSetup banner's bootstrap probe and `lib/api.ts`'s
 * per-call bearer resolution (including its 401-retry).
 */
export async function ensureToken(): Promise<RefreshResult> {
  if (cachedToken) {
    if (cachedExpiresAtMs === null || cachedExpiresAtMs - Date.now() > NEAR_EXPIRY_MARGIN_MS) {
      return { kind: "ok", token: cachedToken };
    }
    // Inside the margin (or already expired) — drop and re-mint below.
    clearSessionToken();
  }
  return mintFromHubSession();
}
