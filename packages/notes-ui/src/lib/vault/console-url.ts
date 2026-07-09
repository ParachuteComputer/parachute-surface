/**
 * Cloud console URL for a vault — the target of the "Manage your vault plan"
 * backlink on the home.
 *
 * Cloud vaults live at `u.parachute.computer/vault/<name>`; their management
 * console is `cloud.parachute.computer/console`. Self-host vaults have NO
 * console — returning null there keeps us from painting a false door to a page
 * that doesn't exist.
 *
 * Detection prefers an explicit console origin (forward-compat with a
 * vault-landing field, should one ship) and otherwise URL-sniffs the known
 * cloud vault host.
 */

const CLOUD_CONSOLE_BY_VAULT_HOST: Record<string, string> = {
  "u.parachute.computer": "https://cloud.parachute.computer/console",
};

export function cloudConsoleUrl(vaultUrl: string, explicitConsole?: string | null): string | null {
  // Prefer an origin the vault advertises directly (not sent by any door today,
  // but honored if it appears — the team's stated preference over sniffing).
  if (explicitConsole) {
    try {
      const u = new URL(explicitConsole);
      return u.pathname === "/" || u.pathname === "" ? `${u.origin}/console` : explicitConsole;
    } catch {
      // malformed — fall through to host-sniff
    }
  }
  try {
    const host = new URL(vaultUrl).host;
    return CLOUD_CONSOLE_BY_VAULT_HOST[host] ?? null;
  } catch {
    return null;
  }
}
