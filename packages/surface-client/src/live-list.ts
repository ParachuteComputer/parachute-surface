/**
 * Live-list — a framework-light reconciler over `VaultClient.subscribe()`.
 *
 * `VaultClient.subscribe()` is the raw transport: it hands you a `snapshot`
 * (the complete matching set) followed by `upsert` / `remove` deltas, plus a
 * lifecycle status. Every surface that wants a *live note list* then has to
 * hand-roll the same reconciliation: keep an ordered array, replace-in-place
 * on upsert, drop on remove, replace-wholesale on the next snapshot, and map
 * the transport status onto a UI-facing "is this live?" state.
 *
 * notes-ui did exactly this, coupled to TanStack Query (`live-query.ts`).
 * This module extracts the reconciliation core with **zero framework
 * dependency** — no React, no react-query — so any surface (vanilla,
 * React via `useSyncExternalStore`, signals, Svelte stores, …) can consume
 * the same well-tested logic. notes-ui now delegates to this core and keeps
 * only its react-query binding on top.
 *
 * ## Shape
 *
 * {@link createLiveList} opens a subscription and returns a small store:
 *
 *   - `getList()` — the current ordered `Note[]` (a stable reference between
 *     changes; a fresh array on every reconciled change so identity-based
 *     memoization works).
 *   - `getState()` — `{ status, list, thinking }` snapshot.
 *   - `subscribe(listener)` — register for change notifications; returns an
 *     unsubscribe. The signature is `useSyncExternalStore`-compatible
 *     (`(onStoreChange) => () => void`).
 *   - `close()` — tear down the subscription (idempotent).
 *
 * ## Status
 *
 * The transport's four-state lifecycle (`connecting` / `open` /
 * `reconnecting` / `closed`) is surfaced verbatim as {@link LiveListStatus},
 * except `open` is renamed `live` — the consumer-facing word. A list is
 * "live" only while the stream is open; in every other state the consumer
 * should treat the list as a best-effort cache (e.g. keep polling) — the
 * last good list is retained, never cleared, across reconnects and closes.
 *
 * ## Reconciliation (identical to notes-ui's prior contract)
 *
 *   - `snapshot` REPLACES the list wholesale (vault re-delivers a fresh
 *     snapshot on every reconnect — self-correcting; anything missed while
 *     disconnected is reconciled in one shot).
 *   - `upsert` replaces the row with the same `id` IN PLACE, or prepends it
 *     if new. We do not re-sort on a single upsert — vault's snapshot is the
 *     ordering authority; an in-place update keeps an already-rendered row
 *     from jumping while the user reads it, and the next snapshot re-aligns.
 *   - `remove` drops the row by `id`; idempotent.
 *   - A transient transport error changes NOTHING — the last list stays put.
 *
 * ## The "thinking" / live-activity indicator
 *
 * Agentic surfaces stream a note that's mid-generation with
 * `metadata.status: "thinking"` (vault's agent-thread convention), flipping
 * it to a terminal status when done. {@link LiveListState.thinking} is true
 * whenever any note in the current list is in such an in-progress status —
 * the data signal behind a "thinking…" / typing indicator. The set of
 * in-progress statuses is configurable ({@link CreateLiveListOptions.thinkingStatuses}).
 */

import type { SubscribeOptions, SubscribeStatus } from "./subscribe.js";
import { assertSubscribableQuery } from "./subscribe.js";
import type { Note } from "./vault-types.js";

/**
 * Minimal slice of `VaultClient` the live-list needs — just `subscribe`.
 * Typing the dependency as this structural interface (rather than the
 * concrete class) keeps the core trivially testable with a fake and avoids
 * a hard import cycle with the heavy client module.
 */
export interface LiveListClient {
  subscribe(
    query: unknown,
    handlers: {
      onSnapshot: (notes: Note[]) => void;
      onUpsert: (note: Note) => void;
      onRemove: (id: string) => void;
      onStatus?: (status: SubscribeStatus) => void;
      onError?: (err: unknown) => void;
    },
    opts?: SubscribeOptions,
  ): () => void;
}

/**
 * Consumer-facing lifecycle of a live list. Maps `VaultClient.subscribe()`'s
 * {@link SubscribeStatus} 1:1, renaming `open` → `live` (the consumer word).
 */
export type LiveListStatus =
  /** First connection attempt is in flight. */
  | "connecting"
  /** Stream is open and delivering — the list is authoritative + fresh. */
  | "live"
  /** Stream dropped; reconnecting (last good list retained). */
  | "reconnecting"
  /** Terminal: closed / unrecoverable error / unsubscribable query. */
  | "closed";

/** A point-in-time snapshot of a live list. */
export interface LiveListState {
  /** Consumer-facing lifecycle — see {@link LiveListStatus}. */
  status: LiveListStatus;
  /** The current ordered note list (best-effort across reconnects). */
  list: Note[];
  /**
   * True while any note in the list is in an in-progress status (default:
   * `metadata.status === "thinking"`). The signal behind a "thinking…" /
   * typing indicator. See {@link CreateLiveListOptions.thinkingStatuses}.
   */
  thinking: boolean;
}

export interface CreateLiveListOptions {
  /**
   * `metadata.status` values that count as "in progress" for the
   * {@link LiveListState.thinking} indicator. Defaults to `["thinking"]`.
   * Pass your own set (e.g. `["thinking", "streaming", "running"]`) to match
   * your surface's status vocabulary; pass `[]` to disable the indicator.
   */
  thinkingStatuses?: readonly string[];
  /** Forwarded to `VaultClient.subscribe()` (backoff, external abort). */
  subscribeOptions?: SubscribeOptions;
  /**
   * Surface transport errors. Transient errors keep retrying inside
   * `subscribe()` and never disturb the list — this is purely observational
   * (logging / diagnostics). A terminal error is always followed by a
   * `closed` status. Defaults to a no-op (a live-transport error must never
   * become the list's error state — that would make live worse than polling).
   */
  onError?: (err: unknown) => void;
}

/**
 * A live, reconciling note list. Framework-agnostic store: read with
 * {@link getState}/{@link getList}, observe with {@link subscribe}, dispose
 * with {@link close}.
 */
export interface LiveList {
  /** Current ordered note list. Fresh array on each reconciled change. */
  getList(): Note[];
  /** Current full state snapshot (status + list + thinking). */
  getState(): LiveListState;
  /**
   * Register for change notifications. The listener takes no arguments —
   * pull the new value via {@link getState}/{@link getList}. Returns an
   * unsubscribe. Signature is `useSyncExternalStore`-compatible.
   */
  subscribe(listener: () => void): () => void;
  /** Tear down the underlying subscription. Idempotent. */
  close(): void;
}

/**
 * Reconcile a single `upsert` into a list: replace the row with the same
 * `id` in place, or prepend it if new. Pure — returns a new array, leaves
 * the input untouched. Exported for direct testing + reuse.
 */
export function reconcileUpsert(list: Note[], note: Note): Note[] {
  const idx = list.findIndex((n) => n.id === note.id);
  if (idx === -1) return [note, ...list];
  const next = list.slice();
  next[idx] = note;
  return next;
}

/**
 * Reconcile a `remove`: drop the row by `id`. Idempotent — returns the SAME
 * reference when the id is absent (so consumers can skip a re-render). Pure.
 */
export function reconcileRemove(list: Note[], id: string): Note[] {
  const idx = list.findIndex((n) => n.id === id);
  if (idx === -1) return list;
  return list.filter((n) => n.id !== id);
}

/** Map a transport status to the consumer-facing live-list status. */
export function toLiveListStatus(status: SubscribeStatus): LiveListStatus {
  return status === "open" ? "live" : status;
}

/**
 * Whether a query (as raw `URLSearchParams`) can be evaluated as a live
 * stream — false for `search` / `near` / `cursor` (vault rejects them). Thin
 * boolean wrapper over {@link assertSubscribableQuery} for call sites that
 * want to branch rather than catch.
 */
export function isSubscribableParams(params: URLSearchParams): boolean {
  try {
    assertSubscribableQuery(params);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_THINKING_STATUSES = ["thinking"] as const;

/** Is any note in the list in an in-progress status? */
function computeThinking(list: Note[], statuses: readonly string[]): boolean {
  if (statuses.length === 0) return false;
  for (const note of list) {
    const status = note.metadata?.status;
    if (typeof status === "string" && statuses.includes(status)) return true;
  }
  return false;
}

/**
 * Open a live, reconciling note list over `client.subscribe(query, …)`.
 *
 * Returns immediately with an empty list in `connecting` status; the
 * snapshot/upsert/remove/status events drive it from there. For an
 * unsubscribable query (`search` / `near` / `cursor`) the list never opens a
 * stream — it stays `closed` with an empty list, and `onError` fires once
 * with the rejection so the caller can fall back to polling.
 *
 * @example
 * ```ts
 * const live = createLiveList(vault, { tag: "#agent/thread" });
 * const unsub = live.subscribe(() => render(live.getState()));
 * // later:
 * unsub();
 * live.close();
 * ```
 */
export function createLiveList(
  client: LiveListClient,
  query: URLSearchParams | Record<string, string> | unknown,
  opts: CreateLiveListOptions = {},
): LiveList {
  const thinkingStatuses = opts.thinkingStatuses ?? DEFAULT_THINKING_STATUSES;

  let list: Note[] = [];
  let status: LiveListStatus = "connecting";
  let thinking = false;
  let snapshot: LiveListState = { status, list, thinking };
  let closed = false;

  const listeners = new Set<() => void>();

  /**
   * Recompute the cached `thinking` flag + the immutable state snapshot, then
   * fan out to listeners. Called after every reconciled change. The snapshot
   * is rebuilt (not mutated) so `useSyncExternalStore`'s `Object.is` check
   * sees a new reference exactly when something changed.
   */
  const commit = () => {
    thinking = computeThinking(list, thinkingStatuses);
    snapshot = { status, list, thinking };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A throwing listener must not break fan-out to the others or the
        // reconcile loop.
      }
    }
  };

  /**
   * Branch unsubscribable queries before touching the transport: no stream,
   * terminal `closed`, surface the rejection once.
   */
  let params: URLSearchParams | null = null;
  if (query instanceof URLSearchParams) {
    params = query;
  } else if (query && typeof query === "object" && !Array.isArray(query)) {
    // Plain Record<string,string> — the only other shape we can pre-validate
    // without pulling in the full notes-query serializer. Other inputs (the
    // typed NotesQuery objects) are validated by subscribe() itself.
    try {
      params = new URLSearchParams(query as Record<string, string>);
    } catch {
      params = null;
    }
  }
  if (params && !isSubscribableParams(params)) {
    status = "closed";
    commit();
    try {
      assertSubscribableQuery(params);
    } catch (err) {
      opts.onError?.(err);
    }
    return {
      getList: () => snapshot.list,
      getState: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {},
    };
  }

  const unsubscribe = client.subscribe(
    query,
    {
      onSnapshot: (notes) => {
        if (closed) return;
        // Authoritative complete set — replace wholesale.
        list = notes.slice();
        commit();
      },
      onUpsert: (note) => {
        if (closed) return;
        list = reconcileUpsert(list, note);
        commit();
      },
      onRemove: (id) => {
        if (closed) return;
        const next = reconcileRemove(list, id);
        if (next === list) return; // id absent — nothing changed, no fan-out
        list = next;
        commit();
      },
      onStatus: (s) => {
        if (closed) return;
        const next = toLiveListStatus(s);
        if (next === status) return;
        status = next;
        commit();
      },
      onError: (err) => {
        // Observational only — the list is never disturbed by a transport
        // error (last good list stays put). A terminal error is followed by
        // onStatus("closed") above.
        opts.onError?.(err);
      },
    },
    opts.subscribeOptions,
  );

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
  };

  return {
    getList: () => snapshot.list,
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close,
  };
}
