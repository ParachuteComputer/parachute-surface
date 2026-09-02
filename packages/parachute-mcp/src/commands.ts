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
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type HubEntry, type ResolvedConfig, resolveConfig } from "./config.js";
import { type LoadedKey, loadKey, loadKeyValue } from "./key.js";
import { buildAuthEvent, signAuthHeader } from "./nip98.js";
import { makeSigningFetch } from "./signing-fetch.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

/**
 * Exit codes. Agents branch on these, so they are part of the contract and
 * are documented in `--help` and the README.
 */
export const EXIT = {
  ok: 0,
  /** Bad arguments, bad config, no key, unknown hub/tool name. */
  usage: 1,
  /** Could not reach the hub, or an HTTP >= 400 that is not an auth failure. */
  transport: 2,
  /** The hub rejected the signature or the key (HTTP 401 / 403). */
  auth: 3,
  /** The tool ran and returned `isError: true`. */
  toolError: 4,
} as const;

export const SUBCOMMANDS = ["tools", "call", "http"] as const;
export type SubcommandName = (typeof SUBCOMMANDS)[number];

export function isSubcommand(arg: string | undefined): arg is SubcommandName {
  return arg !== undefined && (SUBCOMMANDS as readonly string[]).includes(arg);
}

/** Anything the user could fix by typing a different command line. Exit 1. */
export class UsageError extends Error {}

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
}

export interface HttpCommand {
  kind: "http";
  config?: string;
  method: string;
  /** Normalized (`new URL(...).href`) — the NIP-98 `u` tag must be exact. */
  url: string;
  headers: Array<[string, string]>;
  bodyFromStdin: boolean;
}

export interface HelpCommand {
  kind: "help";
}

export type Command = ToolsCommand | CallCommand | HttpCommand | HelpCommand;

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

function parseHeader(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx <= 0) throw new UsageError(`-H expects "Name: value", got "${raw}"`);
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (name === "") throw new UsageError(`-H expects "Name: value", got "${raw}"`);
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
    default:
      throw new UsageError(`unknown subcommand "${String(name)}"`);
  }
}

function parseTools(argv: string[]): ToolsCommand {
  const cmd: ToolsCommand = { kind: "tools", table: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--table") cmd.table = true;
    else if (isFlag(arg, "--config")) [cmd.config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [cmd.hub, i] = takeValue(argv, i, "--hub");
    else if (arg.startsWith("-")) throw new UsageError(`tools: unknown flag ${arg}`);
    else throw new UsageError(`tools: unexpected argument "${arg}" (tools takes no positionals)`);
  }
  return cmd;
}

function parseCall(argv: string[]): CallCommand {
  let tool: string | undefined;
  let literal: string | undefined;
  let fromStdin = false;
  let config: string | undefined;
  let hub: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (isFlag(arg, "--config")) [config, i] = takeValue(argv, i, "--config");
    else if (isFlag(arg, "--hub")) [hub, i] = takeValue(argv, i, "--hub");
    else if (isFlag(arg, "--args")) {
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
  return { kind: "call", tool, args, config, hub };
}

const METHOD_RE = /^[A-Za-z]+$/;

function parseHttp(argv: string[]): HttpCommand {
  let method: string | undefined;
  let url: string | undefined;
  let config: string | undefined;
  let bodyFromStdin = false;
  const headers: Array<[string, string]> = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (isFlag(arg, "--config")) [config, i] = takeValue(argv, i, "--config");
    else if (arg === "-H" || isFlag(arg, "--header")) {
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
  ) {}

  static async open(hub: HubEntry, signingFetch: FetchLike): Promise<HubSession> {
    const client = new Client({ name: "parachute-mcp", version: PARACHUTE_MCP_VERSION });
    const transport = new StreamableHTTPClientTransport(new URL(hub.url), { fetch: signingFetch });
    try {
      await client.connect(transport);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return new HubSession(client, transport);
  }

  async listTools(): Promise<Tool[]> {
    return (await this.client.listTools()).tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** DELETE the session (when the hub issued one), then drop the transport. */
  async close(): Promise<void> {
    await this.transport.terminateSession().catch(() => {});
    await this.client.close().catch(() => {});
  }
}

/** HTTP status behind a transport error, if it carries one. */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError && typeof err.code === "number") return err.code;
  // Fallback for SDK paths that surface the status only in the message.
  const match = /\bHTTP (\d{3})\b/.exec(err instanceof Error ? err.message : "");
  return match ? Number(match[1]) : undefined;
}

function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** Map any thrown value to this CLI's exit-code contract. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return EXIT.usage;
  return isAuthStatus(httpStatusOf(err)) ? EXIT.auth : EXIT.transport;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      session = await HubSession.open(hub, signingFetch);
      for (const tool of await session.listTools()) {
        listed.push({
          name: namespaced ? `${hub.alias}${NAMESPACE_SEP}${tool.name}` : tool.name,
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

  io.out(cmd.table ? renderTable(listed) : `${JSON.stringify(listed, null, 2)}\n`);
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

  let session: HubSession | undefined;
  try {
    session = await HubSession.open(hub, makeSigningFetch(key.sk));
    const result = await session.callTool(toolName, args);
    const text = singleTextBlock(result);
    if (result.isError) {
      io.err(text ?? JSON.stringify(result, null, 2));
      return EXIT.toolError;
    }
    io.out(text !== undefined ? withNewline(text) : `${JSON.stringify(result, null, 2)}\n`);
    return EXIT.ok;
  } finally {
    await session?.close();
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
 * hub would reject it. A 3xx is reported as-is, like `curl` without `-L`.
 */
async function runHttp(cmd: HttpCommand, io: Io): Promise<number> {
  const { key } = resolveKeyAndConfig(cmd.config, cmd.url, io);
  const body = cmd.bodyFromStdin ? new TextEncoder().encode(await io.stdin()) : null;

  const headers = new Headers();
  for (const [name, value] of cmd.headers) headers.set(name, value);
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
    });
  } catch (err) {
    io.err(`http: ${cmd.method} ${cmd.url}: ${messageOf(err)}`);
    return EXIT.transport;
  }

  io.err(`< ${response.status} ${response.statusText}`.trimEnd());
  for (const [name, value] of response.headers) io.err(`< ${name}: ${value}`);
  io.out(new Uint8Array(await response.arrayBuffer()));

  if (isAuthStatus(response.status)) return EXIT.auth;
  return response.status >= 400 ? EXIT.transport : EXIT.ok;
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
    }
  } catch (err) {
    io.err(`parachute-mcp: ${messageOf(err)}`);
    return exitCodeForError(err);
  }
}
