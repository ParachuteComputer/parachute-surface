/**
 * Tests for `reloadAfterServiceWorkerUpdate` — the SW reload helper.
 *
 * Coverage:
 *   - controllerchange fires → reload triggers
 *   - controllerchange never fires → fallback timer triggers reload
 *   - second call is a no-op (idempotent within page load)
 *   - controllerchange fires AND fallback runs → reload happens once only
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetReloadArmedForTests,
  reloadAfterServiceWorkerUpdate,
} from "../sw-reload.ts";

class FakeSWContainer {
  private listeners: Array<(e?: Event) => void> = [];
  addEventListener(event: string, listener: (e?: Event) => void): void {
    if (event === "controllerchange") this.listeners.push(listener);
  }
  fire(): void {
    for (const l of this.listeners) l();
  }
}

beforeEach(() => {
  __resetReloadArmedForTests();
});

afterEach(() => {
  __resetReloadArmedForTests();
});

describe("reloadAfterServiceWorkerUpdate", () => {
  test("controllerchange fires → reload triggers", () => {
    const sw = new FakeSWContainer();
    const reload = mock(() => {});
    reloadAfterServiceWorkerUpdate({
      reload,
      serviceWorker: sw as unknown as ServiceWorkerContainer,
      fallbackMs: 10_000,
    });
    expect(reload).not.toHaveBeenCalled();
    sw.fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("fallback timer fires reload when controllerchange never does", async () => {
    const sw = new FakeSWContainer();
    const reload = mock(() => {});
    reloadAfterServiceWorkerUpdate({
      reload,
      serviceWorker: sw as unknown as ServiceWorkerContainer,
      fallbackMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("idempotent — second call is no-op", () => {
    const sw1 = new FakeSWContainer();
    const sw2 = new FakeSWContainer();
    const reload1 = mock(() => {});
    const reload2 = mock(() => {});
    reloadAfterServiceWorkerUpdate({
      reload: reload1,
      serviceWorker: sw1 as unknown as ServiceWorkerContainer,
      fallbackMs: 10_000,
    });
    reloadAfterServiceWorkerUpdate({
      reload: reload2,
      serviceWorker: sw2 as unknown as ServiceWorkerContainer,
      fallbackMs: 10_000,
    });
    sw1.fire();
    sw2.fire();
    expect(reload1).toHaveBeenCalledTimes(1);
    expect(reload2).not.toHaveBeenCalled();
  });

  test("controllerchange + fallback both fire → reload happens once", async () => {
    const sw = new FakeSWContainer();
    const reload = mock(() => {});
    reloadAfterServiceWorkerUpdate({
      reload,
      serviceWorker: sw as unknown as ServiceWorkerContainer,
      fallbackMs: 5,
    });
    sw.fire();
    await new Promise((r) => setTimeout(r, 30));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("missing serviceWorker → fallback still fires reload", async () => {
    const reload = mock(() => {});
    reloadAfterServiceWorkerUpdate({
      reload,
      serviceWorker: null,
      fallbackMs: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
