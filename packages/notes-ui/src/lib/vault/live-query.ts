/**
 * Live-query layer — makes a react-query-cached note list update in real
 * time off vault's live-query SSE (`VaultClient.subscribe()`), with a
 * graceful fallback to the existing polling when a live stream isn't
 * available.
 *
 * ## What it does
 *
 * `useLiveNotesQuery` takes the SAME `queryKey` + `URLSearchParams` a
 * react-query `useQuery({ queryKey, queryFn })` already drives, opens a
 * `vault.subscribe(params, ...)` for that query, and reconciles the live
 * events into the TanStack Query cache (`queryClient.setQueryData`) under
 * the identical key. Existing components keep reading `useQuery(...).data`
 * and re-render with zero changes — they don't know whether the row that
 * just appeared came from a poll or a live upsert.
 *
 * The hook AUGMENTS polling; it never replaces it. The caller keeps its
 * `useQuery` exactly as before (initial fetch, error UI, offline, the
 * polling cadence). This hook is a sidecar that, when a live stream is
 * healthy, keeps the cache fresher than the poll interval would — and when
 * the stream is unavailable or errors, simply does nothing, leaving the
 * poll in charge.
 *
 * ## The fallback guarantee
 *
 * The live path must never leave the UI emptier or staler than polling did:
 *
 *   - The cache is only written from an authoritative live event
 *     (`snapshot` = the complete matching set; `upsert`/`remove` = a single
 *     reconciled change). A transient connection error writes NOTHING — the
 *     last poll/snapshot result stays put.
 *   - `snapshot` REPLACES the list (vault re-delivers a fresh snapshot on
 *     every reconnect — self-correcting; anything missed while disconnected
 *     is reconciled wholesale).
 *   - When the subscription isn't open + healthy, `isLive` is false and the
 *     caller leaves its normal polling `staleTime`/`refetchInterval` in
 *     place. When live + healthy, the caller can relax that cadence (the
 *     stream keeps the cache fresh). See {@link useLiveNotesQuery}'s return.
 *   - Unsubscribable queries (`search` / `near` / `cursor`) never open a
 *     stream — `isLive` stays false and polling is the sole source.
 *
 * ## Reconciliation
 *
 * `upsert` replaces the matching row by `id` in place (or prepends a new
 * one); `remove` drops it by `id`. We do NOT re-sort or re-page on a single
 * upsert — vault's snapshot is the source of truth for ordering, and the
 * next snapshot (reconnect) or poll re-establishes the exact server order.
 * The in-place upsert keeps an already-rendered row from jumping while the
 * user reads it; ordering drift between snapshots is bounded and self-heals.
 */

import { assertSubscribableQuery } from "@openparachute/surface-client";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { VaultClient } from "./client";
import type { Note } from "./types";

/** Whether a query (as raw search params) can be evaluated as a live stream. */
export function isSubscribableParams(params: URLSearchParams): boolean {
  try {
    assertSubscribableQuery(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile a single `upsert` into an existing list: replace the row with
 * the same `id` in place, or prepend it if it's new. Pure — returns a new
 * array, leaves the input untouched. Exported for direct testing.
 */
export function reconcileUpsert(list: Note[], note: Note): Note[] {
  const idx = list.findIndex((n) => n.id === note.id);
  if (idx === -1) return [note, ...list];
  const next = list.slice();
  next[idx] = note;
  return next;
}

/** Reconcile a `remove`: drop the row by `id`. Idempotent. Pure. */
export function reconcileRemove(list: Note[], id: string): Note[] {
  const idx = list.findIndex((n) => n.id === id);
  if (idx === -1) return list;
  return list.filter((n) => n.id !== id);
}

export interface UseLiveNotesQueryArgs {
  /** The react-query cache key the companion `useQuery` writes to. */
  queryKey: QueryKey;
  /**
   * The query, as the exact `URLSearchParams` the companion `useQuery`'s
   * `queryFn` passes to `client.queryNotes(...)`. Same grammar, same
   * server-side evaluation — so the live snapshot matches the polled list.
   */
  params: URLSearchParams;
  /** The active vault client (or null — hook is inert until one exists). */
  client: VaultClient | null;
  /**
   * Disable the live path entirely (caller still polls). Defaults to
   * enabled. Use when the companion `useQuery` is itself disabled.
   */
  enabled?: boolean;
}

export interface UseLiveNotesQueryResult {
  /**
   * True only while the stream is OPEN and healthy. The caller uses this to
   * relax its polling cadence (the live stream keeps the cache fresh). When
   * false — never opened, unsubscribable query, connecting, reconnecting,
   * or closed — the caller keeps its normal polling `staleTime` so the UI
   * never goes staler than poll-only behavior.
   */
  isLive: boolean;
}

/**
 * Open a live subscription for a note-list query and reconcile its events
 * into the react-query cache under `queryKey`. See the module header for
 * the full contract + fallback guarantee.
 *
 * Lifecycle: re-subscribes whenever `client`, the serialized `params`, or
 * the serialized `queryKey` changes; tears the stream down on unmount /
 * change (the unsubscribe returned by `subscribe`). Reconnection +
 * backoff + token-refresh are handled inside `VaultClient.subscribe()`.
 */
export function useLiveNotesQuery({
  queryKey,
  params,
  client,
  enabled = true,
}: UseLiveNotesQueryArgs): UseLiveNotesQueryResult {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(false);

  // Stable string identities so the effect re-runs only on a real change,
  // not on every render's fresh URLSearchParams/array instance.
  const paramsKey = params.toString();
  const queryKeyStr = JSON.stringify(queryKey);

  useEffect(() => {
    setIsLive(false);
    if (!enabled || !client) return;

    // Rebuild a params instance from the serialized form so the effect's
    // only dependency on `params` is its string identity (see deps).
    const liveParams = new URLSearchParams(paramsKey);
    if (!isSubscribableParams(liveParams)) {
      // search / near / cursor — stays on polling, never opens a stream.
      return;
    }

    let active = true;

    const unsubscribe = client.subscribe(liveParams, {
      onSnapshot: (notes) => {
        if (!active) return;
        // Authoritative full set — replace the cached list wholesale.
        queryClient.setQueryData<Note[]>(queryKey, notes);
      },
      onUpsert: (note) => {
        if (!active) return;
        queryClient.setQueryData<Note[]>(queryKey, (prev) =>
          reconcileUpsert(prev ?? [], note),
        );
      },
      onRemove: (id) => {
        if (!active) return;
        queryClient.setQueryData<Note[]>(queryKey, (prev) =>
          reconcileRemove(prev ?? [], id),
        );
      },
      onStatus: (status) => {
        if (!active) return;
        // Live only while OPEN. connecting/reconnecting/closed → fall back
        // to polling (caller re-applies its normal staleTime). We never
        // clear the cache here — the last good data stays until the next
        // authoritative snapshot or poll.
        setIsLive(status === "open");
      },
      // onError: transient errors keep retrying inside subscribe(); a
      // terminal error is always followed by onStatus("closed"), which
      // flips isLive false above. Nothing to do here but swallow — we must
      // not surface live-transport errors as the list's error state (that
      // would make the live path WORSE than polling).
      onError: () => {},
    });

    return () => {
      active = false;
      setIsLive(false);
      unsubscribe();
    };
    // `params`/`queryKey` are intentionally consumed via their serialized
    // identities (paramsKey/queryKeyStr) so a fresh object each render
    // doesn't thrash the subscription. queryClient is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey, queryKeyStr, enabled, queryClient]);

  return { isLive };
}
