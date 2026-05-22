/**
 * Tests for `token-storage.ts` — load/save/clear + auto-prune behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  TOKEN_KEY_PREFIX,
  clearAllTokensForApp,
  clearToken,
  loadToken,
  saveToken,
  storedFromTokenResponse,
  tokenKey,
} from "../token-storage.ts";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("tokenKey", () => {
  test("uses the canonical prefix:app:scope shape", () => {
    expect(tokenKey("notes", "vault_default")).toBe(`${TOKEN_KEY_PREFIX}:notes:vault_default`);
  });
});

describe("saveToken + loadToken", () => {
  test("round-trip", () => {
    saveToken(
      "notes",
      "vault_default",
      { accessToken: "tok", scope: "vault:read", vault: "default" },
      { storage },
    );
    expect(loadToken("notes", "vault_default", { storage })).toEqual({
      accessToken: "tok",
      scope: "vault:read",
      vault: "default",
    });
  });

  test("missing key returns null", () => {
    expect(loadToken("missing", "v", { storage })).toBeNull();
  });

  test("malformed JSON returns null (does not throw)", () => {
    storage.setItem(tokenKey("notes", "v"), "{not-json");
    expect(loadToken("notes", "v", { storage })).toBeNull();
  });

  test("empty accessToken treated as invalid", () => {
    storage.setItem(
      tokenKey("notes", "v"),
      JSON.stringify({ accessToken: "", scope: "vault:read" }),
    );
    expect(loadToken("notes", "v", { storage })).toBeNull();
  });

  test("expired without refresh → null + key swept", () => {
    const stored = {
      accessToken: "expired",
      scope: "vault:read",
      expiresAt: 1000,
    };
    storage.setItem(tokenKey("notes", "v"), JSON.stringify(stored));
    const out = loadToken("notes", "v", { storage, now: () => 2000 });
    expect(out).toBeNull();
    expect(storage.getItem(tokenKey("notes", "v"))).toBeNull();
  });

  test("expired WITH refresh → returns record (caller can rotate)", () => {
    const stored = {
      accessToken: "expired",
      refreshToken: "rt",
      scope: "vault:read",
      expiresAt: 1000,
    };
    storage.setItem(tokenKey("notes", "v"), JSON.stringify(stored));
    const out = loadToken("notes", "v", { storage, now: () => 2000 });
    expect(out).not.toBeNull();
    expect(out?.refreshToken).toBe("rt");
  });
});

describe("clearToken", () => {
  test("removes the key", () => {
    saveToken(
      "notes",
      "v",
      { accessToken: "x", scope: "vault:read" },
      { storage },
    );
    clearToken("notes", "v", { storage });
    expect(loadToken("notes", "v", { storage })).toBeNull();
  });

  test("no-op when key absent", () => {
    expect(() => clearToken("notes", "missing", { storage })).not.toThrow();
  });
});

describe("clearAllTokensForApp", () => {
  test("removes only the matching app's tokens", () => {
    saveToken("notes", "v1", { accessToken: "a", scope: "x" }, { storage });
    saveToken("notes", "v2", { accessToken: "b", scope: "x" }, { storage });
    saveToken("other", "v1", { accessToken: "c", scope: "x" }, { storage });

    const removed = clearAllTokensForApp("notes", { storage });
    expect(removed).toBe(2);
    expect(loadToken("notes", "v1", { storage })).toBeNull();
    expect(loadToken("notes", "v2", { storage })).toBeNull();
    expect(loadToken("other", "v1", { storage })).not.toBeNull();
  });

  test("zero when no matching keys", () => {
    saveToken("other", "v1", { accessToken: "x", scope: "x" }, { storage });
    expect(clearAllTokensForApp("notes", { storage })).toBe(0);
  });
});

describe("storedFromTokenResponse", () => {
  test("computes absolute expiresAt from expires_in", () => {
    const stored = storedFromTokenResponse(
      {
        access_token: "at",
        scope: "vault:read",
        vault: "default",
        refresh_token: "rt",
        expires_in: 60,
      },
      1000,
    );
    expect(stored).toEqual({
      accessToken: "at",
      scope: "vault:read",
      vault: "default",
      refreshToken: "rt",
      expiresAt: 1000 + 60 * 1000,
    });
  });

  test("omits expiresAt + refreshToken when absent in response", () => {
    const stored = storedFromTokenResponse({
      access_token: "at",
      scope: "vault:read",
    });
    expect(stored.expiresAt).toBeUndefined();
    expect(stored.refreshToken).toBeUndefined();
  });
});
