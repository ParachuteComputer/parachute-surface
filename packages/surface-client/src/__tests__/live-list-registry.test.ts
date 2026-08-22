/**
 * Tests for the refcounted live-list registry (surface#202).
 *
 * The contract under test: two consumers of the SAME `(client, params)` share
 * ONE underlying `client.subscribe()` — one socket, one snapshot, one writer
 * per cache key — and the socket is torn down only when the LAST consumer
 * releases it. Consumers of DIFFERENT params, or of different client
 * instances, are unaffected.
 *
 * The load-bearing assertion throughout is `subscribe` / `unsubscribe` CALL
 * COUNTS on a fake transport — that is the socket, counted directly.
 */

import { describe, expect, mock, test } from "bun:test";

import { type LiveListClient, createLiveList } from "../live-list.js";
import type { SubscribeStatus } from "../subscribe.js";
import type { Note } from "../vault-types.js";

const note = (id: string, extra: Partial<Note> = {}): Note =>
  ({ id, createdAt: "2026-01-01T00:00:00Z", ...extra }) as Note;

type Handlers = {
  onSnapshot: (notes: Note[]) => void;
  onUpsert: (note: Note) => void;
  onRemove: (id: string) => void;
  onStatus?: (status: SubscribeStatus) => void;
  onError?: (err: unknown) => void;
};

/**
 * A fake transport that records EVERY `subscribe()` call (not just the last),
 * so a test can prove how many sockets were opened and drive each one.
 */
function fakeClient() {
  const calls: { query: unknown; handlers: Handlers; unsubscribe: ReturnType<typeof mock> }[] = [];
  const subscribe = mock((query: unknown, handlers: Handlers) => {
    const unsubscribe = mock(() => {});
    calls.push({ query, handlers, unsubscribe });
    return unsubscribe;
  });
  const client = { subscribe } as unknown as LiveListClient;
  return {
    client,
    subscribe,
    calls,
    /** Handlers of the Nth (default: only) subscription. */
    h(i = 0): Handlers {
      const call = calls[i];
      if (!call) throw new Error(`no subscribe() call at index ${i} (have ${calls.length})`);
      return call.handlers;
    },
    unsub(i = 0) {
      const call = calls[i];
      if (!call) throw new Error(`no subscribe() call at index ${i} (have ${calls.length})`);
      return call.unsubscribe;
    },
  };
}

/** Let a queued microtask (the late-joiner replay) run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("live-list registry — one subscription per (client, params)", () => {
  test("two consumers of the same params share ONE subscription", () => {
    const c = fakeClient();

    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));

    expect(c.subscribe).toHaveBeenCalledTimes(1);

    // One snapshot on the one socket reaches BOTH consumers.
    c.h().onSnapshot([note("a"), note("b")]);
    expect(a.getList().map((n) => n.id)).toEqual(["a", "b"]);
    expect(b.getList().map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("deltas on the shared socket reach every consumer", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, { tag: "#x" });
    const b = createLiveList(c.client, { tag: "#x" });
    expect(c.subscribe).toHaveBeenCalledTimes(1);

    c.h().onSnapshot([note("a")]);
    c.h().onUpsert(note("z"));
    c.h().onRemove("a");

    expect(a.getList().map((n) => n.id)).toEqual(["z"]);
    expect(b.getList().map((n) => n.id)).toEqual(["z"]);
  });

  test("status transitions reach every consumer", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));

    c.h().onStatus?.("open");
    expect(a.getState().status).toBe("live");
    expect(b.getState().status).toBe("live");
  });

  test("both consumers' listeners fire off the single shared stream", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const la = mock(() => {});
    const lb = mock(() => {});
    a.subscribe(la);
    b.subscribe(lb);

    c.h().onSnapshot([note("a")]);
    expect(la).toHaveBeenCalledTimes(1);
    expect(lb).toHaveBeenCalledTimes(1);
  });
});

describe("live-list registry — canonical param keying", () => {
  test("param ORDER does not matter", () => {
    const c = fakeClient();
    createLiveList(c.client, new URLSearchParams("tag=%23x&limit=10"));
    createLiveList(c.client, new URLSearchParams("limit=10&tag=%23x"));
    expect(c.subscribe).toHaveBeenCalledTimes(1);
  });

  test("a Record query and the equivalent URLSearchParams dedup together", () => {
    const c = fakeClient();
    createLiveList(c.client, { tag: "#x", limit: "10" });
    createLiveList(c.client, new URLSearchParams("limit=10&tag=%23x"));
    expect(c.subscribe).toHaveBeenCalledTimes(1);
  });

  test("the typed NotesQuery shape dedups with its wire equivalent", () => {
    const c = fakeClient();
    createLiveList(c.client, { pathPrefix: "Daily/", tag: "#x" });
    createLiveList(c.client, new URLSearchParams("tag=%23x&path_prefix=Daily%2F"));
    expect(c.subscribe).toHaveBeenCalledTimes(1);
  });

  test("repeated keys are order-insensitive but multiplicity-preserving", () => {
    const c = fakeClient();
    createLiveList(c.client, new URLSearchParams("extension=md&extension=txt"));
    createLiveList(c.client, new URLSearchParams("extension=txt&extension=md"));
    expect(c.subscribe).toHaveBeenCalledTimes(1);

    // A different multiset is a different query.
    createLiveList(c.client, new URLSearchParams("extension=md"));
    expect(c.subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("live-list registry — isolation (unchanged behavior)", () => {
  test("DIFFERENT params still open separate subscriptions", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23y"));
    expect(c.subscribe).toHaveBeenCalledTimes(2);

    c.h(0).onSnapshot([note("x1")]);
    c.h(1).onSnapshot([note("y1")]);
    expect(a.getList().map((n) => n.id)).toEqual(["x1"]);
    expect(b.getList().map((n) => n.id)).toEqual(["y1"]);
  });

  test("the registry does not leak across client instances", () => {
    const c1 = fakeClient();
    const c2 = fakeClient();
    const a = createLiveList(c1.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c2.client, new URLSearchParams("tag=%23x"));

    expect(c1.subscribe).toHaveBeenCalledTimes(1);
    expect(c2.subscribe).toHaveBeenCalledTimes(1);

    c1.h().onSnapshot([note("one")]);
    expect(a.getList().map((n) => n.id)).toEqual(["one"]);
    expect(b.getList()).toEqual([]); // c2's stream said nothing
  });

  test("share: false opts a caller out of the registry entirely", () => {
    const c = fakeClient();
    createLiveList(c.client, new URLSearchParams("tag=%23x"));
    createLiveList(c.client, new URLSearchParams("tag=%23x"), { share: false });
    expect(c.subscribe).toHaveBeenCalledTimes(2);
  });

  test("a caller passing subscribeOptions gets a dedicated subscription", () => {
    // subscribeOptions carry a caller-owned AbortSignal / backoff policy — a
    // shared socket must never be abortable by one of its consumers.
    const c = fakeClient();
    createLiveList(c.client, new URLSearchParams("tag=%23x"));
    createLiveList(c.client, new URLSearchParams("tag=%23x"), {
      subscribeOptions: { initialBackoffMs: 50 },
    });
    expect(c.subscribe).toHaveBeenCalledTimes(2);
  });

  test("unsubscribable queries are never registered or shared", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("search=foo"));
    const b = createLiveList(c.client, new URLSearchParams("search=foo"));
    expect(c.subscribe).not.toHaveBeenCalled();
    expect(a.getState().status).toBe("closed");
    expect(b.getState().status).toBe("closed");
  });
});

describe("live-list registry — refcounted teardown", () => {
  test("closing ONE consumer leaves the shared socket open for the other", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    c.h().onSnapshot([note("a")]);

    a.close();
    expect(c.unsub()).not.toHaveBeenCalled(); // still one consumer

    // b is still live and still receiving.
    c.h().onUpsert(note("z"));
    expect(b.getList().map((n) => n.id)).toEqual(["z", "a"]);
    // a is detached — its state froze at close.
    expect(a.getList().map((n) => n.id)).toEqual(["a"]);
  });

  test("the socket closes exactly once, when the LAST consumer releases", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));

    a.close();
    expect(c.unsub()).not.toHaveBeenCalled();
    b.close();
    expect(c.unsub()).toHaveBeenCalledTimes(1);

    a.close(); // idempotent
    b.close();
    expect(c.unsub()).toHaveBeenCalledTimes(1);
  });

  test("after full teardown a new consumer opens a FRESH subscription", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    a.close();
    expect(c.unsub(0)).toHaveBeenCalledTimes(1);

    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    expect(c.subscribe).toHaveBeenCalledTimes(2);
    c.h(1).onSnapshot([note("fresh")]);
    expect(b.getList().map((n) => n.id)).toEqual(["fresh"]);
  });

  test("a released consumer receives nothing further from the shared stream", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const la = mock(() => {});
    a.subscribe(la);

    c.h().onSnapshot([note("a")]);
    expect(la).toHaveBeenCalledTimes(1);

    a.close();
    c.h().onSnapshot([note("a"), note("b")]);
    expect(la).toHaveBeenCalledTimes(1); // no further fan-out to the released handle
    expect(b.getList().map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("live-list registry — teardown is safe during event delivery", () => {
  test("a consumer that closes itself inside a listener does not break the others", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));

    const lb = mock(() => {});
    a.subscribe(() => a.close()); // unsubscribe DURING delivery
    b.subscribe(lb);

    expect(() => c.h().onSnapshot([note("a")])).not.toThrow();
    expect(lb).toHaveBeenCalledTimes(1);
    expect(b.getList().map((n) => n.id)).toEqual(["a"]);
    expect(c.unsub()).not.toHaveBeenCalled(); // b still holds it
  });

  test("the LAST consumer closing inside a listener defers teardown past delivery", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const unsubCallsDuringDelivery: number[] = [];

    a.subscribe(() => {
      a.close();
      // The transport must not be torn down while it is still delivering.
      unsubCallsDuringDelivery.push(c.unsub().mock.calls.length);
    });

    c.h().onSnapshot([note("a")]);
    expect(unsubCallsDuringDelivery).toEqual([0]);
    expect(c.unsub()).toHaveBeenCalledTimes(1); // …but it IS torn down after
  });

  test("a throwing listener still lets the other consumer receive", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    a.subscribe(() => {
      throw new Error("boom");
    });
    const lb = mock(() => {});
    b.subscribe(lb);

    expect(() => c.h().onSnapshot([note("a")])).not.toThrow();
    expect(lb).toHaveBeenCalledTimes(1);
  });
});

describe("live-list registry — late joiners", () => {
  test("a consumer joining an established stream is delivered the current list", async () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    c.h().onSnapshot([note("a"), note("b")]);
    c.h().onStatus?.("open");

    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    expect(c.subscribe).toHaveBeenCalledTimes(1); // no second socket

    // Joins in the pristine (connecting / empty) state, exactly as a consumer
    // with its own socket would — then the established state arrives as its
    // first change, so a react-query binding writes the cache normally.
    expect(b.getList()).toEqual([]);
    expect(b.getState().status).toBe("connecting");

    const lb = mock(() => {});
    b.subscribe(lb);
    await tick();

    expect(lb).toHaveBeenCalledTimes(1);
    expect(b.getList().map((n) => n.id)).toEqual(["a", "b"]);
    expect(b.getState().status).toBe("live");
    expect(a.getList().map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("a late joiner that closes before the replay lands stays inert", async () => {
    const c = fakeClient();
    createLiveList(c.client, new URLSearchParams("tag=%23x"));
    c.h().onSnapshot([note("a")]);

    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const lb = mock(() => {});
    b.subscribe(lb);
    b.close();
    await tick();

    expect(lb).not.toHaveBeenCalled();
    expect(b.getList()).toEqual([]);
  });
});

describe("live-list registry — per-consumer options are not shared", () => {
  test("each consumer computes `thinking` with its OWN thinkingStatuses", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"), {
      thinkingStatuses: ["running"],
    });
    expect(c.subscribe).toHaveBeenCalledTimes(1);

    c.h().onSnapshot([note("a", { metadata: { status: "thinking" } })]);
    expect(a.getState().thinking).toBe(true); // default set
    expect(b.getState().thinking).toBe(false); // custom set

    c.h().onUpsert(note("a", { metadata: { status: "running" } }));
    expect(a.getState().thinking).toBe(false);
    expect(b.getState().thinking).toBe(true);
  });

  test("onError fans out to every attached consumer, and stops at close", () => {
    const c = fakeClient();
    const ea = mock(() => {});
    const eb = mock(() => {});
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"), { onError: ea });
    createLiveList(c.client, new URLSearchParams("tag=%23x"), { onError: eb });

    c.h().onError?.(new Error("blip"));
    expect(ea).toHaveBeenCalledTimes(1);
    expect(eb).toHaveBeenCalledTimes(1);

    a.close();
    c.h().onError?.(new Error("blip2"));
    expect(ea).toHaveBeenCalledTimes(1); // released
    expect(eb).toHaveBeenCalledTimes(2);
  });

  test("a transient error still never disturbs the shared list", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    c.h().onSnapshot([note("a")]);
    c.h().onError?.(new Error("blip"));
    expect(a.getList().map((n) => n.id)).toEqual(["a"]);
    expect(b.getList().map((n) => n.id)).toEqual(["a"]);
  });
});

describe("live-list registry — releaseDelayMs grace window", () => {
  test("teardown is deferred, and a remount inside the window reuses the socket", async () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"), {
      releaseDelayMs: 60,
    });
    c.h().onSnapshot([note("a")]);

    a.close();
    expect(c.unsub()).not.toHaveBeenCalled(); // grace window open

    // Remount across a route transition: same params, still inside the window.
    const b = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    expect(c.subscribe).toHaveBeenCalledTimes(1); // reused, not churned

    await new Promise((r) => setTimeout(r, 100));
    expect(c.unsub()).not.toHaveBeenCalled(); // b holds it past the window

    c.h().onUpsert(note("z"));
    expect(b.getList().map((n) => n.id)).toEqual(["z", "a"]);
  });

  test("with no remount, the socket closes once the window elapses", async () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"), {
      releaseDelayMs: 30,
    });
    a.close();
    expect(c.unsub()).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 80));
    expect(c.unsub()).toHaveBeenCalledTimes(1);
  });

  test("the default is immediate teardown (no lingering socket)", () => {
    const c = fakeClient();
    const a = createLiveList(c.client, new URLSearchParams("tag=%23x"));
    a.close();
    expect(c.unsub()).toHaveBeenCalledTimes(1);
  });
});
