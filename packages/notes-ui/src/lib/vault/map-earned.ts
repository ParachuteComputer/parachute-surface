/**
 * The Map's earned-threshold (SYNTHESIS D5).
 *
 * The relational Map isn't a day-1 room — three nodes and a dashed plus is not
 * a map. It stays AMBIENT (a bottom-right FAB, `AmbientMapFab`) until the
 * vault's real graph is worth a permanent slot, then it graduates into the
 * rail. Two cheap, honest signals gate that:
 *   - ≥ 2 connected vaults (always known from the store, zero cost), or
 *   - ≥ 15 linked notes in the vault graph.
 *
 * The linked-note count is read CACHE-ONLY: a disabled query observer that
 * subscribes to the same `["allNotesWithLinks", …]` entry the Map itself
 * fetches, so the ambient signal never triggers a full-vault fetch on its own.
 * The Map row fills in reactively once something that legitimately needs the
 * graph has loaded it — no new backend, no per-page over-fetch.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { buildVaultGraph } from "./graph";
import { useVaultStore } from "./store";
import type { Note } from "./types";

export const MAP_EARN_LINKED_NOTES = 15;
export const MAP_EARN_VAULTS = 2;

/** Count of notes with at least one link in or out (degree > 0). */
export function linkedNoteCount(notes: readonly Note[] | undefined): number {
  if (!notes || notes.length === 0) return 0;
  const graph = buildVaultGraph([...notes]);
  let linked = 0;
  for (const node of graph.nodes) if (node.degree > 0) linked++;
  return linked;
}

/** Pure threshold — testable without a query cache. */
export function isMapEarned(vaultCount: number, linked: number): boolean {
  return vaultCount >= MAP_EARN_VAULTS || linked >= MAP_EARN_LINKED_NOTES;
}

export function useMapEarned(): boolean {
  const vaultCount = useVaultStore((s) => Object.keys(s.vaults).length);
  const activeId = useVaultStore((s) => s.activeVaultId);
  // enabled:false → reads the cache and re-renders on external updates, but
  // never fetches. The queryFn is a guard that can't run (kept for type shape).
  const cached = useQuery<Note[]>({
    queryKey: ["allNotesWithLinks", activeId],
    queryFn: () => {
      throw new Error("useMapEarned reads the query cache only");
    },
    enabled: false,
  });
  const linked = useMemo(() => linkedNoteCount(cached.data), [cached.data]);
  return isMapEarned(vaultCount, linked);
}
