/**
 * Tests for `src/dev-mode.ts` — Phase 1.3 in-memory state.
 *
 * Coverage:
 *   - enable / disable idempotence + timestamp behavior
 *   - listDevMode returns only enabled UIs, alphabetically
 *   - broadcastReload notifies every subscriber + counts dead clients
 *   - removeSubscriber cleans up; disableDevMode cleans up all subscribers
 *   - subscriberCount tracks adds + removes
 *   - resetDevMode clears state and closes subscribers
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  addSubscriber,
  broadcastReload,
  closeAllSubscribers,
  disableDevMode,
  enableDevMode,
  getDevMode,
  isDevMode,
  listDevMode,
  removeSubscriber,
  resetDevMode,
  subscriberCount,
} from "../dev-mode.ts";

/** Build a fake `ReadableStreamDefaultController` capturing enqueued payloads. */
function fakeController(): {
  controller: ReadableStreamDefaultController<Uint8Array>;
  enqueued: Uint8Array[];
  closed: boolean;
  closeCount: number;
} {
  const enqueued: Uint8Array[] = [];
  let closed = false;
  let closeCount = 0;
  const controller = {
    enqueue: (chunk: Uint8Array) => {
      if (closed) throw new Error("closed");
      enqueued.push(chunk);
    },
    close: () => {
      closed = true;
      closeCount++;
    },
    error: (_e?: unknown) => {
      closed = true;
    },
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return {
    controller,
    enqueued,
    get closed() {
      return closed;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

afterEach(() => {
  resetDevMode();
});

describe("dev-mode state", () => {
  test("default is disabled", () => {
    expect(getDevMode("nothing").enabled).toBe(false);
    expect(isDevMode("nothing")).toBe(false);
  });

  test("enable then disable round-trips", () => {
    const s1 = enableDevMode("ui-a");
    expect(s1.enabled).toBe(true);
    expect(s1.enabledAt).toBeGreaterThan(0);
    expect(isDevMode("ui-a")).toBe(true);
    const s2 = disableDevMode("ui-a");
    expect(s2.enabled).toBe(false);
    expect(isDevMode("ui-a")).toBe(false);
  });

  test("enableDevMode is idempotent — second call preserves enabledAt", async () => {
    const s1 = enableDevMode("ui-a");
    // Bun's Date.now() granularity is ms; sleep a hair to ensure a new tick.
    await new Promise((r) => setTimeout(r, 5));
    const s2 = enableDevMode("ui-a");
    expect(s2.enabledAt).toBe(s1.enabledAt);
  });

  test("listDevMode returns only enabled UIs, alphabetical", () => {
    enableDevMode("zeta");
    enableDevMode("alpha");
    enableDevMode("mu");
    disableDevMode("mu");
    const list = listDevMode().map((x) => x.name);
    expect(list).toEqual(["alpha", "zeta"]);
  });

  test("listDevMode is empty when nothing is enabled", () => {
    expect(listDevMode()).toEqual([]);
  });
});

describe("SSE subscribers + broadcast", () => {
  test("addSubscriber + broadcast → controller enqueued", () => {
    const f = fakeController();
    addSubscriber("ui-a", { controller: f.controller, closed: false });
    expect(subscriberCount("ui-a")).toBe(1);
    const n = broadcastReload("ui-a", 12345);
    expect(n).toBe(1);
    expect(f.enqueued.length).toBe(1);
    const wire = new TextDecoder().decode(f.enqueued[0]!);
    expect(wire).toContain("event: reload");
    expect(wire).toContain('"timestamp":12345');
    expect(wire.endsWith("\n\n")).toBe(true);
  });

  test("broadcast notifies multiple subscribers", () => {
    const f1 = fakeController();
    const f2 = fakeController();
    addSubscriber("ui-a", { controller: f1.controller, closed: false });
    addSubscriber("ui-a", { controller: f2.controller, closed: false });
    expect(subscriberCount("ui-a")).toBe(2);
    const n = broadcastReload("ui-a");
    expect(n).toBe(2);
    expect(f1.enqueued.length).toBe(1);
    expect(f2.enqueued.length).toBe(1);
  });

  test("broadcast skips + reaps subscribers whose controller throws", () => {
    const live = fakeController();
    const dead = fakeController();
    dead.controller.close(); // force enqueue to throw
    addSubscriber("ui-a", { controller: live.controller, closed: false });
    addSubscriber("ui-a", { controller: dead.controller, closed: false });
    const n = broadcastReload("ui-a");
    expect(n).toBe(1);
    expect(subscriberCount("ui-a")).toBe(1);
  });

  test("removeSubscriber drops the entry + count goes back to zero", () => {
    const f = fakeController();
    const sub = { controller: f.controller, closed: false };
    addSubscriber("ui-a", sub);
    expect(subscriberCount("ui-a")).toBe(1);
    removeSubscriber("ui-a", sub);
    expect(subscriberCount("ui-a")).toBe(0);
  });

  test("disableDevMode closes all subscribers for that UI", () => {
    enableDevMode("ui-a");
    const f1 = fakeController();
    const f2 = fakeController();
    addSubscriber("ui-a", { controller: f1.controller, closed: false });
    addSubscriber("ui-a", { controller: f2.controller, closed: false });
    expect(subscriberCount("ui-a")).toBe(2);
    disableDevMode("ui-a");
    expect(subscriberCount("ui-a")).toBe(0);
    expect(f1.closed).toBe(true);
    expect(f2.closed).toBe(true);
  });

  test("closeAllSubscribers is safe when none exist", () => {
    expect(() => closeAllSubscribers("nothing")).not.toThrow();
  });

  test("broadcastReload on a UI with no subscribers returns 0", () => {
    enableDevMode("ui-a");
    expect(broadcastReload("ui-a")).toBe(0);
  });
});
