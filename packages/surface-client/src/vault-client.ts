/**
 * `VaultClient` — REST client for Parachute Vault, with auto-refresh
 * on 401/403 and structured error reporting.
 *
 * This is the canonical extract of `parachute-notes/src/lib/vault/client.ts`.
 * The contract:
 *
 *   1. **Auto-renewing token.** Each request attaches `Authorization:
 *      Bearer <token>`. On 401/403, an optional `onAuthError` callback
 *      can attempt a refresh + return a fresh token; the client rotates
 *      and retries once. If no refresh path is available (or the post-
 *      refresh retry also fails), `VaultAuthError` is thrown with the
 *      vault's structured `error_type` + `message` per notes#150's
 *      enhanced shape.
 *
 *   2. **Reachability signals.** `onReachability` callback receives
 *      `"healthy"` on any 2xx/4xx (vault answered) and `"unreachable"`
 *      on 5xx or network failure (vault gone / mid-restart / proxy
 *      down). Side-effect-free here; the consumer's reachability store
 *      runs the state machine.
 *
 *   3. **Structured errors.** `VaultAuthError`, `VaultNotFoundError`,
 *      `VaultUnreachableError`, `VaultConflictError`,
 *      `VaultTargetExistsError`, `VaultUploadError`. Each carries the
 *      detail a consuming UI needs to render a meaningful prompt.
 *
 *   4. **Cursor pagination.** `queryNotesCursor` returns a streamed
 *      result: items + next-cursor token. Notes' UI uses this for the
 *      tag-results infinite scroll; future apps inherit the pattern.
 *
 * Differences from the Notes vendored copy:
 *   - The `signal` parameter is plumbed through every mutating call so
 *     React-Query-style cancellation works.
 *   - The `xhrFactory` is exposed for tests + jsdom environments where
 *     the global XMLHttpRequest is awkward to override.
 *   - The query helpers (`queryNotes` / `queryNotesCursor`) take a
 *     `URLSearchParams | Record<string, string>` so caller ergonomics
 *     match what the modern fetch-style callers want.
 */

import type {
  CreateNotePayload,
  Note,
  NoteAttachment,
  ReachabilitySignal,
  StorageUploadResult,
  TagRecord,
  TagSummary,
  TagUpsertPayload,
  UpdateNotePayload,
  UploadProgress,
  VaultInfo,
} from "./vault-types.js";

export class VaultUploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "VaultUploadError";
    this.status = status;
  }
}

/**
 * Thrown on a 401/403 from the vault — carries the `error_type` +
 * `message` discriminator from notes#150's enhanced shape:
 *
 *   - `vault_scope_mismatch` — token's `vault_scope` claim doesn't
 *     include the URL's vault name.
 *   - `insufficient_scope` — token doesn't carry `vault:read`/`:write`/
 *     `:admin` for the endpoint hit.
 *   - `tag_scope_violation` — tag-scoped pvt_ token violation on a write.
 *   - `undefined` — vault returned a 401 without a discriminator
 *     (signature, audience, expired, revoked).
 */
export class VaultAuthError extends Error {
  readonly status: number;
  readonly errorType?: string;
  readonly body?: string;
  constructor(
    message = "Vault rejected the token",
    status = 0,
    opts: { errorType?: string; body?: string } = {},
  ) {
    super(message);
    this.name = "VaultAuthError";
    this.status = status;
    if (opts.errorType) this.errorType = opts.errorType;
    if (opts.body) this.body = opts.body;
  }
}

export class VaultNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "VaultNotFoundError";
  }
}

/**
 * Thrown when the vault is unreachable — 5xx from the proxy or network-
 * level failure (ECONNREFUSED, DNS, TypeError). `status` is 0 for
 * network errors that never produced a response.
 */
export class VaultUnreachableError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "VaultUnreachableError";
    this.status = status;
  }
}

export class VaultConflictError extends Error {
  readonly currentUpdatedAt: string | null;
  readonly expectedUpdatedAt: string | null;
  constructor(body: {
    current_updated_at?: string | null;
    expected_updated_at?: string | null;
    message?: string;
  }) {
    super(body.message ?? "Note was edited elsewhere");
    this.name = "VaultConflictError";
    this.currentUpdatedAt = body.current_updated_at ?? null;
    this.expectedUpdatedAt = body.expected_updated_at ?? null;
  }
}

export class VaultTargetExistsError extends Error {
  readonly target: string;
  constructor(target: string, message?: string) {
    super(message ?? `A tag named "${target}" already exists`);
    this.name = "VaultTargetExistsError";
    this.target = target;
  }
}

export interface VaultClientOptions {
  vaultUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  xhrFactory?: () => XMLHttpRequest;
  /**
   * Invoked when the vault returns 401/403. Should attempt a refresh-
   * token exchange and return the fresh access token, or `null` if
   * refresh is not possible (legacy `pvt_*` token, no refresh token, or
   * refresh failed). Without this, the first 401 throws immediately.
   */
  onAuthError?: () => Promise<string | null>;
  /**
   * Invoked when a 401/403 ultimately can't be recovered — either there
   * was no refresh callback, or the post-refresh retry also got a
   * 401/403 (the new token is dead too). Lets the consumer mark the
   * vault as needing reconnect.
   *
   * NOT called when `onAuthError` returns null. The convention: when
   * `onAuthError` returns null, the caller's own refresh-handling
   * mechanism is assumed to have recorded the halt state via a separate
   * path (e.g. its own state store). Callers that rely on
   * `onAuthRevoked` for ALL revocation signals should NOT pass an
   * `onAuthError` handler that returns null — either omit `onAuthError`
   * entirely, or throw from it.
   *
   * `detail` carries vault's `error_type` + `message` when the body
   * was JSON-parseable — surfaces `vault_scope_mismatch` /
   * `insufficient_scope` / `tag_scope_violation` diagnostics in the
   * halt banner (notes#150).
   */
  onAuthRevoked?: (status: number, detail?: { errorType?: string; message?: string }) => void;
  /** Coarse reachability signal — fires on every fetch outcome. */
  onReachability?: (signal: ReachabilitySignal, reason?: string) => void;
}

export class VaultClient {
  private readonly baseUrl: string;
  /** Mutable so a successful refresh-on-401 retry can rotate in-place. */
  private token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly xhrFactory: () => XMLHttpRequest;
  private readonly onAuthError?: () => Promise<string | null>;
  private readonly onAuthRevoked?: (
    status: number,
    detail?: { errorType?: string; message?: string },
  ) => void;
  private readonly onReachability?: (signal: ReachabilitySignal, reason?: string) => void;

  constructor(opts: VaultClientOptions) {
    this.baseUrl = opts.vaultUrl.replace(/\/$/, "");
    this.token = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.xhrFactory =
      opts.xhrFactory ??
      (() => {
        if (typeof XMLHttpRequest === "undefined") {
          throw new Error(
            "VaultClient: XMLHttpRequest is not available in this context. " +
              "Pass `xhrFactory` if you need progress-tracked uploads outside a browser.",
          );
        }
        return new XMLHttpRequest();
      });
    if (opts.onAuthError !== undefined) this.onAuthError = opts.onAuthError;
    if (opts.onAuthRevoked !== undefined) this.onAuthRevoked = opts.onAuthRevoked;
    if (opts.onReachability !== undefined) this.onReachability = opts.onReachability;
  }

  /** Update the in-memory access token (e.g. after a manual refresh). */
  setAccessToken(token: string): void {
    this.token = token;
  }

  get vaultBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Protected: subclasses can call this directly to add domain-specific
   * endpoints without re-implementing the auth/refresh/error-classification
   * loop (e.g. a NotesVaultClient adding `linkAttachment`). Wraps
   * `requestWithRetry` with `allowRetry: true`.
   */
  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.requestWithRetry<T>(path, init, true);
  }

  /**
   * Protected: the inner JSON-request loop with explicit retry control.
   * Subclasses normally call `request` instead; reach for this only when
   * you need to opt out of the refresh-and-retry path (e.g. on the retry
   * leg itself).
   */
  protected async requestWithRetry<T>(
    path: string,
    init: RequestInit,
    allowRetry: boolean,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.onReachability?.("unreachable", message);
      throw new VaultUnreachableError(`${init.method ?? "GET"} ${path} failed: ${message}`, 0);
    }

    if (res.status >= 500) {
      this.onReachability?.("unreachable", `HTTP ${res.status}`);
      throw new VaultUnreachableError(
        `${init.method ?? "GET"} ${path} → ${res.status}`,
        res.status,
      );
    }

    this.onReachability?.("healthy");

    if (res.status === 401 || res.status === 403) {
      // Read body BEFORE the refresh-and-retry branch — see Notes' client.ts
      // for the rationale (single source of truth for the message, no
      // double-fetch on the catch path).
      const bodyText = await res.text().catch(() => "");
      let errorType: string | undefined;
      let serverMessage: string | undefined;
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText) as { error_type?: unknown; message?: unknown };
          if (typeof parsed.error_type === "string") errorType = parsed.error_type;
          if (typeof parsed.message === "string") serverMessage = parsed.message;
        } catch {
          // Non-JSON body — `body` carries raw text.
        }
      }
      if (allowRetry && this.onAuthError) {
        const fresh = await this.onAuthError();
        if (fresh) {
          this.token = fresh;
          return this.requestWithRetry<T>(path, init, false);
        }
        // onAuthError returned null → caller's refresh path owns the halt
        // (see onAuthRevoked JSDoc); skip onAuthRevoked here.
      } else {
        this.onAuthRevoked?.(res.status, { errorType, message: serverMessage });
      }
      const composed = errorType
        ? `Vault rejected the token (${res.status}: ${errorType}${serverMessage ? ` — ${serverMessage}` : ""})`
        : serverMessage
          ? `Vault rejected the token (${res.status}: ${serverMessage})`
          : `Vault rejected the token (${res.status})`;
      const opts: { errorType?: string; body?: string } = {};
      if (errorType !== undefined) opts.errorType = errorType;
      if (bodyText) opts.body = bodyText;
      throw new VaultAuthError(composed, res.status, opts);
    }
    if (res.status === 404) {
      throw new VaultNotFoundError(`${init.method ?? "GET"} ${path} → 404`);
    }
    if (res.status === 409 || res.status === 428) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        target?: string;
        message?: string;
        current_updated_at?: string | null;
        expected_updated_at?: string | null;
      };
      if (body.error === "target_exists" && typeof body.target === "string") {
        throw new VaultTargetExistsError(body.target, body.message);
      }
      throw new VaultConflictError(body);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${init.method ?? "GET"} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---------- vault info ----------

  async vaultInfo(includeStats = true): Promise<VaultInfo> {
    const query = includeStats ? "?include_stats=true" : "";
    return this.request<VaultInfo>(`/api/vault${query}`);
  }

  // ---------- notes ----------

  async queryNotes(params: URLSearchParams | Record<string, string>): Promise<Note[]> {
    const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    const s = qs.toString();
    return this.request<Note[]>(`/api/notes${s ? `?${s}` : ""}`);
  }

  /**
   * Cursor-paginated variant. Vault's `/api/notes` accepts `cursor` +
   * `limit` and returns `X-Next-Cursor` on the response. Consumers
   * chain calls until `nextCursor` is undefined.
   *
   * Implementation: drives the request through `requestCursorWithRetry`
   * which mirrors `requestWithRetry`'s 401/403 refresh-and-retry but
   * preserves the Response so we can read the `X-Next-Cursor` header.
   */
  async queryNotesCursor(
    params: URLSearchParams | Record<string, string>,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Note[]; nextCursor?: string }> {
    const qs = params instanceof URLSearchParams ? params : new URLSearchParams(params);
    if (cursor) qs.set("cursor", cursor);
    if (typeof limit === "number") qs.set("limit", String(limit));
    const s = qs.toString();
    const path = `/api/notes${s ? `?${s}` : ""}`;
    return this.requestCursorWithRetry(path, true);
  }

  /**
   * Protected: cursor-paginated variant of `requestWithRetry` that preserves
   * the Response so the `X-Next-Cursor` header survives the auth-retry path.
   * Subclasses can call this directly when adding cursor-paginated
   * domain-specific list endpoints.
   */
  protected async requestCursorWithRetry(
    path: string,
    allowRetry: boolean,
  ): Promise<{ items: Note[]; nextCursor?: string }> {
    const headers = new Headers({
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.onReachability?.("unreachable", message);
      throw new VaultUnreachableError(`GET ${path} failed: ${message}`, 0);
    }
    if (res.status >= 500) {
      this.onReachability?.("unreachable", `HTTP ${res.status}`);
      throw new VaultUnreachableError(`GET ${path} → ${res.status}`, res.status);
    }
    this.onReachability?.("healthy");
    if (res.status === 401 || res.status === 403) {
      const bodyText = await res.text().catch(() => "");
      let errorType: string | undefined;
      let serverMessage: string | undefined;
      if (bodyText) {
        try {
          const parsed = JSON.parse(bodyText) as { error_type?: unknown; message?: unknown };
          if (typeof parsed.error_type === "string") errorType = parsed.error_type;
          if (typeof parsed.message === "string") serverMessage = parsed.message;
        } catch {}
      }
      if (allowRetry && this.onAuthError) {
        const fresh = await this.onAuthError();
        if (fresh) {
          this.token = fresh;
          return this.requestCursorWithRetry(path, false);
        }
        // onAuthError returned null → caller's refresh path owns the halt
        // (see onAuthRevoked JSDoc); skip onAuthRevoked here.
      } else {
        this.onAuthRevoked?.(res.status, { errorType, message: serverMessage });
      }
      const composed = errorType
        ? `Vault rejected the token (${res.status}: ${errorType}${serverMessage ? ` — ${serverMessage}` : ""})`
        : serverMessage
          ? `Vault rejected the token (${res.status}: ${serverMessage})`
          : `Vault rejected the token (${res.status})`;
      const opts: { errorType?: string; body?: string } = {};
      if (errorType !== undefined) opts.errorType = errorType;
      if (bodyText) opts.body = bodyText;
      throw new VaultAuthError(composed, res.status, opts);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    const items = (await res.json()) as Note[];
    const headerCursor = res.headers.get("x-next-cursor") ?? undefined;
    const out: { items: Note[]; nextCursor?: string } = { items };
    if (headerCursor) out.nextCursor = headerCursor;
    return out;
  }

  async getNote(
    id: string,
    opts: { includeLinks?: boolean; includeAttachments?: boolean } = {},
  ): Promise<Note | null> {
    const params = new URLSearchParams({ id, include_content: "true" });
    if (opts.includeLinks) params.set("include_links", "true");
    if (opts.includeAttachments) params.set("include_attachments", "true");
    const rows = await this.request<Note[] | Note>(`/api/notes?${params.toString()}`);
    if (Array.isArray(rows)) return rows[0] ?? null;
    return rows ?? null;
  }

  async createNote(payload: CreateNotePayload, opts: { signal?: AbortSignal } = {}): Promise<Note> {
    const init: RequestInit = { method: "POST", body: JSON.stringify(payload) };
    if (opts.signal) init.signal = opts.signal;
    return this.request<Note>("/api/notes", init);
  }

  async updateNote(
    id: string,
    payload: UpdateNotePayload,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Note> {
    const init: RequestInit = { method: "PATCH", body: JSON.stringify(payload) };
    if (opts.signal) init.signal = opts.signal;
    return this.request<Note>(`/api/notes/${encodeURIComponent(id)}`, init);
  }

  async deleteNote(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const init: RequestInit = { method: "DELETE" };
    if (opts.signal) init.signal = opts.signal;
    await this.request<{ deleted: boolean; id: string } | undefined>(
      `/api/notes/${encodeURIComponent(id)}`,
      init,
    );
  }

  // ---------- tags ----------

  async listTags(): Promise<TagSummary[]> {
    return this.request<TagSummary[]>("/api/tags");
  }

  /**
   * Fetch a single tag-identity record. Returns `null` when the tag
   * doesn't exist. Used by `updateTag`'s idempotency check + by apps
   * that want to read the current schema before patching it.
   *
   * Vault returns 404 on missing-tag for single-tag reads; the canonical
   * `VaultClient` translation is a thrown `VaultNotFoundError`. We
   * catch that here and resolve `null` because callers provisioning
   * schema treat "not found" as "needs creating," not as an error.
   */
  async getTag(name: string): Promise<TagRecord | null> {
    try {
      return await this.request<TagRecord>(`/api/tags/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof VaultNotFoundError) return null;
      throw e;
    }
  }

  /**
   * Upsert a tag-identity row via `PUT /api/tags/:name`. Vault's
   * semantics:
   *   - Omitted keys preserve prior values (description, fields,
   *     relationships, parent_names).
   *   - Explicit `null` clears the key.
   *   - `fields` is merge-on-write: vault preserves prior field keys
   *     and only overwrites the ones declared in this payload.
   *
   * **Idempotent** — re-running with the same payload against a vault
   * that already has the tag is a no-op at the row level (vault
   * re-writes the same JSON).
   *
   * Used by parachute-surface's Phase 2.1 auto-provisioner: when a UI's
   * `meta.json` declares `required_schema.tags`, app calls this for
   * each tag at install time so the operator doesn't have to seed the
   * schema by hand.
   */
  async updateTag(
    name: string,
    payload: TagUpsertPayload,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TagRecord> {
    const init: RequestInit = { method: "PUT", body: JSON.stringify(payload) };
    if (opts.signal) init.signal = opts.signal;
    return this.request<TagRecord>(`/api/tags/${encodeURIComponent(name)}`, init);
  }

  // ---------- attachments ----------

  async addAttachment(
    noteIdOrPath: string,
    body: { path: string; mimeType: string; transcribe?: boolean },
  ): Promise<NoteAttachment> {
    return this.request<NoteAttachment>(
      `/api/notes/${encodeURIComponent(noteIdOrPath)}/attachments`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }

  async listAttachments(noteIdOrPath: string): Promise<NoteAttachment[]> {
    return this.request<NoteAttachment[]>(
      `/api/notes/${encodeURIComponent(noteIdOrPath)}/attachments`,
    );
  }

  async deleteAttachment(noteIdOrPath: string, attachmentId: string): Promise<void> {
    await this.request<undefined>(
      `/api/notes/${encodeURIComponent(noteIdOrPath)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * Upload an attachment file to vault's storage. Uses XHR for the
   * progress events `onProgress` consumes; pre-flight + post-flight
   * mirror the JSON request shape.
   */
  uploadStorageFile(
    file: File,
    opts: {
      onProgress?: (p: UploadProgress) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<StorageUploadResult> {
    return new Promise((resolve, reject) => {
      const xhr = this.xhrFactory();
      const form = new FormData();
      form.append("file", file);

      xhr.open("POST", `${this.baseUrl}/api/storage/upload`);
      xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.setRequestHeader("Accept", "application/json");

      if (opts.onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress?.({ loaded: e.loaded, total: e.total });
        };
      }

      xhr.onload = () => {
        if (xhr.status === 401 || xhr.status === 403) {
          let errorType: string | undefined;
          let serverMessage: string | undefined;
          const bodyText = xhr.responseText ?? "";
          if (bodyText) {
            try {
              const parsed = JSON.parse(bodyText) as {
                error_type?: unknown;
                message?: unknown;
              };
              if (typeof parsed.error_type === "string") errorType = parsed.error_type;
              if (typeof parsed.message === "string") serverMessage = parsed.message;
            } catch {}
          }
          const composed = errorType
            ? `Vault rejected the token (${xhr.status}: ${errorType}${serverMessage ? ` — ${serverMessage}` : ""})`
            : serverMessage
              ? `Vault rejected the token (${xhr.status}: ${serverMessage})`
              : `Vault rejected the token (${xhr.status})`;
          const aopts: { errorType?: string; body?: string } = {};
          if (errorType !== undefined) aopts.errorType = errorType;
          if (bodyText) aopts.body = bodyText;
          reject(new VaultAuthError(composed, xhr.status, aopts));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string };
            if (body.error) message = body.error;
          } catch {}
          reject(new VaultUploadError(message, xhr.status));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText) as StorageUploadResult);
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Invalid upload response"));
        }
      };

      xhr.onerror = () => reject(new VaultUploadError("Network error during upload", 0));
      xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

      if (opts.signal) {
        if (opts.signal.aborted) {
          xhr.abort();
          return;
        }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }

      xhr.send(form);
    });
  }

  /** Convenience: storage URL for an attachment path. */
  storageUrl(p: string): string {
    const trimmed = p.startsWith("/") ? p.slice(1) : p;
    return `${this.baseUrl}/api/storage/${trimmed}`;
  }
}
