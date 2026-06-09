/**
 * Bearer-token auth for parachute-surface's HTTP admin endpoints.
 *
 * Mirrors `parachute-runner/src/auth.ts` deliberately — same trust kernel
 * (`@openparachute/scope-guard`), same hub-origin resolution, same shape for
 * the 401/403 responses. The single difference is the audience: `aud ===
 * "surface"` (with the legacy `"app"` still accepted — see AUDIENCES below).
 *
 * Two scopes surface defines:
 *   - `surface:read`  — list UIs, read per-UI info. Read-only.
 *   - `surface:admin` — add / remove / reload UIs + DCR registration on add.
 *
 * Endpoints that stay unauthenticated:
 *   - `/healthz`, `/surface/healthz` (liveness, hub probes)
 *   - `/.parachute/info`, `/.parachute/config/schema` (open module-protocol
 *     surface — module identity + schema shape leak nothing)
 *   - Per-UI bundle serving under `/surface/<name>/*` (static assets; hub gates
 *     these at the reverse-proxy layer per design doc section 9)
 *   - `/surface/<name>/oauth-client` (UIs need this at page load before they
 *     have any token — public OAuth client_id is by definition public)
 *
 * Admin endpoints take `surface:admin`. Read-only admin endpoints accept
 * `surface:admin` OR `surface:read` per design doc section 13.
 *
 * Hub-origin resolution follows the same shape every other module uses:
 *   - `PARACHUTE_HUB_ORIGIN` env var when set
 *   - `config.hub_url` from `loadConfig()` as the daemon-config-aware override
 *   - `http://127.0.0.1:1939` loopback fallback (v0.6 single-container)
 *
 * `getHubOrigin()` re-resolves on every call so tests can swap the env
 * mid-run; production callers set the env once at boot.
 */

import { HubJwtError, type ScopeGuard, createScopeGuard } from "@openparachute/scope-guard";

export const SCOPE_ADMIN = "surface:admin" as const;
export const SCOPE_READ = "surface:read" as const;

/** Hub loopback for v0.6 single-container; deploys override via env. */
const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/**
 * Audience the daemon declares. The hub's audience rule stamps the bare module
 * short — `inferAudience("surface:admin")` and the session-cookie mint at
 * `GET /admin/module-token/surface` both produce `aud: "surface"`.
 *
 * History: pre-rename (app → surface, PR #40) the short was `app` and hub#300
 * minted `aud: "app"`. The rename flipped the scope strings to `surface:*`
 * but this constant kept the legacy value, which meant NOTHING the hub mints
 * by default validated here (`--scope surface:admin` infers `aud: "surface"`;
 * the only working shape was a manual `--aud app` override). Canonical is now
 * `"surface"`; `"app"` stays accepted (additive) so any manually-crafted
 * legacy bearer rides to its expiry.
 */
export const AUDIENCE = "surface" as const;
/** Legacy audience (pre-rename short). Accepted, never minted anymore. */
export const LEGACY_AUDIENCE = "app" as const;
/** Accepted audiences, canonical first — `validateBearer` tries them in order. */
export const AUDIENCES = [AUDIENCE, LEGACY_AUDIENCE] as const;

/**
 * Resolve the hub origin used for JWT validation.
 *
 * Honors `PARACHUTE_HUB_ORIGIN` first (the canonical override every committed-
 * core module respects), then `hubUrl` (the runtime config field), then falls
 * back to the loopback. `hubUrl` is the same string `config.hub_url` carries —
 * callers in `http-server.ts` pass `state.config.hub_url` so a runtime config
 * change (Phase 1.3 admin SPA toggles) takes effect without a daemon restart.
 */
export function getHubOrigin(hubUrl?: string): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  if (hubUrl && hubUrl.length > 0) return hubUrl.replace(/\/$/, "");
  return DEFAULT_HUB_LOOPBACK;
}

let guard: ScopeGuard | null = null;
let guardHubOrigin: string | null = null;

/**
 * Lazy process-wide guard. The resolver form lets tests flip
 * `PARACHUTE_HUB_ORIGIN` between cases without restarting the harness; the
 * lib re-resolves on every `validateHubJwt` call. JWKS + revocation caches
 * live inside the guard and survive across requests in production.
 *
 * If `hubUrl` is supplied and differs from the cached guard's origin, the
 * cached guard is replaced — daemon-config writes can change `hub_url` at
 * runtime and we want subsequent validations to track the new origin.
 */
function getGuard(hubUrl?: string): ScopeGuard {
  const wanted = getHubOrigin(hubUrl);
  if (!guard || guardHubOrigin !== wanted) {
    guard = createScopeGuard({ hubOrigin: () => wanted });
    guardHubOrigin = wanted;
  }
  return guard;
}

/**
 * Test seam: forget the cached guard so a beforeEach that swaps the
 * `PARACHUTE_HUB_ORIGIN` env var picks up the new origin on the next call.
 */
export function resetGuard(): void {
  if (guard) {
    guard.resetJwksCache();
    guard.resetRevocationCache();
  }
  guard = null;
  guardHubOrigin = null;
}

export function extractBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || undefined;
}

export type AuthResult =
  | { ok: true; scopes: readonly string[] }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } };

/**
 * Run `validate` against each accepted audience in order, returning the first
 * success. An audience-mismatch failure (`HubJwtError` code `"audience"`)
 * falls through to the next candidate; any other failure (bad signature,
 * revoked, expired, …) rethrows immediately — retrying a different audience
 * can't fix those, and masking them would garble the surfaced error.
 *
 * Exported as a pure-ish helper so the fallback ordering is unit-testable
 * without standing up a JWKS endpoint.
 */
export async function validateWithAudienceFallback<T>(
  validate: (audience: string) => Promise<T>,
  audiences: readonly string[] = AUDIENCES,
): Promise<T> {
  let lastAudienceErr: unknown;
  for (const audience of audiences) {
    try {
      return await validate(audience);
    } catch (err) {
      if (err instanceof HubJwtError && err.code === "audience") {
        lastAudienceErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastAudienceErr ?? new HubJwtError("audience", "no accepted audience matched");
}

/**
 * Validate the presented bearer against the hub. Returns the granted scope
 * list on success; on failure returns a typed 401 or 403 the caller forwards
 * verbatim.
 *
 * Audience enforced via `expectedAudience` — a token minted for a different
 * module can't reach our admin surface even if its bearer carries
 * `surface:admin` (which it can't, but defense-in-depth). Canonical `aud` is
 * `"surface"` (what the hub mints today); the legacy `"app"` is accepted as
 * a fallback (see AUDIENCES). JWKS + revocation lookups are cached inside the
 * guard, so the fallback retry costs one extra in-memory verification, not a
 * second network round-trip.
 */
export async function validateBearer(
  token: string | undefined,
  opts: { hubUrl?: string } = {},
): Promise<AuthResult> {
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", message: "Authorization: Bearer <token> required" },
    };
  }
  try {
    const guard = getGuard(opts.hubUrl);
    const claims = await validateWithAudienceFallback((audience) =>
      guard.validateHubJwt(token, { expectedAudience: audience }),
    );
    return { ok: true, scopes: claims.scopes };
  } catch (err) {
    if (err instanceof HubJwtError && err.code === "revoked") {
      console.warn(`[app-auth] hub JWT rejected: ${err.message}`);
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", message: "token has been revoked" },
      };
    }
    if (err instanceof HubJwtError && err.code === "revocation_unavailable") {
      console.warn(`[app-auth] hub JWT rejected: ${err.message}`);
      return {
        ok: false,
        status: 401,
        body: {
          error: "unauthorized",
          message: "token cannot be validated: revocation list unavailable",
        },
      };
    }
    const message =
      err instanceof HubJwtError
        ? err.message
        : err instanceof Error
          ? err.message
          : "JWT validation failed";
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", message },
    };
  }
}

/** Exact-match scope check. Non-vault scopes don't inherit per oauth-scopes.md. */
export function hasScope(granted: readonly string[], required: string): boolean {
  return granted.includes(required);
}

/**
 * Pass-through scope check that treats `surface:admin` as implying `surface:read`.
 * Read-only admin endpoints (GET /surface/list, GET /surface/<name>/info) accept
 * either scope; admin endpoints (add/remove/reload) require `surface:admin`
 * exactly.
 */
export function hasReadAccess(granted: readonly string[]): boolean {
  return granted.includes(SCOPE_READ) || granted.includes(SCOPE_ADMIN);
}

/**
 * Resolve auth + scope. Returns either a Response to forward (401/403) or
 * the granted scopes for the caller to use in finer-grained checks.
 *
 * `requiredScope` is one of:
 *   - `surface:admin` — exact match required
 *   - `surface:read`  — accepts `surface:read` OR `surface:admin` (admin implies read)
 */
export async function enforceScope(
  req: Request,
  requiredScope: typeof SCOPE_ADMIN | typeof SCOPE_READ,
  opts: { hubUrl?: string } = {},
): Promise<Response | { scopes: readonly string[] }> {
  const token = extractBearer(req.headers.get("authorization"));
  const result = await validateBearer(token, opts);
  if (!result.ok) {
    return Response.json(result.body, { status: result.status });
  }
  const granted = result.scopes;
  const ok = requiredScope === SCOPE_READ ? hasReadAccess(granted) : hasScope(granted, SCOPE_ADMIN);
  if (!ok) {
    return Response.json(
      {
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `This endpoint requires the '${requiredScope}' scope.`,
        required_scope: requiredScope,
        granted_scopes: granted,
      },
      { status: 403 },
    );
  }
  return { scopes: granted };
}
