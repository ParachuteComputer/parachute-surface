/**
 * Origin-check middleware — DEFAULT-ON for cookie-authenticated mutations
 * (design P7). Cookies ride ambient on cross-site requests; a state-
 * changing route whose actor came from the session COOKIE must therefore
 * prove same-origin intent or be refused (CSRF). Bearer / `Authorization:
 * Capability` requests are exempt — an attacker's page can't attach those
 * headers cross-origin without CORS consent.
 *
 * Fail-closed shape:
 *   - Mutation methods: everything except GET / HEAD / OPTIONS.
 *   - The `Origin` header MUST be present AND its host must equal the
 *     request's own host (`X-Forwarded-Host` when the hub proxy forwarded
 *     it, else `Host`). Absent Origin on a cookie mutation → refused —
 *     a non-browser client should present its token in a header instead.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isMutation(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** The request's own host as the client addressed it (proxy-aware). */
export function requestHost(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd && fwd.trim().length > 0) {
    // Comma-joined when multiple proxies append; the FIRST is the client-facing host.
    const first = fwd.split(",")[0]?.trim();
    if (first) return first.toLowerCase();
  }
  const host = req.headers.get("host");
  if (host && host.trim().length > 0) return host.trim().toLowerCase();
  try {
    return new URL(req.url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Same-origin verdict for a cookie-authenticated mutation. Returns true
 * iff the `Origin` header is present, parseable, and host-matches the
 * request's own host. Everything else — absent, `null`, malformed,
 * mismatched — is false (fail-closed).
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const own = requestHost(req);
  if (!own) return false;
  return originHost === own;
}
