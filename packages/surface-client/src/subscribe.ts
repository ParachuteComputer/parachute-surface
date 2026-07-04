/**
 * Live-query subscription contract — the shared types + query guard for
 * vault's `GET /vault/<name>/api/subscribe`. The **transport is WebSocket-only**
 * ({@link ./ws-transport.ts}); `VaultClient.subscribe()` is the consumer API.
 *
 * The server sends one `snapshot` (the currently-matching note set), then
 * `upsert` / `remove` messages as notes change. The same query grammar as
 * `GET /api/notes` applies, minus the shapes that can't be evaluated live
 * (`search`, `near`, `cursor` — vault rejects them with 400; we reject them
 * client-side, see {@link assertSubscribableQuery}).
 *
 * **Live is an augmentation; polling is the floor.** There is no SSE fallback —
 * SSE is being retired and the client never speaks it. When WS is unavailable
 * the live subscription degrades to the consumer's polling cadence rather than
 * erroring; see the `ws-transport.ts` header for the degradation model.
 *
 * **Reconnection is self-correcting.** Vault has no event replay: a reconnect
 * re-delivers a fresh snapshot that replaces the consumer's whole set, so a
 * dropped connection can never leave the consumer permanently stale. Reconnects
 * use capped exponential backoff ({@link SubscribeOptions.initialBackoffMs} /
 * `maxBackoffMs`).
 */

import type { Note } from "./vault-types.js";

/** Lifecycle signal for a live subscription. */
export type SubscribeStatus =
  /** First connection attempt is in flight. */
  | "connecting"
  /** Socket is open + authed; snapshot has been (or is about to be) delivered. */
  | "open"
  /** Connection dropped; a reconnect attempt is scheduled / in flight. */
  | "reconnecting"
  /** Terminal: unsubscribed, aborted, or an unrecoverable error. */
  | "closed";

export interface SubscribeHandlers {
  /**
   * The complete matching set, delivered once per (re)connect. A
   * re-delivered snapshot REPLACES the consumer's set (self-correcting
   * reconnect — see the module header).
   */
  onSnapshot: (notes: Note[]) => void;
  /** A note entered the set, or an in-set note changed. */
  onUpsert: (note: Note) => void;
  /**
   * A note left the set (update-no-longer-matches) or was deleted.
   * Idempotent — ignore ids you don't hold.
   */
  onRemove: (id: string) => void;
  /**
   * Invoked on every error the subscription encounters — transient
   * (connection drop, WS unavailable; reconnection continues) and terminal
   * alike. A terminal error is always followed by `onStatus("closed")`;
   * without that, the subscription is still retrying. Observational only —
   * a live-transport error must never become the consumer's data-error state
   * (that would make live worse than polling).
   */
  onError?: (err: unknown) => void;
  /** Lifecycle signal — see {@link SubscribeStatus}. */
  onStatus?: (status: SubscribeStatus) => void;
}

export interface SubscribeOptions {
  /** Abort the subscription externally (equivalent to calling unsubscribe). */
  signal?: AbortSignal;
  /** First reconnect delay in ms (doubles per attempt). Default 1000. */
  initialBackoffMs?: number;
  /** Backoff ceiling in ms. Default 30000. */
  maxBackoffMs?: number;
  /**
   * Interval between client-driven liveness pings (the literal `"ping"`
   * frame). Default 30000.
   */
  pingIntervalMs?: number;
  /**
   * How long to wait for a `"pong"` (or any other server frame) after a ping
   * before treating the socket as dead and reconnecting. Default 10000.
   */
  pongTimeoutMs?: number;
}

/**
 * Query shapes vault's `/api/subscribe` rejects with 400 — checked
 * client-side so a bad subscription throws synchronously instead of
 * opening a doomed connection. Mirrors `parachute-vault/src/subscribe.ts`:
 * `search` (FTS) and `near` (graph BFS) can't be evaluated against a
 * single changed note; `cursor` (paging) is meaningless for a live set.
 */
export function assertSubscribableQuery(params: URLSearchParams): void {
  if (params.get("search")) {
    throw new TypeError(
      "subscribe(): `search` (full-text) is not supported for live subscriptions — drop it or poll GET /notes?search=.",
    );
  }
  for (const key of params.keys()) {
    if (key === "near" || key.startsWith("near[")) {
      throw new TypeError(
        "subscribe(): `near` (graph neighborhood) is not supported for live subscriptions — drop it or poll GET /notes?near[note_id]=.",
      );
    }
  }
  if (params.get("cursor")) {
    throw new TypeError(
      "subscribe(): `cursor` (paging) is meaningless for a live subscription — the snapshot is always the complete matching set.",
    );
  }
}

/**
 * The minimal WebSocket surface the WS transport (`ws-transport.ts`) drives.
 * Typed structurally (rather than as the DOM `WebSocket`) so a test fake is
 * trivial and so the transport works under any runtime that ships a
 * WHATWG-shaped WebSocket global (browser, Bun, Node ≥ 22). Event params are
 * `any` on purpose — the DOM `WebSocket` is then structurally assignable to
 * this without a strict-function-types clash, and the transport reads only
 * `ev.data` / `ev.code` / `ev.reason` defensively.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((ev: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((ev: any) => void) | null;
}

/** Constructor for a {@link WebSocketLike} (the global `WebSocket`, or a fake). */
export type WebSocketCtor = new (url: string) => WebSocketLike;

/**
 * Transport seam between `VaultClient` and the WS subscription loop. Keeps
 * the loop independently testable and keeps token custody inside the
 * client — the loop sees a resolver + refresh callback, never a stored
 * token field.
 */
export interface SubscribeTransport {
  /** Fully-built subscribe URL (`<vaultUrl>/api/subscribe?<query>`, http(s)). */
  url: string;
  /** Resolve the bearer for the next connection attempt / re-auth. */
  resolveToken: () => Promise<string>;
  /**
   * The client's refresh-on-auth-failure seam. Returns a fresh token (the loop
   * re-auths / reconnects with it) or null when refresh isn't possible (the
   * loop terminates with `VaultAuthError`). Absent = no refresh path.
   */
  refreshToken?: (() => Promise<string | null>) | undefined;
  /**
   * WebSocket constructor used to open the live socket. Defaults to the
   * runtime's global `WebSocket` when omitted; when neither is available the
   * subscription signals "live unavailable" (the consumer keeps polling).
   * Injected in tests.
   */
  webSocketImpl?: WebSocketCtor | undefined;
}
