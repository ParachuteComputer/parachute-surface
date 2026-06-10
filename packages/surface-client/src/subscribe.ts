/**
 * Live-query SSE subscription — the client side of vault's
 * `GET /vault/<name>/api/subscribe` (vault design
 * `2026-06-08-live-query-sse.md`). Upstreamed from my-vault-ui's
 * `src/vault/sse.ts` (which carried the literal comment "to be upstreamed
 * as VaultClient.subscribe()"), redesigned around fetch-stream transport.
 *
 * The server sends one `snapshot` event (the currently-matching note set),
 * then `upsert` / `remove` events as notes change, plus `:` comment
 * keepalives every ~25s. The same query grammar as `GET /api/notes`
 * applies, minus the shapes that can't be evaluated live (`search`,
 * `near`, `cursor` — vault rejects them with 400; we reject them
 * client-side before opening a stream).
 *
 * **Why fetch-stream, not EventSource.** `EventSource` cannot set request
 * headers, which forces the bearer into a `?key=` query param — a token in
 * proxy logs, browser history, and Referer headers. That was flagged as the
 * design trap when this was upstreamed. We instead `fetch()` the stream
 * with `Authorization: Bearer <token>` and parse the SSE wire format off
 * the response `ReadableStream` ourselves ({@link parseSSEStream}). Bonus:
 * fetch works identically in Bun/Node server contexts (no `EventSource`
 * global needed), which matters because surface-host's `ScopedVaultClient`
 * runs this server-side.
 *
 * **Reconnection model (self-correcting).** Vault's MVP has no
 * `Last-Event-ID` replay: on reconnect the client simply re-subscribes and
 * receives a **fresh snapshot**, which replaces the consumer's whole set —
 * any events missed while disconnected are reconciled by the snapshot, so
 * a dropped connection can never leave the consumer permanently stale.
 * Reconnects use capped exponential backoff
 * ({@link SubscribeOptions.initialBackoffMs} / `maxBackoffMs`).
 *
 * **Auth.** The token is resolved per connection attempt via the client's
 * token resolution (static token or `tokenProvider`). A 401/403 on connect
 * (including reconnect-after-token-expiry — the common case for ~15-min hub
 * JWTs) drives the client's refresh-on-401 seam (`onAuthError`) once, then
 * resubscribes with the fresh token. If refresh isn't possible (or the
 * refreshed token is rejected too), the subscription terminates:
 * `onError(VaultAuthError)` then `onStatus("closed")`.
 */

import { VaultAuthError, VaultPermissionError, VaultServerError, VaultUnreachableError } from "./vault-client.js";
import type { Note } from "./vault-types.js";

/** A single parsed SSE event (named event + joined data payload). */
export interface SSEEvent {
  /** The `event:` field; `"message"` when the server didn't name one. */
  event: string;
  /** The `data:` payload — multi-line `data:` fields joined with `\n`. */
  data: string;
}

/** Lifecycle signal for a live subscription. */
export type SubscribeStatus =
  /** First connection attempt is in flight. */
  | "connecting"
  /** Stream is open; snapshot has been (or is about to be) delivered. */
  | "open"
  /** Stream dropped; a reconnect attempt is scheduled / in flight. */
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
   * (network drop, 5xx; reconnection continues) and terminal alike. A
   * terminal error is always followed by `onStatus("closed")`; without
   * that, the subscription is still retrying.
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
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Parse the SSE wire format off a `ReadableStream<Uint8Array>` (the
 * response body of a `text/event-stream` fetch). Yields one
 * {@link SSEEvent} per dispatched event. Implements the parts of the
 * WHATWG SSE grammar the vault emits, faithfully:
 *
 *   - `event:` names the next dispatch; resets after each dispatch.
 *   - `data:` lines accumulate; multi-line data joins with `\n`.
 *   - A blank line dispatches. Per spec, an event with an EMPTY data
 *     buffer is dropped (this is how `event:`-only frames behave).
 *   - Lines starting with `:` are comments (vault's keepalive) — ignored.
 *   - `id:` / `retry:` fields are tolerated and ignored (vault doesn't
 *     send them; reconnection here is snapshot-based, not cursor-based).
 *   - CRLF / CR line endings are normalized.
 *
 * Exported for direct use/testing; `VaultClient.subscribe()` is the
 * consumer-facing API.
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const takeEvent = (): SSEEvent | null => {
    // Spec: empty data buffer → reset the event name, dispatch nothing.
    if (dataLines.length === 0) {
      eventName = "";
      return null;
    }
    const ev: SSEEvent = { event: eventName || "message", data: dataLines.join("\n") };
    eventName = "";
    dataLines = [];
    return ev;
  };

  const handleLine = (line: string): SSEEvent | null => {
    if (line === "") return takeEvent();
    if (line.startsWith(":")) return null; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // id / retry / unknown fields: ignored.
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF/CR → LF once per chunk, then emit complete lines.
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ev = handleLine(line);
        if (ev) yield ev;
        nl = buffer.indexOf("\n");
      }
    }
    // Stream ended; a trailing un-terminated line or un-dispatched event is
    // dropped per spec (no final blank line = no dispatch).
  } finally {
    reader.releaseLock();
  }
}

/**
 * Query shapes vault's `/api/subscribe` rejects with 400 — checked
 * client-side so a bad subscription throws synchronously instead of
 * opening a doomed stream. Mirrors `parachute-vault/src/subscribe.ts`:
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
 * Transport seam between `VaultClient` and the subscription loop. Keeps
 * the loop independently testable and keeps token custody inside the
 * client — the loop sees a resolver + refresh callback, never a stored
 * token field.
 */
export interface SubscribeTransport {
  /** Fully-built subscribe URL (`<vaultUrl>/api/subscribe?<query>`). */
  url: string;
  /** Resolve the bearer for the next connection attempt. */
  resolveToken: () => Promise<string>;
  /**
   * The client's refresh-on-401 seam. Returns a fresh token (the loop
   * resubscribes with it) or null when refresh isn't possible (the loop
   * terminates with `VaultAuthError`). Absent = no refresh path.
   */
  refreshToken?: (() => Promise<string | null>) | undefined;
  fetchImpl: typeof fetch;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Run the subscription loop: connect → deliver events → reconnect with
 * capped exponential backoff. Returns the unsubscribe function. See the
 * module header for the full lifecycle contract; `VaultClient.subscribe()`
 * is the consumer-facing wrapper.
 */
export function startSubscription(
  transport: SubscribeTransport,
  handlers: SubscribeHandlers,
  opts: SubscribeOptions = {},
): () => void {
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  const controller = new AbortController();
  let closed = false;

  const emitStatus = (s: SubscribeStatus) => {
    try {
      handlers.onStatus?.(s);
    } catch {
      // A throwing status handler must not kill the loop.
    }
  };

  /** Idempotent terminal close — the ONLY place "closed" is emitted. */
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    emitStatus("closed");
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      // Already aborted: never open a connection. Emit the terminal status
      // for consistency with a post-open abort.
      close();
      return close;
    }
    opts.signal.addEventListener("abort", close, { once: true });
  }

  /** Abortable sleep — resolves early (without throwing) on unsubscribe. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });

  const dispatch = (ev: SSEEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch (err) {
      // One malformed frame must not kill a healthy stream.
      handlers.onError?.(err);
      return;
    }
    const body = (parsed ?? {}) as Record<string, unknown>;
    if (ev.event === "snapshot") {
      handlers.onSnapshot(Array.isArray(body.notes) ? (body.notes as Note[]) : []);
    } else if (ev.event === "upsert") {
      if (body.note && typeof body.note === "object") handlers.onUpsert(body.note as Note);
    } else if (ev.event === "remove") {
      if (typeof body.id === "string") handlers.onRemove(body.id);
    }
    // Unknown event names: ignored (forward compatibility).
  };

  void (async () => {
    let attempt = 0; // backoff exponent; reset on every successful open
    let firstConnect = true;
    // One refresh per consecutive-auth-failure streak: a 401 right after a
    // successful refresh means the fresh token is ALSO rejected — terminate
    // instead of spinning refresh→401→refresh forever.
    let refreshedThisStreak = false;

    while (!closed) {
      emitStatus(firstConnect ? "connecting" : "reconnecting");
      firstConnect = false;

      let res: Response;
      try {
        const token = await transport.resolveToken();
        res = await transport.fetchImpl(transport.url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (closed || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        handlers.onError?.(new VaultUnreachableError(`subscribe connect failed: ${message}`, 0));
        await sleep(Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs));
        attempt++;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const bodyText = await res.text().catch(() => "");
        if (!refreshedThisStreak && transport.refreshToken) {
          let fresh: string | null = null;
          try {
            fresh = await transport.refreshToken();
          } catch {
            fresh = null;
          }
          if (fresh !== null && !closed) {
            refreshedThisStreak = true;
            continue; // resubscribe immediately with the fresh token
          }
        }
        // Unrecoverable: no refresh path, refresh failed, or the refreshed
        // token was rejected too.
        handlers.onError?.(
          res.status === 403
            ? new VaultPermissionError(`subscribe rejected (403)`, bodyText ? { body: bodyText } : {})
            : new VaultAuthError(`subscribe rejected (401)`, 401, bodyText ? { body: bodyText } : {}),
        );
        close();
        return;
      }

      if (res.status === 400) {
        // Invalid/unsupported query — retrying can't heal it.
        const bodyText = await res.text().catch(() => "");
        handlers.onError?.(new Error(`subscribe rejected (400): ${bodyText}`));
        close();
        return;
      }

      if (!res.ok || !res.body) {
        // 5xx / 503-cap / bodyless response — transient; back off and retry.
        // A non-auth response also ends any 401 streak: the next 401 gets a
        // fresh refresh attempt. Deliberate consequence: 401→5xx→401 spends
        // TWO refreshes — one per streak — because the intervening 5xx
        // proves the second 401 is not "the refreshed token was rejected
        // too"; the guard only caps refreshes per CONSECUTIVE auth-failure
        // streak, which is what prevents a refresh→401→refresh spin.
        refreshedThisStreak = false;
        const bodyText = await res.text().catch(() => "");
        handlers.onError?.(
          new VaultServerError(`subscribe → ${res.status}`, res.status, bodyText || undefined),
        );
        await sleep(Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs));
        attempt++;
        continue;
      }

      // ---- Stream open ----
      attempt = 0;
      refreshedThisStreak = false;
      emitStatus("open");
      try {
        for await (const ev of parseSSEStream(res.body)) {
          if (closed) return;
          dispatch(ev);
        }
        // Server closed the stream — treat as transient; the reconnect's
        // fresh snapshot reconciles anything missed.
      } catch (err) {
        if (closed || isAbortError(err)) return;
        handlers.onError?.(err);
      }
      if (closed) return;
      await sleep(Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs));
      attempt++;
    }
  })();

  return close;
}
