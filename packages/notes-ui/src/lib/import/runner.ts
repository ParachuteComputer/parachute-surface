import {
  type CreateNotePayload,
  VaultAuthError,
  type VaultClient,
  VaultConflictError,
  VaultTargetExistsError,
  VaultUnreachableError,
} from "@/lib/vault/client";
import type { ImportOutcome, ImportProgress, ParsedNote } from "./types";

/**
 * Note-creation tally returned by `runImport`. The full `ImportReport`
 * (which the apply orchestrator surfaces in the UI) extends this with the
 * attachment counts; `runImport` itself only touches notes.
 */
export interface NoteImportReport {
  created: number;
  skipped: number;
  errored: number;
  outcomes: ImportOutcome[];
}

/**
 * The maximum number of concurrent POST /api/notes calls we'll have in
 * flight against the vault during import. 5 was chosen as the highest
 * value that comfortably stays under the vault's per-IP rate budget
 * (vault has no formal rate limit today, but bun:sqlite serializes
 * writes — pushing concurrency higher just queues at the DB).
 *
 * Why not the batch endpoint? POST /api/notes accepts `{ notes: [...] }`
 * up to 500 per request, but vault wraps multi-item batches in a SQLite
 * transaction (vault#236 atomicity). One 409 inside a batch of 50 rolls
 * back all 50 — exactly what we *don't* want for friend-import where a
 * partial collision should land the rest. The concurrent single-item
 * path matches our skip-on-conflict semantics and is, at 5-way, fast
 * enough for the 500-note typical case (a few seconds end-to-end).
 *
 * Future: a `?continue_on_error=true` query on the batch endpoint would
 * make the runner trivial — track it as a vault enhancement if import
 * volume justifies.
 */
export const DEFAULT_CONCURRENCY = 5;

/**
 * One retry attempt for transient 5xx errors, with a small backoff. We
 * don't retry 401 (the VaultClient already handles refresh-and-retry
 * inside `request`) or 409 (those are routed to the "skipped" bucket).
 */
const RETRY_BACKOFF_MS = 500;

export interface RunImportOptions {
  client: VaultClient;
  notes: ParsedNote[];
  /** Concurrency override — defaults to `DEFAULT_CONCURRENCY`. */
  concurrency?: number;
  /**
   * Called after each note completes (any outcome). Used by the UI to
   * drive the progress bar. NOT called when nothing happened (empty
   * `notes` list — the caller knows that already).
   */
  onProgress?: (progress: ImportProgress) => void;
  /**
   * Abort signal — when fired, the runner finishes its in-flight
   * requests but doesn't start new ones. The returned report reflects
   * what landed plus a synthesized "errored" row for each aborted note.
   */
  signal?: AbortSignal;
}

/**
 * Run an import: POST each ParsedNote to the vault, classify outcomes,
 * return a per-note report. Never throws — partial success is the whole
 * point. A genuinely unrecoverable condition (auth dead) still produces
 * a report with every remaining note classified as "errored".
 */
export async function runImport(opts: RunImportOptions): Promise<NoteImportReport> {
  const { client, notes, onProgress, signal } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const outcomes: ImportOutcome[] = [];
  let nextIndex = 0;
  let done = 0;
  let authDead = false;

  // Pre-build payloads once so the workers don't recompute on every
  // dequeue. Mostly negligible, but the `id` / `createdAt` field
  // hoisting is conditional and slightly fiddly — keeping it in one
  // place reduces drift risk.
  const payloads: CreateNotePayload[] = notes.map(toCreatePayload);

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      if (authDead) return;
      const i = nextIndex++;
      if (i >= notes.length) return;
      const note = notes[i] as ParsedNote;
      const payload = payloads[i] as CreateNotePayload;
      const outcome = await runOne(client, note, payload, signal);
      outcomes[i] = outcome;
      done++;
      if (outcome.status === "errored" && outcome.reason.startsWith("auth:")) {
        // VaultClient's refresh-and-retry already failed; subsequent
        // workers can't recover. Mark the import dead and let the
        // remaining notes flush as errored below.
        authDead = true;
      }
      onProgress?.({ done, total: notes.length });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, notes.length) }, () => worker());
  await Promise.all(workers);

  // Fill any holes from auth-dead or abort with synthesized errored rows
  // so `outcomes.length === notes.length` always holds.
  for (let i = 0; i < notes.length; i++) {
    if (!outcomes[i]) {
      outcomes[i] = {
        status: "errored",
        sourcePath: (notes[i] as ParsedNote).sourcePath,
        reason: authDead
          ? "Skipped — vault session ended before this note was reached."
          : "Skipped — import was cancelled.",
      };
    }
  }

  let created = 0;
  let skipped = 0;
  let errored = 0;
  for (const o of outcomes) {
    if (o.status === "created") created++;
    else if (o.status === "skipped") skipped++;
    else errored++;
  }
  return { created, skipped, errored, outcomes };
}

async function runOne(
  client: VaultClient,
  note: ParsedNote,
  payload: CreateNotePayload,
  signal: AbortSignal | undefined,
): Promise<ImportOutcome> {
  try {
    const created = await postWithRetry(client, payload, signal);
    return { status: "created", sourcePath: note.sourcePath, noteId: created.id };
  } catch (err) {
    if (err instanceof VaultConflictError || err instanceof VaultTargetExistsError) {
      return {
        status: "skipped",
        sourcePath: note.sourcePath,
        reason: err.message || "Already exists in vault",
      };
    }
    if (err instanceof VaultAuthError) {
      return {
        status: "errored",
        sourcePath: note.sourcePath,
        reason: `auth: ${err.message}`,
      };
    }
    if (err instanceof VaultUnreachableError) {
      return {
        status: "errored",
        sourcePath: note.sourcePath,
        reason: `vault unreachable (${err.status}): ${err.message}`,
      };
    }
    return {
      status: "errored",
      sourcePath: note.sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function postWithRetry(
  client: VaultClient,
  payload: CreateNotePayload,
  signal: AbortSignal | undefined,
): Promise<{ id: string }> {
  const init: { signal?: AbortSignal } = {};
  if (signal) init.signal = signal;
  try {
    return await client.createNote(payload, init);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    if (signal?.aborted) throw err;
    await sleep(RETRY_BACKOFF_MS, signal);
    return await client.createNote(payload, init);
  }
}

function isRetryable(err: unknown): boolean {
  // Only retry transient-feeling errors. 4xx-other-than-409 is a
  // permanent classification problem (validation, scope mismatch);
  // 409 was already routed to "skipped" upstream. VaultClient maps 5xx
  // to VaultUnreachableError, so that's the bucket to retry.
  if (err instanceof VaultUnreachableError) return true;
  return false;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Translate a `ParsedNote` into the wire-level `CreateNotePayload`. The
 * subset that vault knows about: content, path, tags, metadata. We
 * fold `id` and `createdAt` into metadata as `_id` / `_createdAt`
 * convention is NOT used here — vault accepts `id` and `created_at` as
 * top-level fields on POST /api/notes (see vault's routes.ts), so we
 * pass them through directly via the runtime extension below.
 */
function toCreatePayload(note: ParsedNote): CreateNotePayload {
  const payload: CreateNotePayload = { content: note.content };
  if (note.path) payload.path = note.path;
  if (note.tags.length > 0) payload.tags = note.tags;
  if (Object.keys(note.metadata).length > 0) payload.metadata = note.metadata;
  // Vault's POST handler reads `id` and `created_at` off the body
  // directly (see vault's src/routes.ts line ~795 — `item.id`,
  // `item.createdAt ?? item.created_at`). `CreateNotePayload` is the
  // app-client's surface type and doesn't model those fields, but they
  // pass through harmlessly. Use an index-signature cast rather than
  // `any` to keep the noExplicitAny lint clean.
  const extended = payload as CreateNotePayload & {
    id?: string;
    created_at?: string;
  };
  if (note.id) extended.id = note.id;
  if (note.createdAt) extended.created_at = note.createdAt;
  return payload;
}
