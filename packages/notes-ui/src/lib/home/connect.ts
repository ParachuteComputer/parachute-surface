/**
 * "Connect your AI" URL + command helpers.
 *
 * A vault speaks MCP at `<vaultUrl>/mcp` — the literal `/mcp` suffix is
 * load-bearing: the bare `<vaultUrl>` is a read-only metadata page, and an MCP
 * client fails its handshake against it (see parachute.computer/multi-user).
 * This is what the user pastes into Claude / ChatGPT / any MCP client.
 */

/** The MCP endpoint a client connects to. Trailing slash on the vault URL is
 * tolerated so `…/vault/name` and `…/vault/name/` both yield one `/mcp`. */
export function mcpEndpoint(vaultUrl: string): string {
  return `${vaultUrl.replace(/\/+$/, "")}/mcp`;
}

/** A short, shell-safe handle for the vault in the `claude mcp add` command
 * (the CLI wants a token, not a display name with spaces). */
export function connectHandle(vaultName: string): string {
  const slug = vaultName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `parachute-${slug || "vault"}`;
}

/** The Claude Code one-liner (the "nerd footnote" under the point-and-click
 * connector steps), matching the cloud console's `connectCmd`. */
export function claudeConnectCommand(vaultName: string, mcpUrl: string): string {
  return `claude mcp add --transport http ${connectHandle(vaultName)} ${mcpUrl}`;
}
