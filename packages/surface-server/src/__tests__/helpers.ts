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
import type {
  CreateNotePayload,
  Note,
  NotesQueryInput,
  SubscribeHandlers,
  SubscribeOptions,
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
  createdNotes: CreateNotePayload[] = [];
  deletedIds: string[] = [];
  #idCounter = 0;

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

  async queryNotes(_params: NotesQueryInput): Promise<Note[]> {
    this.queryCalls++;
    if (this.queryError) throw this.queryError;
    return [...this.notes.values()];
  }

  async getNote(id: string): Promise<Note | null> {
    return this.notes.get(id) ?? null;
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
