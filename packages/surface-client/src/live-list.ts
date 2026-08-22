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
 *
 * ## Deduplication — one socket per `(client, params)`
 *
 * `createLiveList` is **refcounted**. Two callers that ask the same client for
 * the same query share ONE `client.subscribe()` — one socket, one snapshot,
 * one reconciled list — and the transport is released only when the LAST of
 * them calls `close()`. This is the live analog of react-query's query-key
 * dedup, and it belongs here, at the layer that owns the socket: a surface
 * whose component tree grows a second consumer of the same list would
 * otherwise open a second stream, receive a second full snapshot, and race
 * the first one writing the same cache key. No caller-side discipline can
 * prevent that; this can.
 *
 * The details that make it safe:
 *
 *   - **Canonical key.** The query is serialized through the same
 *     `toNotesSearchParams` the client's `subscribe()` uses, then sorted, so
 *     equivalent queries dedup regardless of param order or input shape
 *     (`URLSearchParams`, a raw record, or a typed `NotesQuery`).
 *   - **Per-client.** The registry is a `WeakMap` keyed on the client, so two
 *     clients (two vaults, two tokens) never share a stream and a discarded
 *     client's entries are collectable.
 *   - **Per-consumer options stay per-consumer.** `thinkingStatuses` and
 *     `onError` are evaluated per handle; only the transport is shared.
 *   - **A caller passing `subscribeOptions` gets a dedicated subscription** —
 *     those carry a caller-owned `AbortSignal` / backoff policy, and one
 *     consumer must never be able to abort another's stream. `share: false`
 *     opts out explicitly.
 *   - **Teardown is delivery-safe.** A consumer may `close()` from inside its
 *     own change listener; the transport is released after the in-flight
 *     fan-out completes, never during it.
 *   - **Optional grace window.** `releaseDelayMs` holds the socket briefly
 *     after the last release so an unmount/remount across a route transition
 *     reuses it instead of churning. Default 0 — teardown is immediate unless
 *     a caller asks otherwise.
 */

import type { NotesQueryInput } from "./notes-query.js";
import { toNotesSearchParams } from "./notes-query.js";
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
   *
   * Evaluated per consumer: on a shared subscription every attached
   * consumer's `onError` sees the error, and a consumer's stops firing the
   * moment it calls `close()`.
   */
  onError?: (err: unknown) => void;
  /**
   * Share the underlying subscription with other consumers of the same
   * `(client, query)` — see the module header. Default `true`. Pass `false`
   * for a dedicated socket (a caller passing {@link subscribeOptions} always
   * gets one, since those are caller-owned).
   */
  share?: boolean;
  /**
   * Hold the shared subscription open for this many ms after the last
   * consumer releases it, so an unmount/remount of the same query (a route
   * transition, a React strict-mode double-effect) reuses the socket instead
   * of churning it. Default `0` — the transport is released synchronously
   * when the refcount hits zero.
   *
   * On a shared entry the LONGEST window any attached consumer asked for
   * wins, so one careful consumer's grace period is not undone by another's
   * default.
   */
  releaseDelayMs?: number;
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
 * The shared pre-first-snapshot list. Every consumer starts here, and a
 * reconciled list is always a fresh array (`notes.slice()` / the pure
 * reconcilers), so `state.list !== <the initial list>` remains a reliable
 * "has anything authoritative arrived yet?" test for bindings that must not
 * clobber a cache with an empty list.
 */
const EMPTY_LIST: Note[] = [];

/** One consumer's attachment to a shared entry. */
interface EntryHandle {
  /** Pull the entry's current state and fan out if it changed. */
  sync: () => void;
  /** Deliver an observational transport error. */
  error: (err: unknown) => void;
}

/**
 * One live subscription, shared by every consumer of the same
 * `(client, canonical params)`. Owns the transport and the reconciled list;
 * knows nothing about per-consumer options.
 */
interface LiveListEntry {
  list: Note[];
  status: LiveListStatus;
  handles: Set<EntryHandle>;
  /** Release the transport. Null until `client.subscribe()` has returned. */
  unsubscribe: (() => void) | null;
  /** Disposal beat `subscribe()`'s return — release as soon as it lands. */
  unsubscribePending: boolean;
  /** True while fanning out; teardown must wait for the loop to finish. */
  delivering: boolean;
  /** A refcount-zero that arrived mid-delivery, re-evaluated after it. */
  releaseAfterDelivery: boolean;
  /** Longest grace window any attached consumer has asked for. */
  releaseDelayMs: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  /** Drop this entry from its registry (a no-op for a dedicated entry). */
  deregister: () => void;
}

/**
 * Live-list registries, one per client instance. A `WeakMap` so entries for a
 * discarded client (a re-auth, a vault switch) are collectable and can never
 * be handed to a consumer of a different client.
 */
const registries = new WeakMap<object, Map<string, LiveListEntry>>();

/**
 * Canonical dedup key for a query, or `null` when the input shape can't be
 * keyed (in which case the caller gets a dedicated subscription — the
 * pre-registry behavior).
 *
 * Serialized through the same `toNotesSearchParams` the client's
 * `subscribe()` uses, so the key is the wire query itself; then sorted by
 * `(name, value)` so param ORDER can't split two identical subscriptions.
 * Sorting pairs — not deduping them — keeps repeated keys (`extension=md&
 * extension=txt`) multiplicity-preserving: a different multiset is a
 * different query.
 */
function canonicalQueryKey(query: unknown): string | null {
  const keyable =
    query instanceof URLSearchParams ||
    (typeof query === "object" && query !== null && !Array.isArray(query));
  if (!keyable) return null;
  let params: URLSearchParams;
  try {
    params = toNotesSearchParams(query as NotesQueryInput);
  } catch {
    // An unserializable query (e.g. an unknown metadata operator) can't be
    // keyed; `subscribe()` will reject it on its own terms.
    return null;
  }
  const pairs = [...params.entries()];
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] === b[1]) return 0;
    return a[1] < b[1] ? -1 : 1;
  });
  const canonical = new URLSearchParams();
  for (const [name, value] of pairs) canonical.append(name, value);
  return canonical.toString();
}

/** An entry with no transport yet — {@link startEntry} attaches one. */
function makeEntry(deregister: () => void): LiveListEntry {
  return {
    list: EMPTY_LIST,
    status: "connecting",
    handles: new Set(),
    unsubscribe: null,
    unsubscribePending: false,
    delivering: false,
    releaseAfterDelivery: false,
    releaseDelayMs: 0,
    releaseTimer: null,
    disposed: false,
    deregister,
  };
}

/**
 * Release the transport and retire the entry. Deregisters BEFORE unsubscribing
 * so that a consumer created re-entrantly from the teardown path opens a fresh
 * subscription rather than attaching to this dead one.
 */
function disposeEntry(entry: LiveListEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  if (entry.releaseTimer !== null) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  entry.deregister();
  if (entry.unsubscribe) entry.unsubscribe();
  else entry.unsubscribePending = true;
}

/**
 * Refcount hit zero — tear down, unless we're mid-fan-out (defer past it) or a
 * grace window is configured (defer by it, cancellable by a new consumer).
 */
function scheduleRelease(entry: LiveListEntry): void {
  if (entry.disposed || entry.handles.size > 0) return;
  if (entry.delivering) {
    // Never unsubscribe a transport from inside its own event delivery.
    entry.releaseAfterDelivery = true;
    return;
  }
  if (entry.releaseDelayMs > 0) {
    if (entry.releaseTimer !== null) return;
    const timer = setTimeout(() => {
      entry.releaseTimer = null;
      if (entry.handles.size === 0) disposeEntry(entry);
    }, entry.releaseDelayMs);
    // A grace-window timer must never hold a process open.
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.releaseTimer = timer;
    return;
  }
  disposeEntry(entry);
}

/** Fan an entry-level event out to every attached handle, teardown-safe. */
function deliver(entry: LiveListEntry, visit: (handle: EntryHandle) => void): void {
  entry.delivering = true;
  try {
    // Iterate a copy: a consumer may close itself (mutating the set) from
    // inside its own listener.
    for (const handle of [...entry.handles]) visit(handle);
  } finally {
    entry.delivering = false;
    if (entry.releaseAfterDelivery) {
      entry.releaseAfterDelivery = false;
      scheduleRelease(entry);
    }
  }
}

/**
 * Open the entry's transport. Split from {@link makeEntry} so the first
 * consumer can already be attached when `subscribe()` runs — a transport that
 * delivers synchronously must reach it synchronously.
 */
function startEntry(
  entry: LiveListEntry,
  client: LiveListClient,
  query: unknown,
  subscribeOptions: SubscribeOptions | undefined,
): void {
  const unsubscribe = client.subscribe(
    query,
    {
      onSnapshot: (notes) => {
        if (entry.disposed) return;
        // Authoritative complete set — replace wholesale.
        entry.list = notes.slice();
        deliver(entry, (h) => h.sync());
      },
      onUpsert: (note) => {
        if (entry.disposed) return;
        entry.list = reconcileUpsert(entry.list, note);
        deliver(entry, (h) => h.sync());
      },
      onRemove: (id) => {
        if (entry.disposed) return;
        const next = reconcileRemove(entry.list, id);
        if (next === entry.list) return; // id absent — nothing changed, no fan-out
        entry.list = next;
        deliver(entry, (h) => h.sync());
      },
      onStatus: (s) => {
        if (entry.disposed) return;
        const next = toLiveListStatus(s);
        if (next === entry.status) return;
        entry.status = next;
        deliver(entry, (h) => h.sync());
      },
      onError: (err) => {
        // Observational only — the list is never disturbed by a transport
        // error (last good list stays put). A terminal error is followed by
        // onStatus("closed") above.
        deliver(entry, (h) => h.error(err));
      },
    },
    subscribeOptions,
  );
  if (entry.unsubscribePending) unsubscribe();
  else entry.unsubscribe = unsubscribe;
}

/**
 * Attach one consumer to an entry and hand back its {@link LiveList} view.
 * The consumer owns its own listener set, its own `thinking` computation, and
 * its own immutable state snapshot; it shares only the transport and the
 * reconciled list.
 */
function attachHandle(entry: LiveListEntry, opts: CreateLiveListOptions): LiveList {
  const thinkingStatuses = opts.thinkingStatuses ?? DEFAULT_THINKING_STATUSES;
  const listeners = new Set<() => void>();

  let released = false;
  let seenList: Note[] = EMPTY_LIST;
  let seenStatus: LiveListStatus = "connecting";
  let snapshot: LiveListState = { status: "connecting", list: EMPTY_LIST, thinking: false };

  /**
   * Recompute this consumer's `thinking` flag + immutable state snapshot from
   * the entry, then fan out to its listeners. The snapshot is rebuilt (not
   * mutated) so `useSyncExternalStore`'s `Object.is` check sees a new
   * reference exactly when something changed — and is skipped entirely when
   * nothing did.
   */
  const sync = () => {
    if (released) return;
    if (entry.list === seenList && entry.status === seenStatus) return;
    seenList = entry.list;
    seenStatus = entry.status;
    snapshot = {
      status: entry.status,
      list: entry.list,
      thinking: computeThinking(entry.list, thinkingStatuses),
    };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A throwing listener must not break fan-out to the others or the
        // reconcile loop.
      }
    }
  };

  const handle: EntryHandle = {
    sync,
    error: (err) => {
      if (released) return;
      opts.onError?.(err);
    },
  };

  entry.handles.add(handle);
  // A new consumer cancels any pending release — this is the remount case the
  // grace window exists for.
  if (entry.releaseTimer !== null) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  entry.releaseAfterDelivery = false;
  if (opts.releaseDelayMs !== undefined && opts.releaseDelayMs > entry.releaseDelayMs) {
    entry.releaseDelayMs = opts.releaseDelayMs;
  }

  // Late joiner: the shared stream is already established. Deliver its current
  // state as this consumer's FIRST CHANGE (on a microtask) rather than as its
  // initial value, so it observes exactly the sequence it would have seen with
  // a socket of its own — pristine `connecting`/`[]`, then a snapshot. That
  // keeps bindings which treat the pristine initial list as not-yet-
  // authoritative (react-query cache mirroring) writing their cache normally.
  if (entry.list !== seenList || entry.status !== seenStatus) queueMicrotask(sync);

  return {
    getList: () => snapshot.list,
    getState: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      if (released) return;
      released = true;
      entry.handles.delete(handle);
      if (entry.handles.size === 0) scheduleRelease(entry);
    },
  };
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
  /**
   * Branch unsubscribable queries before touching the transport OR the
   * registry: no stream, terminal `closed`, surface the rejection once.
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
    const listeners = new Set<() => void>();
    const snapshot: LiveListState = { status: "closed", list: EMPTY_LIST, thinking: false };
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

  // A caller-owned `subscribeOptions` (an AbortSignal, a backoff policy) must
  // never govern someone else's stream — such a caller always gets its own.
  const shareable = opts.share !== false && opts.subscribeOptions === undefined;
  const key = shareable ? canonicalQueryKey(query) : null;

  if (key !== null) {
    // `client` is an object here by the LiveListClient contract; guard anyway
    // so a stray primitive degrades to a dedicated subscription rather than
    // throwing out of the WeakMap.
    const clientKey =
      typeof client === "object" && client !== null ? (client as unknown as object) : null;
    if (clientKey) {
      let registry = registries.get(clientKey);
      if (!registry) {
        registry = new Map<string, LiveListEntry>();
        registries.set(clientKey, registry);
      }
      const existing = registry.get(key);
      if (existing && !existing.disposed) return attachHandle(existing, opts);

      const owner = registry;
      const entry: LiveListEntry = makeEntry(() => {
        if (owner.get(key) === entry) owner.delete(key);
      });
      owner.set(key, entry);
      // Attach BEFORE starting: a transport that delivers synchronously must
      // reach the first consumer synchronously (pre-registry behavior).
      const live = attachHandle(entry, opts);
      try {
        startEntry(entry, client, query, undefined);
      } catch (err) {
        // `subscribe()` rejected the query — retire the entry so the next
        // caller doesn't attach to a stream that never opened.
        entry.disposed = true;
        entry.deregister();
        throw err;
      }
      return live;
    }
  }

  // Dedicated subscription — same machinery, never registered.
  const entry = makeEntry(() => {});
  const live = attachHandle(entry, opts);
  startEntry(entry, client, query, opts.subscribeOptions);
  return live;
}
