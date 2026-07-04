/**
 * Live-query layer — makes a react-query-cached note list update in real
 * time off vault's live-query WebSocket, with a graceful fallback to the
 * existing polling when a live stream isn't available (WS is the only live
 * transport — there is no SSE fallback; the fallback IS polling).
 *
 * ## Delegation to the SDK (dogfood)
 *
 * The subscribe→reconcile core — maintain an ordered list from the
 * `snapshot` + `upsert`/`remove` stream, replace-wholesale on reconnect,
 * track the open/connecting/reconnecting/closed lifecycle — lived here as a
 * notes-only copy. It now lives in `@openparachute/surface-client` as the
 * framework-light {@link createLiveList} store (the #140 extraction). This
 * module is the **react-query binding on top**: it spins up a `createLiveList`
 * for the query and mirrors its reconciled list into the TanStack Query cache
 * under the companion `useQuery`'s key. The reconciliation logic, the
 * subscribable-query guard, and the lifecycle handling are all the SDK's now;
 * notes-ui owns only the cache-mirroring + the polling-cadence signal.
 *
 * ## What it does
 *
 * `useLiveNotesQuery` takes the SAME `queryKey` + `URLSearchParams` a
 * react-query `useQuery({ queryKey, queryFn })` already drives, opens a
 * `createLiveList(client, params)` for that query, and mirrors its list into
 * the TanStack Query cache (`queryClient.setQueryData`) under the identical
 * key. Existing components keep reading `useQuery(...).data` and re-render
 * with zero changes — they don't know whether the row that just appeared came
 * from a poll or a live reconcile.
 *
 * The hook AUGMENTS polling; it never replaces it. When the live stream is
 * healthy it keeps the cache fresher than the poll interval would; when the
 * stream is unavailable or errors it does nothing, leaving the poll in charge.
 *
 * ## The fallback guarantee
 *
 *   - The cache is only written from the live list's reconciled snapshot —
 *     `createLiveList` retains the last good list across a transient drop, so
 *     a blip writes the SAME list, never an empty/stale one.
 *   - On reconnect vault re-delivers a fresh snapshot which REPLACES the list
 *     (self-correcting — anything missed while disconnected is reconciled
 *     wholesale).
 *   - When the subscription isn't open + healthy, `isLive` is false and the
 *     caller keeps its normal polling `staleTime`/`refetchInterval`. When
 *     live, the caller can relax that cadence.
 *   - Unsubscribable queries (`search` / `near` / `cursor`) never open a
 *     stream — `isLive` stays false and polling is the sole source.
 */

import {
  type LiveList,
  createLiveList,
  isSubscribableParams as sdkIsSubscribableParams,
  reconcileRemove as sdkReconcileRemove,
  reconcileUpsert as sdkReconcileUpsert,
} from "@openparachute/surface-client";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { VaultClient } from "./client";
import type { Note } from "./types";

/**
 * Whether a query (as raw search params) can be evaluated as a live stream.
 * Re-exported from the SDK so existing import sites keep resolving.
 */
export const isSubscribableParams = sdkIsSubscribableParams;

/**
 * Pure reconcilers — re-exported from the SDK (the canonical home after the
 * #140 extraction). Kept exported here so existing import sites / tests don't
 * churn; new code should import them from `@openparachute/surface-client`.
 */
export const reconcileUpsert = sdkReconcileUpsert;
export const reconcileRemove = sdkReconcileRemove;

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
   * True only while the stream is OPEN and healthy (the SDK list's `live`
   * status). The caller uses this to relax its polling cadence. When false —
   * never opened, unsubscribable query, connecting, reconnecting, or closed —
   * the caller keeps its normal polling `staleTime` so the UI never goes
   * staler than poll-only behavior.
   */
  isLive: boolean;
}

/**
 * Open a live subscription for a note-list query (via the SDK's
 * {@link createLiveList}) and mirror its reconciled list into the react-query
 * cache under `queryKey`. See the module header for the full contract +
 * fallback guarantee.
 *
 * Lifecycle: re-subscribes whenever `client`, the serialized `params`, or the
 * serialized `queryKey` changes; tears the live list down on unmount /
 * change. Reconnection + backoff + token-refresh are handled inside
 * `createLiveList` → `VaultClient.subscribe()`.
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

    // Rebuild a params instance from the serialized form so the effect's only
    // dependency on `params` is its string identity (see deps).
    const liveParams = new URLSearchParams(paramsKey);
    if (!isSubscribableParams(liveParams)) {
      // search / near / cursor — stays on polling, never opens a stream.
      return;
    }

    let active = true;

    const live: LiveList = createLiveList(client, liveParams);
    // The pristine initial list (empty, pre-first-snapshot). We must NOT mirror
    // this into the cache — doing so would clobber the existing poll result
    // with `[]` before any authoritative snapshot arrives. Only a reconciled
    // list (a different reference, produced by the first real snapshot onward)
    // is authoritative enough to write. `lastWritten` then dedupes repeat
    // writes of the same reconciled array.
    const initialList = live.getList();
    let lastWritten: Note[] | null = null;

    const apply = () => {
      if (!active) return;
      const state = live.getState();
      // `live` status (open) ⇒ relax polling; everything else ⇒ keep polling.
      // We never clear the cache on a non-live state — createLiveList retains
      // the last good list, so the cache stays as fresh as the last snapshot.
      setIsLive(state.status === "live");
      if (state.list !== initialList && state.list !== lastWritten) {
        lastWritten = state.list;
        queryClient.setQueryData<Note[]>(queryKey, state.list);
      }
    };

    const unsubscribe = live.subscribe(apply);
    apply(); // sync the initial (connecting / empty) state

    return () => {
      active = false;
      setIsLive(false);
      unsubscribe();
      live.close();
    };
    // `params`/`queryKey` are intentionally consumed via their serialized
    // identities (paramsKey/queryKeyStr) so a fresh object each render doesn't
    // thrash the subscription. queryClient is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey, queryKeyStr, enabled, queryClient]);

  return { isLive };
}
