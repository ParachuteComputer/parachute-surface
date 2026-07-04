/**
 * Live-query WebSocket transport — the **WS-only** client side of vault's
 * `GET /vault/<name>/api/subscribe` (an `Upgrade: websocket` request selects the
 * WebSocket binding). It sits behind the `startWsSubscription` seam that
 * `VaultClient.subscribe()` drives; `createLiveList`, the reconcilers, and
 * notes-ui all sit above it and are transport-agnostic.
 *
 * Phase 2 of the SSE → Hibernatable-WebSockets migration (team-vault
 * `Decisions/2026-07-04-live-query-ws-hibernation`; wire contract
 * `parachute-cloud/workers/vault/docs/live-query-ws.md`). A held-open SSE stream
 * pins the per-vault Cloudflare Durable Object awake and bills duration; a
 * Hibernatable WebSocket lets an idle-but-open socket evict the DO → ~$0 idle.
 *
 * ## Live is an augmentation; polling is the floor (the degradation model)
 *
 * There is **no SSE fallback** — SSE is being retired, so the client never
 * speaks it. Instead the model is two-state: **WebSocket-or-polling**. The
 * consumer (notes-ui via `createLiveList` → react-query) always has a polling
 * cadence underneath; a live subscription is a *fresher-than-polling*
 * augmentation on top. So when WS can't be established — an old server without
 * the binding, a network that blocks WebSockets, or a drop mid-session — the
 * transport does NOT surface a terminal error or hang. It stays in a non-`live`
 * status (so the consumer keeps polling) and runs a **capped-backoff reconnect
 * in the background**, re-establishing the live augmentation the moment WS
 * becomes reachable again (server upgraded / network recovered). Only genuinely
 * unrecoverable conditions (a protocol bug, a scope denial, or exhausted auth)
 * stop the reconnect loop — and even those just leave the consumer on polling.
 *
 * ## WS wire contract (the load-bearing invariant)
 *
 * The inner payloads are **byte-identical to what the SSE binding emitted** in
 * its `data:` bodies; the event name folds into a `type` discriminator and the
 * snapshot is chunked:
 *
 *   - `{"type":"snapshot","notes":[…],"done":<bool>}` — chunked; accumulate
 *     `notes` across frames until `done:true`, then emit ONE `onSnapshot`
 *     (replaces the set — self-correcting-reconnect semantics).
 *   - `{"type":"upsert","note":{…}}` / `{"type":"remove","id":"…"}` — same
 *     shape/guards the consumer already expects.
 *
 * ## Auth handshake (first-message, not header)
 *
 * Browsers can't set headers on a WebSocket, so auth is the FIRST frame
 * (`{"type":"auth","token":"…"}`, sent on `open`); the token is re-sent on the
 * OPEN socket when it rotates (no reconnect, no re-snapshot). Close codes
 * (application range, visible to JS): 4400 protocol → terminal, 4401
 * unauthorized → refresh-once-then-reconnect, 4403 forbidden → terminal, 4408
 * auth-timeout → reconnect.
 *
 * ## Liveness
 *
 * The client sends the literal string `"ping"` every ~30s and expects a
 * `"pong"` (the DO's no-wake auto-response) — or any other server frame —
 * within ~10s, else it terminates the socket and reconnects (fresh snapshot;
 * the no-replay self-healing is preserved).
 */

import type {
  SubscribeHandlers,
  SubscribeOptions,
  SubscribeTransport,
  WebSocketCtor,
  WebSocketLike,
} from "./subscribe.js";
import { VaultAuthError, VaultPermissionError, VaultUnreachableError } from "./vault-client.js";
import type { Note } from "./vault-types.js";

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

/** WebSocket `readyState` OPEN (avoid depending on a static on the ctor/fake). */
const WS_OPEN = 1;

function resolveWsCtor(transport: SubscribeTransport): WebSocketCtor | undefined {
  if (transport.webSocketImpl) return transport.webSocketImpl;
  // The DOM `WebSocket` isn't structurally `WebSocketLike` under strict
  // function types (its event params are the concrete DOM event types), so
  // route it through `unknown` — we only ever construct it + read `ev.data`.
  const g = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof g === "function" ? (g as unknown as WebSocketCtor) : undefined;
}

/** Map an `http(s)://` subscribe URL to its `ws(s)://` equivalent. */
function toWsUrl(httpUrl: string): string {
  if (/^https:/i.test(httpUrl)) return `wss:${httpUrl.slice("https:".length)}`;
  if (/^http:/i.test(httpUrl)) return `ws:${httpUrl.slice("http:".length)}`;
  return httpUrl; // already ws/wss (or relative — let the ctor decide)
}

/** The outcome of one WebSocket connection attempt, interpreted by the loop. */
interface WsAttemptResult {
  /** Did `onopen` fire? `false` ⇒ the origin answered the upgrade non-101. */
  opened: boolean;
  /** Did we receive at least one server frame? `true` ⇒ auth passed + WS works. */
  gotMessage: boolean;
  /** The application close code, when the socket closed cleanly. */
  closeCode: number | null;
  /** The close reason, when present. */
  reason?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Run the live subscription over a WebSocket, degrading to the consumer's
 * polling floor (never SSE) when WS is unavailable — see the module header.
 * Drop-in shape for the consumer seam: `(transport, handlers, opts) =>
 * unsubscribe`. `onSnapshot` / `onUpsert` / `onRemove` dispatch, capped
 * backoff, and one-refresh-per-auth-failure-streak match what the consumer
 * expects.
 */
export function startWsSubscription(
  transport: SubscribeTransport,
  handlers: SubscribeHandlers,
  opts: SubscribeOptions = {},
): () => void {
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;

  const controller = new AbortController();
  let closed = false;
  /** The socket for the in-flight attempt (so `close()` can tear it down). */
  let activeSocket: WebSocketLike | null = null;

  const emitStatus = (s: Parameters<NonNullable<SubscribeHandlers["onStatus"]>>[0]) => {
    try {
      handlers.onStatus?.(s);
    } catch {
      // A throwing status handler must not kill the loop.
    }
  };

  const backoff = (attempt: number) => Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs);

  /** Idempotent terminal close — the ONLY place "closed" is emitted. */
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    try {
      activeSocket?.close();
    } catch {
      // socket already closing / closed
    }
    emitStatus("closed");
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      close();
      return close;
    }
    opts.signal.addEventListener("abort", close, { once: true });
  }

  const wsCtor = resolveWsCtor(transport);
  if (!wsCtor) {
    // No WebSocket in this runtime → the live augmentation can't run. Signal
    // "live unavailable" (terminal, non-error) so the consumer stays on its
    // polling floor. Not a hang, not an error UI.
    handlers.onError?.(
      new VaultUnreachableError("subscribe: WebSocket unavailable — live disabled, polling only", 0),
    );
    close();
    return close;
  }

  /** Abortable sleep — resolves early (without throwing) on close/abort. */
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

  /** One WebSocket connection; resolves when it closes / errors / is aborted. */
  const runOneConnection = (token: string): Promise<WsAttemptResult> =>
    new Promise<WsAttemptResult>((resolve) => {
      let opened = false;
      let gotMessage = false;
      let settled = false;
      let sessionToken = token; // the token last sent in an `auth` message
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let pongTimer: ReturnType<typeof setTimeout> | null = null;
      // Snapshot chunk accumulator (reset per connection — a snapshot is sent
      // once per authenticated (re)connect).
      let snapshotAcc: Note[] = [];
      let snapshotOpen = false;

      let ws: WebSocketLike;
      try {
        ws = new wsCtor(toWsUrl(transport.url));
      } catch {
        // Constructor threw (bad URL / no WS support) → handshake failure.
        resolve({ opened: false, gotMessage: false, closeCode: null });
        return;
      }
      activeSocket = ws;

      const clearTimers = () => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      };

      const settle = (r: WsAttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimers();
        controller.signal.removeEventListener("abort", onAbort);
        if (activeSocket === ws) activeSocket = null;
        resolve(r);
      };

      function onAbort() {
        try {
          ws.close();
        } catch {
          // already closing
        }
        settle({ opened, gotMessage, closeCode: null });
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });

      /** Any server frame proves liveness — clear the pending pong deadline. */
      const markActivity = () => {
        if (pongTimer) {
          clearTimeout(pongTimer);
          pongTimer = null;
        }
      };

      const armPong = () => {
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          // No liveness response in time → the socket is wedged. Close it; the
          // reconnect re-snapshots (preserving the no-replay self-healing).
          try {
            ws.close();
          } catch {
            // ignore
          }
          settle({ opened, gotMessage, closeCode: null });
        }, pongTimeoutMs);
      };

      const onPingTick = async () => {
        if (closed || ws.readyState !== WS_OPEN) return;
        // Re-auth on the OPEN socket if the token rotated (no reconnect, no
        // re-snapshot) — keeps hours-long sockets authed across ~15-min JWTs.
        try {
          const tok = await transport.resolveToken();
          if (!closed && tok !== sessionToken && ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify({ type: "auth", token: tok }));
            sessionToken = tok;
          }
        } catch {
          // token resolution hiccup — still probe liveness below
        }
        if (closed || ws.readyState !== WS_OPEN) return;
        try {
          ws.send("ping");
        } catch {
          return;
        }
        armPong();
      };

      /** Route one parsed server message — guards match the consumer contract. */
      const dispatch = (raw: unknown) => {
        let parsed: unknown;
        try {
          parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
        } catch (err) {
          // One malformed frame must not kill a healthy socket.
          handlers.onError?.(err);
          return;
        }
        const body = isRecord(parsed) ? parsed : {};
        const type = body.type;
        if (type === "snapshot") {
          const notes = Array.isArray(body.notes) ? (body.notes as Note[]) : [];
          snapshotAcc = snapshotOpen ? snapshotAcc.concat(notes) : notes.slice();
          snapshotOpen = true;
          // `done` is always present per the contract; treat a missing flag as
          // a complete (non-chunked) snapshot rather than buffering forever.
          if (body.done === true || body.done === undefined) {
            handlers.onSnapshot(snapshotAcc);
            snapshotAcc = [];
            snapshotOpen = false;
          }
        } else if (type === "upsert") {
          if (body.note && typeof body.note === "object") handlers.onUpsert(body.note as Note);
        } else if (type === "remove") {
          if (typeof body.id === "string") handlers.onRemove(body.id);
        }
        // Unknown type: ignored (forward compatibility).
      };

      ws.onopen = () => {
        opened = true;
        try {
          ws.send(JSON.stringify({ type: "auth", token: sessionToken }));
        } catch {
          // send-on-open failed — the close/error handler drives recovery
        }
        pingTimer = setInterval(() => {
          void onPingTick();
        }, pingIntervalMs);
      };

      ws.onmessage = (ev: unknown) => {
        const data = isRecord(ev) ? (ev as { data?: unknown }).data : undefined;
        markActivity();
        // A `pong` is liveness only — it must NOT count as "auth succeeded".
        // Check it BEFORE the open flip so the "open only after a real (post-
        // auth) data frame" invariant holds regardless of ping cadence (a pong
        // can precede the snapshot when pingInterval < the server's auth
        // deadline — not at the 30s/10s defaults, but possible in tests).
        if (typeof data === "string" && data === "pong") return; // liveness ack
        if (!gotMessage) {
          // First real frame confirms auth passed + the socket works. This is
          // the analog of the old SSE "open" (auth already validated by then).
          gotMessage = true;
          emitStatus("open");
        }
        dispatch(data);
      };

      ws.onerror = () => {
        // An error is almost always followed by close (which settles). Don't
        // settle here — let onclose carry the code.
      };

      ws.onclose = (ev: unknown) => {
        const code = isRecord(ev) && typeof ev.code === "number" ? (ev.code as number) : null;
        const reason =
          isRecord(ev) && typeof ev.reason === "string" && ev.reason ? (ev.reason as string) : undefined;
        settle(
          reason !== undefined
            ? { opened, gotMessage, closeCode: code, reason }
            : { opened, gotMessage, closeCode: code },
        );
      };
    });

  void (async () => {
    let attempt = 0; // backoff exponent; reset on a working session
    let firstConnect = true;
    let refreshedThisStreak = false;

    while (!closed) {
      emitStatus(firstConnect ? "connecting" : "reconnecting");
      firstConnect = false;

      let token: string;
      try {
        token = await transport.resolveToken();
      } catch (err) {
        if (closed) return;
        const message = err instanceof Error ? err.message : String(err);
        handlers.onError?.(
          new VaultUnreachableError(`subscribe ws token resolution failed: ${message}`, 0),
        );
        await sleep(backoff(attempt));
        attempt++;
        continue;
      }

      const result = await runOneConnection(token);
      if (closed) return;

      const code = result.closeCode;

      // ---- Terminal conditions (a reconnect can't heal them) ----
      // Even these degrade gracefully: the consumer just stays on its polling
      // floor; we only stop the background reconnect because retrying is futile.

      // 4400 protocol error (mirrors the old SSE 400=terminal).
      if (code === 4400) {
        handlers.onError?.(
          new Error(
            `subscribe ws rejected (4400 protocol error)${result.reason ? `: ${result.reason}` : ""}`,
          ),
        );
        close();
        return;
      }

      // 4403 forbidden — scope mismatch / a re-auth that would widen scope.
      // Refresh can't grant more scope → terminal (VaultPermissionError).
      if (code === 4403) {
        handlers.onError?.(
          new VaultPermissionError(
            `subscribe ws forbidden (4403)`,
            result.reason ? { body: result.reason } : {},
          ),
        );
        close();
        return;
      }

      // 4401 unauthorized (expired / revoked) — refresh once per auth-failure
      // streak, then reconnect; exhausted → terminal.
      if (code === 4401) {
        if (!refreshedThisStreak && transport.refreshToken) {
          let fresh: string | null = null;
          try {
            fresh = await transport.refreshToken();
          } catch {
            fresh = null;
          }
          if (fresh !== null && !closed) {
            refreshedThisStreak = true;
            continue; // immediate reconnect with the fresh token
          }
        }
        handlers.onError?.(
          new VaultAuthError(
            `subscribe ws rejected (4401)`,
            401,
            result.reason ? { body: result.reason } : {},
          ),
        );
        close();
        return;
      }

      // ---- Non-terminal: transient → capped-backoff reconnect FOREVER ----
      // This IS the graceful-degradation path. Handshake failure (an old server
      // without the WS binding, or a network that blocks WebSockets), a network
      // error, 4408 auth-timeout, 1006/1011, a clean drop, our ping-timeout, or
      // an opened-but-silent socket all land here. The subscription stays
      // non-`live` (the consumer keeps polling) while we keep probing, so live
      // re-establishes the moment WS is reachable again.
      refreshedThisStreak = false;
      if (result.gotMessage) {
        // A working session dropped → reconnect fast; the fresh snapshot
        // reconciles anything missed.
        attempt = 0;
      } else if (!result.opened) {
        // Never even upgraded — the common "WS not available here" case.
        // Observational only (the consumer keeps polling); backoff grows to the
        // ceiling so a permanently-SSE-only server is probed at most ~every 30s.
        handlers.onError?.(
          new VaultUnreachableError(`subscribe ws: connection did not open (live unavailable — polling)`, 0),
        );
      }
      await sleep(backoff(attempt));
      attempt++;
    }
  })();

  return close;
}
