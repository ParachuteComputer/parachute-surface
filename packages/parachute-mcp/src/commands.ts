/**
 * The CLI face of the same binary: `tools`, `call` and `http`.
 *
 * WHY this exists next to the bridge. The bridge serves harnesses that *run an
 * MCP client*. A growing set of agents do not — they shell out to commands.
 * Those agents were hand-rolling NIP-98 signing (a Python re-implementation, a
 * shell wrapper) to reach the same hubs, which means the signing rules that
 * matter (fresh nonce per request, `u` = the exact URL, payload tag iff a body)
 * get re-derived, badly, per agent. One artifact now serves both shapes: the
 * bridge for MCP clients, these subcommands for everyone else, over the SAME
 * config resolution, the SAME key resolution, and the SAME signing code.
 *
 * Bridge mode is untouched — cli.ts only routes here when argv[0] is one of
 * SUBCOMMANDS, and no hub URL can collide with those words.
 *
 * SECRET DISCIPLINE, unchanged from the rest of the package: the key comes
 * from `loadKey`/`loadKeyValue`, is held in memory, and is only ever surfaced
 * as its npub. Nothing here puts key material in argv (that is why `http`
 * takes its body from stdin ONLY), and every stderr line is passed through
 * `redactSecrets` as a belt-and-braces second line of defence.
 *
 * I/O is injected (`Io`) rather than taken from `process` so the integration
 * tests can drive real hubs over loopback without spawning subprocesses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_NAME_MAX_LENGTH, namespacedToolName } from "./bridge.js";
import { type ChannelVaultLookup, lookupChannelVault } from "./channel-vault.js";
import {
  type ChannelAction,
  type ChannelResult,
  DEFAULT_TAIL_BYTES,
  deriveTarget,
  runChannelContext,
} from "./channel.js";
import { type HubEntry, type ResolvedConfig, resolveConfig } from "./config.js";
import {
  type DoctorDeps,
  type DoctorReport,
  type DoctorSession,
  renderReport,
  runDoctor,
} from "./doctor.js";
import {
  EXIT,
  TimeoutError,
  UsageError,
  exitCodeForError,
  httpStatusOf,
  isAuthStatus,
  messageOf,
} from "./exit.js";
import { type LoadedKey, loadKey, loadKeyValue } from "./key.js";
import { buildAuthEvent, signAuthHeader } from "./nip98.js";
import { makeSigningFetch } from "./signing-fetch.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

/**
 * The exit-code contract lives in exit.ts (shared with doctor.ts) and is
 * re-exported here: `EXIT` and friends have been part of this module's public
 * surface since the CLI face shipped, and callers should not have to care that
 * the definitions moved.
 */
export { EXIT, UsageError, TimeoutError, exitCodeForError };

export const SUBCOMMANDS = ["tools", "call", "http", "doctor", "channel-context"] as const;
export type SubcommandName = (typeof SUBCOMMANDS)[number];

export function isSubcommand(arg: string | undefined): arg is SubcommandName {
  return arg !== undefined && (SUBCOMMANDS as readonly string[]).includes(arg);
}

/**
 * Flags that consume the NEXT argv entry as their value. Needed only by
 * `splitSubcommand`, which must not mistake a flag's VALUE for a subcommand:
 * in `--config tools` the word "tools" is a path, not a command.
 */
const VALUE_FLAGS = new Set([
  "--config",
  "--hub",
  "--args",
  "--body",
  "--header",
  "-H",
  "--timeout",
  "--vault",
  "--relay",
  "--channel",
  "--tail",
]);

export interface SubcommandSplit {
  /** Flags that appeared BEFORE the subcommand name. */
  globals: string[];
  /** argv from the subcommand name onwards. */
  rest: string[];
}

/**
 * Find the subcommand in an argv that may carry flags before it, so that
 * `parachute-mcp --config x.json tools` works like `git -C dir status` and
 * `docker --host h ps` — the convention every agent will assume.
 *
 * Returns undefined when this argv is BRIDGE mode, which is the load-bearing
 * half: a positional that is not a subcommand is a hub URL, and `--version` /
 * `--help` before any subcommand stay exactly the bridge-mode business they
 * were before CLI mode existed.
 *
 * Getting this wrong is not a small bug: before this existed,
 * `parachute-mcp --config x.json tools` fell through to bridge mode, "tools"
 * became the positional hub URL, and the bridge booted and sat on stdio with
 * an empty stdout and exit 0 — a command that looks like it succeeded and
 * produced nothing.
 */
export function splitSubcommand(argv: string[]): SubcommandSplit | undefined {
  const globals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (isSubcommand(arg)) return { globals, rest: argv.slice(i) };
    if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") return undefined;
    if (!arg.startsWith("-")) return undefined;
    globals.push(arg);
    if (VALUE_FLAGS.has(arg) && i + 1 < argv.length) globals.push(argv[++i] as string);
  }
  return undefined;
}

/**
 * Rebuild a subcommand argv with the pre-subcommand flags folded in after the
 * subcommand name, where the per-subcommand parsers already handle them.
 */
export function foldGlobals(split: SubcommandSplit): string[] {
  const [name, ...rest] = split.rest;
  return [name as string, ...split.globals, ...rest];
}

export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Bound `work` by `ms`. The losing promise is left running with its rejection
 * swallowed: a hung hub connection has nothing useful to cancel from here, and
 * the process exits immediately after.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseTimeoutFlag(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError("--timeout needs a positive number of seconds");
  }
  return Math.round(seconds * 1000);
}

const NAMESPACE_SEP = "__";

/**
 * Scrub bech32 secret keys from anything on its way to stderr.
 *
 * This should never fire — no code path here builds a string containing the
 * secret, `key.ts` scrubs its own parse errors, and `config.ts` never echoes
 * file contents. It exists because a CLI's error text is assembled from more
 * sources than the bridge's (hub response bodies, header echoes), and the cost
 * of being wrong once is a key in a log.
 *
 * Deliberately nsec-only: a bare-hex key is 64 hex chars and so is every event
 * id, so redacting 64-hex would mangle legitimate diagnostic output. Hex keys
 * only ever arrive from a file, and no path echoes file contents.
 */
export function redactSecrets(msg: string): string {
  return msg.replace(/nsec1[02-9ac-hj-np-z]{20,}/gi, "nsec1[redacted]");
}

/** Injected I/O so tests can capture streams without spawning a process. */
export interface Io {
  /** stdout — the command's actual result. Never redacted (it is data). */
  out: (chunk: string | Uint8Array) => void;
  /** stderr — diagnostics, status lines, errors. Redacted by `runCli`. */
  err: (msg: string) => void;
  /** Read all of stdin as UTF-8. Only called for `--args -` / `--body -`. */
  stdin: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ToolsCommand {
  kind: "tools";
  config?: string;
  hub?: string;
  table: boolean;
  /** Per-request budget in ms (`--timeout`, seconds on the wire). */
  timeout: number;
}

export interface CallCommand {
  kind: "call";
  config?: string;
  hub?: string;
  tool: string;
  /**
   * Where the JSON arguments come from. `stdin` exists because nested-shell
   * JSON quoting is the single most common way an agent's `call` goes wrong —
   * a heredoc into `--args -` has no quoting rules at all.
   */
  args: { from: "none" } | { from: "literal"; json: string } | { from: "stdin" };
  /** Per-request budget in ms (`--timeout`, seconds on the wire). */
  timeout: number;
}

export interface HttpCommand {
  kind: "http";
  config?: string;
  method: string;
  /** Normalized (`new URL(...).href`) — the NIP-98 `u` tag must be exact. */
  url: string;
  headers: Array<[string, string]>;
  bodyFromStdin: boolean;
  /** Per-request budget in ms (`--timeout`, seconds on the wire). */
  timeout: number;
}

export interface DoctorCommand {
  kind: "doctor";
  config?: string;
  hub?: string;
  /** `--vault <name>`: which vault the write round-trip probes. */
  vault?: string;
  /** `--relay <wss-url>`: the `channel` step's relay. Defaults to `$BUZZ_RELAY_URL`. */
  relay?: string;
  /** `--channel <uuid>`: the `channel` step's channel. Defaults to the env. */
  channel?: string;
  /** `--json`: one machine-readable object instead of the PASS/FAIL lines. */
  json: boolean;
  /** Per-request budget in ms (`--timeout`, seconds on the wire). */
  timeout: number;
}

export interface ChannelContextCommand {
  kind: "channel-context";
  action: ChannelAction;
  config?: string;
  hub?: string;
  /**
   * `--vault <name>`: optional everywhere. Absent on append/init, the vault is
   * resolved from the hub's channel binding.
   */
  vault?: string;
  /** `--relay <wss-url>`: defaults to `$BUZZ_RELAY_URL`. */
  relay?: string;
  /** `--channel <uuid>`: defaults to `$BUZZ_CHANNEL_ID`, then `$BUZZ_GIT_ORIGIN_CHANNEL_ID`. */
  channel?: string;
  /** `--tail <bytes>`: how much of the note's end `read` prints. */
  tail: number;
  json: boolean;
  /** Per-request budget in ms (`--timeout`, seconds on the wire). */
  timeout: number;
}

export interface HelpCommand {
  kind: "help";
}

export type Command =
  | ToolsCommand
  | CallCommand
  | HttpCommand
  | DoctorCommand
  | ChannelContextCommand
  | HelpCommand;

/** Does `arg` introduce flag `name`, either as `--name` or `--name=value`? */
function isFlag(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

/**
 * Read the value of flag `name` at index `i`, from `--name=value` or the next
 * argv entry. Returns the index actually consumed.
 */
function takeValue(argv: string[], i: number, name: string): [string, number] {
  const arg = argv[i] as string;
  if (arg.startsWith(`${name}=`)) {
    const inline = arg.slice(name.length + 1);
    if (inline === "") throw new UsageError(`${name} needs a value`);
    return [inline, i];
  }
  const next = argv[i + 1];
  if (next === undefined || next === "") throw new UsageError(`${name} needs a value`);
  return [next, i + 1];
}

/** RFC 9110 field-name token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseHeader(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx <= 0) throw new UsageError(`-H expects "Name: value", got "${raw}"`);
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (name === "") throw new UsageError(`-H expects "Name: value", got "${raw}"`);
  // Validate here rather than letting Headers.set throw: its TypeError is not
  // a UsageError, so it would surface as a transport failure (exit 2) for what
  // is plainly a typo on the command line.
  if (!HEADER_NAME_RE.test(name)) {
    throw new UsageError(`-H header name "${name}" is not a valid HTTP field name`);
  }
  if (/[\r\n]/.test(value)) throw new UsageError(`-H header "${name}" value contains a newline`);
  if (name.toLowerCase() === "authorization") {
    // Refusing beats silently overwriting: the whole point of this command is
    // that it sets Authorization itself, from a key the caller does not hold.
    throw new UsageError("-H cannot set Authorization — this command signs the request itself");
  }
  return [name, value];
}

function normalizeHttpUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never re-throw the URL error: Node's URL constructor puts the FULL raw
    // input on `error.input`, and this string is user-supplied.
    throw new UsageError(`${what} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`${what} must be http(s)`);
  }
  return url.href;
}

/** `--hub` accepts an alias from the config file, or a hub URL directly. */
export function hubFlagIsUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Parse a subcommand argv (argv[0] IS the subcommand name). `--help` / `-h`
 * anywhere short-circuits to `{ kind: "help" }` so help never trips over a
 * missing required positional.
 */
export function parseCommand(argv: string[]): Command {
  if (argv.some((a) => a === "--help" || a === "-h")) return { kind: "help" };
  const name = argv[0];
  switch (name) {
    case "tools":
      return parseTools(argv);
    case "call":
      return parseCall(argv);
    case "http":
      return parseHttp(argv);
    case "doctor":
      return parseDoctor(argv);
    case "channel-context":
      return parseChannelContext(argv);
    default:
      throw new UsageError(`unknown subcommand "${String(name)}"`);
  }
}

function parseTools(argv: string[]): ToolsCommand {
  const cmd: ToolsCommand = { kind: "tools", table: false, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--table") cmd.table = true;
    else if (isFlag(arg, "--config")) [cmd.config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [cmd.hub, i] = takeValue(argv, i, "--hub");
    else if (isFlag(arg, "--timeout")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--timeout");
      cmd.timeout = parseTimeoutFlag(value);
    } else if (arg.startsWith("-")) throw new UsageError(`tools: unknown flag ${arg}`);
    else throw new UsageError(`tools: unexpected argument "${arg}" (tools takes no positionals)`);
  }
  return cmd;
}

function parseDoctor(argv: string[]): DoctorCommand {
  const cmd: DoctorCommand = { kind: "doctor", json: false, timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") cmd.json = true;
    else if (isFlag(arg, "--config")) [cmd.config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [cmd.hub, i] = takeValue(argv, i, "--hub");
    else if (isFlag(arg, "--vault")) [cmd.vault, i] = takeValue(argv, i, "--vault");
    else if (isFlag(arg, "--relay")) [cmd.relay, i] = takeValue(argv, i, "--relay");
    else if (isFlag(arg, "--channel")) [cmd.channel, i] = takeValue(argv, i, "--channel");
    else if (isFlag(arg, "--timeout")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--timeout");
      cmd.timeout = parseTimeoutFlag(value);
    } else if (arg.startsWith("-")) throw new UsageError(`doctor: unknown flag ${arg}`);
    else throw new UsageError(`doctor: unexpected argument "${arg}" (doctor takes no positionals)`);
  }
  return cmd;
}

const CHANNEL_ACTIONS = ["read", "append", "init"] as const;

function parseTailFlag(raw: string): number {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes <= 0) {
    throw new UsageError("--tail needs a positive whole number of bytes");
  }
  return bytes;
}

function parseChannelContext(argv: string[]): ChannelContextCommand {
  const cmd: ChannelContextCommand = {
    kind: "channel-context",
    // Overwritten by the positional below; a missing one is a UsageError.
    action: "read",
    tail: DEFAULT_TAIL_BYTES,
    json: false,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  let action: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") cmd.json = true;
    else if (isFlag(arg, "--config")) [cmd.config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [cmd.hub, i] = takeValue(argv, i, "--hub");
    else if (isFlag(arg, "--vault")) [cmd.vault, i] = takeValue(argv, i, "--vault");
    else if (isFlag(arg, "--relay")) [cmd.relay, i] = takeValue(argv, i, "--relay");
    else if (isFlag(arg, "--channel")) [cmd.channel, i] = takeValue(argv, i, "--channel");
    else if (isFlag(arg, "--tail")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--tail");
      cmd.tail = parseTailFlag(value);
    } else if (isFlag(arg, "--timeout")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--timeout");
      cmd.timeout = parseTimeoutFlag(value);
    } else if (arg.startsWith("-")) throw new UsageError(`channel-context: unknown flag ${arg}`);
    else if (action === undefined) action = arg;
    else {
      throw new UsageError(
        `channel-context: unexpected argument "${arg}" (expected one of ${CHANNEL_ACTIONS.join(" | ")})`,
      );
    }
  }
  if (action === undefined) {
    throw new UsageError(`channel-context: needs an action (${CHANNEL_ACTIONS.join(" | ")})`);
  }
  if (!(CHANNEL_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(
      `channel-context: unknown action "${action}" (expected ${CHANNEL_ACTIONS.join(" | ")})`,
    );
  }
  cmd.action = action as ChannelAction;
  return cmd;
}

function parseCall(argv: string[]): CallCommand {
  let tool: string | undefined;
  let literal: string | undefined;
  let fromStdin = false;
  let config: string | undefined;
  let hub: string | undefined;
  let timeout = DEFAULT_TIMEOUT_MS;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (isFlag(arg, "--config")) [config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [hub, i] = takeValue(argv, i, "--hub");
    else if (isFlag(arg, "--timeout")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--timeout");
      timeout = parseTimeoutFlag(value);
    } else if (isFlag(arg, "--args")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--args");
      if (value !== "-") {
        throw new UsageError(
          '--args only accepts "-" (read the JSON arguments from stdin); ' +
            "pass a JSON literal as a positional argument instead",
        );
      }
      fromStdin = true;
    } else if (arg.startsWith("-")) throw new UsageError(`call: unknown flag ${arg}`);
    else if (tool === undefined) tool = arg;
    else if (literal === undefined) literal = arg;
    else throw new UsageError(`call: unexpected argument "${arg}" (expected <tool> [<json-args>])`);
  }

  if (tool === undefined) throw new UsageError("call: needs a tool name");
  if (fromStdin && literal !== undefined) {
    throw new UsageError('call: pass JSON arguments as a positional OR with "--args -", not both');
  }
  const args: CallCommand["args"] = fromStdin
    ? { from: "stdin" }
    : literal !== undefined
      ? { from: "literal", json: literal }
      : { from: "none" };
  return { kind: "call", tool, args, config, hub, timeout };
}

const METHOD_RE = /^[A-Za-z]+$/;

function parseHttp(argv: string[]): HttpCommand {
  let method: string | undefined;
  let url: string | undefined;
  let config: string | undefined;
  let bodyFromStdin = false;
  let timeout = DEFAULT_TIMEOUT_MS;
  const headers: Array<[string, string]> = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (isFlag(arg, "--config")) [config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--timeout")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--timeout");
      timeout = parseTimeoutFlag(value);
    } else if (arg === "-H" || isFlag(arg, "--header")) {
      let value: string;
      [value, i] = takeValue(argv, i, arg === "-H" ? "-H" : "--header");
      headers.push(parseHeader(value));
    } else if (isFlag(arg, "--body")) {
      let value: string;
      [value, i] = takeValue(argv, i, "--body");
      if (value !== "-") {
        // A body on the command line lands in argv, which is world-readable
        // via ps/proc. Bodies to a hub routinely carry secrets.
        throw new UsageError('--body only accepts "-" (read the request body from stdin)');
      }
      bodyFromStdin = true;
    } else if (arg.startsWith("-")) throw new UsageError(`http: unknown flag ${arg}`);
    else if (method === undefined) method = arg;
    else if (url === undefined) url = arg;
    else throw new UsageError(`http: unexpected argument "${arg}" (expected <METHOD> <url>)`);
  }

  if (method === undefined) throw new UsageError("http: needs a METHOD (e.g. GET, POST)");
  if (url === undefined) throw new UsageError("http: needs a URL");
  if (!METHOD_RE.test(method)) throw new UsageError(`http: "${method}" is not an HTTP method`);
  const upper = method.toUpperCase();
  if (bodyFromStdin && (upper === "GET" || upper === "HEAD")) {
    throw new UsageError(`http: ${upper} cannot carry a body`);
  }
  return {
    kind: "http",
    method: upper,
    url: normalizeHttpUrl(url, "http: URL"),
    headers,
    bodyFromStdin,
    config,
    timeout,
  };
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

interface Resolved {
  config: ResolvedConfig;
  key: LoadedKey;
}

/**
 * Resolve config + key with the EXACT machinery the bridge uses, then re-label
 * every failure as a UsageError so it exits 1 (a missing key file is the
 * user's to fix, not a transport fault).
 *
 * `positionalUrl` feeds the same single-hub quick path bridge mode has, which
 * is how a Buzz agent with only `BUZZ_PRIVATE_KEY` and no config file gets a
 * key at all. The "config file wins, ignoring positional URL" warning is
 * suppressed here because in CLI mode the URL is not a *fallback* — it came
 * from an explicit `--hub <url>` or is the `http` request target — so the
 * warning would describe a precedence that does not apply.
 */
function resolveKeyAndConfig(
  configFlag: string | undefined,
  positionalUrl: string | undefined,
  io: Io,
): Resolved {
  try {
    const config = resolveConfig({
      configFlag,
      positionalUrl,
      env: io.env,
      home: io.home,
      warn: () => {},
    });
    // keyFile and keyValue are mutually exclusive — resolveKeySource
    // guarantees exactly one is set when resolveConfig returns.
    const key = config.keyFile ? loadKey(config.keyFile) : loadKeyValue(config.keyValue as string);
    return { config, key };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Which hubs this invocation talks to, after `--hub`. */
function targetHubs(config: ResolvedConfig, hubFlag: string | undefined): HubEntry[] {
  if (hubFlag === undefined) return config.hubs;
  if (hubFlagIsUrl(hubFlag)) {
    return [{ alias: "hub", url: normalizeHttpUrl(hubFlag, "--hub URL") }];
  }
  const hub = config.hubs.find((h) => h.alias === hubFlag);
  if (!hub) {
    throw new UsageError(
      `--hub "${hubFlag}": no hub with that alias (configured: ${config.hubs
        .map((h) => h.alias)
        .join(", ")}) — or pass a full hub URL`,
    );
  }
  return [hub];
}

/**
 * One short-lived MCP session over the signing fetch.
 *
 * Deliberately NOT `ParachuteBridge`: the bridge swallows a per-hub failure
 * (logs it, carries on) because a long-lived bridge must survive one hub being
 * down. A one-shot CLI must do the opposite and exit non-zero. Everything
 * below the session — the SDK Client, the Streamable-HTTP transport, the
 * signing fetch — is the same code the bridge runs.
 */
class HubSession {
  private constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
    private readonly timeoutMs: number,
  ) {}

  static async open(
    hub: HubEntry,
    signingFetch: FetchLike,
    timeoutMs: number,
  ): Promise<HubSession> {
    const client = new Client({ name: "parachute-mcp", version: PARACHUTE_MCP_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(hub.url), { fetch: signingFetch });
    try {
      await withTimeout(client.connect(transport), timeoutMs);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return new HubSession(client, transport, timeoutMs);
  }

  async listTools(): Promise<Tool[]> {
    return (await withTimeout(this.client.listTools(), this.timeoutMs)).tools;
  }

  /** `serverInfo` from the `initialize` handshake, when the hub sent one. */
  serverInfo(): { name?: string; version?: string } | undefined {
    return this.client.getServerVersion();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await withTimeout(
      this.client.callTool({ name, arguments: args }),
      this.timeoutMs,
    )) as CallToolResult;
  }

  /**
   * DELETE the session (when the hub issued one), then drop the transport.
   * Bounded too: a hub that hangs on the DELETE must not hang the exit, and a
   * failure to tidy up is never worth failing the command over.
   */
  async close(): Promise<void> {
    await withTimeout(this.transport.terminateSession(), this.timeoutMs).catch(() => {});
    await this.client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

interface ToolLine {
  name: string;
  description: string;
}

function firstLine(text: string): string {
  return (text.split("\n", 1)[0] ?? "").trim();
}

function renderTable(tools: ToolLine[]): string {
  if (tools.length === 0) return "";
  const width = Math.min(Math.max(...tools.map((t) => t.name.length)), 44);
  return `${tools
    .map((t) => `${t.name.padEnd(width)}  ${firstLine(t.description)}`.trimEnd())
    .join("\n")}\n`;
}

/**
 * List tools across the target hubs.
 *
 * Namespacing follows the bridge exactly: `<alias>__<tool>` iff more than one
 * hub is in play, so a name printed here is a name `call` accepts.
 *
 * Partial failure: tools from the hubs that answered are still printed (an
 * agent that lost one tailnet hub should not lose the others), but the exit
 * code reports the worst failure seen. Nothing is silently dropped — each
 * failure gets a stderr line.
 */
async function runTools(cmd: ToolsCommand, io: Io): Promise<number> {
  const { config, key } = resolveKeyAndConfig(
    cmd.config,
    cmd.hub !== undefined && hubFlagIsUrl(cmd.hub) ? cmd.hub : undefined,
    io,
  );
  const hubs = targetHubs(config, cmd.hub);
  const signingFetch = makeSigningFetch(key.sk);
  const namespaced = hubs.length > 1;

  const listed: ToolLine[] = [];
  let worst: number = EXIT.ok;
  for (const hub of hubs) {
    let session: HubSession | undefined;
    try {
      session = await HubSession.open(hub, signingFetch, cmd.timeout);
      for (const tool of await session.listTools()) {
        const name = namespaced ? namespacedToolName(hub.alias, tool.name) : tool.name;
        if (name === null) {
          io.err(
            `hub "${hub.alias}": omitting tool "${tool.name}": namespaced name exceeds ${MCP_TOOL_NAME_MAX_LENGTH} characters`,
          );
          continue;
        }
        listed.push({
          name,
          description: tool.description ?? "",
        });
      }
    } catch (err) {
      io.err(`hub "${hub.alias}" (${hub.url}): ${messageOf(err)}`);
      worst = Math.max(worst, exitCodeForError(err));
    } finally {
      await session?.close();
    }
  }

  // Nothing listed AND something failed: stay silent on stdout. Printing `[]`
  // there is a lie in the shape of data — an agent that pipes stdout to a JSON
  // parser would read "this hub has no tools" out of a total connection
  // failure. An honestly empty hub (worst === ok) still prints `[]`.
  if (listed.length > 0 || worst === EXIT.ok) {
    io.out(cmd.table ? renderTable(listed) : `${JSON.stringify(listed, null, 2)}\n`);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

/** Route a (possibly namespaced) tool name to one target hub. */
function resolveToolTarget(hubs: HubEntry[], name: string): { hub: HubEntry; toolName: string } {
  const single = hubs[0];
  if (hubs.length === 1 && single) {
    // Accept the namespaced form too, so a name copied out of `tools` output
    // still works once `--hub` has narrowed the target to one.
    const prefix = `${single.alias}${NAMESPACE_SEP}`;
    return { hub: single, toolName: name.startsWith(prefix) ? name.slice(prefix.length) : name };
  }
  for (const hub of hubs) {
    const prefix = `${hub.alias}${NAMESPACE_SEP}`;
    if (name.startsWith(prefix)) return { hub, toolName: name.slice(prefix.length) };
  }
  throw new UsageError(
    `unknown tool "${name}": with several hubs configured, name it ` +
      `<alias>${NAMESPACE_SEP}<tool> (aliases: ${hubs.map((h) => h.alias).join(", ")}) or pass --hub`,
  );
}

/**
 * Parse the JSON arguments. The error is deliberately CONTENT-FREE, the same
 * discipline config.ts uses: the classic accident is piping the wrong file in,
 * and that file could hold a key.
 */
function parseToolArgs(raw: string, where: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UsageError(`call: ${where} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`call: ${where} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Text of a result that is exactly one text block, else undefined. */
function singleTextBlock(result: CallToolResult): string | undefined {
  const content = result.content as Array<{ type?: string; text?: unknown }> | undefined;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Tools whose `id` parameter is a documented id-OR-path lookup key (vault
 * `core/src/mcp.ts`'s `resolveNote`) — the same convention `channel-context`
 * already relies on (`appendEntry` sends `id: target.path`, never a separate
 * `path`). `call` is a raw pass-through for any tool on any hub, so this maps
 * `path` -> `id` only for the tools known to share that contract: an agent
 * that reaches for the more obvious `path` key (there is no such thing as a
 * "path" parameter on these tools) gets the note the hub would have found
 * anyway, instead of an `id`-less call.
 *
 * `update-note` ALSO accepts `path` as a genuine field (renames the note), so
 * this only fires when `id` is absent — a caller passing both keeps its
 * rename intent untouched. See surface#236: `call update-note` with `path`
 * and no `id` reached the hub with `id` unset, and the hub's fallback for an
 * unresolvable id/path is an unstructured `Error: ...` tool result.
 */
const ID_OR_PATH_TOOLS = new Set(["update-note"]);

function resolveIdOrPath(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!ID_OR_PATH_TOOLS.has(toolName)) return args;
  if (args.id !== undefined || typeof args.path !== "string") return args;
  const { path, ...rest } = args;
  return { ...rest, id: path };
}

async function runCall(cmd: CallCommand, io: Io): Promise<number> {
  const { config, key } = resolveKeyAndConfig(
    cmd.config,
    cmd.hub !== undefined && hubFlagIsUrl(cmd.hub) ? cmd.hub : undefined,
    io,
  );
  const { hub, toolName } = resolveToolTarget(targetHubs(config, cmd.hub), cmd.tool);

  const args =
    cmd.args.from === "stdin"
      ? parseToolArgs(await io.stdin(), "stdin")
      : cmd.args.from === "literal"
        ? parseToolArgs(cmd.args.json, "the JSON arguments")
        : {};

  // A connect failure here is NOT caught below — it propagates to runCli's
  // generic classification, same as `tools`: an unreachable hub is a
  // transport fault, not the tool failing.
  const session = await HubSession.open(hub, makeSigningFetch(key.sk), cmd.timeout);
  try {
    const result = await session.callTool(toolName, resolveIdOrPath(toolName, args));
    const text = singleTextBlock(result);
    if (result.isError) {
      io.err(text ?? JSON.stringify(result, null, 2));
      return EXIT.toolError;
    }
    io.out(text !== undefined ? withNewline(text) : `${JSON.stringify(result, null, 2)}\n`);
    return EXIT.ok;
  } catch (err) {
    // A JSON-RPC error out of tools/call (the hub throwing instead of
    // answering with `isError`) is still the TOOL failing, not the network —
    // classify it the same way doctor/channel-context do (`classifyError`
    // below), so it doesn't fall through to runCli's generic transport
    // default and every failure here resolves to a real, non-zero EXIT code.
    io.err(`call: ${messageOf(err)}`);
    return classifyError(err, "tool");
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

/**
 * One NIP-98-signed HTTP request — a signed `curl` for everything the hub
 * serves under Nostr auth that is not a tool call.
 *
 * Redirects are NOT followed: the `u` tag pins the signature to one exact URL,
 * so a followed redirect would carry a signature for the wrong target and the
 * hub would reject it. A 3xx is therefore reported as-is (like `curl` without
 * `-L`) and exits NON-ZERO: the request did not do what was asked, and an
 * empty body with exit 0 is the worst of both worlds for a caller that
 * branches on the exit code.
 */
async function runHttp(cmd: HttpCommand, io: Io): Promise<number> {
  const { key } = resolveKeyAndConfig(cmd.config, cmd.url, io);
  const body = cmd.bodyFromStdin ? new TextEncoder().encode(await io.stdin()) : null;

  const headers = new Headers();
  try {
    for (const [name, value] of cmd.headers) headers.set(name, value);
  } catch (err) {
    // parseHeader validates the field name already; this catches anything
    // Headers rejects that the regex does not, and keeps it exit 1 (a typo on
    // the command line) rather than exit 2 (a transport fault).
    throw new UsageError(`-H rejected by the HTTP layer: ${messageOf(err)}`);
  }
  // Set last so no `-H` can shadow it (parseHeader already refuses, belt and
  // braces). `body` is passed explicitly: buildAuthEvent adds the `payload`
  // tag iff the body is non-empty, which is the rule the hub verifies.
  headers.set(
    "authorization",
    signAuthHeader(key.sk, buildAuthEvent({ url: cmd.url, method: cmd.method, body })),
  );

  let response: Response;
  try {
    response = await fetch(cmd.url, {
      method: cmd.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(cmd.timeout),
    });
  } catch (err) {
    // A server that accepts the connection and never answers is indisting-
    // uishable from a hang without this; report it as a timeout, not as a
    // generic fetch failure.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why = timedOut ? new TimeoutError(cmd.timeout).message : messageOf(err);
    io.err(`http: ${cmd.method} ${cmd.url}: ${why}`);
    return EXIT.transport;
  }

  io.err(`< ${response.status} ${response.statusText}`.trimEnd());
  for (const [name, value] of response.headers) io.err(`< ${name}: ${value}`);
  io.out(new Uint8Array(await response.arrayBuffer()));

  if (isAuthStatus(response.status)) return EXIT.auth;
  // >= 300, not just >= 400: redirects are not followed, so a 3xx is an
  // unfulfilled request with an empty body, not a success.
  return response.status >= 300 ? EXIT.transport : EXIT.ok;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Which of the three key sources actually supplied the key, as a LABEL.
 *
 * Mirrors `resolveKeySource` exactly (env file path beats config `keyFile`
 * beats the injected value). The label deliberately does NOT include the key
 * file's path: `doctor`'s report goes to stdout, which is not passed through
 * `redactSecrets`, and the classic first-run mistake is pasting an nsec into
 * `PARACHUTE_NSEC_FILE` where a path belongs — which would put the secret in
 * the "path" and then into the report.
 */
/**
 * Map a thrown value to this CLI's exit codes, given WHERE it came from.
 * Shared by `call`, `doctor` and `channel-context`: all three drive tool
 * calls and must tell "the tool said no" (4) apart from "the network is
 * down" (2).
 */
function classifyError(err: unknown, phase: "transport" | "tool"): number {
  // Auth first: a 401/403 is an auth failure whichever phase surfaced it.
  if (isAuthStatus(httpStatusOf(err))) return EXIT.auth;
  // A JSON-RPC error out of a tools/call is the TOOL failing (the hub reports
  // "vault not covered" / "not granted" / "not found" that way), not the
  // network.
  if (phase === "tool" && err instanceof McpError) return EXIT.toolError;
  return exitCodeForError(err);
}

function keySourceLabel(config: ResolvedConfig, env: NodeJS.ProcessEnv): string {
  if (env.PARACHUTE_NSEC_FILE) return "PARACHUTE_NSEC_FILE (a key file)";
  if (config.keyFile) return 'config "keyFile"';
  return "BUZZ_PRIVATE_KEY (injected nsec value)";
}

/**
 * Ask the hub which vault backs `(relay, channel)`, over the SAME NIP-98
 * signing path every other hub call in this package uses.
 *
 * The `fetch` is freshly signing per request (`makeSigningFetch`), because the
 * hub burns event ids even on failed auth — a re-sent Authorization header is
 * a rejected one.
 */
function channelVaultLookup(
  hub: HubEntry,
  key: LoadedKey,
  timeoutMs: number,
): (target: { relayHost: string; channelId: string }) => Promise<ChannelVaultLookup> {
  return async (target) =>
    await lookupChannelVault({
      hubUrl: hub.url,
      relayHost: target.relayHost,
      channelId: target.channelId,
      fetch: makeSigningFetch(key.sk),
      timeoutMs,
    });
}

/**
 * Wire the real config, key, MCP session and clock into the step runner in
 * doctor.ts. Everything here is plumbing; the policy — what a step means, when
 * it skips, what the probe writes — lives there and is unit-tested against a
 * fake hub.
 *
 * `doctor` targets exactly ONE hub. With several configured and no `--hub`,
 * the hub step FAILs with a usage error naming the aliases rather than
 * silently picking one: "prove I have access" has to name which door it
 * proved.
 */
async function runDoctorCommand(cmd: DoctorCommand, io: Io): Promise<number> {
  const env = io.env ?? process.env;
  let resolved: Resolved | undefined;
  const resolveOnce = (): Resolved => {
    resolved ??= resolveKeyAndConfig(
      cmd.config,
      cmd.hub !== undefined && hubFlagIsUrl(cmd.hub) ? cmd.hub : undefined,
      io,
    );
    return resolved;
  };

  const soleDoctorHub = (): HubEntry => {
    const { config } = resolveOnce();
    const hubs = targetHubs(config, cmd.hub);
    const only = hubs[0];
    if (hubs.length !== 1 || !only) {
      throw new UsageError(
        `doctor checks one hub at a time — pass --hub <alias|url> (configured: ${config.hubs
          .map((h) => h.alias)
          .join(", ")})`,
      );
    }
    return only;
  };

  const deps: DoctorDeps = {
    version: PARACHUTE_MCP_VERSION,
    now: () => new Date(),
    resolveKey: () => {
      const { config, key } = resolveOnce();
      return { npub: key.npub, source: keySourceLabel(config, env) };
    },
    resolveHub: soleDoctorHub,
    openSession: async (hub): Promise<DoctorSession> =>
      await HubSession.open(hub, makeSigningFetch(resolveOnce().key.sk), cmd.timeout),
    classify: classifyError,
    // The `channel` step's two injected halves. `deriveTarget` throws a
    // UsageError naming the missing flag; the step reports that verbatim as
    // its SKIP reason, which is exactly the "how do I make this run?" line an
    // operator needs.
    channelTarget: () => {
      try {
        const target = deriveTarget(
          {
            ...(cmd.relay !== undefined ? { relay: cmd.relay } : {}),
            ...(cmd.channel !== undefined ? { channel: cmd.channel } : {}),
          },
          env,
          "doctor",
        );
        return { ok: true, target: { relayHost: target.relayHost, channelId: target.channelId } };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      }
    },
    lookupChannelVault: async (target) =>
      await channelVaultLookup(soleDoctorHub(), resolveOnce().key, cmd.timeout)(target),
  };

  const report: DoctorReport = await runDoctor(
    cmd.vault !== undefined ? { vault: cmd.vault } : {},
    deps,
  );
  // The report IS the output, so it goes to stdout — same reasoning as
  // `--version`. Nothing here can carry key material (see `keySourceLabel`).
  io.out(cmd.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  return report.exitCode;
}

// ---------------------------------------------------------------------------
// channel-context
// ---------------------------------------------------------------------------

/**
 * The ONE hub a single-target subcommand talks to. With several configured and
 * no `--hub` this refuses rather than picking one — an append that silently
 * landed in the wrong hub's vault is worse than an error.
 */
function soleHub(config: ResolvedConfig, hubFlag: string | undefined, what: string): HubEntry {
  const hubs = targetHubs(config, hubFlag);
  const only = hubs[0];
  if (hubs.length !== 1 || !only) {
    throw new UsageError(
      `${what} targets one hub at a time — pass --hub <alias|url> (configured: ${config.hubs
        .map((h) => h.alias)
        .join(", ")})`,
    );
  }
  return only;
}

/**
 * Wire the real config, key and MCP session into the channel-context runner in
 * channel.ts. Plumbing only; the policy — path derivation, the tail window,
 * the create-then-append retry, `path_conflict` as success — lives there and
 * is unit-tested against a fake hub.
 */
async function runChannelContextCommand(cmd: ChannelContextCommand, io: Io): Promise<number> {
  const { config, key } = resolveKeyAndConfig(
    cmd.config,
    cmd.hub !== undefined && hubFlagIsUrl(cmd.hub) ? cmd.hub : undefined,
    io,
  );
  const hub = soleHub(config, cmd.hub, "channel-context");

  const result: ChannelResult = await runChannelContext(
    {
      action: cmd.action,
      tail: cmd.tail,
      ...(cmd.vault !== undefined ? { vault: cmd.vault } : {}),
      ...(cmd.relay !== undefined ? { relay: cmd.relay } : {}),
      ...(cmd.channel !== undefined ? { channel: cmd.channel } : {}),
    },
    {
      env: io.env ?? process.env,
      openSession: async () => await HubSession.open(hub, makeSigningFetch(key.sk), cmd.timeout),
      resolveVault: channelVaultLookup(hub, key, cmd.timeout),
      // Tool phase only: a connect failure is thrown before the runner's
      // guarded region and is mapped by `runCli`.
      classify: (err) => classifyError(err, "tool"),
      readStdin: io.stdin,
    },
  );

  if (result.error !== undefined) io.err(`channel-context: ${result.error}`);
  // The human face prints the note's bytes verbatim, so a `--json` consumer
  // and a `read | tail` consumer see exactly what they asked for and nothing
  // else. A missing note prints nothing at all.
  const out = cmd.json ? `${JSON.stringify(result.json, null, 2)}\n` : result.text;
  if (out !== "") io.out(out);
  return result.exitCode;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Parse and run one subcommand, returning its exit code. Never throws: every
 * failure is reported on (redacted) stderr and mapped through `EXIT`.
 */
export async function runCli(argv: string[], rawIo: Io, usage: string): Promise<number> {
  const io: Io = { ...rawIo, err: (msg) => rawIo.err(redactSecrets(msg)) };
  try {
    const cmd = parseCommand(argv);
    switch (cmd.kind) {
      case "help":
        io.out(usage);
        return EXIT.ok;
      case "tools":
        return await runTools(cmd, io);
      case "call":
        return await runCall(cmd, io);
      case "http":
        return await runHttp(cmd, io);
      case "doctor":
        return await runDoctorCommand(cmd, io);
      case "channel-context":
        return await runChannelContextCommand(cmd, io);
    }
  } catch (err) {
    io.err(`parachute-mcp: ${messageOf(err)}`);
    return exitCodeForError(err);
  }
}
