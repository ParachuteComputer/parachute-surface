/**
 * WS pump contract (P4) — the parts stateful protocols depend on:
 *
 *   - ONE wrapper instance per connection across open/message/close (the
 *     identity contract — backends key per-connection state on it);
 *   - `data.socketId` unique per connection, stable across events;
 *   - `readyState` mirrors the underlying socket live;
 *   - handler errors are contained (socket closed 1011, failure recorded,
 *     siblings untouched);
 *   - missing backend → close, nothing pumped.
 */

import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import type { BackendSupervisor } from "../backend-supervisor.ts";
import type { BackendWebSocketHandlers, SurfaceSocket } from "../backend-types.ts";
import { type SurfaceWsData, createSurfaceWsHandlers } from "../backend-ws.ts";

/** Minimal fake Bun socket (the pump touches send/close/readyState/data). */
function fakeBunSocket(surface = "demo"): ServerWebSocket<SurfaceWsData> & {
  sent: (string | Uint8Array)[];
  closed: { code?: number; reason?: string }[];
  state: number;
} {
  const fake = {
    sent: [] as (string | Uint8Array)[],
    closed: [] as { code?: number; reason?: string }[],
    state: 1,
    data: { surface, layer: "public", clientIp: null } as unknown as SurfaceWsData,
    send(data: string | Uint8Array) {
      fake.sent.push(data);
      return data.length;
    },
    close(code?: number, reason?: string) {
      fake.closed.push({ code, reason });
      fake.state = 3;
    },
    get readyState() {
      return fake.state;
    },
  };
  return fake as unknown as ReturnType<typeof fakeBunSocket>;
}

function supervisorWith(handlers: BackendWebSocketHandlers | undefined): {
  supervisor: BackendSupervisor;
  failures: string[];
} {
  const failures: string[] = [];
  const supervisor = {
    websocketHandlersFor: () => handlers,
    recordContainedFailure: (_name: string, detail: string) => {
      failures.push(detail);
    },
  } as unknown as BackendSupervisor;
  return { supervisor, failures };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Build the pump and assert the handler set is complete (it always is). */
function makePump(deps: Parameters<typeof createSurfaceWsHandlers>[0]): {
  open: (ws: ServerWebSocket<SurfaceWsData>) => void;
  message: (ws: ServerWebSocket<SurfaceWsData>, message: string | Buffer<ArrayBuffer>) => void;
  close: (ws: ServerWebSocket<SurfaceWsData>, code: number, reason: string) => void;
} {
  const pump = createSurfaceWsHandlers(deps);
  const { open, message, close } = pump;
  if (!open || !message || !close) throw new Error("pump is missing a handler");
  return {
    open: (ws) => open.call(pump, ws),
    message: (ws, m) => message.call(pump, ws, m),
    close: (ws, code, reason) => close.call(pump, ws, code, reason),
  };
}

describe("backend-ws socket wrapper", () => {
  test("one connection sees ONE SurfaceSocket instance across open/message/close", async () => {
    const seen: SurfaceSocket[] = [];
    const { supervisor } = supervisorWith({
      open: (ws) => {
        seen.push(ws);
      },
      message: (ws) => {
        seen.push(ws);
      },
      close: (ws) => {
        seen.push(ws);
      },
    });
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: () => {}, error: () => {} },
    });
    const ws = fakeBunSocket();
    pump.open(ws);
    pump.message(ws, Buffer.from([1, 2, 3]));
    pump.close(ws, 1000, "done");
    await settle();
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0] as SurfaceSocket);
    expect(seen[2]).toBe(seen[0] as SurfaceSocket);
  });

  test("socketId is stable per connection and unique across connections", async () => {
    const ids: string[] = [];
    const { supervisor } = supervisorWith({
      open: (ws) => {
        ids.push(ws.data.socketId);
      },
      message: (ws) => {
        ids.push(ws.data.socketId);
      },
    });
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: () => {}, error: () => {} },
    });
    const a = fakeBunSocket();
    const b = fakeBunSocket();
    pump.open(a);
    pump.message(a, Buffer.from([0]));
    pump.open(b);
    await settle();
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1] as string);
    expect(ids[2]).not.toBe(ids[0] as string);
  });

  test("readyState mirrors the underlying socket live", async () => {
    let socket: SurfaceSocket | undefined;
    const { supervisor } = supervisorWith({
      open: (ws) => {
        socket = ws;
      },
    });
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: () => {}, error: () => {} },
    });
    const ws = fakeBunSocket();
    pump.open(ws);
    await settle();
    expect(socket?.readyState).toBe(1);
    ws.state = 3;
    expect(socket?.readyState).toBe(3);
  });

  test("message frames arrive as exact-bounds Uint8Array views", async () => {
    const frames: (string | Uint8Array)[] = [];
    const { supervisor } = supervisorWith({
      message: (_ws, message) => {
        frames.push(message);
      },
    });
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: () => {}, error: () => {} },
    });
    const ws = fakeBunSocket();
    pump.open(ws);
    pump.message(ws, Buffer.from([7, 8, 9]));
    await settle();
    const frame = frames[0] as Uint8Array;
    expect(frame).toBeInstanceOf(Uint8Array);
    expect([...frame]).toEqual([7, 8, 9]);
    expect(frame.byteLength).toBe(3);
  });

  test("a throwing handler is contained: 1011 close + recorded failure", async () => {
    const { supervisor, failures } = supervisorWith({
      message: () => {
        throw new Error("boom");
      },
    });
    const warns: string[] = [];
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: (...a: unknown[]) => warns.push(a.join(" ")), error: () => {} },
    });
    const ws = fakeBunSocket();
    pump.message(ws, Buffer.from([1]));
    await settle();
    expect(ws.closed).toEqual([{ code: 1011, reason: "backend error" }]);
    expect(failures.some((f) => f.includes("boom"))).toBe(true);
    expect(warns.some((w) => w.includes("contained"))).toBe(true);
  });

  test("no backend handlers → close 1011, nothing pumped", async () => {
    const { supervisor } = supervisorWith(undefined);
    const pump = makePump({
      getSupervisor: () => supervisor,
      logger: { warn: () => {}, error: () => {} },
    });
    const ws = fakeBunSocket();
    pump.open(ws);
    await settle();
    expect(ws.closed).toEqual([{ code: 1011, reason: "surface backend unavailable" }]);
  });
});
