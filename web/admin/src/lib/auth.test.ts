/**
 * Tests for lib/auth.ts — the hub-session silent mint (boundary C4).
 *
 * Coverage:
 *   - happy path: GET /admin/module-token/surface with credentials:"include",
 *     token cached in memory, NO localStorage write
 *   - cache: a fresh token is reused without a second mint fetch
 *   - near-expiry: a token inside the margin is re-minted on the next call
 *   - 401/403/404 → auth-required (the fallback-visibility driver)
 *   - 5xx / thrown fetch / token-less body → network-error
 *   - clearSessionToken drops the cache (the api layer's 401-retry hook)
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MINT_PATH,
  NEAR_EXPIRY_MARGIN_MS,
  clearSessionToken,
  ensureToken,
  getSessionToken,
} from "./auth.ts";

const realFetch = globalThis.fetch;

function mintResponse(token: string, expiresInMs: number): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      scopes: ["surface:admin"],
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  clearSessionToken();
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("ensureToken — happy path", () => {
  test("mints from the hub session and caches in memory only", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, init };
      return Promise.resolve(mintResponse("jwt-1", 10 * 60_000));
    }) as unknown as typeof fetch;

    const result = await ensureToken();
    expect(result).toEqual({ kind: "ok", token: "jwt-1" });
    expect(captured?.url).toBe(MINT_PATH);
    expect(captured?.init?.credentials).toBe("include");
    expect(getSessionToken()).toBe("jwt-1");
    // The session path NEVER touches localStorage.
    expect(localStorage.length).toBe(0);
  });

  test("reuses a fresh cached token without refetching", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(mintResponse("jwt-1", 10 * 60_000)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureToken();
    const second = await ensureToken();
    expect(second).toEqual({ kind: "ok", token: "jwt-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("re-mints when the cached token is inside the near-expiry margin", async () => {
    let mintCount = 0;
    globalThis.fetch = vi.fn(() => {
      mintCount += 1;
      // First mint is already inside the margin; second is fresh.
      const ttl = mintCount === 1 ? NEAR_EXPIRY_MARGIN_MS - 1_000 : 10 * 60_000;
      return Promise.resolve(mintResponse(`jwt-${mintCount}`, ttl));
    }) as unknown as typeof fetch;

    const first = await ensureToken();
    expect(first).toEqual({ kind: "ok", token: "jwt-1" });
    const second = await ensureToken();
    expect(second).toEqual({ kind: "ok", token: "jwt-2" });
    expect(mintCount).toBe(2);
  });

  test("token without a parseable expiry is trusted until cleared", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ token: "jwt-x" }), { status: 200 })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureToken();
    await ensureToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("ensureToken — failure shapes", () => {
  test.each([401, 403, 404])("%i → auth-required", async (status) => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("{}", { status })),
    ) as unknown as typeof fetch;
    const result = await ensureToken();
    expect(result).toEqual({ kind: "auth-required", status });
    expect(getSessionToken()).toBeNull();
  });

  test("5xx → network-error (hub reachable but failing)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("oops", { status: 502 })),
    ) as unknown as typeof fetch;
    const result = await ensureToken();
    expect(result).toEqual({ kind: "network-error", message: "hub returned 502" });
  });

  test("thrown fetch → network-error", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("connection refused")),
    ) as unknown as typeof fetch;
    const result = await ensureToken();
    expect(result).toEqual({ kind: "network-error", message: "connection refused" });
  });

  test("200 with a token-less body → network-error", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ scopes: [] }), { status: 200 })),
    ) as unknown as typeof fetch;
    const result = await ensureToken();
    expect(result).toEqual({ kind: "network-error", message: "mint response missing token" });
  });
});

describe("clearSessionToken", () => {
  test("drops the cache so the next ensureToken re-mints", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(mintResponse("jwt-1", 10 * 60_000)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await ensureToken();
    expect(getSessionToken()).toBe("jwt-1");
    clearSessionToken();
    expect(getSessionToken()).toBeNull();
    await ensureToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
