/**
 * The server-entry contract for BACKED surfaces (surface-runtime design P1,
 * P5; backed-surface pattern "The shape: Surface is the runtime").
 *
 * A surface package that declares a `server` block in its meta.json ships a
 * module whose DEFAULT EXPORT is a factory:
 *
 * ```ts
 * export default function createBackend(ctx: SurfaceHostContext): SurfaceBackend;
 * ```
 *
 * THE CONTRACT (enforced by `backend-supervisor.ts`, documented here so
 * surface authors have one place to read):
 *
 *   - **No module-level side effects.** The entry module must not open
 *     ports, start timers, or touch the filesystem at import time — all
 *     work begins inside the factory (and stops on `ctx.shutdownSignal` /
 *     `shutdown()`). The host imports the module to discover the factory;
 *     an import is not a grant of runtime.
 *   - **The factory is called once per mount** (boot, add, reload). It may
 *     be synchronous or async. A throw (or rejection) marks the surface
 *     `backend-error` — the static bundle still serves.
 *   - **`fetch` is web-standard**: `Request` in, `Response` (or a promise
 *     of one) out. The host forwards EXACTLY two namespaces to it —
 *     `${mount}/api/*` and `${mount}/ws` — with the ORIGINAL pathname
 *     intact (use `ctx.mount` to strip the prefix). Static assets,
 *     `/oauth-client`, the admin SPA, and sibling surfaces are unreachable
 *     from a backend's router BY CONSTRUCTION (P4).
 *   - **Every request runs inside the host's containment middleware**
 *     (NON-OPTIONAL, §11): a per-request timeout (`server.timeoutMs`), an
 *     error boundary (a thrown/rejected handler 500s THAT surface only —
 *     generic JSON, no stack), and a crash-loop counter that quarantines a
 *     repeatedly-failing backend (`backend-disabled`, 503) until reload.
 *   - **`websocket` handlers are honored iff the surface declared the
 *     `"websocket"` capability** in its meta.json `server.capabilities`
 *     (deny-by-default at the host AND at the hub's upgrade bridge).
 *   - **`shutdown()` is bounded (~5s) and awaited on unmount.**
 *     `ctx.shutdownSignal` is aborted FIRST, so long-lived work
 *     (subscriptions, intervals) keyed to the signal stops before the
 *     final flush.
 */

import type { UiServerBlock } from "./meta-schema.ts";

/**
 * Substrate-stamped trust layer (design §10). Stamped by the HUB proxy as
 * `X-Parachute-Layer` on every forwarded request (inbound occurrences are
 * stripped at the public edge); read via `ctx.layer(req)`. Fail-closed:
 * absent or unrecognized → `"public"` (direct-to-1946 access has no hub
 * classification, so it gets no trust).
 */
export type TrustLayer = "loopback" | "tailnet" | "public";

export const TRUST_LAYERS: readonly TrustLayer[] = ["loopback", "tailnet", "public"];

/**
 * Per-connection data attached to a backend's WebSocket. Captured at
 * upgrade time from the hub-stamped trust headers (the upgrade `Request`
 * isn't available to the per-message handlers).
 */
export interface SurfaceSocketData {
  /** The owning surface's name (multiplexing key). */
  readonly surface: string;
  /** Trust layer at upgrade time (fail-closed `"public"`). */
  readonly layer: TrustLayer;
  /** Client IP at upgrade time, or null when unattributable. */
  readonly clientIp: string | null;
  /**
   * Unique id for this connection, stable for its lifetime — the host-
   * plane connection identity for logging and Map keys. Note: engine-
   * class protocols may mint their OWN connection ids (Hocuspocus's
   * ClientConnection does, and its disconnect hooks dedupe by THAT id);
   * this one identifies the host connection wrapping them.
   */
  readonly socketId: string;
}

/**
 * The socket handed to a backend's websocket handlers — a narrow,
 * runtime-agnostic view over Bun's `ServerWebSocket` so backends don't
 * couple to Bun types.
 *
 * IDENTITY CONTRACT: the host hands the SAME SurfaceSocket instance to
 * every open/message/close event of one connection, so backends may use
 * the object itself (or `data.socketId`) as a Map key for per-connection
 * state. `readyState` mirrors the underlying socket live (WebSocket
 * readyState vocabulary: 0 connecting, 1 open, 2 closing, 3 closed) —
 * engine classes that probe liveness before sending (Hocuspocus's
 * `WebSocketLike`) read it directly.
 */
export interface SurfaceSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly data: SurfaceSocketData;
}

/**
 * WebSocket handlers a backend may export (iff the `"websocket"` capability
 * is declared). The host's Bun-native server multiplexes connections across
 * surfaces and pumps open/message/close into these (P4) — the Hocuspocus /
 * y-protocols "transport-agnostic manual pumping" shape. Handler errors are
 * contained: the connection closes (1011) and counts toward the surface's
 * crash-loop window; siblings are unaffected.
 */
export interface BackendWebSocketHandlers {
  open?(ws: SurfaceSocket): void | Promise<void>;
  message?(ws: SurfaceSocket, message: string | Uint8Array): void | Promise<void>;
  close?(ws: SurfaceSocket, code: number, reason: string): void | Promise<void>;
}

/** What the server entry's factory returns. */
export interface SurfaceBackend {
  /** Web-standard request handler for `${mount}/api/*` (+ `${mount}/ws` refusals). */
  fetch(req: Request): Response | Promise<Response>;
  /** Present iff the surface declared the `"websocket"` capability. */
  websocket?: BackendWebSocketHandlers;
  /** Bounded (~5s), awaited on unmount AFTER `ctx.shutdownSignal` aborts. */
  shutdown?(): Promise<void>;
}

/** The server entry's default export. */
export type SurfaceBackendFactory = (
  ctx: SurfaceHostContext,
) => SurfaceBackend | Promise<SurfaceBackend>;

/**
 * Read access to the surface's own config (admin-editable). Reads are
 * dynamic — the backing file is re-read per call so an admin edit takes
 * effect without a remount.
 */
export interface SurfaceConfigAccess {
  /** The full config object (empty when none has been written). */
  all(): Record<string, unknown>;
  /** One key, or undefined. */
  get(key: string): unknown;
}

/** Prefixed logger flowing into the daemon's (supervisor-multiplexed) stream. */
export interface SurfaceLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * The per-surface host context (P2 — the keystone injection; capability,
 * never secret).
 *
 * Live-query subscriptions ride `vault.subscribe(...)` (surface-client
 * Tier 1) — bound to the same host-custodied credential, so there is no
 * separate `subscribe` member.
 */
export interface SurfaceHostContext {
  /**
   * Pre-authenticated, tag-scope-bound vault client. NO token accessor —
   * the credential lives host-side (P3); `force` writes are rejected
   * (vault-as-source-of-truth, design §9). See `scoped-vault-client.ts`.
   */
  vault: import("./scoped-vault-client.ts").ScopedVaultClient;
  /**
   * Per-surface SQLite blob store for OPERATIONAL state (CRDT snapshots,
   * caches, reconciliation cursors) — closed on unmount, file deleted on
   * surface removal. Knowledge lives in the vault, never here.
   */
  store: import("./surface-state-store.ts").SurfaceStateStore;
  /**
   * Trust layer for a request (design §10): reads the hub-stamped
   * `X-Parachute-Layer`. Backends MUST use this, never raw headers — and
   * never infer trust from header ABSENCE. Fail-closed `"public"`.
   */
  layer(req: Request): TrustLayer;
  /** Hub-stamped `X-Parachute-Client-IP`, or null. Fail-closed null. */
  clientIp(req: Request): string | null;
  /** The surface's own config (admin-editable), read dynamically. */
  config: SurfaceConfigAccess;
  /** Prefixed into the daemon's log stream as `[surface:<name>]`. */
  log: SurfaceLogger;
  /** The surface's mount path, e.g. `"/surface/woven-boulder"`. */
  mount: string;
  /** Aborted at unmount, BEFORE `shutdown()` is awaited. */
  shutdownSignal: AbortSignal;
}

/**
 * Real per-surface status (P5 — replaces the hardcoded `"active"`):
 *
 *   "static-only"      — no `server` block; the bundle serves, nothing to mount.
 *   "active"           — backend mounted and healthy.
 *   "failing"          — recent contained failures inside the crash-loop
 *                        window, below the quarantine threshold. Still serving.
 *   "backend-error"    — the factory (or entry import) failed at mount; the
 *                        static bundle still serves, `${mount}/api/*` 503s.
 *   "backend-disabled" — crash-loop quarantine; 503 until an operator reload.
 *
 * services.json stamping maps these onto the hub's UiSubUnitStatus
 * vocabulary (active|pending|inactive|failing): static-only/active →
 * "active", everything else → "failing".
 */
export type SurfaceStatus =
  | "static-only"
  | "active"
  | "failing"
  | "backend-error"
  | "backend-disabled";

/** The subset of a registered UI the supervisor needs (avoids a cycle). */
export interface BackendMountSpec {
  /** Surface name (meta.name). */
  name: string;
  /** Absolute path to the surface's installed root (`<uis>/<name>/`). */
  uiDir: string;
  /** Mount path (meta.path). */
  mount: string;
  /** The validated server block. */
  server: UiServerBlock;
}
