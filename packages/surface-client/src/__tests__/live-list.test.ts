/**
 * Tests for `createLiveList` — the framework-light reconciler over
 * `VaultClient.subscribe()`. No React: we drive a fake transport that hands
 * us the four event handlers, fire events, and assert the reconciled list +
 * status + thinking indicator.
 *
 * Mirrors the reconciliation contract notes-ui's `live-query.ts` carried, now
 * proven framework-agnostically:
 *   - snapshot populates / replaces the list
 *   - upsert updates in place; new ids prepend
 *   - remove drops; absent id is a no-op (no fan-out)
 *   - ordering preserved across an in-place upsert
 *   - reconnect replaces from a fresh snapshot
 *   - status transitions (connecting → live → reconnecting → live → closed)
 *   - metadata.status "thinking" / live-activity signal
 *   - unsubscribable queries never open a stream
 *   - transient errors never disturb the list
 */

import { describe, expect, mock, test } from "bun:test";

import {
  type LiveListClient,
  createLiveList,
  reconcileRemove,
  reconcileUpsert,
} from "../live-list.ts";
import type { SubscribeStatus } from "../subscribe.ts";
import type { Note } from "../vault-types.ts";

const note = (id: string, extra: Partial<Note> = {}): Note =>
  ({ id, createdAt: "2026-01-01T00:00:00Z", ...extra }) as Note;

/**
 * A fake transport: captures the handlers `createLiveList` registers so the
 * test can fire snapshot/upsert/remove/status/error at will, and exposes the
 * unsubscribe spy.
 */
function fakeClient() {
  let handlers: {
    onSnapshot: (notes: Note[]) => void;
    onUpsert: (note: Note) => void;
    onRemove: (id: string) => void;
    onStatus?: (status: SubscribeStatus) => void;
    onError?: (err: unknown) => void;
  } | null = null;
  const unsubscribe = mock(() => {});
  const subscribe = mock((_q: unknown, h: typeof handlers) => {
    handlers = h;
    return unsubscribe;
  });
  const client = { subscribe } as unknown as LiveListClient;
  return {
    client,
    subscribe,
    unsubscribe,
    get h() {
      if (!handlers) throw new Error("subscribe() was not called");
      return handlers;
    },
  };
}

const TAG_QUERY = new URLSearchParams("tag=%23x");

describe("createLiveList — reconciliation", () => {
  test("snapshot populates the list", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    expect(live.getList()).toEqual([]);

    c.h.onSnapshot([note("a"), note("b")]);
    expect(live.getList().map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("upsert updates in place; ordering preserved", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a", { content: "1" }), note("b"), note("c")]);

    c.h.onUpsert(note("b", { content: "changed" }));
    expect(live.getList().map((n) => n.id)).toEqual(["a", "b", "c"]); // order kept
    expect(live.getList()[1]?.content).toBe("changed");
  });

  test("upsert of a new id prepends", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a")]);
    c.h.onUpsert(note("z"));
    expect(live.getList().map((n) => n.id)).toEqual(["z", "a"]);
  });

  test("remove drops the row by id", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a"), note("b"), note("c")]);
    c.h.onRemove("b");
    expect(live.getList().map((n) => n.id)).toEqual(["a", "c"]);
  });

  test("remove of an absent id is a no-op (no fan-out)", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a")]);
    const before = live.getList();
    const listener = mock(() => {});
    live.subscribe(listener);
    c.h.onRemove("nope");
    expect(live.getList()).toBe(before); // same reference
    expect(listener).not.toHaveBeenCalled();
  });

  test("reconnect replaces the list from a fresh snapshot", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a"), note("b")]);
    c.h.onUpsert(note("c"));
    expect(live.getList().map((n) => n.id)).toEqual(["c", "a", "b"]);

    // Reconnect: vault re-delivers a fresh, authoritative snapshot.
    c.h.onStatus?.("reconnecting");
    c.h.onSnapshot([note("a"), note("d")]);
    expect(live.getList().map((n) => n.id)).toEqual(["a", "d"]); // wholesale replace
  });
});

describe("createLiveList — status", () => {
  test("starts connecting and transitions through live / reconnecting / closed", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    expect(live.getState().status).toBe("connecting");

    c.h.onStatus?.("open");
    expect(live.getState().status).toBe("live"); // open → live (consumer word)

    c.h.onStatus?.("reconnecting");
    expect(live.getState().status).toBe("reconnecting");

    c.h.onStatus?.("open");
    expect(live.getState().status).toBe("live");

    c.h.onStatus?.("closed");
    expect(live.getState().status).toBe("closed");
  });

  test("fans out to listeners on change; unsubscribe stops them", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    const listener = mock(() => {});
    const off = live.subscribe(listener);

    c.h.onStatus?.("open");
    expect(listener).toHaveBeenCalledTimes(1);
    c.h.onSnapshot([note("a")]);
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    c.h.onSnapshot([note("a"), note("b")]);
    expect(listener).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });
});

describe("createLiveList — thinking indicator", () => {
  test("thinking is true when any note has metadata.status thinking", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    expect(live.getState().thinking).toBe(false);

    c.h.onSnapshot([note("a"), note("b", { metadata: { status: "thinking" } })]);
    expect(live.getState().thinking).toBe(true);
  });

  test("thinking flips false when the note reaches a terminal status", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a", { metadata: { status: "thinking" } })]);
    expect(live.getState().thinking).toBe(true);

    c.h.onUpsert(note("a", { metadata: { status: "done" } }));
    expect(live.getState().thinking).toBe(false);
  });

  test("custom thinkingStatuses set", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY, {
      thinkingStatuses: ["streaming", "running"],
    });
    c.h.onSnapshot([note("a", { metadata: { status: "running" } })]);
    expect(live.getState().thinking).toBe(true);
    c.h.onUpsert(note("a", { metadata: { status: "thinking" } })); // not in the custom set
    expect(live.getState().thinking).toBe(false);
  });

  test("empty thinkingStatuses disables the indicator", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY, { thinkingStatuses: [] });
    c.h.onSnapshot([note("a", { metadata: { status: "thinking" } })]);
    expect(live.getState().thinking).toBe(false);
  });
});

describe("createLiveList — unsubscribable queries", () => {
  test("never opens a stream for search; stays closed + empty + surfaces error", () => {
    const c = fakeClient();
    const onError = mock(() => {});
    const live = createLiveList(c.client, new URLSearchParams("search=foo"), { onError });
    expect(c.subscribe).not.toHaveBeenCalled();
    expect(live.getState().status).toBe("closed");
    expect(live.getList()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("never opens a stream for near / cursor", () => {
    const c1 = fakeClient();
    createLiveList(c1.client, new URLSearchParams("near=abc"));
    expect(c1.subscribe).not.toHaveBeenCalled();

    const c2 = fakeClient();
    createLiveList(c2.client, new URLSearchParams("cursor=xyz"));
    expect(c2.subscribe).not.toHaveBeenCalled();
  });

  test("opens a stream for a subscribable Record query", () => {
    const c = fakeClient();
    createLiveList(c.client, { tag: "#x" });
    expect(c.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("createLiveList — fallback guarantee + lifecycle", () => {
  test("a transient error never disturbs the list", () => {
    const c = fakeClient();
    const onError = mock(() => {});
    const live = createLiveList(c.client, TAG_QUERY, { onError });
    c.h.onSnapshot([note("a")]);
    c.h.onError?.(new Error("blip"));
    expect(live.getList().map((n) => n.id)).toEqual(["a"]); // unchanged
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("close() unsubscribes and stops further reconciliation", () => {
    const c = fakeClient();
    const live = createLiveList(c.client, TAG_QUERY);
    c.h.onSnapshot([note("a")]);
    live.close();
    expect(c.unsubscribe).toHaveBeenCalledTimes(1);

    // Late events after close are ignored.
    c.h.onSnapshot([note("a"), note("b")]);
    expect(live.getList().map((n) => n.id)).toEqual(["a"]);

    live.close(); // idempotent
    expect(c.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("pure reconcilers (re-exported for reuse)", () => {
  test("reconcileUpsert is pure and replaces in place", () => {
    const list = [note("a", { content: "1" }), note("b")];
    const next = reconcileUpsert(list, note("a", { content: "2" }));
    expect(next.map((n) => n.id)).toEqual(["a", "b"]);
    expect(next[0]?.content).toBe("2");
    expect(list[0]?.content).toBe("1"); // input untouched
  });

  test("reconcileRemove returns the same ref when id is absent", () => {
    const list = [note("a")];
    expect(reconcileRemove(list, "x")).toBe(list);
  });
});
