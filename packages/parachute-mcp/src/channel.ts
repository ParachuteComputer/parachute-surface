/**
 * `parachute-mcp channel-context` — the shared, append-only memory a group of
 * agents on one Buzz channel keeps in a Parachute vault.
 *
 * WHY. Several agents (different harnesses, different keys) answer in the same
 * channel and each one starts its turn blind: it sees the relay's message tail
 * and nothing about what the others actually DID. The convention that fixes
 * that is one note per channel — `Channels/<relay-host>/<channel-uuid>` — that
 * every agent reads the tail of before acting and appends one entry to after.
 * It works because `append` is atomic in the vault, so concurrent turns cannot
 * clobber each other the way a read-modify-write of `content` would.
 *
 * That convention is three tool calls with fiddly arguments (a byte window
 * computed from the note's size; `create-note` on first use; `path_conflict`
 * meaning success, not failure), and every agent that hand-rolls it gets a
 * different corner wrong — usually the create/append race, which shows up as a
 * lost turn rather than as an error. This subcommand is the convention, once.
 *
 * EVERYTHING IS INJECTED (`ChannelDeps`), the same shape `doctor.ts` uses: no
 * config reading, no key loading, no MCP client, no `process.env`. commands.ts
 * wires the real ones; the unit tests hand it a fake hub, so the sequences
 * that matter (append → not found → init → append; `path_conflict`) are
 * testable without a network and without writing to anyone's vault. This
 * module holds the POLICY; commands.ts holds the plumbing.
 *
 * SECRET DISCIPLINE: nothing here ever sees the key, and no argument this
 * builds carries one. The entry text comes from STDIN, never argv — an entry
 * is prose an agent composed and has no business in a `ps` listing.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { EXIT, UsageError, messageOf } from "./exit.js";

/** The tag every channel-context note carries, per the vault-side runbook. */
export const CHANNEL_LOG_TAG = "channel-log";

/** Path prefix for every note this command will read or write. */
export const CHANNEL_PATH_PREFIX = "Channels/";

/** Default `--tail`: enough for a handful of entries, small enough to be free. */
export const DEFAULT_TAIL_BYTES = 8000;

/**
 * The vault's floor for `content_length`. A smaller `--tail` is still honoured
 * on OUR side (we ask for the minimum and the caller gets what the window
 * holds); asking for less would make `query-notes` reject the read outright.
 */
const MIN_CONTENT_LENGTH = 4;

const QUERY_NOTES_TOOL = "query-notes";
const CREATE_NOTE_TOOL = "create-note";
const UPDATE_NOTE_TOOL = "update-note";

export type ChannelAction = "read" | "append" | "init";

export interface ChannelOptions {
  action: ChannelAction;
  /** `--vault` — required for `append`/`init`, passed through on `read`. */
  vault?: string;
  /** `--relay` — defaults to `$BUZZ_RELAY_URL`. */
  relay?: string;
  /** `--channel` — defaults to `$BUZZ_CHANNEL_ID`. */
  channel?: string;
  /** `--tail`, in bytes. */
  tail: number;
}

/** The subset of an MCP session this command needs. HubSession implements it. */
export interface ChannelSession {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface ChannelDeps {
  openSession(): Promise<ChannelSession>;
  /**
   * Map a thrown value to an exit code. `phase` matters for the same reason it
   * does in `doctor`: a JSON-RPC error out of a `tools/call` is the tool
   * failing (4), not the network (2).
   */
  classify(err: unknown, phase: "transport" | "tool"): number;
  /** The entry text, for `append` only. Read before any session is opened. */
  readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
}

export interface ChannelResult {
  exitCode: number;
  /** stdout for the human face. May be empty (a missing note prints nothing). */
  text: string;
  /** stdout for `--json`. */
  json: Record<string, unknown>;
  /** One stderr line, when something failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

export interface ChannelTarget {
  /** The relay, scheme stripped and de-slashed — `buzz.unforced.org`. */
  relayHost: string;
  channelId: string;
  /** `Channels/<relay-host>/<channel-uuid>`. */
  path: string;
}

/**
 * `wss://buzz.unforced.org/` → `buzz.unforced.org`.
 *
 * Deliberately NOT `new URL(raw).host`: `$BUZZ_RELAY_URL` is set by hand in
 * plenty of places and a value the URL parser rejects would throw an error
 * carrying the FULL raw input (Node puts it on `error.input`) — the same trap
 * `normalizeHttpUrl` documents. A regex strip cannot throw and cannot echo.
 */
export function relayHostOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const stripped = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "");
  return stripped === "" ? undefined : stripped;
}

/**
 * A channel id becomes a PATH SEGMENT, so anything that could climb out of the
 * `Channels/` namespace is refused rather than normalized. A caller passing a
 * bad `--channel` should hear about it, not silently append to another note.
 */
function assertSegment(value: string, what: string): string {
  if (/[/\\]/.test(value) || value.includes("..") || /\s/.test(value)) {
    throw new UsageError(
      `channel-context: ${what} must be a single path segment (no slashes, "..", or whitespace)`,
    );
  }
  return value;
}

/**
 * Where this channel's context note lives. Both inputs may come from the
 * environment buzz-acp injects, which is what makes the command a one-liner
 * inside an agent turn: `parachute-mcp channel-context read --vault uni`.
 */
export function deriveTarget(
  opts: { relay?: string; channel?: string },
  env: NodeJS.ProcessEnv,
): ChannelTarget {
  const relayHost = relayHostOf(opts.relay ?? env.BUZZ_RELAY_URL);
  if (!relayHost) {
    throw new UsageError(
      "channel-context: needs a relay — pass --relay <wss-url> or set $BUZZ_RELAY_URL",
    );
  }
  const rawChannel = (opts.channel ?? env.BUZZ_CHANNEL_ID ?? "").trim();
  if (rawChannel === "") {
    throw new UsageError(
      "channel-context: needs a channel — pass --channel <uuid> or set $BUZZ_CHANNEL_ID",
    );
  }
  const channelId = assertSegment(rawChannel, "--channel");
  assertSegment(relayHost, "--relay host");
  return { relayHost, channelId, path: `${CHANNEL_PATH_PREFIX}${relayHost}/${channelId}` };
}

/**
 * The header a fresh channel note gets, verbatim from the vault-side runbook
 * "Channel context notes". It is the first thing every agent on the channel
 * reads, so it states the one rule that keeps concurrent turns safe.
 */
export function initialContent(target: ChannelTarget): string {
  // One long template on purpose: this string is byte-exact with the runbook's
  // header, and a concatenation invites an editor to "tidy" a space away.
  return `# ${target.channelId} — ${target.relayHost}\n\nShared, append-only channel context. One entry per agent turn. Read the tail before you act. Never rewrite; only \`append\`.\n`;
}

function initialSummary(target: ChannelTarget): string {
  return `Shared append-only context for Buzz channel ${target.channelId} on ${target.relayHost}. One entry per agent turn; read the tail before acting, append only.`;
}

/**
 * The byte window for the tail read. `content_offset` is aligned DOWN to a
 * codepoint boundary by the vault and slices end on one, so a window computed
 * in bytes is UTF-8 safe without this side counting characters.
 */
export function tailWindow(
  totalBytes: number,
  tail: number,
): { content_offset: number; content_length: number } {
  return {
    content_offset: Math.max(0, totalBytes - tail),
    content_length: Math.max(tail, MIN_CONTENT_LENGTH),
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// Result parsing — deliberately tolerant
// ---------------------------------------------------------------------------

/** The first text block of a result, whatever else rides alongside it. */
function anyText(result: CallToolResult): string {
  const content = result.content as Array<{ type?: string; text?: unknown }> | undefined;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function parseJsonBlock(result: CallToolResult): unknown {
  const text = anyText(result);
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface NoteView {
  content?: string;
  /** Full size of the note's content in BYTES, whatever slice came back. */
  totalBytes?: number;
  updatedAt?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function looksLikeNote(obj: Record<string, unknown>): boolean {
  const named = typeof obj.id === "string" || typeof obj.path === "string";
  const noteish =
    typeof obj.content === "string" ||
    typeof obj.updatedAt === "string" ||
    typeof obj.updated_at === "string" ||
    typeof obj.content_total_length === "number";
  return named && noteish;
}

/**
 * Pull the note out of whatever envelope the hub used.
 *
 * The hub's `query-notes` overlay wraps each vault's answer as
 * `{ vaults_queried, results: [{ vault, notes }] }`, `notes` is sometimes an
 * array and sometimes a bare object, and the vault's own note shape has
 * changed before. Walking for the first note-SHAPED object survives all of
 * that; the alternative — pinning one envelope — is a command that reports "no
 * such note" the day an envelope gains a field.
 */
export function extractNote(value: unknown): NoteView | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractNote(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  if (looksLikeNote(obj)) {
    const content = asString(obj.content);
    return {
      ...(content !== undefined ? { content } : {}),
      ...(() => {
        const total =
          asNumber(obj.content_total_length) ??
          asNumber(obj.byteSize) ??
          asNumber(obj.byte_size) ??
          (content !== undefined ? byteLength(content) : undefined);
        return total !== undefined ? { totalBytes: total } : {};
      })(),
      ...(() => {
        const updatedAt = asString(obj.updatedAt) ?? asString(obj.updated_at);
        return updatedAt !== undefined ? { updatedAt } : {};
      })(),
    };
  }
  for (const child of Object.values(obj)) {
    const found = extractNote(child);
    if (found) return found;
  }
  return undefined;
}

/** The first `updatedAt` / `updated_at` string anywhere in a result. */
export function findUpdatedAt(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUpdatedAt(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "updatedAt" || key === "updated_at") && typeof child === "string") return child;
    const found = findUpdatedAt(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * Does this tool error mean "no such note"? The vault says `not_found`; the
 * hub relays it as prose. Matched loosely on purpose — the cost of a miss is
 * an append that fails instead of creating the note.
 */
export function isNotFound(message: string): boolean {
  return /not[_\s-]?found/i.test(message) || /no such note/i.test(message);
}

/**
 * Does this tool error mean "someone else created it first"? That is the
 * SUCCESS case for `init`: two agents opening the same channel in the same
 * second both need to end up with the note existing and exit 0.
 */
export function isPathConflict(message: string): boolean {
  return /path[_\s-]?conflict/i.test(message) || /already exists/i.test(message);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** A tool that ran and said no. Carries the exit code it maps to. */
class ChannelFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/**
 * One `tools/call` with both failure shapes folded into one: the SDK THROWS
 * for a JSON-RPC error (how the hub reports "vault not covered" / "not
 * granted" / "not found") and RESOLVES with `isError: true` for a tool-level
 * failure. Both are the tool failing, not the network.
 */
async function call(
  session: ChannelSession,
  deps: ChannelDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  let result: CallToolResult;
  try {
    result = await session.callTool(name, args);
  } catch (err) {
    throw new ChannelFailure(`${name}: ${messageOf(err)}`, deps.classify(err, "tool"));
  }
  if (result.isError) {
    throw new ChannelFailure(
      `${name}: ${anyText(result) || "tool returned an error"}`,
      EXIT.toolError,
    );
  }
  return result;
}

/** `--vault` is optional only on the read path (query-notes fans out). */
function vaultArgs(vault: string | undefined): Record<string, unknown> {
  return vault === undefined ? {} : { vault };
}

async function readTail(
  session: ChannelSession,
  deps: ChannelDeps,
  target: ChannelTarget,
  opts: ChannelOptions,
): Promise<ChannelResult> {
  const base = { ...vaultArgs(opts.vault), id: target.path, include_content: true };
  // Ask for the HEAD window first. It costs one call instead of two for the
  // common case (a note smaller than the window is returned complete), and it
  // is the only way to learn `content_total_length` — which is what the tail
  // offset is computed from — without a second round trip anyway.
  let note: NoteView | undefined;
  try {
    const first = await call(session, deps, QUERY_NOTES_TOOL, {
      ...base,
      content_offset: 0,
      content_length: Math.max(opts.tail, MIN_CONTENT_LENGTH),
    });
    note = extractNote(parseJsonBlock(first));
  } catch (err) {
    // A vault that answers "not found" with an ERROR and one that answers with
    // an empty result set are the same fact. Both are exit 0 with no output:
    // "this channel has no context yet" is not a failure, and an agent that
    // branched on a non-zero exit here would refuse to start its first turn.
    if (err instanceof ChannelFailure && err.exitCode === EXIT.toolError && isNotFound(err.message))
      note = undefined;
    else throw err;
  }

  if (!note) {
    return {
      exitCode: EXIT.ok,
      text: "",
      json: { action: "read", path: target.path, exists: false },
    };
  }

  const totalBytes = note.totalBytes ?? byteLength(note.content ?? "");
  let content = note.content ?? "";
  let updatedAt = note.updatedAt;
  if (totalBytes > opts.tail) {
    const window = await call(session, deps, QUERY_NOTES_TOOL, {
      ...base,
      ...tailWindow(totalBytes, opts.tail),
    });
    const tail = extractNote(parseJsonBlock(window));
    content = tail?.content ?? content;
    updatedAt = tail?.updatedAt ?? updatedAt;
  }

  return {
    exitCode: EXIT.ok,
    // Printed EXACTLY as it came back, with no newline added: the point of
    // `--tail <bytes>` is that the caller gets those bytes.
    text: content,
    json: {
      action: "read",
      path: target.path,
      exists: true,
      byteSize: totalBytes,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      tailBytes: byteLength(content),
      content,
    },
  };
}

/** create-note, treating `path_conflict` as the success it is. */
async function createNote(
  session: ChannelSession,
  deps: ChannelDeps,
  target: ChannelTarget,
  vault: string,
): Promise<{ existed: boolean }> {
  try {
    await call(session, deps, CREATE_NOTE_TOOL, {
      vault,
      path: target.path,
      tags: [CHANNEL_LOG_TAG],
      metadata: {
        relay: target.relayHost,
        channel_id: target.channelId,
        summary: initialSummary(target),
      },
      content: initialContent(target),
    });
    return { existed: false };
  } catch (err) {
    if (
      err instanceof ChannelFailure &&
      err.exitCode === EXIT.toolError &&
      isPathConflict(err.message)
    ) {
      return { existed: true };
    }
    throw err;
  }
}

async function initChannel(
  session: ChannelSession,
  deps: ChannelDeps,
  target: ChannelTarget,
  vault: string,
): Promise<ChannelResult> {
  const { existed } = await createNote(session, deps, target, vault);
  return {
    exitCode: EXIT.ok,
    text: `${existed ? "exists" : "created"} ${target.path}\n`,
    json: {
      action: "init",
      path: target.path,
      ...(existed ? { existed: true } : { created: true }),
    },
  };
}

async function appendEntry(
  session: ChannelSession,
  deps: ChannelDeps,
  target: ChannelTarget,
  vault: string,
  entry: string,
): Promise<ChannelResult> {
  const args = { vault, id: target.path, append: entry };
  let created = false;
  let result: CallToolResult;
  try {
    result = await call(session, deps, UPDATE_NOTE_TOOL, args);
  } catch (err) {
    // First turn on a channel nobody has logged to yet. Create the note and
    // append again rather than making the caller run `init` by hand — an agent
    // mid-turn cannot branch on "was I first?" without another round trip, and
    // the retry is what makes two simultaneous first turns both land.
    if (
      !(err instanceof ChannelFailure && err.exitCode === EXIT.toolError && isNotFound(err.message))
    )
      throw err;
    await createNote(session, deps, target, vault);
    created = true;
    result = await call(session, deps, UPDATE_NOTE_TOOL, args);
  }
  const updatedAt = findUpdatedAt(parseJsonBlock(result));
  return {
    exitCode: EXIT.ok,
    text: `${updatedAt ?? "appended"}\n`,
    json: {
      action: "append",
      path: target.path,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      created,
    },
  };
}

/**
 * Normalize an entry: exactly one leading newline, so entries never run
 * together on one line whether or not the caller remembered.
 */
export function normalizeEntry(raw: string): string {
  if (raw.trim() === "") {
    throw new UsageError(
      "channel-context append: the entry comes from stdin and must not be empty " +
        "(e.g. `printf '...' | parachute-mcp channel-context append ...`)",
    );
  }
  return raw.startsWith("\n") ? raw : `\n${raw}`;
}

/**
 * Run one `channel-context` action. Throws `UsageError` for anything the
 * caller could fix on the command line (checked BEFORE a session is opened, so
 * a typo never costs a hub round trip); every other failure comes back as a
 * `ChannelResult` carrying the exit code.
 */
export async function runChannelContext(
  opts: ChannelOptions,
  deps: ChannelDeps,
): Promise<ChannelResult> {
  const target = deriveTarget(opts, deps.env);
  if (opts.action !== "read" && opts.vault === undefined) {
    throw new UsageError(
      `channel-context ${opts.action}: needs --vault <name> (the hub requires a vault on every ` +
        `tool except ${QUERY_NOTES_TOOL})`,
    );
  }
  const entry = opts.action === "append" ? normalizeEntry(await deps.readStdin()) : undefined;

  const session = await deps.openSession();
  try {
    switch (opts.action) {
      case "read":
        return await readTail(session, deps, target, opts);
      case "init":
        return await initChannel(session, deps, target, opts.vault as string);
      case "append":
        return await appendEntry(session, deps, target, opts.vault as string, entry as string);
    }
  } catch (err) {
    if (err instanceof ChannelFailure) {
      return {
        exitCode: err.exitCode,
        text: "",
        json: { action: opts.action, path: target.path, ok: false, error: err.message },
        error: err.message,
      };
    }
    throw err;
  } finally {
    await session.close().catch(() => {});
  }
}
