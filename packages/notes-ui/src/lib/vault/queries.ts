import type { LensDB } from "@/lib/sync/db";
import { isLocalId, newLocalId, resolveNoteId } from "@/lib/sync/id-map";
import { enqueue } from "@/lib/sync/queue";
import { useSync } from "@/providers/SyncProvider";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuthHaltStore } from "./auth-halt-store";
import {
  type CreateNotePayload,
  type StorageUploadResult,
  type UpdateNotePayload,
  type UploadProgress,
  VaultClient,
} from "./client";
import { useLiveNotesQuery } from "./live-query";
import { type NoteQueryState, buildNoteQueryParams } from "./note-query";
import { useVaultReachabilityStore } from "./reachability-store";
import { forceRefresh } from "./refresh";
import { loadToken } from "./storage";
import { useVaultStore } from "./store";
import type { Note, NoteAttachment, TagRecord, TagUpsertPayload } from "./types";

export function useActiveVaultClient(): VaultClient | null {
  const vault = useVaultStore((s) => s.getActiveVault());
  const activeId = useVaultStore((s) => s.activeVaultId);
  return useMemo(() => {
    if (!vault || !activeId) return null;
    const token = loadToken(activeId);
    if (!token) return null;
    return new VaultClient({
      vaultUrl: vault.url,
      accessToken: token.accessToken,
      onAuthError: () => forceRefresh(activeId),
      onAuthRevoked: (status) =>
        useAuthHaltStore
          .getState()
          .markHalted(activeId, `Vault rejected the current session (${status}).`),
      onReachability: (signal, reason) =>
        useVaultReachabilityStore.getState().reportSignal(activeId, signal, reason),
    });
  }, [vault, activeId]);
}

export function useVaultInfo() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["vaultInfo", activeId],
    enabled: !!client,
    queryFn: () => client!.vaultInfo(true),
    staleTime: 30_000,
  });
}

/**
 * The vault's declared voice-transcription capability — what the mic
 * affordance gates on (launch-audit P0-3: free-tier cloud vaults showed
 * "Record voice memo" then landed "_Transcription unavailable._").
 *
 * The two doors declare it in different places (verified 2026-07-03):
 *   - self-host: `GET /api/vault` carries `transcription: { enabled,
 *     provider? }` (vault#529) — already fetched + cached by
 *     `useVaultInfo`, so this leg costs nothing extra.
 *   - cloud: the BARE landing `GET <vaultUrl>` carries `transcription:
 *     { enabled, minutes_remaining }` (cloud#56); cloud's `/api/vault`
 *     does NOT. The fallback probe below fires only when `/api/vault`
 *     resolved WITHOUT the field, and is cached like the rest of vault
 *     config — never a per-render network call.
 *
 * Returns `undefined` while loading or when neither door declares the
 * capability (older self-host vaults) — callers must treat that as
 * "undeclared" and keep the mic (absent ≠ disabled; back-compat).
 */
export function useTranscriptionCapability() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const info = useVaultInfo();

  // Only probe the bare landing once /api/vault has answered without the
  // field. Older vaults 404/answer without it — `retry: false` keeps the
  // probe to a single attempt per cache window.
  const needsLandingProbe = !!client && info.isSuccess && info.data?.transcription === undefined;
  const landing = useQuery({
    queryKey: ["vaultLanding", activeId],
    enabled: needsLandingProbe,
    queryFn: () => client!.vaultLanding(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return info.data?.transcription ?? landing.data?.transcription;
}

export function useNotes(queryState: NoteQueryState) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  const queryKey = useMemo(() => ["notes", activeId, queryState], [activeId, queryState]);
  const params = useMemo(() => buildNoteQueryParams(queryState), [queryState]);

  // Live layer: open an SSE subscription for this exact query and reconcile
  // events into the same cache key. When the stream is open + healthy we
  // relax the aggressive 10s staleTime (the stream keeps the cache fresh);
  // on any non-open state we revert to polling. The hook is a no-op for
  // unsubscribable queries (e.g. `search`) — those stay on polling. See
  // `live-query.ts` for the full fallback guarantee.
  const { isLive } = useLiveNotesQuery({ queryKey, params, client });

  return useQuery({
    queryKey,
    enabled: !!client,
    queryFn: () => client!.queryNotes(params),
    staleTime: isLive ? Number.POSITIVE_INFINITY : 10_000,
    placeholderData: keepPreviousData,
  });
}

// Cap on how many notes to pull back for the full-vault graph in v1.
// If a vault grows beyond this, the graph page will show the first N —
// pagination/sampling is a future PR.
export const VAULT_GRAPH_NOTE_CAP = 5000;

// Lightweight variant for the Cmd+K switcher: no links, no content — just
// enough to render a title/path/tags line per entry. Capped at the same N
// as the graph so huge vaults degrade gracefully (pagination is a later PR).
export function useAllNotesForSwitcher(enabled: boolean) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["allNotesForSwitcher", activeId],
    enabled: !!client && enabled,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("include_content", "true");
      params.set("limit", String(VAULT_GRAPH_NOTE_CAP));
      return client!.queryNotes(params);
    },
    staleTime: 60_000,
  });
}

// Fetches a capped window of recent notes (by vault's default sort, desc) for
// date-grouped surfaces like /today and /calendar. The vault has no date-range
// filter, so we client-side bucket. A vault with more than the cap gets the
// most-recent N — older days on the calendar show empty.
export function useNotesForDateViews() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  const queryKey = useMemo(() => ["notesForDateViews", activeId], [activeId]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("sort", "desc");
    p.set("limit", String(VAULT_GRAPH_NOTE_CAP));
    return p;
  }, []);

  // Live layer for Today / Activity / Calendar — same reconcile-into-cache
  // pattern as `useNotes`. The capped recent-notes window is a plain
  // sort+limit query (subscribable). When live, relax the 60s staleTime.
  const { isLive } = useLiveNotesQuery({ queryKey, params, client });

  return useQuery({
    queryKey,
    enabled: !!client,
    queryFn: () => client!.queryNotes(params),
    staleTime: isLive ? Number.POSITIVE_INFINITY : 60_000,
  });
}

// Fetches a capped metadata-only window of the vault for the path-tree
// sidebar. We want a stable index of every path so the tree and threshold
// check aren't skewed by whatever filter is currently applied to the main
// list. Capped at VAULT_GRAPH_NOTE_CAP; vaults beyond that get a tree for
// the most-recent N paths (the fallback input on the filter bar still works
// for navigating outside the window).
export function useNotesForPathTree(enabled: boolean) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["notesForPathTree", activeId],
    enabled: !!client && enabled,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("sort", "desc");
      params.set("limit", String(VAULT_GRAPH_NOTE_CAP));
      return client!.queryNotes(params);
    },
    staleTime: 60_000,
  });
}

export function useAllNotesWithLinks() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["allNotesWithLinks", activeId],
    enabled: !!client,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("include_links", "true");
      params.set("limit", String(VAULT_GRAPH_NOTE_CAP));
      return client!.queryNotes(params);
    },
    staleTime: 60_000,
  });
}

export function useTags() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["tags", activeId],
    enabled: !!client,
    queryFn: () => client!.listTags(),
    staleTime: 60_000,
  });
}

// Same source as `useTags()` but returns the joined TagRecord[] shape with
// description / fields / parent_names / relationships per tag. Vault's
// `GET /api/tags?include_schema=true` returns a single envelope so this is
// one request, not N. Used by the Notes UI tag viewer (notes-ui,
// 2026-05-27 unified create + tag schemas pass) so the row UI can show
// "fields: a, b, c" inline without a waterfall.
//
// Separate hook (not an overload of `useTags`) so the cache key is
// distinct — the cheap listing and the schema-bearing listing are
// different queries with different invalidation lifetimes.
export function useTagsWithSchema() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);

  return useQuery({
    queryKey: ["tags", activeId, "with-schema"],
    enabled: !!client,
    queryFn: () => client!.listTags({ includeSchema: true }),
    staleTime: 60_000,
  });
}

// Single-tag identity row (description, fields, parent_names, relationships).
// Used by the Tags page schema editor (notes-ui, 2026-05-27). VaultClient
// resolves a 404 to `null`, so consumers can treat "no schema yet" as the
// data shape without forking on error.
export function useTag(name: string | null) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  return useQuery({
    queryKey: ["tag", activeId, name],
    enabled: !!client && !!name,
    queryFn: () => client!.getTag(name!),
    staleTime: 30_000,
  });
}

// Upsert a tag's identity row — description, fields, parent_names. Vault's
// PUT /api/tags/:name is merge-on-write at the row level (omitted keys
// preserved, explicit null clears). The mutation invalidates both the
// single-tag cache and the list so the Tags page UI reflects the change.
//
// Important: vault DOES NOT backfill schemas onto notes already carrying
// the tag. The PUT only touches the tag-identity row; existing notes keep
// whatever metadata shape they already had. The Tags UI surfaces a warning
// to that effect when the operator edits a schema.
export function useUpdateTag() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      name: string;
      payload: TagUpsertPayload;
    }): Promise<TagRecord> => {
      if (!client) throw new Error("No active vault");
      return client.updateTag(args.name, args.payload);
    },
    onSuccess: (rec, args) => {
      qc.setQueryData(["tag", activeId, args.name], rec);
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
    },
  });
}

export function useNote(id: string | undefined) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const { db } = useSync();
  const qc = useQueryClient();

  return useQuery({
    queryKey: ["note", activeId, id],
    enabled: !!client && !!id,
    queryFn: async () => {
      // Offline-created notes (a voice or text capture made while offline)
      // navigate to `/n/<localId>` before their `create-note` row drains.
      // `getNote(localId)` would 404, so resolve the local id to its server id
      // via the sync id-map first. Until the row drains (no mapping yet), serve
      // the optimistic note the capture flow seeded into the cache — the
      // capture must land on a readable note, not an error screen.
      if (id && isLocalId(id)) {
        const realId = db && activeId ? await resolveNoteId(db, id, activeId) : null;
        if (!realId) {
          const optimistic = qc.getQueryData<Note>(["note", activeId, id]);
          if (optimistic) return optimistic;
          throw new Error("This note is still syncing — try again in a moment.");
        }
        return client!.getNote(realId, { includeLinks: true, includeAttachments: true });
      }
      return client!.getNote(id!, { includeLinks: true, includeAttachments: true });
    },
    // While we're still sitting on a local id that hasn't resolved to a server
    // note, poll so the view flips to the real note once the `create-note` row
    // drains and the id-map fills. Stops as soon as the data is a server note.
    refetchInterval: (query) => {
      if (!id || !isLocalId(id)) return false;
      const data = query.state.data as Note | undefined;
      if (data && !isLocalId(data.id)) return false;
      return 2_000;
    },
    staleTime: 10_000,
  });
}

// Offline policy for mutations: we don't trust `navigator.onLine` alone. In the
// installed-PWA standalone mode (caught 2026-04-21, issue #61) airplane mode
// leaves `onLine === true` on Android Chrome, and a service worker can also
// intercept the POST and never settle its fetch promise. So the policy is:
//
//   1. If we can see we're offline AND we have somewhere to enqueue, skip the
//      network attempt entirely — cheap, no-wait enqueue.
//   2. Otherwise try the network with a bounded AbortController timeout.
//   3. If the network call rejects (error, abort, or timeout) and we have the
//      sync DB available, enqueue the mutation and return the optimistic row.
//   4. If there's nowhere to enqueue, re-throw — that's a genuine config fail.
//
// Callers keep the same signature; the returned Note is optimistic (local id +
// local timestamps) and is replaced by the server-authored one when the drain
// lands.
const OFFLINE_FALLBACK_MS = 8_000;

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function withOfflineFallback<T>(
  online: (signal: AbortSignal) => Promise<T>,
  enqueueFallback: (() => Promise<T>) | null,
): Promise<T> {
  if (enqueueFallback && isOffline()) {
    return enqueueFallback();
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("offline-timeout")), OFFLINE_FALLBACK_MS);
  try {
    return await online(ctrl.signal);
  } catch (err) {
    if (enqueueFallback) return enqueueFallback();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function optimisticCreatedNote(payload: CreateNotePayload, localId: string): Note {
  const now = new Date().toISOString();
  return {
    id: localId,
    path: payload.path,
    createdAt: now,
    updatedAt: now,
    tags: payload.tags,
    metadata: payload.metadata,
    content: payload.content,
  };
}

async function enqueueCreate(
  db: LensDB,
  vaultId: string,
  payload: CreateNotePayload,
): Promise<Note> {
  const localId = newLocalId();
  await enqueue(db, { kind: "create-note", localId, payload }, { vaultId });
  return optimisticCreatedNote(payload, localId);
}

async function enqueueUpdate(
  db: LensDB,
  vaultId: string,
  targetId: string,
  payload: UpdateNotePayload,
  existing: Note | undefined,
): Promise<Note> {
  // Baseline carries the last-known server `updatedAt` so the drain handler
  // can send `if_updated_at` and avoid silently clobbering a peer's edit. A
  // missing baseline (note never fetched in this session) is fine — the drain
  // gets a 428 on first PATCH, refetches, and retries.
  const baselineUpdatedAt = existing?.updatedAt;
  await enqueue(
    db,
    {
      kind: "update-note",
      targetId,
      payload,
      ...(baselineUpdatedAt && { baselineUpdatedAt }),
    },
    { vaultId },
  );
  const base: Note = existing ?? { id: targetId, createdAt: new Date().toISOString() };
  return {
    ...base,
    ...(payload.content !== undefined && { content: payload.content }),
    ...(payload.path !== undefined && { path: payload.path }),
    ...(payload.metadata !== undefined && { metadata: payload.metadata }),
    updatedAt: new Date().toISOString(),
  };
}

export function useUpdateNote(id: string | undefined) {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const { db } = useSync();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateNotePayload) => {
      if (!id) throw new Error("No note id");
      const fallback =
        db && activeId
          ? () => {
              const existing = qc.getQueryData<Note>(["note", activeId, id]);
              return enqueueUpdate(db, activeId, id, payload, existing);
            }
          : null;
      return withOfflineFallback((signal) => {
        if (!client) throw new Error("No active vault");
        return client.updateNote(id, payload, { signal });
      }, fallback);
    },
    onSuccess: (updated) => {
      qc.setQueryData(["note", activeId, id], updated);
      qc.invalidateQueries({ queryKey: ["notes", activeId] });
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
      // If the path changed (→ new id), also seed the new key.
      if (updated?.id && updated.id !== id) {
        qc.setQueryData(["note", activeId, updated.id], updated);
      }
    },
  });
}

export function useCreateNote() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const { db } = useSync();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateNotePayload) => {
      const fallback = db && activeId ? () => enqueueCreate(db, activeId, payload) : null;
      return withOfflineFallback((signal) => {
        if (!client) throw new Error("No active vault");
        return client.createNote(payload, { signal });
      }, fallback);
    },
    onSuccess: (created) => {
      qc.setQueryData(["note", activeId, created.id], created);
      qc.invalidateQueries({ queryKey: ["notes", activeId] });
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
      qc.invalidateQueries({ queryKey: ["vaultInfo", activeId] });
    },
  });
}

export function useUploadStorageFile() {
  const client = useActiveVaultClient();
  return useMutation({
    mutationFn: async (args: {
      file: File;
      onProgress?: (p: UploadProgress) => void;
      signal?: AbortSignal;
    }): Promise<StorageUploadResult> => {
      if (!client) throw new Error("No active vault");
      return client.uploadStorageFile(args.file, {
        onProgress: args.onProgress,
        signal: args.signal,
      });
    },
  });
}

export function useLinkAttachment() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      noteId: string;
      path: string;
      mimeType: string;
    }): Promise<NoteAttachment> => {
      if (!client) throw new Error("No active vault");
      return client.linkAttachment(args.noteId, { path: args.path, mimeType: args.mimeType });
    },
    onSuccess: (_att, args) => {
      qc.invalidateQueries({ queryKey: ["note", activeId, args.noteId] });
    },
  });
}

export function useDeleteAttachment() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const { db } = useSync();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: { noteId: string; attachmentId: string }) => {
      if (isOffline() && db && activeId) {
        await enqueue(
          db,
          { kind: "delete-attachment", noteId: args.noteId, attachmentId: args.attachmentId },
          { vaultId: activeId },
        );
        return args;
      }
      if (!client) throw new Error("No active vault");
      await client.deleteAttachment(args.noteId, args.attachmentId);
      return args;
    },
    onSuccess: (args) => {
      qc.invalidateQueries({ queryKey: ["note", activeId, args.noteId] });
    },
  });
}

export function useRenameTag() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      oldName: string;
      newName: string;
    }): Promise<{ renamed: number }> => {
      if (!client) throw new Error("No active vault");
      return client.renameTag(args.oldName, args.newName);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
      qc.invalidateQueries({ queryKey: ["notes", activeId] });
      qc.invalidateQueries({ queryKey: ["vaultInfo", activeId] });
    },
  });
}

export function useMergeTags() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: {
      sources: string[];
      target: string;
    }): Promise<{ merged: Record<string, number>; target: string }> => {
      if (!client) throw new Error("No active vault");
      return client.mergeTags(args.sources, args.target);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
      qc.invalidateQueries({ queryKey: ["notes", activeId] });
      qc.invalidateQueries({ queryKey: ["vaultInfo", activeId] });
    },
  });
}

export function useDeleteNote() {
  const client = useActiveVaultClient();
  const activeId = useVaultStore((s) => s.activeVaultId);
  const { db } = useSync();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const fallback =
        db && activeId
          ? async () => {
              await enqueue(db, { kind: "delete-note", targetId: id }, { vaultId: activeId });
              return id;
            }
          : null;
      return withOfflineFallback(async (signal) => {
        if (!client) throw new Error("No active vault");
        await client.deleteNote(id, { signal });
        return id;
      }, fallback);
    },
    onSuccess: (id) => {
      qc.removeQueries({ queryKey: ["note", activeId, id] });
      qc.invalidateQueries({ queryKey: ["notes", activeId] });
      qc.invalidateQueries({ queryKey: ["tags", activeId] });
      qc.invalidateQueries({ queryKey: ["vaultInfo", activeId] });
    },
  });
}
