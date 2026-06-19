/**
 * Test fixtures for the Meeting MCP surface: a scriptable fake vault
 * (mirroring surface-server's faithful behavior — typed not-found, opaque
 * versions, and the query matching this READ surface actually uses: tag,
 * metadata-shorthand equality, full-text `search`, and `limit`), a fake
 * `SurfaceHostContext` over a REAL `SurfaceStateStore` (temp SQLite), and
 * `makeBackend` — the full factory with the GrantStore's live-query
 * subscription driven to "live" before the backend resolves.
 *
 * No network: the fake vault is in-memory; nothing here talks to a real
 * vault or hub.
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
import { VaultNotFoundError } from "@openparachute/surface-client";
import { type BuildBackendOptions, type BuiltBackend, buildBackend } from "../index.ts";

export const MOUNT = "/surface/meeting-mcp";
export const ORIGIN = "https://meet.test";
export const OPERATOR_JWT = "operator-jwt-fixture";
export const TAG = "capture/meeting";

function hasTag(note: Note, tag: string): boolean {
  return Array.isArray(note.tags) && note.tags.includes(tag);
}

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
  /** Every queryNotes input, in call order (projection query inspection). */
  queryInputs: NotesQueryInput[] = [];
  /** When set, queryNotes throws (degraded path). */
  queryError: Error | null = null;
  #versionCounter = 0;

  nextVersion(): string {
    return `v-${++this.#versionCounter}`;
  }

  /** Seed a meeting note. */
  seed(id: string, extra: Partial<Note> = {}): Note {
    const note: Note = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: this.nextVersion(),
      tags: [TAG],
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
   * Match notes the way this surface's projections query: `tag` (exact),
   * `metadata[field]` shorthand equality, full-text `search` (substring over
   * content + title), `order_by created_at` + `sort`, and `limit`. Faithful
   * enough for the surface's query shapes; not a full vault emulation.
   */
  matching(query: NotesQueryInput): Note[] {
    const q = query as {
      tag?: string;
      metadata?: Record<string, unknown>;
      search?: string;
      sort?: "asc" | "desc";
      limit?: number;
    };
    let out = [...this.notes.values()];
    if (typeof q.tag === "string") out = out.filter((n) => hasTag(n, q.tag as string));
    if (q.metadata && typeof q.metadata === "object") {
      for (const [field, filter] of Object.entries(q.metadata)) {
        out = out.filter((n) => n.metadata?.[field] === filter);
      }
    }
    if (typeof q.search === "string" && q.search.length > 0) {
      const needle = q.search.toLowerCase();
      out = out.filter((n) => {
        const hay = `${n.content ?? ""} ${String(n.metadata?.title ?? "")}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    // Deterministic order: createdAt then id, honoring sort direction.
    out.sort((a, b) => {
      const cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id);
      return q.sort === "desc" ? -cmp : cmp;
    });
    if (typeof q.limit === "number" && q.limit >= 0) out = out.slice(0, q.limit);
    return out;
  }

  async queryNotes(params: NotesQueryInput): Promise<Note[]> {
    this.queryInputs.push(params);
    if (this.queryError) throw this.queryError;
    // Mirror the REAL vault: `order_by` works only on a field declared
    // `indexed: true` — the built-in created_at/updated_at columns and any
    // undeclared field 400 with FIELD_NOT_INDEXED. The fake declares none, so
    // any `orderBy` throws. (Trip-wire for the bug the live vault caught:
    // `orderBy: "created_at"` is invalid — use `sort: "desc"` for created_at.)
    const orderBy = (params as { orderBy?: unknown }).orderBy;
    if (typeof orderBy === "string" && orderBy.length > 0) {
      throw new Error(
        `metadata field "${orderBy}" is not indexed (order_by requires indexed:true) [FIELD_NOT_INDEXED]`,
      );
    }
    return this.matching(params);
  }

  async getNote(id: string): Promise<Note | null> {
    const note = this.notes.get(id);
    if (note === undefined) throw new VaultNotFoundError(`note ${id} not found`);
    return note;
  }

  // Write methods exist only to satisfy the client surface; this READ surface
  // never calls them. A call here would be a regression (asserted by the
  // read-only test).
  async updateNote(_id: string, _payload: UpdateNotePayload): Promise<Note> {
    throw new Error("meeting-mcp is read-only: updateNote must never be called");
  }
  async createNote(_payload: CreateNotePayload): Promise<Note> {
    throw new Error("meeting-mcp is read-only: createNote must never be called");
  }
  async deleteNote(_id: string): Promise<void> {
    throw new Error("meeting-mcp is read-only: deleteNote must never be called");
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
  const dir = mkdtempSync(path.join(tmpdir(), "meeting-mcp-test-"));
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
          scopes: ["vault:default:read"],
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

/** GET a mount-relative path. */
export function get(
  backend: { fetch(req: Request): Response | Promise<Response> },
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(backend.fetch(new Request(`${ORIGIN}${MOUNT}${pathname}`, { headers })));
}

/** POST a JSON-RPC body to the MCP endpoint. */
export function mcpPost(
  backend: { fetch(req: Request): Response | Promise<Response> },
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    backend.fetch(
      new Request(`${ORIGIN}${MOUNT}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}
