/**
 * Shared test fixtures: a fake `SurfaceHostContext` over a REAL
 * `SurfaceStateStore` (temp SQLite) and a scriptable fake vault client.
 *
 * The vault fake is cast through `unknown` because `ScopedVaultClient`
 * carries ECMAScript-private fields (nominal typing) — the kit only ever
 * CALLS the public surface, which the fake implements.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type SurfaceHostContext, SurfaceStateStore } from "@openparachute/surface";
import {
  type CreateNotePayload,
  type Note,
  type NotesQueryInput,
  type SubscribeHandlers,
  type SubscribeOptions,
  type UpdateNotePayload,
  VaultConflictError,
  VaultNotFoundError,
} from "@openparachute/surface-client";

export interface FakeSubscription {
  query: NotesQueryInput;
  handlers: SubscribeHandlers;
  opts: SubscribeOptions;
  unsubscribed: boolean;
}

/** Scriptable stand-in for the kit-visible ScopedVaultClient surface. */
export class FakeVault {
  readonly vaultName = "default";
  notes = new Map<string, Note>();
  subscriptions: FakeSubscription[] = [];
  /** When set, queryNotes throws (degraded-revalidation failure path). */
  queryError: Error | null = null;
  queryCalls = 0;
  /** Every queryNotes input, in call order (projection query inspection). */
  queryInputs: NotesQueryInput[] = [];
  createdNotes: CreateNotePayload[] = [];
  deletedIds: string[] = [];
  /** Every updateNote call, in order — payloads recorded VERBATIM. */
  updateCalls: { id: string; payload: UpdateNotePayload }[] = [];
  /** When set, updateNote throws it (transient-failure path). */
  updateError: Error | null = null;
  /** When set, updateNote awaits it before applying (in-flight race tests). */
  updateGate: Promise<void> | null = null;
  getNoteCalls = 0;
  /** When set, getNote throws (degraded-revalidation failure path). */
  getNoteError: Error | null = null;
  #idCounter = 0;
  #versionCounter = 0;

  /**
   * Deliberately OPAQUE version strings (`v-1`, `v-2`, …) — not ISO
   * timestamps. Any consumer that parses/normalizes `updatedAt` instead
   * of treating it as a verbatim string breaks against this fake (§9).
   */
  nextVersion(): string {
    return `v-${++this.#versionCounter}`;
  }

  /** Seed a note with content + a fresh opaque version. */
  noteFixture(id: string, content: string, extra: Partial<Note> = {}): Note {
    const note: Note = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: this.nextVersion(),
      content,
      ...extra,
    };
    this.notes.set(id, note);
    return note;
  }

  /** Simulate another writer (agent, sync job, sibling surface). */
  externalEdit(id: string, content: string): Note {
    const existing = this.notes.get(id);
    if (!existing) throw new Error(`externalEdit: no note ${id}`);
    const updated: Note = { ...existing, content, updatedAt: this.nextVersion() };
    this.notes.set(id, updated);
    return updated;
  }

  subscribe(
    query: NotesQueryInput,
    handlers: SubscribeHandlers,
    opts: SubscribeOptions = {},
  ): () => void {
    const sub: FakeSubscription = { query, handlers, opts, unsubscribed: false };
    this.subscriptions.push(sub);
    return () => {
      sub.unsubscribed = true;
    };
  }

  async queryNotes(params: NotesQueryInput): Promise<Note[]> {
    this.queryCalls++;
    this.queryInputs.push(params);
    if (this.queryError) throw this.queryError;
    return [...this.notes.values()];
  }

  /**
   * FAITHFUL to the live client: vault 404s the by-id read of a missing
   * note and surface-client raises the typed `VaultNotFoundError` — the
   * fake must NOT soften that to null, or oracle regressions (missing →
   * 500 while denied → 404) stay invisible to this suite.
   */
  async getNote(id: string): Promise<Note | null> {
    this.getNoteCalls++;
    if (this.getNoteError) throw this.getNoteError;
    const note = this.notes.get(id);
    if (note === undefined) throw new VaultNotFoundError(`note ${id} not found`);
    return note;
  }

  /**
   * Mirrors vault's PATCH optimistic-concurrency contract: `if_updated_at`
   * (or `force`) is REQUIRED, and a stale baseline 409s with
   * `VaultConflictError` — so reconciler tests exercise the real conflict
   * path, not a scripted stub.
   */
  async updateNote(id: string, payload: UpdateNotePayload): Promise<Note> {
    this.updateCalls.push({ id, payload });
    if (this.updateError) throw this.updateError;
    const existing = this.notes.get(id);
    if (!existing) throw new VaultNotFoundError(`note ${id} not found`);
    if (payload.force !== true) {
      if (payload.if_updated_at === undefined) {
        throw new Error("FakeVault.updateNote: if_updated_at or force is required");
      }
      if (payload.if_updated_at !== existing.updatedAt) {
        throw new VaultConflictError({
          current_updated_at: existing.updatedAt ?? null,
          expected_updated_at: payload.if_updated_at,
        });
      }
    }
    const updated: Note = {
      ...existing,
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      updatedAt: this.nextVersion(),
    };
    this.notes.set(id, updated);
    // The commit is already visible (vault's SSE would fire now); the gate
    // models HTTP response latency AFTER the commit — the echo-race window.
    if (this.updateGate) await this.updateGate;
    return updated;
  }

  async createNote(payload: CreateNotePayload): Promise<Note> {
    const note: Note = {
      id: `note-${++this.#idCounter}`,
      createdAt: new Date().toISOString(),
      content: payload.content,
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      ...(payload.path !== undefined ? { path: payload.path } : {}),
    };
    this.createdNotes.push(payload);
    this.notes.set(note.id, note);
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    this.deletedIds.push(id);
    this.notes.delete(id);
  }
}

export interface TestCtx {
  ctx: SurfaceHostContext;
  vault: FakeVault;
  store: SurfaceStateStore;
  controller: AbortController;
  logs: { warns: string[]; errors: string[]; logs: string[] };
}

export function makeTestCtx(
  opts: { mount?: string; vault?: FakeVault; config?: Record<string, unknown> } = {},
): TestCtx {
  const mount = opts.mount ?? "/surface/demo";
  const vault = opts.vault ?? new FakeVault();
  const dir = mkdtempSync(path.join(tmpdir(), "surface-server-test-"));
  const store = new SurfaceStateStore(path.join(dir, "state.sqlite"));
  const controller = new AbortController();
  const logs = { warns: [] as string[], errors: [] as string[], logs: [] as string[] };
  const config = opts.config ?? {};

  const ctx: SurfaceHostContext = {
    vault: vault as unknown as SurfaceHostContext["vault"],
    store,
    layer: (req: Request) => {
      const v = req.headers.get("x-parachute-layer");
      return v === "loopback" || v === "tailnet" || v === "public" ? v : "public";
    },
    clientIp: (req: Request) => {
      const v = req.headers.get("x-parachute-client-ip");
      return v !== null && v.trim().length > 0 ? v.trim() : null;
    },
    config: {
      all: () => config,
      get: (key: string) => config[key],
    },
    log: {
      log: (...a: unknown[]) => logs.logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.warns.push(a.join(" ")),
      error: (...a: unknown[]) => logs.errors.push(a.join(" ")),
    },
    mount,
    shutdownSignal: controller.signal,
  };

  return { ctx, vault, store, controller, logs };
}

/** A grant note in the canonical wire shape. */
export function grantNote(args: {
  id: string;
  subjectType: "public" | "capability" | "subject";
  subject?: string;
  resourceType: "note" | "path" | "tag";
  resource: string;
  level: string;
  expiresAt?: string;
}): Note {
  return {
    id: args.id,
    createdAt: new Date().toISOString(),
    tags: ["surface-acl/demo"],
    metadata: {
      subject_type: args.subjectType,
      subject: args.subject ?? "",
      resource_type: args.resourceType,
      resource: args.resource,
      level: args.level,
      ...(args.expiresAt !== undefined ? { expires_at: args.expiresAt } : {}),
    },
  };
}

/** Drive a fake subscription to live with the given snapshot. */
export function deliverSnapshot(sub: FakeSubscription, notes: Note[]): void {
  sub.handlers.onStatus?.("open");
  sub.handlers.onSnapshot(notes);
}
