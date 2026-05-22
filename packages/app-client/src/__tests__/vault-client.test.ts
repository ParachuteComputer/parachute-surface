/**
 * Tests for `VaultClient` — the REST client with auto-refresh on 401.
 *
 * Coverage:
 *   - GET happy path
 *   - 401 with onAuthError that returns a fresh token → retry succeeds
 *   - 401 with onAuthError returning null → onAuthRevoked + throw VaultAuthError
 *   - 401 without onAuthError → onAuthRevoked + throw VaultAuthError
 *   - 403 with structured error_type surfaces in VaultAuthError.errorType
 *   - 404 → VaultNotFoundError
 *   - 5xx → VaultUnreachableError + onReachability("unreachable")
 *   - network failure → VaultUnreachableError(status=0) + onReachability("unreachable")
 *   - 2xx → onReachability("healthy")
 *   - 409 → VaultConflictError
 *   - 409 target_exists → VaultTargetExistsError
 *   - queryNotesCursor: reads X-Next-Cursor; auth retry preserves cursor
 */

import { describe, expect, test } from "bun:test";

import {
  VaultAuthError,
  VaultClient,
  VaultConflictError,
  VaultNotFoundError,
  VaultTargetExistsError,
  VaultUnreachableError,
} from "../vault-client.ts";

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function makeFetch(responders: Responder[]): typeof fetch {
  let i = 0;
  return (async (url: string, init?: RequestInit) => {
    const r = responders[i++];
    if (!r) throw new Error(`no responder for call ${i}`);
    return r(url, init);
  }) as unknown as typeof fetch;
}

function jsonRes(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

describe("VaultClient — happy path", () => {
  test("GET vaultInfo", async () => {
    const reachability: string[] = [];
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes({
            name: "default",
            description: "test",
            stats: { noteCount: 5, tagCount: 1, linkCount: 0 },
          }),
      ]),
      onReachability: (s) => reachability.push(s),
    });
    const info = await c.vaultInfo();
    expect(info.name).toBe("default");
    expect(reachability).toEqual(["healthy"]);
  });

  test("queryNotes returns array", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes([{ id: "n1", createdAt: "2026-05-21" }])]),
    });
    const notes = await c.queryNotes({ tag: "x" });
    expect(notes.length).toBe(1);
    expect(notes[0]!.id).toBe("n1");
  });

  test("createNote POSTs JSON", async () => {
    let capturedInit: RequestInit | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (_url, init) => {
          capturedInit = init;
          return jsonRes({ id: "n2", createdAt: "2026-05-21" }, 201);
        },
      ]),
    });
    const note = await c.createNote({ content: "hello" });
    expect(note.id).toBe("n2");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toContain("hello");
  });

  test("attaches Bearer header from accessToken", async () => {
    let capturedAuth: string | null = null;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "tok-xyz",
      fetchImpl: makeFetch([
        (_url, init) => {
          const headers = new Headers(init?.headers);
          capturedAuth = headers.get("Authorization");
          return jsonRes({ name: "default", description: "x" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedAuth).toBe("Bearer tok-xyz");
  });

  test("setAccessToken rotates in-place", async () => {
    const auths: string[] = [];
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "old",
      fetchImpl: makeFetch([
        (_url, init) => {
          auths.push(new Headers(init?.headers).get("Authorization") ?? "");
          return jsonRes({ name: "default", description: "x" });
        },
        (_url, init) => {
          auths.push(new Headers(init?.headers).get("Authorization") ?? "");
          return jsonRes({ name: "default", description: "x" });
        },
      ]),
    });
    await c.vaultInfo();
    c.setAccessToken("new");
    await c.vaultInfo();
    expect(auths).toEqual(["Bearer old", "Bearer new"]);
  });
});

describe("VaultClient — auth error paths", () => {
  test("401 with onAuthError returning fresh → retry succeeds", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([
        () => new Response("denied", { status: 401 }),
        () => jsonRes({ name: "default", description: "x" }),
      ]),
      onAuthError: async () => "fresh",
    });
    const info = await c.vaultInfo();
    expect(info.name).toBe("default");
  });

  test("401 with onAuthError returning null → throws VaultAuthError", async () => {
    let revokedStatus: number | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([() => new Response("denied", { status: 401 })]),
      onAuthError: async () => null,
      onAuthRevoked: (status) => {
        revokedStatus = status;
      },
    });
    // null-return from onAuthError means refresh.ts handles its own halt,
    // so onAuthRevoked is NOT called in the null branch (mirrors Notes).
    await expect(c.vaultInfo()).rejects.toBeInstanceOf(VaultAuthError);
    expect(revokedStatus).toBeUndefined();
  });

  test("401 without onAuthError → onAuthRevoked called + VaultAuthError thrown", async () => {
    let revokedStatus: number | undefined;
    let revokedDetail: { errorType?: string; message?: string } | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ error_type: "vault_scope_mismatch", message: "scope mismatch" }, 403),
      ]),
      onAuthRevoked: (status, detail) => {
        revokedStatus = status;
        revokedDetail = detail;
      },
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultAuthError);
    expect((thrown as VaultAuthError).errorType).toBe("vault_scope_mismatch");
    expect((thrown as VaultAuthError).status).toBe(403);
    expect(revokedStatus).toBe(403);
    expect(revokedDetail?.errorType).toBe("vault_scope_mismatch");
    expect(revokedDetail?.message).toBe("scope mismatch");
  });

  test("401 post-refresh retry → onAuthRevoked + VaultAuthError", async () => {
    let revokedStatus: number | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([
        () => new Response("denied", { status: 401 }),
        () => new Response("denied2", { status: 401 }),
      ]),
      onAuthError: async () => "fresh",
      onAuthRevoked: (status) => {
        revokedStatus = status;
      },
    });
    await expect(c.vaultInfo()).rejects.toBeInstanceOf(VaultAuthError);
    expect(revokedStatus).toBe(401);
  });
});

describe("VaultClient — error classes", () => {
  test("404 → VaultNotFoundError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("nope", { status: 404 })]),
    });
    await expect(c.vaultInfo()).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  test("5xx → VaultUnreachableError + unreachable signal", async () => {
    const signals: string[] = [];
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("down", { status: 502 })]),
      onReachability: (s) => signals.push(s),
    });
    await expect(c.vaultInfo()).rejects.toBeInstanceOf(VaultUnreachableError);
    expect(signals).toEqual(["unreachable"]);
  });

  test("network failure → VaultUnreachableError(status=0)", async () => {
    const signals: string[] = [];
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      onReachability: (s) => signals.push(s),
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultUnreachableError);
    expect((thrown as VaultUnreachableError).status).toBe(0);
    expect(signals).toEqual(["unreachable"]);
  });

  test("409 baseline mismatch → VaultConflictError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes(
            {
              current_updated_at: "2026-05-21T00:00:00Z",
              expected_updated_at: "2026-05-20T00:00:00Z",
              message: "stale",
            },
            409,
          ),
      ]),
    });
    let thrown: unknown;
    try {
      await c.updateNote("n1", { content: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultConflictError);
    expect((thrown as VaultConflictError).currentUpdatedAt).toBe("2026-05-21T00:00:00Z");
  });

  test("409 target_exists → VaultTargetExistsError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ error: "target_exists", target: "existing", message: "dup" }, 409),
      ]),
    });
    let thrown: unknown;
    try {
      await c.updateNote("n1", { content: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultTargetExistsError);
    expect((thrown as VaultTargetExistsError).target).toBe("existing");
  });

  test("AbortError propagates unchanged", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
    });
    await expect(c.vaultInfo()).rejects.toThrow(/aborted/);
  });
});

describe("VaultClient — cursor pagination", () => {
  test("queryNotesCursor reads X-Next-Cursor header", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes([{ id: "n1", createdAt: "x" }], 200, { "X-Next-Cursor": "abc123" }),
      ]),
    });
    const out = await c.queryNotesCursor({ tag: "x" }, undefined, 10);
    expect(out.items.length).toBe(1);
    expect(out.nextCursor).toBe("abc123");
  });

  test("queryNotesCursor without next cursor returns undefined", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes([{ id: "n1", createdAt: "x" }], 200, {})]),
    });
    const out = await c.queryNotesCursor({});
    expect(out.nextCursor).toBeUndefined();
  });

  test("queryNotesCursor 401 → onAuthError → retry preserves cursor", async () => {
    let secondUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([
        () => new Response("denied", { status: 401 }),
        (url) => {
          secondUrl = url;
          return jsonRes([], 200, { "X-Next-Cursor": "next2" });
        },
      ]),
      onAuthError: async () => "fresh",
    });
    const out = await c.queryNotesCursor({ tag: "x" }, "cur1", 5);
    expect(out.nextCursor).toBe("next2");
    expect(secondUrl).toContain("cursor=cur1");
    expect(secondUrl).toContain("limit=5");
  });
});
