/**
 * createVaultReconciler — the corrected reconciliation state machine
 * (surface-runtime design P10, trust decision §9) between a surface's live
 * Y.Docs and their backing vault notes.
 *
 * Prism's load-bearing rules, KEPT:
 *
 *   - **documentName = note id.** One Y.Doc per note; the note id is the
 *     routing key end to end.
 *   - **Vault-as-source-of-truth.** The Y.Doc is a working surface over the
 *     note; the note (markdown-canonical, §8) is what persists, syncs, and
 *     is visible to agents.
 *   - **External-edit-WINS.** An edit that reached the vault from anywhere
 *     else (agent, sync job, sibling surface, the operator's own Notes app)
 *     beats unwritten local CRDT state — the doc is re-seeded from the
 *     winner, never the other way round.
 *   - **Populated re-seed guard.** A doc that already carries CRDT state is
 *     NEVER seeded over on load — seeding into a populated doc duplicates
 *     content (the classic double-seed bug).
 *
 * Prism's two bug paths, REPLACED (§9):
 *
 *   1. **Writebacks send `if_updated_at` with the tracked `updatedAt`
 *      string VERBATIM** — never parsed, never reformatted, never
 *      force-by-default. The machine treats vault versions as opaque
 *      strings; equality is the only operation. No `force` flag ever
 *      rides a reconciler writeback (test-pinned; `ScopedVaultClient`
 *      rejects it besides).
 *   2. **409 → fetch the winner → re-seed into the live Y.Doc in ONE
 *      transaction.** Connected clients observe a single atomic swap —
 *      no torn intermediate state (a cleared-but-not-yet-reseeded doc) is
 *      ever broadcast.
 *
 * **The external-edit signal is the vault SSE subscription** on the
 * surface's working tag (`ctx.vault.subscribe`, surface-client Tier 1) —
 * NOT load-time comparison. Reconnects deliver a fresh snapshot, which the
 * machine diffs against its tracked versions; missed events self-correct.
 *
 * **Fail-closed on stream loss** (the kit's ethos, same direction as
 * GrantStore): while the stream is down the external state is UNKNOWN, so
 * the machine revalidates (one-shot `getNote`) before the next writeback
 * instead of assuming no external edits. Revalidation failure defers the
 * writeback (with capped backoff) — the machine never writes blind while
 * degraded.
 *
 * ## Failure windows — properties of the machine (written once, here)
 *
 * These are inherent to reconciling a CRDT against a non-CRDT source of
 * truth; they are documented properties, not bugs:
 *
 *   - **External-commit → re-seed delta.** Local edits made between an
 *     external vault commit and the re-seed completing are DROPPED
 *     (external-edit-wins). The window is the SSE delivery + winner fetch
 *     latency (or, on the 409 path, the writeback round-trip). Surfaces
 *     that must preserve such edits should listen for conflict events and
 *     offer recovery UX (e.g. a "your version" copy).
 *   - **Debounce window on crash.** Local edits are persisted to the state
 *     store at flush time; a hard crash inside the debounce window loses
 *     at most `debounceMs` of edits. (A clean `stop()`/`unload()` flushes.)
 *   - **Degraded-stream staleness.** While the SSE stream is down,
 *     connected clients may read stale doc content until the reconnect
 *     snapshot (or a pre-writeback revalidation) catches the external
 *     edit. Writebacks stay safe throughout — revalidate-first plus
 *     `if_updated_at` means a stale write can only 409, never clobber.
 *   - **Removal is terminal per scope.** A note that leaves the watch
 *     scope (deleted, or untagged out of the working tag) emits
 *     `note-removed`, drops its persisted state, and stops being
 *     reconciled. The live Y.Doc instance is NOT destroyed — the surface
 *     owns its sessions and decides what to tell connected clients.
 *
 * ## Hook contract (the ONLY surface-author-facing seam)
 *
 * The machine exposes `serialize`/`seed` hooks + conflict events; its
 * internals (state-store layout, queues, debounce, tracking) stay private.
 *
 *   - `seed(doc, note)` must REPLACE the doc's content from the note
 *     (clear + populate). It runs inside a reconciler-managed transaction
 *     (origin {@link RECONCILER_ORIGIN}) — do not nest `doc.transact` with
 *     a different origin, and do not throw (a throwing seed leaves the
 *     doc partially updated and emits `hook-error`).
 *   - `serialize(doc)` derives the note's canonical content (markdown for
 *     `format: "markdown"` surfaces — use `@openparachute/doc-schema`'s
 *     `docToMarkdown`, never an ad-hoc serializer, so schema and codec
 *     stay versioned together).
 *
 * For the collaborative docs editor: build `seed` on y-prosemirror's
 * `prosemirrorJSONToYDoc(schema, markdownToDocJSON(md))` — ALWAYS the
 * doc-schema package's exported schema, never one built ad hoc (node/mark
 * names persist inside Y.Docs). And note the recorded Hocuspocus upstream
 * bug (design appendix "Resolved: Hocuspocus under Bun"): `onDisconnect`
 * fires TWICE when the departing client had awareness state — any
 * disconnect-driven cleanup a surface wires around this machine (presence
 * counters, `unload()` calls) MUST be idempotent, deduped by socketId.
 *
 * Version anchor: the Hocuspocus-under-Bun spike was verified on
 * **Bun 1.3.13 + @hocuspocus/server 4.1.1** (sandboxed spike, 2026-06-10).
 * On a Bun (or Hocuspocus) upgrade, re-verify the manual-pumping wiring
 * contract (`handleConnection` / `handleMessage` / `handleClose` over
 * Bun.serve native WebSockets) and the double-`onDisconnect` upstream bug
 * — see the design appendix for the 7-case convergence checklist.
 */

import type {
  Note,
  NotesQueryInput,
  SubscribeHandlers,
  TagExpandMode,
} from "@openparachute/surface-client";
import { VaultConflictError } from "@openparachute/surface-client";
import * as Y from "yjs";
import type { SurfaceHostContext } from "../types.ts";

/**
 * Transaction origin for every reconciler-initiated doc mutation (seed,
 * re-seed, snapshot restore). Update observers — the machine's own dirty
 * tracking, and any surface-side listener — can distinguish reconciler
 * writes from client edits by this origin.
 */
export const RECONCILER_ORIGIN = Symbol("vault-reconciler");

/** The serialize/seed seam — see the module header for the contract. */
export interface ReconcilerHooks {
  /** REPLACE the doc's content from the note (runs in ONE transaction). */
  seed(doc: Y.Doc, note: Note): void;
  /** Derive the note's canonical content (markdown) from the doc. */
  serialize(doc: Y.Doc): string;
  /**
   * Override the populated probe for the re-seed guard. Default: the doc
   * carries any CRDT state (`Y.encodeStateVector(doc).byteLength > 1`).
   */
  isPopulated?(doc: Y.Doc): boolean;
}

/** Conflict / lifecycle events — the machine's outward-facing signal. */
export type ReconcilerEvent =
  /** An external vault edit won; the live doc was re-seeded from it. */
  | { type: "external-edit"; noteId: string; note: Note }
  /** A writeback 409ed; the winner was fetched and re-seeded. */
  | { type: "writeback-conflict"; noteId: string; note: Note }
  /** The note left the watch scope (deleted or untagged); tracking dropped. */
  | { type: "note-removed"; noteId: string }
  /** A vault writeback failed (non-409); retried with capped backoff. */
  | { type: "writeback-error"; noteId: string; error: unknown }
  /** A surface-author hook threw — author bug, never retried. */
  | { type: "hook-error"; noteId: string; hook: "seed" | "serialize"; error: unknown };

export interface VaultReconcilerOptions {
  /** The surface's working tag — the SSE watch scope. */
  tag: string;
  hooks: ReconcilerHooks;
  /** Tag-expansion mode for the watch query. Default `"exact"`. */
  expand?: TagExpandMode;
  /** Writeback debounce after a local edit, ms. Default 2000. */
  debounceMs?: number;
  /** Ceiling for the error-retry backoff, ms. Default 30000. */
  maxRetryMs?: number;
}

export interface VaultReconciler {
  /**
   * Start the live external-edit subscription. Resolves on the first
   * snapshot (rejects if the stream terminally closes before one) so a
   * backend factory can sequence "reconciler ready". Lifetime is keyed to
   * `ctx.shutdownSignal` and `stop()`.
   */
  start(): Promise<void>;
  /** Flush + persist everything, unsubscribe, drop all tracking. */
  stop(): Promise<void>;
  /**
   * Load the doc for a note (documentName = note id). Pass the engine's
   * doc instance (e.g. Hocuspocus's `document` in `onLoadDocument`) to
   * have the machine adopt it; omitted, a fresh `Y.Doc` is created.
   * Restores the persisted snapshot when one exists; otherwise fetches
   * the note and seeds — never over a populated doc (the guard).
   * Rejects after `stop()` — an engine must not load documents during or
   * after shutdown (a silently-accepted late load would register a doc
   * no subscription reconciles, hiding teardown-ordering bugs).
   */
  load(noteId: string, doc?: Y.Doc): Promise<Y.Doc>;
  /** Flush pending writeback, persist the snapshot, drop the live doc. */
  unload(noteId: string): Promise<void>;
  /** Force pending writebacks now (one note, or all when omitted). */
  flush(noteId?: string): Promise<void>;
  /** Subscribe to conflict events. Returns the unsubscribe function. */
  on(handler: (event: ReconcilerEvent) => void): () => void;
  /** Is the external-edit stream live? False = degraded (revalidate mode). */
  readonly live: boolean;
  /** The working tag this machine watches. */
  readonly tag: string;
}

/** State-store key for a note's persisted doc snapshot (private layout). */
function stateKey(noteId: string): string {
  return `ydoc/${noteId}`;
}

/** Default populated probe: any CRDT state at all (public yjs API). */
function defaultIsPopulated(doc: Y.Doc): boolean {
  // An empty doc's state vector encodes as a single varint 0 byte.
  return Y.encodeStateVector(doc).byteLength > 1;
}

function isConflict(err: unknown): boolean {
  if (err instanceof VaultConflictError) return true;
  return err instanceof Error && err.name === "VaultConflictError";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_RETRY_MS = 30_000;

interface TrackedDoc {
  doc: Y.Doc;
  /** Vault `updatedAt` VERBATIM at last seed/ack — the `if_updated_at` baseline. */
  tracked: string;
  /** Local edits pending writeback. */
  dirty: boolean;
  /** Local-edit counter; a writeback acks only its own generation. */
  generation: number;
  /** Consecutive writeback failures (capped-backoff exponent). */
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Dedupe queued external checks. */
  checkQueued: boolean;
  /** Latest external `updatedAt` hint from the stream (echo fast-path). */
  externalHint: string | undefined;
  /** Detach the doc's update observer. */
  detach: () => void;
}

class Reconciler implements VaultReconciler {
  readonly #ctx: SurfaceHostContext;
  readonly #hooks: ReconcilerHooks;
  readonly #tag: string;
  readonly #expand: TagExpandMode;
  readonly #debounceMs: number;
  readonly #maxRetryMs: number;

  readonly #docs = new Map<string, TrackedDoc>();
  /** Per-note operation chain: load / writeback / external-check / removal
   *  run strictly serialized, which is what kills the writeback-vs-echo race. */
  readonly #ops = new Map<string, Promise<unknown>>();
  readonly #handlers = new Set<(event: ReconcilerEvent) => void>();

  #live = false;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;

  constructor(ctx: SurfaceHostContext, opts: VaultReconcilerOptions) {
    this.#ctx = ctx;
    this.#hooks = opts.hooks;
    this.#tag = opts.tag;
    this.#expand = opts.expand ?? "exact";
    this.#debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  }

  get live(): boolean {
    return this.#live;
  }

  get tag(): string {
    return this.#tag;
  }

  on(handler: (event: ReconcilerEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  #emit(event: ReconcilerEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        this.#ctx.log.warn(`reconciler: event handler threw (${errMessage(err)})`);
      }
    }
  }

  // -------------------------------------------------------------------
  // Per-note serialization
  // -------------------------------------------------------------------

  #enqueue<T>(noteId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#ops.get(noteId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run after the prior op settles, either way
    const tail = next.then(
      () => undefined,
      () => undefined, // the chain itself never sticks rejected
    );
    this.#ops.set(noteId, tail);
    void tail.then(() => {
      if (this.#ops.get(noteId) === tail) this.#ops.delete(noteId);
    });
    return next;
  }

  // -------------------------------------------------------------------
  // The external-edit signal (SSE on the working tag)
  // -------------------------------------------------------------------

  start(): Promise<void> {
    if (this.#unsubscribe) return Promise.resolve();
    if (this.#stopped) return Promise.reject(new Error("reconciler: stopped"));
    const query: NotesQueryInput = { tag: this.#tag, expand: this.#expand };
    return new Promise<void>((resolveFirst, rejectFirst) => {
      let settled = false;
      const handlers: SubscribeHandlers = {
        onSnapshot: (notes) => {
          this.#live = true;
          const byId = new Map<string, Note>();
          for (const note of notes) byId.set(note.id, note);
          for (const [noteId, td] of this.#docs) {
            const note = byId.get(noteId);
            if (note === undefined) {
              // The complete matching set no longer contains a tracked
              // note: it was deleted or left the working tag.
              this.#queueRemoved(noteId);
              continue;
            }
            td.externalHint = note.updatedAt;
            if (note.updatedAt !== td.tracked) this.#queueCheck(noteId);
          }
          if (!settled) {
            settled = true;
            resolveFirst();
          }
        },
        onUpsert: (note) => {
          const td = this.#docs.get(note.id);
          if (!td) return;
          td.externalHint = note.updatedAt;
          // Echo fast-path: our own acked writeback comes back with the
          // version we already track — nothing to do.
          if (note.updatedAt !== undefined && note.updatedAt === td.tracked) return;
          this.#queueCheck(note.id);
        },
        onRemove: (id) => {
          if (this.#docs.has(id)) this.#queueRemoved(id);
        },
        onError: (err) => {
          this.#ctx.log.warn(`reconciler stream error: ${errMessage(err)}`);
        },
        onStatus: (status) => {
          if (status === "open") return;
          // connecting / reconnecting / closed — external state is UNKNOWN
          // from here on: degrade (revalidate before the next writeback).
          this.#live = false;
          if (status === "closed" && !settled) {
            settled = true;
            rejectFirst(new Error("reconciler: subscription closed before first snapshot"));
          }
        },
      };
      this.#unsubscribe = this.#ctx.vault.subscribe(query, handlers, {
        signal: this.#ctx.shutdownSignal,
      });
    });
  }

  /**
   * Queued external-edit check. The queue runs it AFTER any in-flight
   * writeback for the same note settles, so a stream echo of our own
   * write compares against the post-ack tracked version and no-ops —
   * instead of racing the writeback and re-seeding over fresh local edits.
   */
  #queueCheck(noteId: string): void {
    const td = this.#docs.get(noteId);
    if (!td || td.checkQueued) return;
    td.checkQueued = true;
    void this.#enqueue(noteId, async () => {
      const cur = this.#docs.get(noteId);
      if (!cur) return;
      cur.checkQueued = false;
      // Echo confirmed without a fetch: the latest hint matches what we track.
      if (cur.externalHint !== undefined && cur.externalHint === cur.tracked) return;
      let winner: Note | null;
      try {
        winner = await this.#ctx.vault.getNote(noteId);
      } catch (err) {
        // The next event / reconnect snapshot self-corrects.
        this.#ctx.log.warn(`reconciler: external check for ${noteId} failed (${errMessage(err)})`);
        return;
      }
      if (winner === null) {
        this.#removeTracking(noteId);
        return;
      }
      if (winner.updatedAt === cur.tracked) return; // converged already
      this.#reseed(noteId, cur, winner, "external-edit");
    });
  }

  #queueRemoved(noteId: string): void {
    void this.#enqueue(noteId, async () => {
      this.#removeTracking(noteId);
    });
  }

  #removeTracking(noteId: string): void {
    const td = this.#docs.get(noteId);
    if (!td) return;
    if (td.timer !== null) clearTimeout(td.timer);
    td.detach();
    this.#docs.delete(noteId);
    try {
      this.#ctx.store.delete(stateKey(noteId));
    } catch (err) {
      this.#ctx.log.warn(`reconciler: deleting state for ${noteId} failed (${errMessage(err)})`);
    }
    this.#emit({ type: "note-removed", noteId });
  }

  // -------------------------------------------------------------------
  // Load / unload
  // -------------------------------------------------------------------

  load(noteId: string, doc?: Y.Doc): Promise<Y.Doc> {
    if (this.#stopped) {
      // Loading after stop() would register a doc with an update observer
      // but no subscription reconciling it — surface the teardown-ordering
      // bug loudly instead of stubbing it silently.
      return Promise.reject(
        new Error(`reconciler is stopped: cannot load note ${noteId} after stop()`),
      );
    }
    return this.#enqueue(noteId, () => this.#load(noteId, doc));
  }

  async #load(noteId: string, provided?: Y.Doc): Promise<Y.Doc> {
    const existing = this.#docs.get(noteId);
    if (existing) {
      if (provided !== undefined && provided !== existing.doc) {
        throw new Error(
          `reconciler: note ${noteId} is already loaded with a different Y.Doc instance`,
        );
      }
      return existing.doc;
    }

    const doc = provided ?? new Y.Doc();
    const populated = (this.#hooks.isPopulated ?? defaultIsPopulated)(doc);
    const entry = this.#ctx.store.get(stateKey(noteId));

    let tracked: string;
    let dirty = false;
    if (entry !== null && entry.sourceVersion !== null) {
      if (!populated) {
        // Restore the persisted snapshot — one transaction, reconciler origin.
        Y.applyUpdate(doc, entry.blob, RECONCILER_ORIGIN);
      }
      // A populated doc keeps its live state (the snapshot may be staler
      // than what connected clients already hold); tracking adopts the
      // persisted baseline either way.
      tracked = entry.sourceVersion;
      dirty = entry.dirty;
    } else {
      // No usable persisted state (an entry without a sourceVersion is
      // untrusted — vault-as-source-of-truth): fetch and seed.
      const note = await this.#ctx.vault.getNote(noteId);
      if (note === null) {
        throw new Error(
          `reconciler: note ${noteId} not found — create the note in the vault before loading its doc`,
        );
      }
      if (typeof note.updatedAt !== "string") {
        throw new Error(`reconciler: note ${noteId} carries no updatedAt — cannot reconcile`);
      }
      if (!populated) {
        doc.transact(() => {
          this.#hooks.seed(doc, note);
        }, RECONCILER_ORIGIN);
      }
      // Populated guard: an already-populated doc is NEVER seeded over;
      // its baseline is the current vault version.
      tracked = note.updatedAt;
    }

    const td: TrackedDoc = {
      doc,
      tracked,
      dirty,
      generation: 0,
      retries: 0,
      timer: null,
      checkQueued: false,
      externalHint: undefined,
      detach: () => undefined,
    };
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === RECONCILER_ORIGIN) return;
      td.generation++;
      td.dirty = true;
      this.#schedule(noteId);
    };
    doc.on("update", onUpdate);
    td.detach = () => doc.off("update", onUpdate);
    this.#docs.set(noteId, td);
    this.#persist(noteId, td);
    // Crash recovery: a restored dirty snapshot resumes its writeback.
    if (td.dirty) this.#schedule(noteId);
    return doc;
  }

  async unload(noteId: string): Promise<void> {
    const td = this.#docs.get(noteId);
    if (!td) return;
    if (td.timer !== null) {
      clearTimeout(td.timer);
      td.timer = null;
    }
    await this.#enqueue(noteId, () => this.#flushNote(noteId));
    const cur = this.#docs.get(noteId);
    if (!cur) return; // removed while flushing
    if (cur.timer !== null) {
      clearTimeout(cur.timer); // an error-path retry; the persisted dirty flag resumes it on reload
      cur.timer = null;
    }
    cur.detach();
    this.#persist(noteId, cur);
    this.#docs.delete(noteId);
  }

  // -------------------------------------------------------------------
  // Writeback
  // -------------------------------------------------------------------

  #schedule(noteId: string, delayMs?: number): void {
    const td = this.#docs.get(noteId);
    if (!td) return;
    if (td.timer !== null) clearTimeout(td.timer);
    td.timer = setTimeout(() => {
      td.timer = null;
      void this.#enqueue(noteId, () => this.#flushNote(noteId));
    }, delayMs ?? this.#debounceMs);
  }

  async flush(noteId?: string): Promise<void> {
    const ids = noteId !== undefined ? [noteId] : [...this.#docs.keys()];
    await Promise.all(
      ids.map((id) => {
        const td = this.#docs.get(id);
        if (!td) return Promise.resolve();
        if (td.timer !== null) {
          clearTimeout(td.timer);
          td.timer = null;
        }
        return this.#enqueue(id, () => this.#flushNote(id));
      }),
    );
  }

  /** Runs inside the per-note queue. Never throws. */
  async #flushNote(noteId: string): Promise<void> {
    const td = this.#docs.get(noteId);
    if (!td || !td.dirty) return;

    // Persist the dirty snapshot at flush time, BEFORE any vault round
    // trip — from here on a crash can no longer lose these edits (the
    // documented debounce-window bound), however the writeback fares.
    this.#persist(noteId, td);

    if (!this.#live) {
      // Degraded stream: external state is unknown — revalidate before
      // writing rather than assuming no external edits happened.
      let current: Note | null;
      try {
        current = await this.#ctx.vault.getNote(noteId);
      } catch (err) {
        this.#ctx.log.warn(
          `reconciler: degraded revalidation for ${noteId} failed — writeback deferred (${errMessage(err)})`,
        );
        this.#scheduleRetry(noteId, td);
        return;
      }
      if (current === null) {
        this.#removeTracking(noteId);
        return;
      }
      if (current.updatedAt !== td.tracked) {
        // External edit landed while we were blind: it wins.
        this.#reseed(noteId, td, current, "external-edit");
        return;
      }
    }

    const generation = td.generation;
    let content: string;
    try {
      content = this.#hooks.serialize(td.doc);
    } catch (err) {
      // Author bug — deterministic, so never auto-retried.
      this.#ctx.log.error(`reconciler: serialize hook threw for ${noteId} (${errMessage(err)})`);
      this.#emit({ type: "hook-error", noteId, hook: "serialize", error: err });
      return;
    }

    try {
      // The baseline rides VERBATIM — and no force flag, ever.
      const updated = await this.#ctx.vault.updateNote(noteId, {
        content,
        if_updated_at: td.tracked,
      });
      if (typeof updated.updatedAt !== "string") {
        throw new Error("vault returned no updatedAt on update");
      }
      td.tracked = updated.updatedAt;
      td.retries = 0;
      if (td.generation === generation) {
        td.dirty = false;
        this.#persist(noteId, td);
      } else {
        // Local edits landed mid-flight: baseline acked, still dirty.
        this.#persist(noteId, td);
        this.#schedule(noteId);
      }
    } catch (err) {
      if (isConflict(err)) {
        let winner: Note | null;
        try {
          winner = await this.#ctx.vault.getNote(noteId);
        } catch (fetchErr) {
          this.#ctx.log.warn(
            `reconciler: conflict winner fetch for ${noteId} failed (${errMessage(fetchErr)})`,
          );
          this.#emit({ type: "writeback-error", noteId, error: fetchErr });
          this.#scheduleRetry(noteId, td);
          return;
        }
        if (winner === null) {
          this.#removeTracking(noteId);
          return;
        }
        this.#reseed(noteId, td, winner, "writeback-conflict");
      } else {
        this.#ctx.log.warn(`reconciler: writeback for ${noteId} failed (${errMessage(err)})`);
        this.#emit({ type: "writeback-error", noteId, error: err });
        this.#scheduleRetry(noteId, td);
      }
    }
  }

  #scheduleRetry(noteId: string, td: TrackedDoc): void {
    const delay = Math.min(this.#debounceMs * 2 ** td.retries, this.#maxRetryMs);
    td.retries++;
    this.#schedule(noteId, delay);
  }

  /**
   * Re-seed the live doc from the winning vault note in ONE transaction —
   * connected clients observe a single atomic swap, never a torn
   * intermediate state. Pending local edits are superseded
   * (external-edit-wins).
   */
  #reseed(
    noteId: string,
    td: TrackedDoc,
    winner: Note,
    type: "external-edit" | "writeback-conflict",
  ): void {
    if (typeof winner.updatedAt !== "string") {
      this.#ctx.log.warn(`reconciler: winner for ${noteId} carries no updatedAt — skipping reseed`);
      return;
    }
    try {
      td.doc.transact(() => {
        this.#hooks.seed(td.doc, winner);
      }, RECONCILER_ORIGIN);
    } catch (err) {
      this.#ctx.log.error(`reconciler: seed hook threw for ${noteId} (${errMessage(err)})`);
      this.#emit({ type: "hook-error", noteId, hook: "seed", error: err });
      return;
    }
    td.tracked = winner.updatedAt;
    td.dirty = false;
    td.retries = 0;
    if (td.timer !== null) {
      clearTimeout(td.timer);
      td.timer = null;
    }
    this.#persist(noteId, td);
    this.#emit({ type, noteId, note: winner });
  }

  #persist(noteId: string, td: TrackedDoc): void {
    try {
      this.#ctx.store.put(stateKey(noteId), Y.encodeStateAsUpdate(td.doc), {
        sourceVersion: td.tracked,
        dirty: td.dirty,
      });
    } catch (err) {
      this.#ctx.log.warn(`reconciler: persisting ${noteId} failed (${errMessage(err)})`);
    }
  }

  // -------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#live = false; // final flushes revalidate — fail-closed to the end
    await this.flush();
    for (const [noteId, td] of this.#docs) {
      if (td.timer !== null) clearTimeout(td.timer);
      td.detach();
      this.#persist(noteId, td);
    }
    this.#docs.clear();
  }
}

/**
 * Build the reconciliation machine over the host context. Call
 * `await reconciler.start()` in the backend factory (after which external
 * edits flow live) and `await reconciler.stop()` in `shutdown()`.
 */
export function createVaultReconciler(
  ctx: SurfaceHostContext,
  opts: VaultReconcilerOptions,
): VaultReconciler {
  return new Reconciler(ctx, opts);
}
