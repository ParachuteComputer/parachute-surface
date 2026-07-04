/**
 * Tests for the WebSocket-only live-query transport (`ws-transport.ts`).
 *
 * A fake WebSocket (driven by the test) exercises the WS state machine:
 * first-message auth handshake, "open" on the first server frame, chunked
 * snapshot accumulation, upsert/remove dispatch, re-auth on token rotation,
 * raw ping / pong liveness + ping-timeout reconnect, and the close-code map
 * (4400 / 4401 / 4403). Plus the degradation model: when WS can't be
 * established the subscription stays non-`live` and keeps a capped-backoff
 * reconnect running (so the consumer keeps polling), re-establishing live the
 * moment WS is reachable — and NO SSE fallback anywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SubscribeHandlers, SubscribeTransport, WebSocketCtor } from "../subscribe.ts";
import { VaultAuthError, VaultPermissionError } from "../vault-client.ts";
import { startWsSubscription } from "../ws-transport.ts";

// ---- fake WebSocket ----

/**
 * A minimal, test-driven WebSocket. The transport constructs it; the test
 * drives lifecycle via `open()` / `message()` / `serverClose()`. `close()`
 * (called by the transport on abort / ping-timeout) fires `onclose` too.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset() {
    FakeSocket.instances = [];
  }

  readyState = 0; // CONNECTING
  url: string;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
  }

  // ---- test drivers ----
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  serverClose(code: number, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Parse a sent frame as JSON. */
  sentJson(i: number): unknown {
    return JSON.parse(this.sent[i] as string);
  }
}

const FakeCtor = FakeSocket as unknown as WebSocketCtor;

// ---- plumbing ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | undefined | null | false,
  ms = 2_000,
  label = "condition",
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error("timed out waiting for " + label);
    await sleep(2);
  }
}

/** Wait for `FakeSocket.instances[i]` to exist and return it. */
function socketAt(i: number, label = `socket ${i}`): Promise<FakeSocket> {
  return waitFor(() => FakeSocket.instances[i], 2_000, label);
}

function noopHandlers(over: Partial<SubscribeHandlers> = {}): SubscribeHandlers {
  return { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {}, ...over };
}

function makeTransport(over: Partial<SubscribeTransport> = {}): SubscribeTransport {
  return {
    url: "https://vault.example/vault/x/api/subscribe?tag=%23t",
    resolveToken: async () => "tok-1",
    webSocketImpl: FakeCtor,
    ...over,
  };
}

const SNAP = (notes: { id: string }[], done = true) =>
  JSON.stringify({ type: "snapshot", notes, done });

beforeEach(() => {
  FakeSocket.reset();
});
afterEach(() => {
  FakeSocket.reset();
});

// ---- auth handshake + dispatch ----

describe("ws transport — handshake + dispatch", () => {
  test("maps http(s)→ws(s) and sends {type:auth,token} as the first frame", async () => {
    const unsub = startWsSubscription(makeTransport(), noopHandlers());
    const ws = await socketAt(0);
    expect(ws.url).toBe("wss://vault.example/vault/x/api/subscribe?tag=%23t");
    ws.open();
    expect(ws.sentJson(0)).toEqual({ type: "auth", token: "tok-1" });
    unsub();
  });

  test('emits "open" only on the first server frame, not on socket open', async () => {
    const statuses: string[] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onStatus: (s) => statuses.push(s) }),
    );
    const ws = await socketAt(0);
    await waitFor(() => statuses.includes("connecting"), 2_000, "connecting");
    ws.open();
    await sleep(10);
    expect(statuses).not.toContain("open"); // open socket, not yet a server frame
    ws.message(SNAP([{ id: "a" }]));
    await waitFor(() => statuses.includes("open"), 2_000, "open");
    unsub();
  });

  test("accumulates a chunked snapshot and emits it once on done:true", async () => {
    const snapshots: string[][] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onSnapshot: (n) => snapshots.push(n.map((x) => x.id)) }),
    );
    const ws = await socketAt(0);
    ws.open();
    ws.message(JSON.stringify({ type: "snapshot", notes: [{ id: "a" }], done: false }));
    ws.message(JSON.stringify({ type: "snapshot", notes: [{ id: "b" }], done: false }));
    ws.message(JSON.stringify({ type: "snapshot", notes: [{ id: "c" }], done: true }));
    await waitFor(() => snapshots.length === 1, 2_000, "one snapshot");
    expect(snapshots).toEqual([["a", "b", "c"]]);
    unsub();
  });

  test("an empty snapshot (single done:true) delivers an empty set once", async () => {
    const snapshots: string[][] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onSnapshot: (n) => snapshots.push(n.map((x) => x.id)) }),
    );
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([]));
    await waitFor(() => snapshots.length === 1, 2_000, "empty snapshot");
    expect(snapshots).toEqual([[]]);
    unsub();
  });

  test("dispatches upsert / remove with contract-identical guards", async () => {
    const events: string[] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({
        onSnapshot: (n) => events.push(`snapshot:${n.map((x) => x.id).join(",")}`),
        onUpsert: (note) => events.push(`upsert:${note.id}`),
        onRemove: (id) => events.push(`remove:${id}`),
      }),
    );
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([{ id: "a" }, { id: "b" }]));
    ws.message(JSON.stringify({ type: "upsert", note: { id: "c" } }));
    ws.message(JSON.stringify({ type: "remove", id: "a" }));
    // guards: a remove with a non-string id and an upsert with no note are ignored
    ws.message(JSON.stringify({ type: "remove", id: 42 }));
    ws.message(JSON.stringify({ type: "upsert" }));
    ws.message(JSON.stringify({ type: "unknown-future-type", foo: 1 }));
    await waitFor(() => events.length === 3, 2_000, "3 events");
    expect(events).toEqual(["snapshot:a,b", "upsert:c", "remove:a"]);
    unsub();
  });

  test("a malformed frame reports onError but keeps the socket alive", async () => {
    const errors: unknown[] = [];
    const upserts: string[] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onError: (e) => errors.push(e), onUpsert: (n) => upserts.push(n.id) }),
    );
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([]));
    ws.message("{ not json");
    ws.message(JSON.stringify({ type: "upsert", note: { id: "ok" } }));
    await waitFor(() => upserts.length === 1, 2_000, "post-garbage upsert");
    expect(upserts).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
    unsub();
  });
});

// ---- liveness: ping / pong / re-auth ----

describe("ws transport — liveness + re-auth", () => {
  test("sends a raw ping on the interval; a pong keeps the socket open", async () => {
    // pongTimeout ≫ ping so a single unanswered deadline can't fire within the
    // assertion window (production runs 30s ping / 10s pong — deadline first).
    const unsub = startWsSubscription(makeTransport(), noopHandlers(), {
      pingIntervalMs: 15,
      pongTimeoutMs: 500,
    });
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([]));
    await waitFor(() => ws.sent.includes("ping"), 2_000, "ping frame");
    ws.message("pong"); // liveness ack
    await sleep(40);
    // pong cleared the deadline → no reconnect
    expect(FakeSocket.instances).toHaveLength(1);
    unsub();
  });

  test("a missing pong terminates the socket and reconnects (fresh snapshot)", async () => {
    const snapshots: number[] = [];
    // The real invariant: pongTimeout < pingInterval, so the pong deadline
    // fires before the next ping can re-arm it.
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onSnapshot: (n) => snapshots.push(n.length) }),
      { pingIntervalMs: 30, pongTimeoutMs: 10, initialBackoffMs: 5, maxBackoffMs: 20 },
    );
    const ws1 = await socketAt(0);
    ws1.open();
    ws1.message(SNAP([{ id: "a" }]));
    // no pong → after ping+pong-timeout the socket is closed and a reconnect opens
    const ws2 = await socketAt(1, "reconnect socket");
    expect(ws1.readyState).toBe(3); // the wedged socket was closed by the client
    ws2.open();
    ws2.message(SNAP([{ id: "a" }, { id: "b" }]));
    await waitFor(() => snapshots.length === 2, 2_000, "second snapshot");
    expect(snapshots).toEqual([1, 2]);
    unsub();
  });

  test("re-auths on the OPEN socket when the token rotates (no reconnect)", async () => {
    let calls = 0;
    const transport = makeTransport({
      resolveToken: async () => {
        calls++;
        return calls === 1 ? "tok-1" : "tok-2"; // rotates after the initial resolve
      },
    });
    const unsub = startWsSubscription(transport, noopHandlers(), {
      pingIntervalMs: 15,
      pongTimeoutMs: 200,
    });
    const ws = await socketAt(0);
    ws.open();
    expect(ws.sentJson(0)).toEqual({ type: "auth", token: "tok-1" });
    ws.message(SNAP([]));
    // On the next ping tick resolveToken returns tok-2 → re-auth on THIS socket.
    await waitFor(
      () => ws.sent.some((f) => f.includes('"auth"') && f.includes("tok-2")),
      2_000,
      "re-auth frame",
    );
    const reauth = ws.sent.find((f) => f.includes("tok-2"));
    expect(JSON.parse(reauth as string)).toEqual({ type: "auth", token: "tok-2" });
    expect(FakeSocket.instances).toHaveLength(1); // no reconnect
    unsub();
  });
});

// ---- close-code map ----

describe("ws transport — close-code map", () => {
  test("4400 protocol error is terminal (no reconnect)", async () => {
    const errors: unknown[] = [];
    const statuses: string[] = [];
    startWsSubscription(
      makeTransport(),
      noopHandlers({ onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }),
      { initialBackoffMs: 5 },
    );
    const ws = await socketAt(0);
    ws.open();
    ws.serverClose(4400, "bad frame");
    await waitFor(() => statuses.at(-1) === "closed", 2_000, "closed");
    expect(String(errors[0])).toContain("4400");
    await sleep(30); // would have reconnected at 5ms backoff
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("4403 forbidden is terminal with VaultPermissionError", async () => {
    const errors: unknown[] = [];
    const closed: string[] = [];
    startWsSubscription(
      makeTransport(),
      noopHandlers({ onError: (e) => errors.push(e), onStatus: (s) => closed.push(s) }),
      { initialBackoffMs: 5 },
    );
    const ws = await socketAt(0);
    ws.open();
    ws.serverClose(4403);
    await waitFor(() => closed.at(-1) === "closed", 2_000, "closed");
    expect(errors[0]).toBeInstanceOf(VaultPermissionError);
    await sleep(30);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("4401 refreshes once, then reconnects with the fresh token", async () => {
    let current = "tok-1";
    let refreshCalls = 0;
    const transport = makeTransport({
      resolveToken: async () => current,
      refreshToken: async () => {
        refreshCalls++;
        current = "tok-2";
        return current;
      },
    });
    startWsSubscription(transport, noopHandlers(), { initialBackoffMs: 5 });
    const ws1 = await socketAt(0);
    ws1.open();
    expect(ws1.sentJson(0)).toEqual({ type: "auth", token: "tok-1" });
    ws1.serverClose(4401);
    const ws2 = await socketAt(1, "reconnect after refresh");
    ws2.open();
    expect(refreshCalls).toBe(1);
    expect(ws2.sentJson(0)).toEqual({ type: "auth", token: "tok-2" }); // fresh token
  });

  test("4401 with no refresh path terminates with VaultAuthError", async () => {
    const errors: unknown[] = [];
    const statuses: string[] = [];
    startWsSubscription(
      makeTransport(), // no refreshToken
      noopHandlers({ onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }),
      { initialBackoffMs: 5 },
    );
    const ws = await socketAt(0);
    ws.open();
    ws.serverClose(4401);
    await waitFor(() => statuses.at(-1) === "closed", 2_000, "closed");
    expect(errors[0]).toBeInstanceOf(VaultAuthError);
    await sleep(30);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("a second 4401 right after a refresh is terminal (one refresh per streak)", async () => {
    let refreshCalls = 0;
    const transport = makeTransport({
      resolveToken: async () => "tok-x",
      refreshToken: async () => {
        refreshCalls++;
        return "tok-x2";
      },
    });
    const errors: unknown[] = [];
    const statuses: string[] = [];
    startWsSubscription(
      transport,
      noopHandlers({ onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }),
      { initialBackoffMs: 5 },
    );
    const ws1 = await socketAt(0);
    ws1.open();
    ws1.serverClose(4401); // → refresh → reconnect
    const ws2 = await socketAt(1, "reconnect");
    ws2.open();
    ws2.serverClose(4401); // fresh token also rejected → terminal
    await waitFor(() => statuses.at(-1) === "closed", 2_000, "closed");
    expect(refreshCalls).toBe(1);
    expect(errors.at(-1)).toBeInstanceOf(VaultAuthError);
    await sleep(30);
    expect(FakeSocket.instances).toHaveLength(2); // no third attempt
  });
});

// ---- degrade to polling (WS-or-polling, never SSE) ----

describe("ws transport — degrade to polling + recover", () => {
  test("a WS that never opens stays non-live and keeps retrying (no terminal, no SSE)", async () => {
    const errors: unknown[] = [];
    const statuses: string[] = [];
    const snapshots: unknown[] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({
        onError: (e) => errors.push(e),
        onStatus: (s) => statuses.push(s),
        onSnapshot: (n) => snapshots.push(n),
      }),
      { initialBackoffMs: 5, maxBackoffMs: 20 },
    );
    // Old server / WS-blocked network: the upgrade never opens.
    const ws0 = await socketAt(0);
    ws0.serverClose(1006);
    // It must keep probing in the background (a second attempt appears) …
    await socketAt(1, "background reconnect");
    // … while NEVER terminating (consumer keeps polling) and never delivering.
    expect(statuses).toContain("connecting");
    expect(statuses).toContain("reconnecting");
    expect(statuses).not.toContain("open");
    expect(statuses).not.toContain("closed");
    expect(snapshots).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0); // observational, not a data-error
    unsub();
    // Only after unsubscribe do we go terminal.
    await waitFor(() => statuses.at(-1) === "closed", 1_000, "closed after unsub");
  });

  test("re-establishes live the moment WS becomes reachable", async () => {
    const statuses: string[] = [];
    const snapshots: string[][] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onStatus: (s) => statuses.push(s), onSnapshot: (n) => snapshots.push(n.map((x) => x.id)) }),
      { initialBackoffMs: 5, maxBackoffMs: 20 },
    );
    // First probe fails (server not yet WS-capable) …
    const ws0 = await socketAt(0);
    ws0.serverClose(1006);
    // … then the server comes online: the next probe opens + delivers.
    const ws1 = await socketAt(1, "recovered socket");
    ws1.open();
    ws1.message(SNAP([{ id: "live-1" }]));
    await waitFor(() => statuses.includes("open"), 2_000, "live after recovery");
    expect(snapshots).toEqual([["live-1"]]);
    unsub();
  });

  test("no WebSocket in the runtime → signals live-unavailable once, no socket, consumer polls", async () => {
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    // biome-ignore lint: intentionally remove the global for this case
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    try {
      const errors: unknown[] = [];
      const statuses: string[] = [];
      startWsSubscription(
        makeTransport({ webSocketImpl: undefined }),
        noopHandlers({ onError: (e) => errors.push(e), onStatus: (s) => statuses.push(s) }),
      );
      await waitFor(() => statuses.at(-1) === "closed", 1_000, "closed");
      expect(errors).toHaveLength(1);
      expect(FakeSocket.instances).toHaveLength(0); // never tried to construct one
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    }
  });
});

// ---- teardown ----

describe("ws transport — teardown", () => {
  test("unsubscribe closes the live socket and emits closed once (idempotent)", async () => {
    const statuses: string[] = [];
    const unsub = startWsSubscription(
      makeTransport(),
      noopHandlers({ onStatus: (s) => statuses.push(s) }),
    );
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([]));
    await waitFor(() => statuses.includes("open"), 2_000, "open");
    unsub();
    expect(ws.readyState).toBe(3); // socket torn down
    unsub(); // idempotent
    await sleep(10);
    expect(statuses.filter((s) => s === "closed")).toHaveLength(1);
  });

  test("an aborted signal never opens a socket", async () => {
    const ac = new AbortController();
    ac.abort();
    const statuses: string[] = [];
    startWsSubscription(makeTransport(), noopHandlers({ onStatus: (s) => statuses.push(s) }), {
      signal: ac.signal,
    });
    await sleep(20);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(statuses).toEqual(["closed"]);
  });

  test("an external abort mid-session tears the socket down", async () => {
    const ac = new AbortController();
    const statuses: string[] = [];
    startWsSubscription(makeTransport(), noopHandlers({ onStatus: (s) => statuses.push(s) }), {
      signal: ac.signal,
    });
    const ws = await socketAt(0);
    ws.open();
    ws.message(SNAP([]));
    await waitFor(() => statuses.includes("open"), 2_000, "open");
    ac.abort();
    await waitFor(() => statuses.at(-1) === "closed", 2_000, "closed after abort");
    expect(ws.readyState).toBe(3);
  });
});
