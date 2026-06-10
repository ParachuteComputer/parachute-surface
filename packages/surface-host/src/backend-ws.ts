/**
 * WebSocket multiplexing for backed surfaces (surface-runtime design P4).
 *
 * The HUB's upgrade bridge (H1, parachute-hub/src/ws-bridge.ts) forwards
 * `Upgrade: websocket` requests for modules declaring `websocket: true` to
 * this daemon over loopback, with the substrate trust headers stamped
 * (X-Parachute-Layer / X-Parachute-Client-IP) and the client's own
 * cookie/authorization riding through. The host's HTTP dispatch accepts an
 * upgrade ONLY at `${mount}/ws` for a surface that (a) declared the
 * `"websocket"` capability AND (b) has a mounted backend exporting
 * `websocket` handlers — everything else is 426 (deny-by-default, same
 * posture as the hub bridge).
 *
 * One Bun.serve handler set serves every surface; per-connection data
 * (`ws.data`) carries the owning surface name + the trust signals captured
 * at upgrade time (the per-message handlers have no Request to read). The
 * pump resolves the surface's CURRENT backend per event — a reload swaps
 * the backend under live connections cleanly (events after the swap reach
 * the fresh instance; a removed/disabled backend closes the socket).
 *
 * Handler errors are CONTAINED (§11): the connection closes (1011 with a
 * generic reason — no error detail crosses the wire) and the failure
 * counts toward the surface's crash-loop window. Siblings are unaffected.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";

import type { BackendSupervisor } from "./backend-supervisor.ts";
import type { BackendWebSocketHandlers, SurfaceSocket, TrustLayer } from "./backend-types.ts";

/** Per-connection payload attached at `server.upgrade(req, { data })`. */
export interface SurfaceWsData {
  /** Owning surface (the multiplexing key). */
  surface: string;
  /** Trust layer at upgrade time (hub-stamped; fail-closed "public"). */
  layer: TrustLayer;
  /** Client IP at upgrade time, or null. */
  clientIp: string | null;
}

/**
 * Wrap Bun's socket in the narrow runtime-agnostic SurfaceSocket view.
 *
 * MEMOIZED per underlying socket (WeakMap): one connection sees ONE wrapper
 * instance across its open/message/close events — the identity contract
 * stateful protocols (Hocuspocus, y-protocols) need to key per-connection
 * state. The wrapper also mints the connection's `socketId` (first wrap)
 * and exposes a live `readyState` view.
 */
function createSocketWrapper(): (ws: ServerWebSocket<SurfaceWsData>) => SurfaceSocket {
  const wrappers = new WeakMap<ServerWebSocket<SurfaceWsData>, SurfaceSocket>();
  let counter = 0;
  return (ws) => {
    const existing = wrappers.get(ws);
    if (existing) return existing;
    const wrapper: SurfaceSocket = {
      send: (data) => {
        ws.send(data);
      },
      close: (code?: number, reason?: string) => {
        ws.close(code, reason);
      },
      get readyState() {
        return ws.readyState;
      },
      data: {
        surface: ws.data.surface,
        layer: ws.data.layer,
        clientIp: ws.data.clientIp,
        socketId: `ws-${++counter}-${Date.now().toString(36)}`,
      },
    };
    wrappers.set(ws, wrapper);
    return wrapper;
  };
}

export type SurfaceWsDeps = {
  /** Resolve the live supervisor (state.backends may be swapped in tests). */
  getSupervisor: () => BackendSupervisor | undefined;
  logger?: Pick<Console, "warn" | "error">;
};

/**
 * Build the Bun.serve `websocket` handler set. Open/message/close pump
 * into the owning surface's backend handlers through a containment
 * boundary.
 */
export function createSurfaceWsHandlers(deps: SurfaceWsDeps): WebSocketHandler<SurfaceWsData> {
  const logger = deps.logger ?? console;
  const toSurfaceSocket = createSocketWrapper();

  function handlersFor(surface: string): BackendWebSocketHandlers | undefined {
    return deps.getSupervisor()?.websocketHandlersFor(surface);
  }

  async function pump(
    ws: ServerWebSocket<SurfaceWsData>,
    event: "open" | "message" | "close",
    invoke: (h: BackendWebSocketHandlers) => void | Promise<void>,
  ): Promise<void> {
    const surface = ws.data.surface;
    const handlers = handlersFor(surface);
    if (!handlers) {
      // Backend unmounted/disabled mid-connection — close; nothing to pump.
      if (event !== "close") {
        try {
          ws.close(1011, "surface backend unavailable");
        } catch {
          // already closing
        }
      }
      return;
    }
    try {
      await invoke(handlers);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      logger.warn(`[app] ws ${surface}: ${event} handler failed (contained): ${detail}`);
      deps.getSupervisor()?.recordContainedFailure(surface, `ws ${event} handler: ${detail}`);
      if (event !== "close") {
        try {
          // Generic reason — no backend detail crosses the wire.
          ws.close(1011, "backend error");
        } catch {
          // already closing
        }
      }
    }
  }

  return {
    open(ws) {
      void pump(ws, "open", (h) => h.open?.(toSurfaceSocket(ws)));
    },
    message(ws, message) {
      const frame: string | Uint8Array =
        typeof message === "string" ? message : new Uint8Array(message);
      void pump(ws, "message", (h) => h.message?.(toSurfaceSocket(ws), frame));
    },
    close(ws, code, reason) {
      void pump(ws, "close", (h) => h.close?.(toSurfaceSocket(ws), code, reason));
    },
  };
}
