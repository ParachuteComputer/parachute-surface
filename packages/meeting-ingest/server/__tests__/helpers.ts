/**
 * Test fixtures for the meeting-ingest surface: a scriptable fake vault
 * (mirroring surface-server's faithful behavior — typed not-found, opaque
 * versions, metadata-shorthand query matching for the dedup path), a fake
 * `SurfaceHostContext` over a REAL `SurfaceStateStore` (temp SQLite), and
 * `makeBackend` — the full factory with the GrantStore's live-query
 * subscription driven to "live" before the backend resolves.
 */

import { createHmac } from "node:crypto";
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
import { VaultNotFoundError } from "@openparachute/surface-client";
import { type BuildBackendOptions, type BuiltBackend, buildBackend } from "../index.ts";

export const MOUNT = "/surface/meeting-ingest";
export const ORIGIN = "https://meet.test";
export const OPERATOR_JWT = "operator-jwt-fixture";

export interface FakeSubscription {
  query: NotesQueryInput;
  handlers: SubscribeHandlers;
  opts: SubscribeOptions;
  unsubscribed: boolean;
}

function hasTag(note: Note, tag: string): boolean {
  return Array.isArray(note.tags) && note.tags.includes(tag);
}

/** Compute the Fireflies-style hex HMAC-SHA256 of a raw body, for tests. */
export function sign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Scriptable stand-in for the kit-visible ScopedVaultClient surface. */
export class FakeVault {
  readonly vaultName = "default";
  notes = new Map<string, Note>();
  subscriptions: FakeSubscription[] = [];
  createCalls: CreateNotePayload[] = [];
  queryCalls: NotesQueryInput[] = [];
  #idCounter = 0;
  #versionCounter = 0;

  nextVersion(): string {
    return `v-${++this.#versionCounter}`;
  }

  noteFixture(id: string, content: string, extra: Partial<Note> = {}): Note {
    const note: Note = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: this.nextVersion(),
      content,
      tags: ["meeting"],
      ...extra,
    };
    this.notes.set(id, note);
    return note;
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

  /**
   * Match notes the way the dedup path queries: `tag` (exact) +
   * `metadata[field]` shorthand equality. Faithful enough for the surface's
   * one query shape; not a full vault emulation.
   */
  matching(query: NotesQueryInput): Note[] {
    const q = query as { tag?: string; metadata?: Record<string, unknown> };
    let out = [...this.notes.values()];
    if (typeof q.tag === "string") out = out.filter((n) => hasTag(n, q.tag as string));
    if (q.metadata && typeof q.metadata === "object") {
      for (const [field, filter] of Object.entries(q.metadata)) {
        // Surface only uses scalar shorthand equality for dedup.
        out = out.filter((n) => n.metadata?.[field] === filter);
      }
    }
    return out;
  }

  async queryNotes(params: NotesQueryInput): Promise<Note[]> {
    this.queryCalls.push(params);
    return this.matching(params);
  }

  async getNote(id: string): Promise<Note | null> {
    const note = this.notes.get(id);
    if (note === undefined) throw new VaultNotFoundError(`note ${id} not found`);
    return note;
  }

  async updateNote(id: string, _payload: UpdateNotePayload): Promise<Note> {
    const existing = this.notes.get(id);
    if (!existing) throw new VaultNotFoundError(`note ${id} not found`);
    return existing;
  }

  async createNote(payload: CreateNotePayload): Promise<Note> {
    this.createCalls.push(payload);
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
}

export interface TestCtx {
  ctx: SurfaceHostContext;
  vault: FakeVault;
  store: SurfaceStateStore;
  controller: AbortController;
  config: Record<string, unknown>;
  logs: { warns: string[]; errors: string[]; logs: string[] };
}

export function makeTestCtx(
  opts: { vault?: FakeVault; config?: Record<string, unknown> } = {},
): TestCtx {
  const vault = opts.vault ?? new FakeVault();
  const config = opts.config ?? {};
  const dir = mkdtempSync(path.join(tmpdir(), "meeting-ingest-test-"));
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
    config: { all: () => ({ ...config }), get: (k: string) => config[k] },
    log: {
      log: (...a: unknown[]) => logs.logs.push(a.join(" ")),
      warn: (...a: unknown[]) => logs.warns.push(a.join(" ")),
      error: (...a: unknown[]) => logs.errors.push(a.join(" ")),
    },
    mount: MOUNT,
    shutdownSignal: controller.signal,
  };

  return { ctx, vault, store, controller, config, logs };
}

export interface MadeBackend extends BuiltBackend {
  ctx: SurfaceHostContext;
  vault: FakeVault;
  controller: AbortController;
  logs: TestCtx["logs"];
}

/**
 * Build the full backend over a fake vault. The factory awaits the
 * GrantStore's first snapshot, so this helper delivers it as soon as the
 * subscription registers.
 */
export async function makeBackend(
  opts: { vault?: FakeVault; config?: Record<string, unknown>; build?: BuildBackendOptions } = {},
): Promise<MadeBackend> {
  const { ctx, vault, controller, logs } = makeTestCtx({
    ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  });
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
    ...opts.build,
  });
  // The GrantStore subscription registers synchronously inside start(); the
  // factory then awaits its first snapshot.
  await Promise.resolve();
  vault.deliverSnapshots();
  const built = await building;
  return { ...built, ctx, vault, controller, logs };
}

/** POST a raw (already-serialized) webhook body with optional signature. */
export function postWebhook(
  backend: { fetch(req: Request): Response | Promise<Response> },
  provider: string,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/webhook/${provider}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: rawBody,
      }),
    ),
  );
}

export function get(
  backend: { fetch(req: Request): Response | Promise<Response> },
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(backend.fetch(new Request(`${ORIGIN}${MOUNT}${pathname}`, { headers })));
}
