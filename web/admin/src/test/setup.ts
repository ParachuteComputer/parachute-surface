/**
 * Vitest setup file.
 *
 * Two responsibilities:
 *   1. Load `@testing-library/jest-dom` matchers so `toBeInTheDocument()` etc.
 *      are available on `expect`.
 *   2. Install a working `localStorage` implementation. Node 25 ships a
 *      built-in `localStorage` global that's a stub `{}` (lacks setItem/clear
 *      etc.) and happy-dom doesn't override the *global*-on-globalThis path
 *      under Node 25. We replace `globalThis.localStorage` + `window.localStorage`
 *      with an in-memory Storage implementation that survives across tests.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";

class InMemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function installStorage(): void {
  const ls = new InMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: ls,
    configurable: true,
    writable: false,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      value: ls,
      configurable: true,
      writable: false,
    });
  }
}

installStorage();

beforeEach(() => {
  // Fresh storage per test — avoids cross-test bleed of operator tokens.
  installStorage();
});

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // Storage may have been replaced mid-test; harmless to ignore.
  }
});
