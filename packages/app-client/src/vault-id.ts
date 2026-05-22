/**
 * `vaultIdFromUrl` — canonical URL → storage-key mapping for vault tokens.
 *
 * Two pieces of context to keep in mind:
 *
 * 1. **Token storage is keyed by vault id.** A multi-vault app holds one
 *    token per vault and needs a stable key per vault URL. The naive
 *    "use the URL as the key" works until the URL drifts — same vault,
 *    same operator, but the URL gains a trailing slash / changes
 *    scheme / etc., and the cached token is orphaned. `vaultIdFromUrl`
 *    is the canonical reduction: strip scheme, collapse non-word chars
 *    to `_`. The output is stable across the URL-shape drift that
 *    actually happens in operator workflows (see notes#149 — the
 *    URL-drift fix that made this function the canonical mapping).
 *
 * 2. **The function is intentionally lossy.** Two distinct vault URLs
 *    can collapse to the same id if they only differ in punctuation
 *    that maps to `_`. That's fine — two URLs hosting the same vault
 *    SHOULD share state. The shape is "compare by id, not by URL."
 *
 * Mirrors `parachute-notes/src/lib/vault/url.ts`'s `vaultIdFromUrl`
 * byte-for-byte. When Notes migrates to app-client (design doc section
 * 16 Phase 1) the import path changes; the behavior does not.
 */

/**
 * Reduce a vault URL to a storage-safe identifier. Strips the
 * `http://` / `https://` scheme, then replaces any run of non-word
 * (`\w.-`) chars with a single `_`. The result is filesystem-safe,
 * localStorage-key-safe, and URL-safe.
 *
 * Examples:
 *   `https://vault.example.com/vault/gitcoin` → `vault.example.com_vault_gitcoin`
 *   `http://127.0.0.1:1940/vault/default` → `127.0.0.1_1940_vault_default`
 *   `https://example.com/vault/` → `example.com_vault_`
 */
export function vaultIdFromUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_");
}

/**
 * Normalize a user-entered vault URL to the canonical "vault root" form:
 * no trailing slash, no common API/MCP suffixes, lowercased host.
 * Throws if the input is not a valid absolute HTTP(S) URL.
 *
 * Use this BEFORE `vaultIdFromUrl` when the caller is taking input
 * directly from a user. The normalize-then-id pipeline is the URL-drift
 * fix from notes#149: cache hits stay sticky even when the operator
 * pastes a URL with a trailing slash on the second visit.
 */
export function normalizeVaultUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Vault URL is required");

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Not a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Vault URL must use http or https");
  }

  parsed.hash = "";
  parsed.search = "";
  parsed.host = parsed.host.toLowerCase();

  let pathSegment = parsed.pathname.replace(/\/+$/, "");
  const stripSuffixes = [
    "/api",
    "/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
    "/.well-known/parachute.json",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/register",
  ];
  for (const suffix of stripSuffixes) {
    if (pathSegment.toLowerCase().endsWith(suffix)) {
      pathSegment = pathSegment.slice(0, -suffix.length);
      break;
    }
  }
  parsed.pathname = pathSegment || "";

  return parsed.toString().replace(/\/$/, "");
}
