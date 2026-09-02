#!/usr/bin/env node
/**
 * parachute-mcp — NIP-98-signed access to remote Parachute hubs, in two faces
 * on one binary:
 *
 *   - BRIDGE MODE (no subcommand): a stdio MCP server, for harnesses that run
 *     an MCP client. Unchanged.
 *   - CLI MODE (`tools` / `call` / `http`): one-shot commands, for agents that
 *     shell out instead. See commands.ts.
 *
 * In bridge mode stdout is the MCP wire, so ALL human-facing output goes to
 * stderr. The secret key is read from a file named by config/env (or, for a
 * Buzz agent, from the `BUZZ_PRIVATE_KEY` value buzz-acp injects into this
 * subprocess), held in memory only, and only ever surfaced as its npub.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ParachuteBridge } from "./bridge.js";
import { type Io, foldGlobals, runCli, splitSubcommand } from "./commands.js";
import { resolveConfig } from "./config.js";
import { loadKey, loadKeyValue } from "./key.js";
import { createBridgeServer } from "./server.js";
import { makeSigningFetch } from "./signing-fetch.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

const USAGE = `parachute-mcp — NIP-98-signed access to Parachute hubs

Bridge mode (an MCP server on stdio, for MCP clients):
  parachute-mcp [--config <path>]        bridge the configured hubs
  parachute-mcp <hub-mcp-url>            single-hub quick path (needs a key: see below)
  parachute-mcp --version | --help

CLI mode (one-shot commands, for agents that shell out):
  parachute-mcp tools [--hub <alias|url>] [--table]
      List the hubs' tools as JSON (name + description) on stdout.
      With several hubs and no --hub, names are namespaced <alias>__<tool>.

  parachute-mcp call <tool> --args - [--hub <alias|url>]
  parachute-mcp call <tool> [<json-args>] [--hub <alias|url>]
      One signed tools/call. Arguments are a JSON object, read from stdin with
      "--args -" or given as a positional literal. PREFER "--args -": a
      positional literal is in this process's argv, which ps shows to every
      user on the box, and it has to survive your shell's quoting. A single
      text result is printed as-is; anything else as the JSON result.

  parachute-mcp http <METHOD> <url> [--body -] [-H 'Name: value']...
      One signed HTTP request — a signed curl for hub endpoints that are not
      tool calls. The body comes from stdin only, never from argv. The
      response body goes to stdout; the status line and headers to stderr.
      Redirects are not followed (the signature pins one exact URL), so a 3xx
      exits 2.

Common flags: --config <path>, --timeout <seconds> (default 60).
--config and --timeout may go before OR after the subcommand:
  parachute-mcp --config c.json tools     and     parachute-mcp tools --config c.json
are the same command. All CLI subcommands use the same config and key
resolution as bridge mode.

Exit codes:
  0  success
  1  usage or configuration error (bad flags, no key, unknown hub or tool)
  2  network / transport failure, a timeout, or an HTTP response >= 300 that
     is not an auth failure (redirects are deliberately not followed)
  3  authentication rejected by the hub (HTTP 401 / 403)
  4  the tool ran and returned an error result (isError)

Config resolution order: --config, $PARACHUTE_MCP_CONFIG,
~/.config/parachute/mcp.json, then the positional URL quick path.

Key resolution order: config "keyFile", then $PARACHUTE_NSEC_FILE (a file path,
overrides "keyFile"), then $BUZZ_PRIVATE_KEY (a bech32 nsec value — injected
automatically for Buzz agents by buzz-acp, so no key file is needed there).
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

/** Read all of stdin as UTF-8 — only for `--args -` / `--body -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Wait for stdout/stderr to drain. `process.exit()` truncates pending writes
 * on a pipe, which is exactly how a CLI is used from an agent's shell.
 */
async function flushStdio(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
    ),
  );
}

/**
 * `parachute-mcp tools | head -1` closes the pipe under us. Node's default is
 * an unhandled EPIPE — a stack trace and exit 1 — for what is the reader
 * saying "I have enough". Exit 0 instead, the way every well-behaved CLI does.
 */
function ignoreEpipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

function processIo(): Io {
  ignoreEpipe(process.stdout);
  ignoreEpipe(process.stderr);
  return {
    out: (chunk) => process.stdout.write(chunk),
    err: (msg) => process.stderr.write(`${msg}\n`),
    stdin: readStdin,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // CLI mode. `splitSubcommand` also accepts flags BEFORE the subcommand
  // (`--config c.json tools`, the git/docker convention) and returns undefined
  // for every bridge-mode argv — a positional that is not a subcommand is a
  // hub URL, and no hub URL can be the word "tools", "call" or "http".
  const split = splitSubcommand(argv);
  if (split) {
    const code = await runCli(foldGlobals(split), processIo(), USAGE);
    process.exitCode = code;
    await flushStdio();
    process.exit(code);
  }

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
  // keyFile and keyValue are mutually exclusive (resolveKeySource guarantees
  // exactly one is set when resolveConfig returns without throwing).
  const key = config.keyFile ? loadKey(config.keyFile) : loadKeyValue(config.keyValue!);

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
  // This hook must be set BEFORE server.connect: SDK 1.29's Protocol.connect
  // CHAINS a pre-existing transport.onclose (protocol.js saves and re-invokes
  // it) rather than overwriting. If a future SDK bump changes that to a plain
  // overwrite, this orphan cleanup silently stops firing — re-verify on bumps.
  transport.onclose = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  await server.connect(transport);
  log("ready on stdio");
}

/**
 * Only run main() when this file IS the entry point (the bin, or
 * `node dist/cli.js`), not when imported — tests import `parseArgs` and must
 * not boot the bridge. Realpaths on both sides so npm's bin symlink matches.
 */
function invokedAsEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (invokedAsEntry()) {
  main().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
