/**
 * Tests for api.ts — the thin fetch wrapper.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  addUi,
  disableDevMode,
  enableDevMode,
  formatError,
  getDevModeStatus,
  getOperatorToken,
  listDevMode,
  listUis,
  provisionSchema,
  reloadUi,
  removeUi,
  setOperatorToken,
  triggerReload,
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
    expect(capturedUrl).toBe("/surface/list");
    expect((capturedHeaders as Record<string, string>).authorization).toBe("Bearer op-token");
  });

  test("addUi sends POST + JSON body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, init: init as RequestInit };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui: null }), { status: 201 }));
    }) as unknown as typeof fetch;
    await addUi({ source: "/tmp/x", name: "x", path: "/surface/x" });
    expect(captured?.url).toBe("/surface/add");
    expect(captured?.init.method).toBe("POST");
    const body = JSON.parse(captured?.init.body as string);
    expect(body).toEqual({ source: "/tmp/x", name: "x", path: "/surface/x" });
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
    expect(capturedUrl).toBe("/surface/my-ui");
  });

  test("reloadUi → POST /surface/<name>/reload", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 }));
    }) as unknown as typeof fetch;
    await reloadUi("zz");
    expect(captured?.url).toBe("/surface/zz/reload");
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

describe("dev-mode helpers", () => {
  test("listDevMode → GET /surface/dev/list", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(new Response(JSON.stringify({ uis: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const res = await listDevMode();
    expect(captured?.url).toBe("/surface/dev/list");
    expect(captured?.method).toBe("GET");
    expect(res.uis).toEqual([]);
  });

  test("getDevModeStatus → GET /surface/<name>/dev", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({ name: "notes", enabled: true, enabledAt: 1, subscribers: 0 }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const res = await getDevModeStatus("notes");
    expect(capturedUrl).toBe("/surface/notes/dev");
    expect(res.enabled).toBe(true);
  });

  test("enableDevMode → POST /surface/<name>/dev/enable", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, name: "notes", enabled: true, enabledAt: 1, subscribers: 0 }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    await enableDevMode("notes");
    expect(captured?.url).toBe("/surface/notes/dev/enable");
    expect(captured?.method).toBe("POST");
  });

  test("disableDevMode → POST /surface/<name>/dev/disable", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, name: "notes", enabled: false, was_on: true }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    await disableDevMode("notes");
    expect(captured?.url).toBe("/surface/notes/dev/disable");
    expect(captured?.method).toBe("POST");
  });

  test("triggerReload → POST /surface/<name>/dev/trigger", async () => {
    let captured: { url: string; method: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET" };
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, name: "notes", notified: 3 }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const res = await triggerReload("notes");
    expect(captured?.url).toBe("/surface/notes/dev/trigger");
    expect(captured?.method).toBe("POST");
    expect(res.notified).toBe(3);
  });
});

describe("provisionSchema (Phase 2.1)", () => {
  test("POST /surface/<name>/provision-schema with auth", async () => {
    setOperatorToken("op-token");
    let captured: { url: string; method: string; auth?: string } | undefined;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      captured = {
        url,
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string>)?.authorization,
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            name: "notes",
            provisioned: ["capture"],
            errors: [],
            vaultUrl: "http://hub/vault/default",
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const res = await provisionSchema("notes");
    expect(captured?.url).toBe("/surface/notes/provision-schema");
    expect(captured?.method).toBe("POST");
    expect(captured?.auth).toBe("Bearer op-token");
    expect(res.provisioned).toEqual(["capture"]);
  });

  test("URL-encodes the UI name", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = vi.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, name: "w x", provisioned: [], errors: [] }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;
    await provisionSchema("w x");
    expect(capturedUrl).toBe("/surface/w%20x/provision-schema");
  });

  test("surfaces skipReason from the server response", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            name: "notes",
            provisioned: [],
            errors: [],
            skipReason: "no required_schema",
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    const res = await provisionSchema("notes");
    expect(res.skipReason).toBe("no required_schema");
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
