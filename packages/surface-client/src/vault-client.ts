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

import { toNotesSearchParams, type NotesQueryInput } from "./notes-query.js";
import {
  assertSubscribableQuery,
  type SubscribeHandlers,
  type SubscribeOptions,
  type SubscribeTransport,
  type WebSocketCtor,
} from "./subscribe.js";
import { startWsSubscription } from "./ws-transport.js";
import type {
  CreateNotePayload,
  FindPathResult,
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

/**
 * Common base class for every `VaultClient` error.
 *
 * Callers that want to handle "anything the client threw" can `catch (e
 * instanceof VaultError)` without enumerating every subclass; callers
 * that want fine-grained handling can `instanceof` the specific
 * subclass. Every concrete error carries `status` (HTTP status, or `0`
 * for pre-flight network failures) and an optional `body` (raw response
 * body when one was available) — both useful for `console.error` /
 * log-line diagnosis from scripts.
 */
export abstract class VaultError extends Error {
  /** HTTP status, or `0` for a network-level failure with no response. */
  abstract readonly status: number;
  /** Raw response body, when one was available. */
  readonly body?: string;
  constructor(message: string, body?: string) {
    super(message);
    this.name = "VaultError";
    if (body !== undefined) this.body = body;
  }
}

export class VaultUploadError extends VaultError {
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
 *
 * 403 responses surface as `VaultPermissionError` (a subclass of this)
 * so script callers can distinguish "token's identity is broken" (401)
 * from "token identity is fine but it lacks the scope" (403) with
 * `instanceof VaultPermissionError`. Callers that just want "auth
 * failed" continue to work with `instanceof VaultAuthError`.
 */
export class VaultAuthError extends VaultError {
  readonly status: number;
  readonly errorType?: string;
  constructor(
    message = "Vault rejected the token",
    status = 0,
    opts: { errorType?: string; body?: string } = {},
  ) {
    super(message, opts.body);
    this.name = "VaultAuthError";
    this.status = status;
    if (opts.errorType) this.errorType = opts.errorType;
  }
}

/**
 * Thrown specifically on a 403 from the vault — the token authenticated
 * but lacks the scope needed for this endpoint. Extends `VaultAuthError`
 * so existing consumers that catch `VaultAuthError` keep working; new
 * consumers can branch on `instanceof VaultPermissionError` for the
 * "ask the operator to reissue with a wider scope" UX vs the
 * "token is dead / expired, re-auth" UX of a bare `VaultAuthError`.
 */
export class VaultPermissionError extends VaultAuthError {
  constructor(message = "Insufficient permission", opts: { errorType?: string; body?: string } = {}) {
    super(message, 403, opts);
    this.name = "VaultPermissionError";
  }
}

export class VaultNotFoundError extends VaultError {
  readonly status = 404;
  constructor(message = "Not found", body?: string) {
    super(message, body);
    this.name = "VaultNotFoundError";
  }
}

/**
 * Thrown when the vault is unreachable — network-level failure
 * (ECONNREFUSED, DNS, TypeError) with `status === 0` and no response
 * body. For 5xx responses (vault answered with an error), use the
 * `VaultServerError` subclass; both share this base so the
 * `try/catch VaultUnreachableError` shape works for "vault is having
 * a bad time, either way" handling.
 */
export class VaultUnreachableError extends VaultError {
  readonly status: number;
  constructor(message: string, status: number, body?: string) {
    super(message, body);
    this.name = "VaultUnreachableError";
    this.status = status;
  }
}

/**
 * Thrown when the vault answered with a 5xx — the request reached vault
 * (or its proxy) but the server returned an error. Extends
 * `VaultUnreachableError` so existing consumers that branch on
 * "is the vault healthy?" keep working; scripts that want to log a
 * different message for "server error" vs "network down" can branch
 * on `instanceof VaultServerError`.
 */
export class VaultServerError extends VaultUnreachableError {
  constructor(message: string, status: number, body?: string) {
    super(message, status, body);
    this.name = "VaultServerError";
  }
}

export class VaultConflictError extends VaultError {
  readonly status = 409;
  readonly currentUpdatedAt: string | null;
  readonly expectedUpdatedAt: string | null;
  constructor(body: {
    current_updated_at?: string | null;
    expected_updated_at?: string | null;
    message?: string;
  }) {
    super(body.message ?? "Note was edited elsewhere", JSON.stringify(body));
    this.name = "VaultConflictError";
    this.currentUpdatedAt = body.current_updated_at ?? null;
    this.expectedUpdatedAt = body.expected_updated_at ?? null;
  }
}

export class VaultTargetExistsError extends VaultError {
  readonly status = 409;
  readonly target: string;
  constructor(target: string, message?: string) {
    super(message ?? `A tag named "${target}" already exists`);
    this.name = "VaultTargetExistsError";
    this.target = target;
  }
}

export interface VaultClientOptions {
  vaultUrl: string;
  /**
   * Static access token to send as `Authorization: Bearer <token>` on
   * every request. Either this or `tokenProvider` must be supplied.
   * If both are supplied, `tokenProvider` wins (the static token is
   * ignored — passing both is a programmer mistake, not a fallback).
   */
  accessToken?: string;
  /**
   * Callback resolving to a token for the next request. Called once per
   * request before sending; the resolved value is used as the Bearer
   * credential. Use this when the calling code owns a refresh-flow loop
   * (the OAuth layer in `surface-client/oauth.ts`, or a script that
   * mints fresh tokens from a long-lived credential) — return the
   * current valid token from your loop.
   *
   * Errors thrown from `tokenProvider` propagate to the caller
   * unchanged; they're not converted to `VaultAuthError`. This is
   * intentional — a token-provider failure is the caller's failure
   * domain, not vault's.
   */
  tokenProvider?: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  xhrFactory?: () => XMLHttpRequest;
  /**
   * Invoked when the vault returns 401/403. Should attempt a refresh-
   * token exchange and return the fresh access token, or `null` if
   * refresh is not possible (legacy `pvt_*` token, no refresh token, or
   * refresh failed). Without this, the first 401 throws immediately.
   *
   * Note: when `tokenProvider` is supplied, the post-retry token comes
   * from a fresh `tokenProvider()` call — the `onAuthError` return is
   * still honored (rotates the in-memory cache) but the next request
   * will re-call `tokenProvider` regardless.
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
  /**
   * WebSocket constructor for {@link VaultClient.subscribe}'s live transport.
   * Defaults to the runtime global `WebSocket`; when neither exists the
   * subscription signals "live unavailable" and the consumer keeps polling.
   * Primarily a test seam.
   */
  webSocketImpl?: WebSocketCtor;
}

export class VaultClient {
  private readonly baseUrl: string;
  /** Mutable so a successful refresh-on-401 retry can rotate in-place. */
  private token: string;
  /**
   * When set, called once per request to resolve the Bearer token. Wins
   * over `token` (the cached static value). The cache field still gets
   * rotated on `setAccessToken` / `onAuthError`-returned-fresh so
   * subclasses that read it directly continue to see the latest value.
   */
  private readonly tokenProvider?: () => Promise<string> | string;
  private readonly fetchImpl: typeof fetch;
  private readonly xhrFactory: () => XMLHttpRequest;
  private readonly onAuthError?: () => Promise<string | null>;
  private readonly onAuthRevoked?: (
    status: number,
    detail?: { errorType?: string; message?: string },
  ) => void;
  private readonly onReachability?: (signal: ReachabilitySignal, reason?: string) => void;
  private readonly webSocketImpl?: WebSocketCtor;

  constructor(opts: VaultClientOptions) {
    if (opts.accessToken === undefined && opts.tokenProvider === undefined) {
      throw new TypeError(
        "VaultClient: must supply either `accessToken` (static) or `tokenProvider` (callback).",
      );
    }
    this.baseUrl = opts.vaultUrl.replace(/\/$/, "");
    this.token = opts.accessToken ?? "";
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
    if (opts.tokenProvider !== undefined) this.tokenProvider = opts.tokenProvider;
    if (opts.onAuthError !== undefined) this.onAuthError = opts.onAuthError;
    if (opts.onAuthRevoked !== undefined) this.onAuthRevoked = opts.onAuthRevoked;
    if (opts.onReachability !== undefined) this.onReachability = opts.onReachability;
    if (opts.webSocketImpl !== undefined) this.webSocketImpl = opts.webSocketImpl;
  }

  /**
   * Build a `VaultClient` from a hub origin + vault name. The
   * script-friendly entry point — captures the canonical Parachute URL
   * shape (`<hubOrigin>/vault/<name>`) without callers having to glue
   * the pieces together.
   *
   * Use this when scripting against a Parachute hub. The full-control
   * constructor is still available if you need to point at a vault
   * mounted under a non-standard URL (cross-origin test harnesses,
   * direct-to-vault calls bypassing hub, etc.).
   *
   * Example:
   *
   * ```ts
   * const vault = VaultClient.fromHub({
   *   hubOrigin: "https://my-hub.parachute.computer",
   *   vaultName: "default",
   *   token: process.env.PARACHUTE_TOKEN!,
   * });
   * const notes = await vault.queryNotes({ tag: "#meeting" });
   * ```
   */
  static fromHub(opts: {
    hubOrigin: string;
    vaultName: string;
    /** Static Bearer token. Mutually exclusive with `tokenProvider`. */
    token?: string;
    /** Callback resolving to a Bearer token for each request. */
    tokenProvider?: () => Promise<string> | string;
    fetchImpl?: typeof fetch;
    onAuthError?: () => Promise<string | null>;
    onAuthRevoked?: (
      status: number,
      detail?: { errorType?: string; message?: string },
    ) => void;
    onReachability?: (signal: ReachabilitySignal, reason?: string) => void;
  }): VaultClient {
    const origin = opts.hubOrigin.replace(/\/$/, "");
    const vaultUrl = `${origin}/vault/${encodeURIComponent(opts.vaultName)}`;
    const ctorOpts: VaultClientOptions = { vaultUrl };
    if (opts.token !== undefined) ctorOpts.accessToken = opts.token;
    if (opts.tokenProvider !== undefined) ctorOpts.tokenProvider = opts.tokenProvider;
    if (opts.fetchImpl !== undefined) ctorOpts.fetchImpl = opts.fetchImpl;
    if (opts.onAuthError !== undefined) ctorOpts.onAuthError = opts.onAuthError;
    if (opts.onAuthRevoked !== undefined) ctorOpts.onAuthRevoked = opts.onAuthRevoked;
    if (opts.onReachability !== undefined) ctorOpts.onReachability = opts.onReachability;
    return new VaultClient(ctorOpts);
  }

  /** Update the in-memory access token (e.g. after a manual refresh). */
  setAccessToken(token: string): void {
    this.token = token;
  }

  get vaultBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Resolve the Bearer token for the next request. When a
   * `tokenProvider` was supplied, calls it; otherwise returns the
   * static token. Protected so subclasses that build their own request
   * paths can reuse the resolution logic.
   */
  protected async resolveToken(): Promise<string> {
    if (this.tokenProvider) {
      const fresh = await this.tokenProvider();
      this.token = fresh;
      return fresh;
    }
    return this.token;
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
    const token = await this.resolveToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
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
      const bodyText = await res.text().catch(() => "");
      throw new VaultServerError(
        `${init.method ?? "GET"} ${path} → ${res.status}`,
        res.status,
        bodyText || undefined,
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
      // 403 is a subclass of VaultAuthError — existing `instanceof
      // VaultAuthError` checks still catch it; scripts wanting to branch
      // "wrong scope" from "dead token" use `instanceof
      // VaultPermissionError`.
      if (res.status === 403) {
        throw new VaultPermissionError(composed, opts);
      }
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

  /**
   * Query notes. Accepts the typed `NotesQuery` shape (see
   * `notes-query.ts` — serialized to vault's exact wire grammar by
   * `buildNotesQuery`) or the raw `URLSearchParams | Record<string,
   * string>` forms (back-compat; also the escape hatch for `search` /
   * `near`, which the typed shape deliberately doesn't model).
   *
   * @example
   * ```ts
   * await vault.queryNotes({
   *   tag: ["#work", "#decision"],
   *   tagMatch: "any",
   *   metadata: { status: { eq: "in-progress" } },
   *   orderBy: "updated_at",
   *   sort: "desc",
   *   limit: 20,
   * });
   * ```
   */
  async queryNotes(params: NotesQueryInput): Promise<Note[]> {
    const s = toNotesSearchParams(params).toString();
    return this.request<Note[]>(`/api/notes${s ? `?${s}` : ""}`);
  }

  /**
   * Cursor-paginated variant. Vault's `/api/notes` cursor mode is
   * PRESENCE-based (`?cursor=` set at all, even empty) — both doors agree
   * (bun `src/routes.ts:1383-1394`, cloud `rest/notes.ts:256-268`): the
   * bootstrap call (no watermark yet) still sends the bare `?cursor=`
   * param, and every call in cursor mode answers the `{notes, next_cursor}`
   * envelope in the JSON body. `X-Next-Cursor` is a cloud-only ADDITIVE
   * mirror of that same body field (`rest/parse.ts:50-53`) — bun never
   * emits it, so it can't be the primary read; this client reads the body
   * and only falls back to the header when the body omits it.
   *
   * Cursor pagination forces ascending order by `updated_at` server-side
   * (`core/src/notes.ts:1320-1338`), so `orderBy` or `sort: "desc"`
   * alongside `cursor` always 400s (`INVALID_QUERY`) on both doors — this
   * throws client-side instead of spending a round trip on a combination
   * that can never succeed.
   *
   * Consumers chain calls (`cursor = nextCursor` from the prior page)
   * until `nextCursor` is undefined.
   *
   * Implementation: drives the request through `requestCursorWithRetry`
   * which mirrors `requestWithRetry`'s 401/403 refresh-and-retry but
   * preserves the Response so we can parse the envelope / fall back to
   * the header.
   */
  async queryNotesCursor(
    params: NotesQueryInput,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Note[]; nextCursor?: string }> {
    const qs = toNotesSearchParams(params);
    // Check the SERIALIZED wire keys, not the typed `NotesQuery` fields —
    // `params` may also arrive as a raw `URLSearchParams | Record<string,
    // string>` (the wire grammar's own `order_by`/`sort` spelling), and
    // both forms funnel through `toNotesSearchParams` to the same keys.
    if (qs.get("order_by") !== null) {
      throw new Error(
        "queryNotesCursor: `orderBy` is incompatible with cursor pagination — cursor mode always orders by updated_at ascending",
      );
    }
    if (qs.get("sort") === "desc") {
      throw new Error(
        'queryNotesCursor: `sort: "desc"` is incompatible with cursor pagination — cursor mode requires ascending order',
      );
    }
    // Bootstrap: the FIRST call has no watermark yet but must still set the
    // param (empty string) to opt into cursor mode at all — omitting
    // `cursor` entirely gets the legacy bare-array shape forever
    // (vault#550's bootstrap fix; see the JSDoc above).
    qs.set("cursor", cursor ?? "");
    if (typeof limit === "number") qs.set("limit", String(limit));
    const s = qs.toString();
    const path = `/api/notes${s ? `?${s}` : ""}`;
    return this.requestCursorWithRetry(path, true);
  }

  /**
   * Protected: cursor-paginated variant of `requestWithRetry` that preserves
   * the Response so the `{notes, next_cursor}` envelope (and the cloud-only
   * `X-Next-Cursor` fallback) survives the auth-retry path. Subclasses can
   * call this directly when adding cursor-paginated domain-specific list
   * endpoints.
   */
  protected async requestCursorWithRetry(
    path: string,
    allowRetry: boolean,
  ): Promise<{ items: Note[]; nextCursor?: string }> {
    const token = await this.resolveToken();
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
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
      const bodyText = await res.text().catch(() => "");
      throw new VaultServerError(`GET ${path} → ${res.status}`, res.status, bodyText || undefined);
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
      if (res.status === 403) {
        throw new VaultPermissionError(composed, opts);
      }
      throw new VaultAuthError(composed, res.status, opts);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    const body = (await res.json()) as unknown;
    // Cursor mode always answers the `{notes, next_cursor}` envelope (both
    // doors: bun `routes.ts:1729-1735`, cloud `notes.ts(c):379-383`) — this
    // call always sets `?cursor=` so it's always in cursor mode. Guard the
    // shape anyway rather than assume, so a server that ignores `cursor`
    // degrades to a single final page instead of throwing on `.notes`.
    let items: Note[];
    let nextCursor: string | undefined;
    if (body && typeof body === "object" && !Array.isArray(body) && "notes" in body) {
      const envelope = body as { notes: Note[]; next_cursor?: string | null };
      items = envelope.notes;
      nextCursor = envelope.next_cursor ?? undefined;
    } else {
      items = body as Note[];
    }
    // `X-Next-Cursor` is a cloud-only additive mirror of the same body
    // field (bun never emits it) — fallback only, body is authoritative.
    if (!nextCursor) {
      const headerCursor = res.headers.get("x-next-cursor") ?? undefined;
      if (headerCursor) nextCursor = headerCursor;
    }
    const out: { items: Note[]; nextCursor?: string } = { items };
    if (nextCursor) out.nextCursor = nextCursor;
    return out;
  }

  /**
   * Live-query subscription over vault's `GET /api/subscribe` endpoint.
   * Delivers one `onSnapshot(notes)` — the complete matching set — then
   * `onUpsert(note)` / `onRemove(id)` as notes enter/change/leave the set.
   * Returns the unsubscribe function.
   *
   * - **Transport is WebSocket-only** (`ws-transport.ts`). A Hibernatable
   *   WebSocket lets an idle-but-open socket evict the cloud vault DO → ~$0
   *   idle. There is **no SSE fallback** — SSE is being retired; when WS is
   *   unavailable (an old server without the binding, a WS-blocked network, or
   *   a drop) the subscription degrades to the consumer's **polling floor**
   *   (`isLive` stays false, no error UI, no hang) while a capped-backoff
   *   reconnect keeps trying in the background and re-establishes live the
   *   moment WS is reachable again.
   * - **Query grammar** is the same as `queryNotes` (same server-side
   *   parser), except `search`, `near`, and `cursor` are not
   *   live-evaluable — this method throws on them synchronously (the
   *   vault would 400).
   * - **Auth rides a first-message handshake, never a `?key=` query param** —
   *   browsers can't header-auth a socket, so the client sends
   *   `{type:"auth",token}` as the first frame and re-auths on the open socket
   *   when the token rotates (no reconnect, no re-snapshot). No token in proxy
   *   logs.
   * - **Reconnects are self-correcting**: vault has no event replay, so a
   *   reconnect re-delivers a *fresh snapshot* that replaces the
   *   consumer's set — anything missed while disconnected is reconciled
   *   wholesale. Backoff is exponential and capped (see
   *   {@link SubscribeOptions}).
   * - **Auth expiry**: a WS close 4401 (expired/revoked) drives the client's
   *   `onAuthError` refresh seam once, then reconnects with the fresh token
   *   (also rotated into the client). Unrecoverable auth → the subscription
   *   terminates with `onError(VaultAuthError)` + `onStatus("closed")` (and the
   *   consumer falls back to polling).
   *
   * @example
   * ```ts
   * const unsubscribe = vault.subscribe(
   *   { tag: "#channel-message", "meta[channel][eq]": "general" },
   *   {
   *     onSnapshot: (notes) => render(notes),
   *     onUpsert: (note) => upsertRow(note),
   *     onRemove: (id) => dropRow(id),
   *     onStatus: (s) => setLive(s === "open"),
   *   },
   * );
   * // later: unsubscribe();
   * ```
   */
  subscribe(
    query: NotesQueryInput,
    handlers: SubscribeHandlers,
    opts: SubscribeOptions = {},
  ): () => void {
    const qs = toNotesSearchParams(query);
    assertSubscribableQuery(qs);
    const s = qs.toString();
    const transport: SubscribeTransport = {
      url: `${this.baseUrl}/api/subscribe${s ? `?${s}` : ""}`,
      resolveToken: () => this.resolveToken(),
      // Reuse the request path's refresh-on-auth-failure seam; rotate the
      // cached token the same way `requestWithRetry` does on a refresh.
      refreshToken: this.onAuthError
        ? async () => {
            const fresh = await this.onAuthError?.();
            if (fresh) this.token = fresh;
            return fresh ?? null;
          }
        : undefined,
      webSocketImpl: this.webSocketImpl,
    };
    return startWsSubscription(transport, handlers, opts);
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

  /**
   * Batch-create notes via `POST /api/notes` with a `{notes: [...]}`
   * envelope. Vault wraps the batch in a SQLite transaction — a mid-
   * batch failure (path conflict, etc.) rolls back every prior insert,
   * so the caller gets either "all of these landed" or
   * "none of these landed" (no partial state).
   *
   * **Batch cap.** Vault refuses batches over its `MAX_BATCH_SIZE`
   * (500 at time of writing — see vault#213). Oversized batches return
   * `413 batch_too_large`, which surfaces here as an `Error` carrying
   * the upstream message; vault doesn't yet emit a structured shape
   * the client can class-discriminate on.
   *
   * **Conflict handling.** A path collision (or any other 409 from the
   * store) throws `VaultConflictError` — or `VaultTargetExistsError`
   * for the tag-rename collision shape — same as `createNote`.
   *
   * Returns the created notes in the order they were submitted.
   *
   * @example
   * ```ts
   * const notes = await vault.createNotes([
   *   { content: "Note A", tags: ["#log"] },
   *   { content: "Note B", tags: ["#log"] },
   * ]);
   * console.log(`Created ${notes.length} notes`);
   * ```
   */
  async createNotes(
    payloads: CreateNotePayload[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<Note[]> {
    const init: RequestInit = {
      method: "POST",
      body: JSON.stringify({ notes: payloads }),
    };
    if (opts.signal) init.signal = opts.signal;
    return this.request<Note[]>("/api/notes", init);
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

  async listTags(): Promise<TagSummary[]>;
  async listTags(opts: { includeSchema: true }): Promise<TagRecord[]>;
  async listTags(opts: { includeSchema: false }): Promise<TagSummary[]>;
  /**
   * List every tag in the vault.
   *
   * - Default: returns `{name, count}` rows — the cheap path for tag
   *   pickers, autocomplete, and home-strip pin lookups.
   * - `{ includeSchema: true }`: returns full `TagRecord[]` per tag —
   *   description, fields, parent_names, relationships, timestamps —
   *   in a single round-trip. Vault joins from `tag_identity` rows
   *   internally so this is one query, not N. Used by the Notes UI
   *   tag schema viewer (notes-ui, 2026-05-27).
   *
   * Vault's `GET /api/tags?include_schema=true` returns the joined shape
   * envelope; the non-overloaded `await listTags()` keeps the old shape.
   */
  async listTags(opts?: { includeSchema?: boolean }): Promise<TagSummary[] | TagRecord[]> {
    if (opts?.includeSchema) {
      return this.request<TagRecord[]>("/api/tags?include_schema=true");
    }
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

  /**
   * Delete a tag identity row + remove the tag from every note that
   * carries it. Vault's `DELETE /api/tags/:name`.
   *
   * **Tag-scoped-token guard.** Vault refuses 409 if any tag-scoped
   * token references the tag in its allowlist (deleting the tag would
   * silently orphan the token's scope). The caller has to revoke or
   * re-mint those tokens before retrying. Surfaces as
   * `VaultConflictError` with the upstream `referenced_by` payload
   * carried on `error.body` (JSON-encoded) for diagnostic logging.
   */
  async deleteTag(name: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const init: RequestInit = { method: "DELETE" };
    if (opts.signal) init.signal = opts.signal;
    await this.request<{ deleted?: boolean } | undefined>(
      `/api/tags/${encodeURIComponent(name)}`,
      init,
    );
  }

  // ---------- graph ----------

  /**
   * Find a path between two notes in the link graph (BFS shortest
   * path; bi-directional — traverses both inbound and outbound links).
   * Calls `GET /api/find-path?source=...&target=...&max_depth=...`.
   *
   * Vault caps `max_depth` at 10 internally; values above that get
   * clamped silently. Returns `null` when no path is reachable within
   * the depth limit.
   *
   * `from` and `to` accept either note IDs or note paths. Vault
   * resolves both the same way it does for other note-level calls.
   *
   * @example
   * ```ts
   * const result = await vault.findPath("note-a", "note-b");
   * if (result) {
   *   console.log(`Connected via ${result.path.length - 1} hop(s)`);
   * }
   * ```
   */
  async findPath(
    from: string,
    to: string,
    opts: { maxDepth?: number; signal?: AbortSignal } = {},
  ): Promise<FindPathResult | null> {
    const params = new URLSearchParams({ source: from, target: to });
    if (typeof opts.maxDepth === "number") params.set("max_depth", String(opts.maxDepth));
    const init: RequestInit = {};
    if (opts.signal) init.signal = opts.signal;
    return this.request<FindPathResult | null>(`/api/find-path?${params.toString()}`, init);
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

      // Upload uses XHR (for the progress events fetch can't expose), so
      // we resolve the token synchronously off the cached value. When a
      // `tokenProvider` is in use, the cache is whatever the last
      // request resolved — `uploadStorageFile` callers wanting a fresh
      // token should do an unrelated JSON request first to warm the
      // cache, or call `resolveToken()` directly before invoking this.
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
          if (xhr.status === 403) {
            reject(new VaultPermissionError(composed, aopts));
          } else {
            reject(new VaultAuthError(composed, xhr.status, aopts));
          }
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

  /**
   * Auth'd GET of an attachment blob (image/audio render). Accepts an
   * absolute URL, a vault-relative path (`/api/storage/<path>`), or a
   * bare storage path — the same resolution notes-ui's subclass
   * established (which keeps its own override; this base implementation
   * makes plain clients blob-capable too).
   *
   * Exists because the shared `request*` loop always `.json()`s the
   * body; blobs need their own thin retry loop. Runs the full
   * auth/refresh/error-classification contract: Authorization header,
   * refresh-on-401 via `onAuthError` (retry once), reachability
   * signals, and the structured error hierarchy.
   *
   * **This is the deliberate fetch-blob seam for surface-render** — its
   * `vaultClientFetchBlob` adapter prefers `client.fetchAttachmentBlob`
   * when present, so a base `VaultClient` now renders auth-gated media
   * without the surface exposing a bearer accessor. The token stays
   * inside the client *on purpose*: no `getAccessToken` is added, so
   * the future no-token-accessor `ScopedVaultClient` (surface-host R3)
   * can extend this class without violating its custody contract.
   */
  async fetchAttachmentBlob(url: string): Promise<Blob> {
    const target = /^https?:\/\//.test(url)
      ? url
      : `${this.baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
    return this.requestBlobWithRetry(target, url, true);
  }

  /**
   * Protected: the blob-returning analog of `requestWithRetry` —
   * identical auth/refresh/reachability/error semantics, but resolves
   * `res.blob()` instead of parsing JSON. Subclasses adding blob
   * endpoints can reuse it.
   */
  protected async requestBlobWithRetry(
    target: string,
    original: string,
    allowRetry: boolean,
  ): Promise<Blob> {
    const token = await this.resolveToken();
    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.onReachability?.("unreachable", message);
      throw new VaultUnreachableError(`GET ${original} failed: ${message}`, 0);
    }
    if (res.status >= 500) {
      this.onReachability?.("unreachable", `HTTP ${res.status}`);
      const bodyText = await res.text().catch(() => "");
      throw new VaultServerError(
        `GET ${original} → ${res.status}`,
        res.status,
        bodyText || undefined,
      );
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
          return this.requestBlobWithRetry(target, original, false);
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
      if (res.status === 403) {
        throw new VaultPermissionError(composed, opts);
      }
      throw new VaultAuthError(composed, res.status, opts);
    }
    if (res.status === 404) {
      throw new VaultNotFoundError(`GET ${original} → 404`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GET ${original} failed (${res.status}): ${text}`);
    }
    return res.blob();
  }
}
