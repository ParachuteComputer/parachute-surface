/**
 * Test fixtures for the docs surface: a scriptable fake vault (mirroring
 * surface-server's — if_updated_at enforced, OPAQUE version strings so any
 * consumer that parses `updatedAt` breaks loudly), a fake
 * `SurfaceHostContext` over a REAL `SurfaceStateStore` (temp SQLite), and
 * `makeBackend` — the full factory with its live-query subscriptions
 * driven to "live" before the backend resolves.
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
  UpdateNotePayload,
} from "@openparachute/surface-client";
import { VaultConflictError, VaultNotFoundError } from "@openparachute/surface-client";
import { type BuildBackendOptions, type BuiltBackend, buildBackend } from "../index.ts";

export const MOUNT = "/surface/docs";
export const ORIGIN = "https://docs.test";
export const OPERATOR_JWT = "operator-jwt-fixture";
export const WORKING_TAG = "doc";
export const ACL_TAG = "surface-acl/docs";

export interface FakeSubscription {
  query: NotesQueryInput;
  handlers: SubscribeHandlers;
  opts: SubscribeOptions;
  unsubscribed: boolean;
}

function hasTag(note: Note, tag: string): boolean {
  return Array.isArray(note.tags) && note.tags.includes(tag);
}

/** Scriptable stand-in for the kit-visible ScopedVaultClient surface. */
export class FakeVault {
  readonly vaultName = "default";
  notes = new Map<string, Note>();
  subscriptions: FakeSubscription[] = [];
  updateCalls: { id: string; payload: UpdateNotePayload }[] = [];
  /** When set, the NEXT updateNote throws it once (conflict scripting). */
  updateErrorOnce: Error | null = null;
  /** When set, updateNote awaits it BEFORE applying (in-flight race tests). */
  updateGate: Promise<void> | null = null;
  #idCounter = 0;
  #versionCounter = 0;

  /** Deliberately OPAQUE version strings — never parseable timestamps. */
  nextVersion(): string {
    return `v-${++this.#versionCounter}`;
  }

  noteFixture(id: string, content: string, extra: Partial<Note> = {}): Note {
    const note: Note = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: this.nextVersion(),
      content,
      tags: [WORKING_TAG],
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

  /** Notes matching `query.tag` (literal membership — `expand: "exact"`). */
  matching(query: NotesQueryInput): Note[] {
    const tag = (query as { tag?: string }).tag;
    const all = [...this.notes.values()];
    return typeof tag === "string" ? all.filter((n) => hasTag(n, tag)) : all;
  }

  async queryNotes(params: NotesQueryInput): Promise<Note[]> {
    return this.matching(params);
  }

  async getNote(id: string): Promise<Note | null> {
    return this.notes.get(id) ?? null;
  }

  async updateNote(id: string, payload: UpdateNotePayload): Promise<Note> {
    this.updateCalls.push({ id, payload });
    if (this.updateErrorOnce) {
      const err = this.updateErrorOnce;
      this.updateErrorOnce = null;
      throw err;
    }
    // Pre-commit gate: a blocked write keeps the caller's flush in flight
    // — the seam the connect-during-unload race test stretches.
    if (this.updateGate) await this.updateGate;
    const existing = this.notes.get(id);
    if (!existing) throw new VaultNotFoundError(`note ${id} not found`);
    if (payload.force === true) {
      throw new Error("FakeVault.updateNote: force is FORBIDDEN for this surface");
    }
    if (payload.if_updated_at === undefined) {
      throw new Error("FakeVault.updateNote: if_updated_at is required");
    }
    if (payload.if_updated_at !== existing.updatedAt) {
      throw new VaultConflictError({
        current_updated_at: existing.updatedAt ?? null,
        expected_updated_at: payload.if_updated_at,
      });
    }
    const updated: Note = {
      ...existing,
      ...(payload.content !== undefined ? { content: payload.content } : {}),
      updatedAt: this.nextVersion(),
    };
    this.notes.set(id, updated);
    return updated;
  }

  async createNote(payload: CreateNotePayload): Promise<Note> {
    const note: Note = {
      id: `note-${++this.#idCounter}`,
      createdAt: new Date().toISOString(),
      updatedAt: this.nextVersion(),
      content: payload.content,
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      ...(payload.path !== undefined ? { path: payload.path } : {}),
    };
    this.notes.set(note.id, note);
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    this.notes.delete(id);
  }

  /** Drive every live subscription with a fresh tag-matched snapshot. */
  deliverSnapshots(): void {
    for (const sub of this.subscriptions) {
      if (sub.unsubscribed) continue;
      sub.handlers.onStatus?.("open");
      sub.handlers.onSnapshot(this.matching(sub.query));
    }
  }

  /** Push an upsert event to every subscription whose tag matches. */
  pushUpsert(note: Note): void {
    for (const sub of this.subscriptions) {
      if (sub.unsubscribed) continue;
      const tag = (sub.query as { tag?: string }).tag;
      if (typeof tag === "string" && !hasTag(note, tag)) continue;
      sub.handlers.onUpsert(note);
    }
  }
}

export interface TestCtx {
  ctx: SurfaceHostContext;
  vault: FakeVault;
  store: SurfaceStateStore;
  controller: AbortController;
  logs: { warns: string[]; errors: string[]; logs: string[] };
}

export function makeTestCtx(opts: { vault?: FakeVault } = {}): TestCtx {
  const vault = opts.vault ?? new FakeVault();
  const dir = mkdtempSync(path.join(tmpdir(), "docs-editor-test-"));
  const store = new SurfaceStateStore(path.join(dir, "state.sqlite"));
  const controller = new AbortController();
  const logs = { warns: [] as string[], errors: [] as string[], logs: [] as string[] };

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
    config: { all: () => ({}), get: () => undefined },
    log: {
      log: (...a: unknown[]) => logs.logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.warns.push(a.join(" ")),
      error: (...a: unknown[]) => logs.errors.push(a.join(" ")),
    },
    mount: MOUNT,
    shutdownSignal: controller.signal,
  };

  return { ctx, vault, store, controller, logs };
}

export interface MadeBackend extends BuiltBackend {
  ctx: SurfaceHostContext;
  vault: FakeVault;
  controller: AbortController;
  logs: TestCtx["logs"];
}

/**
 * Build the full backend over a fake vault. The factory awaits both
 * live-query first-snapshots, so this helper delivers them as soon as the
 * subscriptions register.
 */
export async function makeBackend(
  opts: { vault?: FakeVault; build?: BuildBackendOptions } = {},
): Promise<MadeBackend> {
  const { ctx, vault, controller, logs } = makeTestCtx(
    opts.vault !== undefined ? { vault: opts.vault } : {},
  );
  const building = buildBackend(ctx, {
    authOptions: {
      validateHubJwt: async (token, expectedAudience) => {
        if (token !== OPERATOR_JWT) throw new Error("bad token");
        if (expectedAudience !== "vault.default") throw new Error("bad audience");
        return {
          sub: "operator-1",
          scopes: ["vault:default:write"],
          aud: expectedAudience,
          jti: undefined,
          clientId: undefined,
          vaultScope: [],
        };
      },
    },
    rateLimit: false,
    reconcilerDebounceMs: 25,
    ...opts.build,
  });
  // Both subscriptions register synchronously inside the factory's start
  // calls; the factory then awaits their first snapshots.
  await Promise.resolve();
  vault.deliverSnapshots();
  const built = await building;
  return { ...built, ctx, vault, controller, logs };
}

/** Poll until `probe` is truthy (collab tests — CRDT settling). */
export async function waitUntil(
  probe: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const startedAt = Date.now();
  while (!probe()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitUntil timed out: ${opts.label ?? "(unnamed probe)"}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Convenience request builders against the composed backend.fetch. */
export function get(
  backend: { fetch(req: Request): Response | Promise<Response> },
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(backend.fetch(new Request(`${ORIGIN}${MOUNT}${pathname}`, { headers })));
}

export function post(
  backend: { fetch(req: Request): Response | Promise<Response> },
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    backend.fetch(
      new Request(`${ORIGIN}${MOUNT}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );
}

export function del(
  backend: { fetch(req: Request): Response | Promise<Response> },
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    backend.fetch(new Request(`${ORIGIN}${MOUNT}${pathname}`, { method: "DELETE", headers })),
  );
}
