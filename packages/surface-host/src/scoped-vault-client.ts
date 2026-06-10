/**
 * ScopedVaultClient — the vault capability injected into a backed surface's
 * host context (surface-runtime design P2: "capability, never secret").
 *
 * Built on surface-client's `VaultClient.fromHub` server path with a
 * `tokenProvider` — the token-bearing closure lives HOST-side (commit 4's
 * credential store); the backend gets the capability, never the credential:
 *
 *   - **No token accessor.** The base `VaultClient` exposes no
 *     `getAccessToken`; this wrapper additionally COMPOSES (never extends)
 *     and holds the inner client in an ECMAScript #private field, so
 *     neither `setAccessToken` nor the cached token field is reachable
 *     from a backend holding the wrapper. (In-process code can still
 *     subvert the runtime wholesale — the §11 honest line; the wrapper
 *     closes the casual/accidental paths, the install trust act prices
 *     the rest.)
 *   - **`force` writes are rejected** unless the wrapper was constructed
 *     with `allowForce` (the host NEVER sets it in v1 — backed-surface
 *     pattern: "Never write back with `force: true` as policy; use
 *     `if_updated_at` and re-seed on conflict").
 *   - **`fetchAttachmentBlob` stays internal-token**: it rides the inner
 *     client's own auth loop (the tokenProvider), so a backend can fetch
 *     blob content without ever seeing the Bearer.
 *   - **`subscribe` passes through** (surface-client Tier 1) — live-query
 *     SSE bound to the same host-custodied credential.
 *
 * The wrapper is deliberately an explicit method list (not a Proxy): every
 * vault capability a backend holds is enumerable in one screen, and a new
 * `VaultClient` method never leaks through silently.
 */

import type {
  CreateNotePayload,
  FindPathResult,
  Note,
  NoteAttachment,
  NotesQueryInput,
  SubscribeHandlers,
  SubscribeOptions,
  TagRecord,
  TagSummary,
  TagUpsertPayload,
  UpdateNotePayload,
  VaultInfo,
} from "@openparachute/surface-client";
import { VaultClient } from "@openparachute/surface-client/vault-client";

export type ScopedVaultClientOptions = {
  /** Hub origin (the canonical `/vault/<name>` path is derived from it). */
  hubOrigin: string;
  /** Vault the surface is bound to (meta `vault_default`, or `"default"`). */
  vaultName: string;
  /**
   * Resolves the Bearer for each request — host-side closure over the
   * custodied credential (P3). Errors propagate to the caller unchanged
   * (e.g. "no credential provisioned" / "credential needs operator
   * re-approval").
   */
  tokenProvider: () => Promise<string> | string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /**
   * Permit `force: true` on note updates. The host NEVER sets this in v1 —
   * it exists so the constraint is explicit and test-pinned rather than
   * incidental.
   */
  allowForce?: boolean;
};

export class ScopedVaultClient {
  /** ECMAScript-private: not reachable via property access from a backend. */
  readonly #inner: VaultClient;
  readonly #allowForce: boolean;
  /** The vault this client is bound to (informational). */
  readonly vaultName: string;

  constructor(opts: ScopedVaultClientOptions) {
    this.vaultName = opts.vaultName;
    this.#allowForce = opts.allowForce ?? false;
    this.#inner = VaultClient.fromHub({
      hubOrigin: opts.hubOrigin,
      vaultName: opts.vaultName,
      tokenProvider: opts.tokenProvider,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  // ---------- vault ----------

  vaultInfo(includeStats = true): Promise<VaultInfo> {
    return this.#inner.vaultInfo(includeStats);
  }

  // ---------- notes ----------

  queryNotes(params: NotesQueryInput): Promise<Note[]> {
    return this.#inner.queryNotes(params);
  }

  queryNotesCursor(
    ...args: Parameters<VaultClient["queryNotesCursor"]>
  ): ReturnType<VaultClient["queryNotesCursor"]> {
    return this.#inner.queryNotesCursor(...args);
  }

  /** Live-query SSE (Tier 1). Returns the unsubscribe function. */
  subscribe(
    query: NotesQueryInput,
    handlers: SubscribeHandlers,
    opts: SubscribeOptions = {},
  ): () => void {
    return this.#inner.subscribe(query, handlers, opts);
  }

  getNote(
    id: string,
    opts: { includeLinks?: boolean; includeAttachments?: boolean } = {},
  ): Promise<Note | null> {
    return this.#inner.getNote(id, opts);
  }

  createNote(payload: CreateNotePayload, opts: { signal?: AbortSignal } = {}): Promise<Note> {
    return this.#inner.createNote(payload, opts);
  }

  createNotes(payloads: CreateNotePayload[], opts: { signal?: AbortSignal } = {}): Promise<Note[]> {
    return this.#inner.createNotes(payloads, opts);
  }

  /**
   * Optimistic-concurrency note update. `force: true` is REJECTED unless
   * the wrapper was constructed `allowForce` (never, in v1): vaults are
   * multi-writer (agents, sync jobs, sibling surfaces) — a backend that
   * force-writes as policy silently destroys external edits. Send
   * `if_updated_at` and re-seed on 409 instead (design §9).
   */
  updateNote(
    id: string,
    payload: UpdateNotePayload,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Note> {
    if (payload.force === true && !this.#allowForce) {
      return Promise.reject(
        new Error(
          "ScopedVaultClient: `force: true` updates are not permitted for surface backends — send `if_updated_at` and re-seed on conflict (vault-as-source-of-truth)",
        ),
      );
    }
    return this.#inner.updateNote(id, payload, opts);
  }

  deleteNote(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#inner.deleteNote(id, opts);
  }

  // ---------- tags ----------

  listTags(): Promise<TagSummary[]>;
  listTags(opts: { includeSchema: true }): Promise<TagRecord[]>;
  listTags(opts: { includeSchema: false }): Promise<TagSummary[]>;
  listTags(opts?: { includeSchema?: boolean }): Promise<TagSummary[] | TagRecord[]> {
    if (opts?.includeSchema === true) return this.#inner.listTags({ includeSchema: true });
    return this.#inner.listTags();
  }

  getTag(name: string): Promise<TagRecord | null> {
    return this.#inner.getTag(name);
  }

  updateTag(...args: Parameters<VaultClient["updateTag"]>): ReturnType<VaultClient["updateTag"]> {
    return this.#inner.updateTag(...args);
  }

  deleteTag(name: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    return this.#inner.deleteTag(name, opts);
  }

  // ---------- paths ----------

  findPath(...args: Parameters<VaultClient["findPath"]>): Promise<FindPathResult | null> {
    return this.#inner.findPath(...args) as Promise<FindPathResult | null>;
  }

  // ---------- attachments ----------

  addAttachment(
    ...args: Parameters<VaultClient["addAttachment"]>
  ): ReturnType<VaultClient["addAttachment"]> {
    return this.#inner.addAttachment(...args);
  }

  listAttachments(noteIdOrPath: string): Promise<NoteAttachment[]> {
    return this.#inner.listAttachments(noteIdOrPath);
  }

  deleteAttachment(noteIdOrPath: string, attachmentId: string): Promise<void> {
    return this.#inner.deleteAttachment(noteIdOrPath, attachmentId);
  }

  /**
   * Fetch an attachment's bytes. The Bearer rides the INNER client's auth
   * loop — the backend gets the Blob, never the token.
   */
  fetchAttachmentBlob(url: string): Promise<Blob> {
    return this.#inner.fetchAttachmentBlob(url);
  }
}

export type { TagUpsertPayload };
