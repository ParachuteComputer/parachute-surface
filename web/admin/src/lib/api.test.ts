/**
 * Tests for api.ts — the thin fetch wrapper.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  addUi,
  formatError,
  getOperatorToken,
  listUis,
  reloadUi,
  removeUi,
  setOperatorToken,
} from "./api.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("token storage", () => {
  test("set / get round-trips", () => {
    setOperatorToken("abc");
    expect(getOperatorToken()).toBe("abc");
  });
  test("getOperatorToken returns null when unset", () => {
    expect(getOperatorToken()).toBeNull();
  });
  test("TOKEN_STORAGE_KEY is the canonical key", () => {
    setOperatorToken("xyz");
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("xyz");
  });
});

describe("api calls", () => {
  test("listUis sends GET + Authorization header", async () => {
    setOperatorToken("op-token");
    let capturedUrl: string | undefined;
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return Promise.resolve(
        new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await listUis();
    expect(capturedUrl).toBe("/app/list");
    expect((capturedHeaders as Record<string, string>).authorization).toBe("Bearer op-token");
  });

  test("addUi sends POST + JSON body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, init: init as RequestInit };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui: null }), { status: 201 }));
    }) as unknown as typeof fetch;
    await addUi({ source: "/tmp/x", name: "x", path: "/app/x" });
    expect(captured?.url).toBe("/app/add");
    expect(captured?.init.method).toBe("POST");
    const body = JSON.parse(captured?.init.body as string);
    expect(body).toEqual({ source: "/tmp/x", name: "x", path: "/app/x" });
  });

  test("removeUi URL-encodes the name", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      capturedUrl = url;
      expect(init?.method).toBe("DELETE");
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, removed: "weird name" }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    await removeUi("my-ui");
    expect(capturedUrl).toBe("/app/my-ui");
  });

  test("reloadUi → POST /app/<name>/reload", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 }));
    }) as unknown as typeof fetch;
    await reloadUi("zz");
    expect(captured?.url).toBe("/app/zz/reload");
    expect(captured?.method).toBe("POST");
  });

  test("non-2xx → throws an ApiError-shaped object", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad_request", message: "nope" }), { status: 400 }),
      ),
    ) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await listUis();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { status: number }).status).toBe(400);
    expect((caught as { error: string }).error).toBe("bad_request");
  });
});

describe("formatError", () => {
  test("renders status + message", () => {
    expect(formatError({ status: 404, message: "not here" })).toBe("HTTP 404: not here");
  });
  test("falls back to error key when message absent", () => {
    expect(formatError({ status: 422, error: "no_dist" })).toBe("HTTP 422: no_dist");
  });
  test("non-object input", () => {
    expect(formatError("plain string")).toBe("plain string");
  });
});
