/**
 * Tests for api.ts — the thin fetch wrapper.
 *
 * Bearer resolution (boundary C4): every `call()` first tries the hub-session
 * silent mint (`lib/auth.ts`); the legacy localStorage token is the fallback.
 * Tests that exercise the legacy path stub the mint route to 404 (the
 * direct-on-:1946 / no-hub shape).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  addUi,
  clearOperatorToken,
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
import { MINT_PATH, clearSessionToken, getSessionToken } from "./auth.ts";

const realFetch = globalThis.fetch;

/**
 * Install a fetch stub that answers the hub mint route separately from the
 * admin-endpoint handler under test. Default mint behavior is 404 — the
 * no-hub shape, which sends `call()` down the legacy localStorage path that
 * the pre-C4 tests exercised.
 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  opts: { mint?: () => Response } = {},
) {
  const mintCalls: number[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (url === MINT_PATH) {
      mintCalls.push(Date.now());
      return Promise.resolve(opts.mint ? opts.mint() : new Response("{}", { status: 404 }));
    }
    return Promise.resolve(handler(url, init));
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, mintCalls };
}

function mintOk(token: string): Response {
  return new Response(
    JSON.stringify({
      token,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      scopes: ["surface:admin"],
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  localStorage.clear();
  clearSessionToken();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("token storage (legacy fallback)", () => {
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
  test("clearOperatorToken removes the stored token", () => {
    setOperatorToken("xyz");
    clearOperatorToken();
    expect(getOperatorToken()).toBeNull();
  });
});

describe("session-mint path (boundary C4)", () => {
  test("silent mint happy path: API call carries the minted bearer, no localStorage write", async () => {
    let capturedAuth: string | undefined;
    const { mintCalls } = stubFetch(
      (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.authorization;
        return new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 });
      },
      { mint: () => mintOk("session-jwt") },
    );

    await listUis();
    expect(mintCalls.length).toBe(1);
    expect(capturedAuth).toBe("Bearer session-jwt");
    // The session path never persists — localStorage stays untouched.
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  test("session token is preferred over a stored legacy token", async () => {
    setOperatorToken("legacy-token");
    let capturedAuth: string | undefined;
    stubFetch(
      (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.authorization;
        return new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 });
      },
      { mint: () => mintOk("session-jwt") },
    );

    await listUis();
    expect(capturedAuth).toBe("Bearer session-jwt");
  });

  test("mint reused across calls — one mint, many requests", async () => {
    const { mintCalls } = stubFetch(
      () => new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 }),
      { mint: () => mintOk("session-jwt") },
    );
    await listUis();
    await listUis();
    await listUis();
    expect(mintCalls.length).toBe(1);
  });

  test("401 → drop cache, re-mint once, retry once (success)", async () => {
    let mintCount = 0;
    const listAuths: Array<string | undefined> = [];
    stubFetch(
      (_url, init) => {
        listAuths.push((init?.headers as Record<string, string>)?.authorization);
        // First request 401s (stale/revoked token); the retry succeeds.
        if (listAuths.length === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 });
      },
      {
        mint: () => {
          mintCount += 1;
          return mintOk(`jwt-${mintCount}`);
        },
      },
    );

    const res = await listUis();
    expect(res.uis).toEqual([]);
    expect(listAuths).toEqual(["Bearer jwt-1", "Bearer jwt-2"]);
    expect(mintCount).toBe(2);
    expect(getSessionToken()).toBe("jwt-2");
  });

  test("401 with no fresher bearer available → original 401 surfaces, single retry max", async () => {
    setOperatorToken("legacy-token");
    let listCalls = 0;
    stubFetch(() => {
      listCalls += 1;
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    });

    let caught: unknown;
    try {
      await listUis();
    } catch (e) {
      caught = e;
    }
    expect((caught as { status: number }).status).toBe(401);
    // Mint 404s both times; the legacy token is the same bearer that just
    // 401'd, so there's nothing fresher to retry with — exactly one request.
    expect(listCalls).toBe(1);
  });

  test("401 on the legacy path recovers via a now-working session mint", async () => {
    setOperatorToken("legacy-token");
    let mintAvailable = false;
    const listAuths: Array<string | undefined> = [];
    stubFetch(
      (_url, init) => {
        listAuths.push((init?.headers as Record<string, string>)?.authorization);
        if (listAuths.length === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 });
      },
      {
        mint: () => {
          if (!mintAvailable) {
            mintAvailable = true; // first probe 404s, the operator's session appears
            return new Response("{}", { status: 404 });
          }
          return mintOk("fresh-session-jwt");
        },
      },
    );

    const res = await listUis();
    expect(res.uis).toEqual([]);
    expect(listAuths).toEqual(["Bearer legacy-token", "Bearer fresh-session-jwt"]);
  });
});

describe("api calls (legacy fallback path — mint 404s)", () => {
  test("listUis sends GET + Authorization header", async () => {
    setOperatorToken("op-token");
    let capturedUrl: string | undefined;
    let capturedHeaders: HeadersInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 });
    });
    await listUis();
    expect(capturedUrl).toBe("/surface/list");
    expect((capturedHeaders as Record<string, string>).authorization).toBe("Bearer op-token");
  });

  test("addUi sends POST + JSON body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    stubFetch((url, init) => {
      captured = { url, init: init as RequestInit };
      return new Response(JSON.stringify({ ok: true, ui: null }), { status: 201 });
    });
    await addUi({ source: "/tmp/x", name: "x", path: "/surface/x" });
    expect(captured?.url).toBe("/surface/add");
    expect(captured?.init.method).toBe("POST");
    const body = JSON.parse(captured?.init.body as string);
    expect(body).toEqual({ source: "/tmp/x", name: "x", path: "/surface/x" });
  });

  test("removeUi URL-encodes the name", async () => {
    let capturedUrl: string | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true, removed: "weird name" }), { status: 200 });
    });
    await removeUi("my-ui");
    expect(capturedUrl).toBe("/surface/my-ui");
  });

  test("reloadUi → POST /surface/<name>/reload", async () => {
    let captured: { url: string; method: string } | undefined;
    stubFetch((url, init) => {
      captured = { url, method: init?.method ?? "GET" };
      return new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 });
    });
    await reloadUi("zz");
    expect(captured?.url).toBe("/surface/zz/reload");
    expect(captured?.method).toBe("POST");
  });

  test("non-2xx (non-401) → throws an ApiError-shaped object, no retry", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return new Response(JSON.stringify({ error: "bad_request", message: "nope" }), {
        status: 400,
      });
    });
    let caught: unknown;
    try {
      await listUis();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { status: number }).status).toBe(400);
    expect((caught as { error: string }).error).toBe("bad_request");
    expect(calls).toBe(1);
  });
});

describe("dev-mode helpers", () => {
  test("listDevMode → GET /surface/dev/list", async () => {
    let captured: { url: string; method: string } | undefined;
    stubFetch((url, init) => {
      captured = { url, method: init?.method ?? "GET" };
      return new Response(JSON.stringify({ uis: [] }), { status: 200 });
    });
    const res = await listDevMode();
    expect(captured?.url).toBe("/surface/dev/list");
    expect(captured?.method).toBe("GET");
    expect(res.uis).toEqual([]);
  });

  test("getDevModeStatus → GET /surface/<name>/dev", async () => {
    let capturedUrl: string | undefined;
    stubFetch((url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ name: "notes", enabled: true, enabledAt: 1, subscribers: 0 }),
        { status: 200 },
      );
    });
    const res = await getDevModeStatus("notes");
    expect(capturedUrl).toBe("/surface/notes/dev");
    expect(res.enabled).toBe(true);
  });

  test("enableDevMode → POST /surface/<name>/dev/enable", async () => {
    let captured: { url: string; method: string } | undefined;
    stubFetch((url, init) => {
      captured = { url, method: init?.method ?? "GET" };
      return new Response(
        JSON.stringify({ ok: true, name: "notes", enabled: true, enabledAt: 1, subscribers: 0 }),
        { status: 200 },
      );
    });
    await enableDevMode("notes");
    expect(captured?.url).toBe("/surface/notes/dev/enable");
    expect(captured?.method).toBe("POST");
  });

  test("disableDevMode → POST /surface/<name>/dev/disable", async () => {
    let captured: { url: string; method: string } | undefined;
    stubFetch((url, init) => {
      captured = { url, method: init?.method ?? "GET" };
      return new Response(
        JSON.stringify({ ok: true, name: "notes", enabled: false, was_on: true }),
        {
          status: 200,
        },
      );
    });
    await disableDevMode("notes");
    expect(captured?.url).toBe("/surface/notes/dev/disable");
    expect(captured?.method).toBe("POST");
  });

  test("triggerReload → POST /surface/<name>/dev/trigger", async () => {
    let captured: { url: string; method: string } | undefined;
    stubFetch((url, init) => {
      captured = { url, method: init?.method ?? "GET" };
      return new Response(JSON.stringify({ ok: true, name: "notes", notified: 3 }), {
        status: 200,
      });
    });
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
    stubFetch((url, init) => {
      captured = {
        url,
        method: init?.method ?? "GET",
        auth: (init?.headers as Record<string, string>)?.authorization,
      };
      return new Response(
        JSON.stringify({
          ok: true,
          name: "notes",
          provisioned: ["capture"],
          errors: [],
          vaultUrl: "http://hub/vault/default",
        }),
        { status: 200 },
      );
    });
    const res = await provisionSchema("notes");
    expect(captured?.url).toBe("/surface/notes/provision-schema");
    expect(captured?.method).toBe("POST");
    expect(captured?.auth).toBe("Bearer op-token");
    expect(res.provisioned).toEqual(["capture"]);
  });

  test("URL-encodes the UI name", async () => {
    let capturedUrl: string | undefined;
    stubFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ok: true, name: "w x", provisioned: [], errors: [] }), {
        status: 200,
      });
    });
    await provisionSchema("w x");
    expect(capturedUrl).toBe("/surface/w%20x/provision-schema");
  });

  test("surfaces skipReason from the server response", async () => {
    stubFetch(
      () =>
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
    );
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
