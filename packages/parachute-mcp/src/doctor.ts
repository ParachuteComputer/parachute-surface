/**
 * `parachute-mcp doctor` — the one command that PROVES a harness has Parachute
 * access, end to end, and says exactly which link broke when it doesn't.
 *
 * WHY. Getting an agent onto a hub is four separate things that each fail
 * silently and look identical from the outside: the key never resolved; the
 * key resolved but the hub rejects the signature; the hub accepts the
 * signature but the grant covers no vault; the grant covers a vault but is
 * read-only. Before this, the first symptom of any of them was a tool call
 * failing somewhere deep in a turn, and the agent's own account of it (see the
 * README's exit-code table for why that matters) is not evidence. `doctor`
 * turns all four into one exit code and four PASS/FAIL lines.
 *
 * Exit 0 therefore means all four: a key resolved, the hub accepts its
 * signature, the grant reaches at least one vault, and (when there is one
 * vault to aim at) a note round-trips. A grant that reaches nothing exits 4.
 *
 * The steps run in dependency order and STOP at the first hard failure —
 * reporting "vaults: FAIL" when the key never loaded is noise, not diagnosis.
 * A step that cannot apply (no `list-vaults` tool; no single vault to write
 * to) is SKIP, which is not a failure and does not change the exit code.
 *
 * EVERYTHING IS INJECTED (`DoctorDeps`). No config reading, no key loading, no
 * MCP client, no clock: commands.ts wires the real ones, and the unit tests
 * hand it a fake hub so the whole step machine — including the failure and
 * cleanup paths, which a live hub will not reproduce on demand — is testable
 * without a network. This module holds the POLICY; commands.ts holds the
 * plumbing.
 *
 * SECRET DISCIPLINE, as everywhere in this package: the key is never seen
 * here. `resolveKey()` hands back an npub and a source LABEL, and that is the
 * only key-shaped thing that reaches a report, a log or a note path.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { EXIT, UsageError, messageOf } from "./exit.js";

/**
 * The key-resolution order, verbatim from `config.ts` `resolveKeySource`. It is
 * printed on the key step's FAIL because "no key" is the single most common
 * first-run failure and the fix is always "set one of these three".
 */
export const KEY_RESOLUTION_ORDER =
  'PARACHUTE_NSEC_FILE (a key file path) → config "keyFile" → ' +
  "BUZZ_PRIVATE_KEY (an nsec value, injected by buzz-acp)";

/** Hub-native tool that lists the vaults a connection can reach. */
const LIST_VAULTS_TOOL = "list-vaults";
const CREATE_NOTE_TOOL = "create-note";
const READ_NOTES_TOOL = "query-notes";
const DELETE_NOTE_TOOL = "delete-note";
const UPDATE_NOTE_TOOL = "update-note";

/**
 * The ONLY path prefix `doctor` will ever write to. Asserted immediately
 * before the create AND before the delete: a probe that wrote to, or worse
 * deleted, a real note because a name got composed wrong would be a far larger
 * failure than the one it was diagnosing.
 *
 * NOT `.parachute/` — that is the vault's own metadata namespace, and the
 * vault treats a commit touching only `.parachute/` as metadata-only and skips
 * it (parachute-vault `shouldCommit`, reason `parachute_meta_only`). A probe
 * filed there would be invisible to the export/commit path it rides on, which
 * is the opposite of what a diagnostic wants.
 */
export const PROBE_PATH_PREFIX = ".doctor/";

export type StepName = "key" | "hub" | "vaults" | "write";
export type StepStatus = "pass" | "fail" | "skip";

export interface DoctorStep {
  step: StepName;
  status: StepStatus;
  /** One line, human-first. Never contains key material. */
  reason: string;
  /** Machine-readable extras for `--json`. Never contains key material. */
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  exitCode: number;
  version: string;
  npub?: string;
  hub?: { alias: string; url: string };
  steps: DoctorStep[];
  /** The one line a human reads first. */
  summary: string;
}

/** The subset of an MCP session `doctor` needs. Implemented over the SDK. */
export interface DoctorSession {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** `serverInfo` from `initialize`, when the hub sent one. */
  serverInfo(): { name?: string; version?: string } | undefined;
  close(): Promise<void>;
}

export interface DoctorHub {
  alias: string;
  url: string;
}

export interface DoctorDeps {
  /** Config + key resolution. Throws `UsageError` when there is no key. */
  resolveKey(): { npub: string; source: string };
  /** The ONE hub this run targets. Throws `UsageError` when it is ambiguous. */
  resolveHub(): DoctorHub;
  openSession(hub: DoctorHub): Promise<DoctorSession>;
  /**
   * Map a thrown value to an exit code. `phase` matters: the same JSON-RPC
   * error is a tool error (4) when it came out of a `tools/call` and a
   * transport failure (2) when it came out of the connect.
   */
  classify(err: unknown, phase: "transport" | "tool"): number;
  now(): Date;
  version: string;
}

export interface DoctorOptions {
  /** `--vault <name>`: force the write round-trip against this vault. */
  vault?: string;
}

// ---------------------------------------------------------------------------
// Result parsing — deliberately tolerant
// ---------------------------------------------------------------------------

/** Text of a result that is exactly one text block, else undefined. */
function singleTextBlock(result: CallToolResult): string | undefined {
  const content = result.content as Array<{ type?: string; text?: unknown }> | undefined;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0];
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

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
  const text = singleTextBlock(result);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface VaultListing {
  names: string[];
  /** `"all"` = the grant covers every vault on the hub; `"listed"` = a subset. */
  covered?: string;
}

/**
 * Pull vault names out of a `list-vaults` result.
 *
 * The hub answers `{ covered, vaults: [{ name, url, version }] }`, but this
 * accepts a bare array and an array of plain strings too. The cost of being
 * strict here is a doctor that reports FAIL against a hub that is working
 * fine — the exact false negative this command exists to eliminate.
 */
export function parseVaultListing(result: CallToolResult): VaultListing | undefined {
  const parsed = parseJsonBlock(result);
  if (parsed === undefined || parsed === null) return undefined;
  const raw = Array.isArray(parsed) ? parsed : (parsed as { vaults?: unknown }).vaults;
  if (!Array.isArray(raw)) return undefined;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") names.push(entry);
    else if (entry && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string") names.push(name);
    }
  }
  const covered = !Array.isArray(parsed) ? (parsed as { covered?: unknown }).covered : undefined;
  return { names, ...(typeof covered === "string" ? { covered } : {}) };
}

/**
 * Every string under a `content` key, anywhere in the value.
 *
 * The read-back travels through two envelopes that are not this package's to
 * pin: the hub's `query-notes` overlay wraps each vault's answer as
 * `{ vaults_queried, results: [{ vault, notes }] }`, and the vault's own note
 * shape has changed before. Walking for `content` survives both, and the
 * assertion stays exact — the probe's content string must be present, byte for
 * byte, or the step FAILs.
 */
export function collectContentStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectContentStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "content" && typeof child === "string") out.push(child);
      else collectContentStrings(child, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The probe note
// ---------------------------------------------------------------------------

/** `20260902T041500Z` — sortable, filename-safe, no colons. */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * Where the write round-trip writes. Namespaced by the CALLER's npub prefix as
 * well as the time, so two agents doctoring the same vault in the same second
 * cannot collide on one path and read back each other's probe.
 */
export function probePath(npub: string, now: Date): string {
  return `${PROBE_PATH_PREFIX}${npub.slice(0, 12)}-${stamp(now)}`;
}

export function probeContent(now: Date): string {
  return `parachute-mcp doctor probe ${now.toISOString()}`;
}

/** Refuse to touch anything outside the probe namespace. */
function assertProbePath(path: string): void {
  if (!path.startsWith(PROBE_PATH_PREFIX) || path.includes("..")) {
    throw new UsageError(`refusing to touch "${path}": doctor only writes ${PROBE_PATH_PREFIX}*`);
  }
}

// ---------------------------------------------------------------------------
// The step runner
// ---------------------------------------------------------------------------

class StepFailure extends Error {
  constructor(
    readonly step: DoctorStep,
    readonly exitCode: number,
  ) {
    super(step.reason);
  }
}

function pass(step: StepName, reason: string, details?: Record<string, unknown>): DoctorStep {
  return { step, status: "pass", reason, ...(details ? { details } : {}) };
}

function skip(step: StepName, reason: string): DoctorStep {
  return { step, status: "skip", reason };
}

function fail(
  step: StepName,
  reason: string,
  exitCode: number,
  details?: Record<string, unknown>,
): StepFailure {
  return new StepFailure(
    { step, status: "fail", reason, ...(details ? { details } : {}) },
    exitCode,
  );
}

/**
 * One `tools/call`, with both failure shapes folded into one: the SDK THROWS
 * for a JSON-RPC error (which is how the hub reports `AccountToolError` —
 * "vault not covered", "not granted") and RESOLVES with `isError: true` for a
 * tool-level failure. Both are exit 4, and neither should read as "the network
 * is down".
 */
async function callOrFail(
  session: DoctorSession,
  deps: DoctorDeps,
  step: StepName,
  name: string,
  args: Record<string, unknown>,
  /**
   * Carried onto the FAILURE, not just the pass. For the write probe this is
   * `{ vault, path }`, so a `--json` consumer whose create timed out can find
   * the note that may have been left behind without parsing the reason string.
   */
  details?: Record<string, unknown>,
): Promise<CallToolResult> {
  let result: CallToolResult;
  try {
    result = await session.callTool(name, args);
  } catch (err) {
    throw fail(step, `${name}: ${messageOf(err)}`, deps.classify(err, "tool"), details);
  }
  if (result.isError) {
    throw fail(
      step,
      `${name}: ${anyText(result) || "tool returned an error"}`,
      EXIT.toolError,
      details,
    );
  }
  return result;
}

/**
 * Run the checks and return the report. NEVER throws: every failure becomes a
 * FAIL step plus an exit code, because a doctor that crashes has diagnosed
 * nothing.
 */
export async function runDoctor(opts: DoctorOptions, deps: DoctorDeps): Promise<DoctorReport> {
  const steps: DoctorStep[] = [];
  let npub: string | undefined;
  let hub: DoctorHub | undefined;
  let session: DoctorSession | undefined;

  try {
    // --- key ---------------------------------------------------------------
    let key: { npub: string; source: string };
    try {
      key = deps.resolveKey();
    } catch (err) {
      throw fail(
        "key",
        `${messageOf(err)} — resolution order: ${KEY_RESOLUTION_ORDER}`,
        EXIT.usage,
      );
    }
    npub = key.npub;
    steps.push(
      pass("key", `signing as ${key.npub} (from ${key.source})`, {
        npub: key.npub,
        source: key.source,
      }),
    );

    // --- hub ---------------------------------------------------------------
    try {
      hub = deps.resolveHub();
    } catch (err) {
      throw fail("hub", messageOf(err), EXIT.usage);
    }
    let tools: Tool[];
    try {
      session = await deps.openSession(hub);
      tools = await session.listTools();
    } catch (err) {
      throw fail("hub", `${hub.url}: ${messageOf(err)}`, deps.classify(err, "transport"));
    }
    const info = session.serverInfo();
    const server = info?.name
      ? ` — server ${info.name}${info.version ? ` ${info.version}` : ""}`
      : "";
    steps.push(
      pass("hub", `${hub.url}: initialize + tools/list ok, ${tools.length} tools${server}`, {
        url: hub.url,
        alias: hub.alias,
        toolCount: tools.length,
        ...(info?.name ? { serverName: info.name } : {}),
        ...(info?.version ? { serverVersion: info.version } : {}),
      }),
    );

    // --- vaults ------------------------------------------------------------
    const has = (name: string) => tools.some((t) => t.name === name);
    let listing: VaultListing | undefined;
    if (!has(LIST_VAULTS_TOOL)) {
      steps.push(
        skip(
          "vaults",
          `hub exposes no "${LIST_VAULTS_TOOL}" tool — this door is not a hub account door`,
        ),
      );
    } else {
      const result = await callOrFail(session, deps, "vaults", LIST_VAULTS_TOOL, {});
      listing = parseVaultListing(result);
      if (!listing) {
        throw fail(
          "vaults",
          `${LIST_VAULTS_TOOL} returned a shape this build does not understand`,
          EXIT.toolError,
        );
      }
      // Zero vaults is a FAILURE, not a pass with a caveat. Exit 0 is
      // documented to mean "the grant reaches a vault and a write round-trips";
      // a key that authenticates and can reach nothing has not got working
      // access, and reporting PASS here would make `doctor` agree with the
      // exact confusion it exists to remove. Exit 4 — the hub is fine, the
      // grant is not.
      if (listing.names.length === 0) {
        throw fail(
          "vaults",
          "0 vaults reachable — the key authenticates but holds no vault grant; " +
            "ask a hub admin for a grant (grant-access) on this npub",
          EXIT.toolError,
          { vaults: [], ...(listing.covered ? { covered: listing.covered } : {}) },
        );
      }
      const scope =
        listing.covered === "all"
          ? "grant covers ALL vaults on this hub"
          : listing.covered === "listed"
            ? "grant covers this listed subset"
            : "access level not reported by this hub";
      steps.push(
        pass(
          "vaults",
          `${listing.names.length} reachable: ${listing.names.join(", ")} (${scope})`,
          {
            vaults: listing.names,
            ...(listing.covered ? { covered: listing.covered } : {}),
          },
        ),
      );
    }

    // --- write round-trip --------------------------------------------------
    const target =
      opts.vault ?? (listing && listing.names.length === 1 ? listing.names[0] : undefined);
    if (!target) {
      steps.push(
        skip(
          "write",
          listing === undefined
            ? "no vault listing and no --vault <name> — nothing to write to"
            : `${listing.names.length} vaults reachable — pass --vault <name> to test a write`,
        ),
      );
    } else if (!has(CREATE_NOTE_TOOL) || !has(READ_NOTES_TOOL)) {
      steps.push(
        skip("write", `hub exposes no "${CREATE_NOTE_TOOL}"/"${READ_NOTES_TOOL}" pair to probe`),
      );
    } else {
      steps.push(await writeRoundTrip(session, deps, target, npub, has));
    }
  } catch (err) {
    if (err instanceof StepFailure) {
      steps.push(err.step);
      return finish(steps, err.exitCode, deps.version, npub, hub);
    }
    // Defensive: nothing above should throw anything else, but a doctor that
    // dies with a stack trace has diagnosed nothing.
    steps.push({ step: "hub", status: "fail", reason: messageOf(err) });
    return finish(steps, EXIT.transport, deps.version, npub, hub);
  } finally {
    await session?.close().catch(() => {});
  }

  return finish(steps, EXIT.ok, deps.version, npub, hub);
}

/**
 * Create → read back byte-exact → remove. The cleanup runs even when the read
 * back fails, so a failed probe does not leave litter in someone's vault.
 */
async function writeRoundTrip(
  session: DoctorSession,
  deps: DoctorDeps,
  vault: string,
  npub: string,
  has: (name: string) => boolean,
): Promise<DoctorStep> {
  const now = deps.now();
  const path = probePath(npub, now);
  const content = probeContent(now);
  assertProbePath(path);

  try {
    await callOrFail(
      session,
      deps,
      "write",
      CREATE_NOTE_TOOL,
      { vault, path, content },
      { vault, path },
    );
  } catch (err) {
    // A REFUSAL (exit 4 — "read-only grant", "vault not covered") means the hub
    // decided not to write: there is nothing to sweep, and a delete against a
    // read-only grant would only add a second, misleading error.
    //
    // A TIMEOUT or transport failure is an UNKNOWN, not a no. The hub may have
    // committed the note and lost the answer, which fails the step with the
    // probe still sitting in the vault — exactly the litter this command must
    // not leave. Sweep the path; `removeProbe` re-asserts the namespace, and
    // deleting something that was never written is harmless.
    if (err instanceof StepFailure && err.exitCode !== EXIT.toolError) {
      await removeProbe(session, deps, vault, path, has);
    }
    throw err;
  }

  let cleanup = "";
  try {
    const read = await callOrFail(session, deps, "write", READ_NOTES_TOOL, {
      vault,
      id: path,
      include_content: true,
    });
    const parsed = parseJsonBlock(read);
    const found = parsed === undefined ? [] : collectContentStrings(parsed);
    if (!found.includes(content)) {
      throw fail(
        "write",
        parsed === undefined
          ? `wrote ${vault}:${path} but the read-back was not a JSON result this build can check`
          : `wrote ${vault}:${path} but the read-back did not return it byte-exact`,
        EXIT.toolError,
        { vault, path },
      );
    }
  } finally {
    cleanup = await removeProbe(session, deps, vault, path, has);
  }

  return pass("write", `${vault}: created, read back byte-exact, ${cleanup} — ${path}`, {
    vault,
    path,
    cleanup,
  });
}

/**
 * Remove the probe note, or — when the door exposes no delete — LABEL it and
 * say so, loudly, in the step's reason. Never fails the command: the write
 * round-trip has already answered the question by this point, and a tidy-up
 * error would report "write: FAIL" for a write that plainly worked.
 */
async function removeProbe(
  session: DoctorSession,
  deps: DoctorDeps,
  vault: string,
  path: string,
  has: (name: string) => boolean,
): Promise<string> {
  assertProbePath(path);
  if (has(DELETE_NOTE_TOOL)) {
    try {
      await callOrFail(session, deps, "write", DELETE_NOTE_TOOL, { vault, id: path });
      return "deleted";
    } catch (err) {
      return `NOT deleted (${messageOf(err)}) — remove ${path} by hand`;
    }
  }
  if (has(UPDATE_NOTE_TOOL)) {
    try {
      await callOrFail(session, deps, "write", UPDATE_NOTE_TOOL, {
        vault,
        id: path,
        content: "parachute-mcp doctor probe, safe to delete",
      });
      return `NOT deleted (this hub exposes no "${DELETE_NOTE_TOOL}") — marked "safe to delete"`;
    } catch {
      return `NOT deleted (no "${DELETE_NOTE_TOOL}" tool) — remove ${path} by hand`;
    }
  }
  return `NOT deleted (no "${DELETE_NOTE_TOOL}" or "${UPDATE_NOTE_TOOL}" tool) — remove ${path} by hand`;
}

const ORDER: StepName[] = ["key", "hub", "vaults", "write"];

function finish(
  steps: DoctorStep[],
  exitCode: number,
  version: string,
  npub: string | undefined,
  hub: DoctorHub | undefined,
): DoctorReport {
  const ok = exitCode === EXIT.ok;
  const failed = steps.find((s) => s.status === "fail");
  const passed = steps.filter((s) => s.status === "pass").length;
  const skipped = steps.filter((s) => s.status === "skip").length;
  const summary = failed
    ? `FAIL at ${failed.step}: ${failed.reason} (exit ${exitCode})`
    : `PASS — ${passed}/${ORDER.length} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`;
  return {
    ok,
    exitCode,
    version,
    ...(npub ? { npub } : {}),
    ...(hub ? { hub } : {}),
    steps,
    summary,
  };
}

/** Human-readable render: one aligned line per step, then the summary. */
export function renderReport(report: DoctorReport): string {
  const lines = report.steps.map(
    (s) => `${s.status.toUpperCase().padEnd(4)}  ${s.step.padEnd(6)}  ${s.reason}`,
  );
  lines.push("", report.summary);
  return `${lines.join("\n")}\n`;
}
