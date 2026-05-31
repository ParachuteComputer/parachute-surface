/**
 * URL helpers — re-exports from `@openparachute/surface-client` plus Notes'
 * legacy-vault-URL guard.
 *
 * Phase 2 of the notes-migration-to-app arc (parachute-app#6, design doc
 * section 16) moved `vaultIdFromUrl` + `normalizeVaultUrl` into
 * app-client so other hosted apps share the URL-drift fix from
 * notes#149. `isLegacyVaultUrl` stays Notes-side — it's a one-off
 * migration helper for VaultRecords that pre-date vault PR 7's
 * `/vaults/` → `/vault/` rename.
 */

export { normalizeVaultUrl, vaultIdFromUrl } from "@openparachute/surface-client";
export { isLegacyVaultUrl } from "./types";

/**
 * Sanitize a caller-supplied post-connect redirect target (the `redirect`
 * search param the hub `/account` deep-link rides through `/add`, notes#63).
 *
 * Only an in-app, same-origin path is allowed — react-router `navigate()`
 * treats its argument as an internal location, so a value like
 * `https://evil.example` or the protocol-relative `//evil.example` must never
 * round-trip into it. We require a single leading slash and reject anything
 * that parses as an absolute URL or starts with `//`. Returns `undefined` for
 * anything that doesn't pass, so callers fall back to the default landing
 * (`/`).
 */
export function safeInternalRedirect(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // Must be an app-internal absolute path: one leading slash, not two
  // (protocol-relative `//host` would navigate off-origin).
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  // Reject anything the URL parser accepts as absolute (has a scheme).
  try {
    // A relative path throws here; an absolute URL (with scheme) parses.
    new URL(raw);
    return undefined;
  } catch {
    return raw;
  }
}
