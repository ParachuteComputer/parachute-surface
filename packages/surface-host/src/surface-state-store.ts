/**
 * SurfaceStateStore — per-surface derived-state storage (surface-runtime
 * design P2/P10 substrate).
 *
 * One SQLite file per surface (bun:sqlite) under the host's state dir:
 * a keyed blob store `{ key → (blob, sourceVersion, dirty, updatedAt) }`.
 * This is the home for OPERATIONAL state — CRDT document snapshots, caches,
 * reconciliation cursors — never knowledge (notes live in the vault;
 * vault-as-source-of-truth).
 *
 * The shape anticipates `createVaultReconciler` (R4/P10):
 *   - `sourceVersion` — the vault note's `updatedAt` string VERBATIM at the
 *     last seed/writeback (the `if_updated_at` baseline; design §9 — never
 *     a parsed/normalized timestamp).
 *   - `dirty` — local changes not yet written back.
 *
 * Lifecycle: the file is created lazily on first open and DELETED when the
 * surface is removed (`removeSurfaceState` in host-context.ts) — state must
 * not outlive its surface.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

export interface SurfaceStateEntry {
  key: string;
  blob: Uint8Array;
  /** Vault `updatedAt` string verbatim at last seed/writeback, or null. */
  sourceVersion: string | null;
  /** Local changes pending writeback. */
  dirty: boolean;
  /** ISO timestamp of the last put. */
  updatedAt: string;
}

/** `list()` row — metadata only (blobs can be large; fetch them by key). */
export interface SurfaceStateEntryMeta {
  key: string;
  sourceVersion: string | null;
  dirty: boolean;
  updatedAt: string;
}

interface Row {
  key: string;
  blob: Uint8Array;
  source_version: string | null;
  dirty: number;
  updated_at: string;
}

export class SurfaceStateStore {
  readonly #db: Database;
  /** Absolute path of the backing SQLite file. */
  readonly path: string;
  #closed = false;

  constructor(filePath: string, opts: { now?: () => Date } = {}) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.path = filePath;
    this.#now = opts.now ?? (() => new Date());
    this.#db = new Database(filePath, { create: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        blob BLOB NOT NULL,
        source_version TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
  }

  readonly #now: () => Date;

  get(key: string): SurfaceStateEntry | null {
    this.#assertOpen();
    const row = this.#db
      .query<Row, [string]>(
        "SELECT key, blob, source_version, dirty, updated_at FROM kv WHERE key = ?",
      )
      .get(key);
    if (!row) return null;
    return {
      key: row.key,
      blob: new Uint8Array(row.blob),
      sourceVersion: row.source_version,
      dirty: row.dirty === 1,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Upsert a blob. `sourceVersion`/`dirty` default to "preserve nothing":
   * an omitted option writes its default (null / false), not the prior
   * value — a put is a full replacement of the entry.
   */
  put(
    key: string,
    blob: Uint8Array | string,
    opts: { sourceVersion?: string | null; dirty?: boolean } = {},
  ): void {
    this.#assertOpen();
    const bytes = typeof blob === "string" ? new TextEncoder().encode(blob) : blob;
    this.#db
      .query(
        `INSERT INTO kv (key, blob, source_version, dirty, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           blob = excluded.blob,
           source_version = excluded.source_version,
           dirty = excluded.dirty,
           updated_at = excluded.updated_at`,
      )
      .run(
        key,
        bytes,
        opts.sourceVersion ?? null,
        opts.dirty === true ? 1 : 0,
        this.#now().toISOString(),
      );
  }

  /** Returns true when an entry was removed. */
  delete(key: string): boolean {
    this.#assertOpen();
    const res = this.#db.query("DELETE FROM kv WHERE key = ?").run(key);
    return res.changes > 0;
  }

  /** Metadata for every entry (no blobs), key-ordered. */
  list(): SurfaceStateEntryMeta[] {
    this.#assertOpen();
    const rows = this.#db
      .query<Omit<Row, "blob">, []>(
        "SELECT key, source_version, dirty, updated_at FROM kv ORDER BY key",
      )
      .all();
    return rows.map((r) => ({
      key: r.key,
      sourceVersion: r.source_version,
      dirty: r.dirty === 1,
      updatedAt: r.updated_at,
    }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SurfaceStateStore: store is closed (surface unmounted or removed)");
    }
  }
}
