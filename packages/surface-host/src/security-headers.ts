/**
 * Host-injected security headers for BACKED surfaces (surface-runtime
 * design P6/§13).
 *
 * While public surfaces share the hub origin, CSP is the load-bearing
 * same-origin mitigation: a backed surface rendering untrusted audience
 * content is same-origin with the hub admin, so the host stamps a strict
 * `script-src 'self'`-class policy (plus nosniff / frame denial /
 * referrer suppression) on EVERY response that belongs to a backed
 * surface — api responses, WS-upgrade refusals, AND the surface's static
 * bundle. Static-only surfaces keep their current (header-free) behavior;
 * the trust act of shipping a backend is what opts a surface into the
 * hardened envelope. Long-term tracked: separate-origin hosting for
 * public surfaces.
 *
 * The per-surface `server.csp` override is ADD-ONLY (validated at parse
 * time — meta-schema.ts `parseCspOverride`): extra sources merge into the
 * defaults for fetch-class directives; nothing can be removed or loosened.
 */

import type { UiMeta } from "./meta-schema.ts";

/**
 * The default policy. Notes on the non-obvious lines:
 *   - `style-src 'unsafe-inline'`: bundlers (Vite et al.) inject style
 *     tags at runtime; inline STYLE is not the script-execution vector CSP
 *     primarily guards here.
 *   - `img/media/worker` allow `data:`/`blob:` — PWA + canvas/export flows
 *     use object URLs routinely.
 *   - `frame-ancestors 'none'` + the X-Frame-Options belt: no embedding,
 *     same posture as the hub admin.
 *   - `base-uri 'self'`: the host's tenancy injection adds a same-origin
 *     `<base href>`; anything else is an injection.
 */
export const DEFAULT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'"]],
  ["style-src", ["'self'", "'unsafe-inline'"]],
  ["img-src", ["'self'", "data:", "blob:"]],
  ["font-src", ["'self'", "data:"]],
  ["connect-src", ["'self'"]],
  ["media-src", ["'self'", "blob:"]],
  ["worker-src", ["'self'", "blob:"]],
  ["frame-src", ["'none'"]],
  ["object-src", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'self'"]],
];

/** Build the CSP header value for a surface (defaults + add-only override). */
export function buildCspValue(meta: UiMeta): string {
  const override = meta.server?.csp ?? {};
  const parts: string[] = [];
  for (const [directive, defaults] of DEFAULT_CSP_DIRECTIVES) {
    const extra = (override as Record<string, string[] | undefined>)[directive] ?? [];
    const sources = [...defaults];
    for (const e of extra) {
      if (!sources.includes(e)) sources.push(e);
    }
    // A directive whose default is 'none' and gained explicit sources
    // must drop the 'none' (CSP treats "'none' x" as invalid).
    const effective =
      sources.length > 1 && sources.includes("'none'")
        ? sources.filter((s) => s !== "'none'")
        : sources;
    parts.push(`${directive} ${effective.join(" ")}`);
  }
  return parts.join("; ");
}

/** The full P6 header set for a backed surface. */
export function securityHeadersFor(meta: UiMeta): Record<string, string> {
  return {
    "content-security-policy": buildCspValue(meta),
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Stamp the P6 headers onto a response (backed surfaces only — the caller
 * checks `meta.server`). Existing values are OVERWRITTEN: the host's
 * policy is non-optional, a backend must not be able to relax it by
 * setting its own CSP header (the meta.json override is the sanctioned
 * channel).
 *
 * Returns a fresh Response when the original's headers are immutable
 * (responses minted by `fetch` / some constructors guard them).
 */
export function applySecurityHeaders(res: Response, meta: UiMeta): Response {
  const headers = securityHeadersFor(meta);
  try {
    for (const [k, v] of Object.entries(headers)) {
      res.headers.set(k, v);
    }
    return res;
  } catch {
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(headers)) {
      out.headers.set(k, v);
    }
    return out;
  }
}
