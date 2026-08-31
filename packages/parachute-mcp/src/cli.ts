#!/usr/bin/env node
/**
 * parachute-mcp — stdio MCP bridge to remote Parachute hubs, signing every
 * HTTP request with a NIP-98 Nostr auth event.
 *
 * stdout is the MCP wire: ALL human-facing output goes to stderr. The secret
 * key is read from a file named by config/env, held in memory only, and only
 * ever surfaced as its npub.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ParachuteBridge } from "./bridge.js";
import { resolveConfig } from "./config.js";
import { loadKey } from "./key.js";
import { createBridgeServer } from "./server.js";
import { makeSigningFetch } from "./signing-fetch.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

const USAGE = `parachute-mcp — stdio MCP bridge to Parachute hubs (NIP-98 signed)

Usage:
  parachute-mcp [--config <path>]        bridge the configured hubs
  parachute-mcp <hub-mcp-url>            single-hub quick path (needs PARACHUTE_NSEC_FILE)
  parachute-mcp --version | --help

Config resolution order: --config, $PARACHUTE_MCP_CONFIG,
~/.config/parachute/mcp.json, then the positional URL quick path.
`;

function log(msg: string): void {
  process.stderr.write(`[parachute-mcp] ${msg}\n`);
}

interface ParsedArgs {
  config?: string;
  url?: string;
  version: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") parsed.version = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--config") {
      const value = argv[++i];
      if (!value) throw new Error("--config needs a path");
      parsed.config = value;
    } else if (arg?.startsWith("--config=")) {
      parsed.config = arg.slice("--config=".length);
    } else if (arg?.startsWith("-")) {
      throw new Error(`unknown flag ${arg}`);
    } else if (arg) {
      if (parsed.url) throw new Error("at most one positional hub URL");
      parsed.url = arg;
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    // --version goes to stdout: it's the invocation's entire purpose and no
    // MCP session is running.
    process.stdout.write(`${PARACHUTE_MCP_VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const config = resolveConfig({ configFlag: args.config, positionalUrl: args.url, warn: log });
  const key = loadKey(config.keyFile);

  const bridge = new ParachuteBridge(config.hubs, makeSigningFetch(key.sk), log);
  log(
    `v${PARACHUTE_MCP_VERSION} — signing as ${key.npub}; hubs: ${config.hubs.map((h) => `${h.alias} (${h.url})`).join(", ")} [config: ${config.source}]`,
  );

  const report = await bridge.start();
  if (report.connected.length > 0) log(`connected: ${report.connected.join(", ")}`);
  if (report.failed.length > 0) {
    log(`unreachable (will retry lazily): ${report.failed.join(", ")}`);
  }

  const server = createBridgeServer(bridge);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  await server.connect(transport);
  log("ready on stdio");
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
