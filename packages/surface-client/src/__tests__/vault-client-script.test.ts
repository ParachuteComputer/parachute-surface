/**
 * Tests for the script-friendly `VaultClient` surface:
 *
 *   - `VaultClient.fromHub({ hubOrigin, vaultName, token })` factory
 *   - `tokenProvider` callback (vs static `accessToken`)
 *   - `VaultPermissionError` (403) split from `VaultAuthError` (401)
 *   - `VaultServerError` (5xx) split from `VaultUnreachableError` (network)
 *   - `VaultError` common base class
 *   - `createNotes` batch + 409 handling
 *   - `findPath` (graph)
 *   - `deleteTag`
 *   - URL encoding (vault name, tag name with special chars)
 *
 * The legacy `vault-client.test.ts` covers the UI-driver surface
 * (`onAuthError` refresh loop, reachability signals, cursor pagination,
 * tag upsert merge semantics). This file is the script-callable
 * complement.
 */

import { describe, expect, test } from "bun:test";

import {
  VaultAuthError,
  VaultClient,
  VaultConflictError,
  VaultError,
  VaultNotFoundError,
  VaultPermissionError,
  VaultServerError,
  VaultUnreachableError,
} from "../vault-client.ts";

// ---- Test plumbing ----

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

// ---- Constructor + fromHub factory ----

describe("VaultClient — fromHub factory", () => {
  test("composes hubOrigin + vaultName into the canonical vault URL", async () => {
    let capturedUrl: string | undefined;
    const c = VaultClient.fromHub({
      hubOrigin: "https://hub.example.com",
      vaultName: "default",
      token: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedUrl).toBe("https://hub.example.com/vault/default/api/vault?include_stats=true");
  });

  test("strips trailing slash from hubOrigin", async () => {
    let capturedUrl: string | undefined;
    const c = VaultClient.fromHub({
      hubOrigin: "https://hub.example.com/",
      vaultName: "default",
      token: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedUrl?.startsWith("https://hub.example.com/vault/default/")).toBe(true);
    expect(capturedUrl?.startsWith("https://hub.example.com//vault/")).toBe(false);
  });

  test("URL-encodes vault names containing special characters", async () => {
    let capturedUrl: string | undefined;
    const c = VaultClient.fromHub({
      hubOrigin: "https://hub.example.com",
      vaultName: "my vault",
      token: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ name: "my vault", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedUrl).toContain("/vault/my%20vault/");
  });

  test("attaches Bearer header from token", async () => {
    let capturedAuth: string | null = null;
    const c = VaultClient.fromHub({
      hubOrigin: "https://hub.example.com",
      vaultName: "default",
      token: "pvt_abc",
      fetchImpl: makeFetch([
        (_url, init) => {
          capturedAuth = new Headers(init?.headers).get("Authorization");
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedAuth).toBe("Bearer pvt_abc");
  });

  test("passes tokenProvider through to the request loop", async () => {
    const auths: string[] = [];
    let providerCalls = 0;
    const c = VaultClient.fromHub({
      hubOrigin: "https://hub.example.com",
      vaultName: "default",
      tokenProvider: async () => {
        providerCalls++;
        return `dyn_${providerCalls}`;
      },
      fetchImpl: makeFetch([
        (_u, init) => {
          auths.push(new Headers(init?.headers).get("Authorization") ?? "");
          return jsonRes({ name: "default", description: "" });
        },
        (_u, init) => {
          auths.push(new Headers(init?.headers).get("Authorization") ?? "");
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    await c.vaultInfo();
    expect(auths).toEqual(["Bearer dyn_1", "Bearer dyn_2"]);
    expect(providerCalls).toBe(2);
  });
});

describe("VaultClient — constructor validation", () => {
  test("throws when neither accessToken nor tokenProvider is supplied", () => {
    expect(
      () =>
        new VaultClient({
          vaultUrl: "http://vault.test",
        }),
    ).toThrow(/accessToken.*tokenProvider/);
  });

  test("accepts tokenProvider in the main constructor", async () => {
    let capturedAuth: string | null = null;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      tokenProvider: () => "sync-token",
      fetchImpl: makeFetch([
        (_u, init) => {
          capturedAuth = new Headers(init?.headers).get("Authorization");
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedAuth).toBe("Bearer sync-token");
  });

  test("tokenProvider wins over accessToken when both are supplied", async () => {
    let capturedAuth: string | null = null;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "static",
      tokenProvider: () => "dynamic",
      fetchImpl: makeFetch([
        (_u, init) => {
          capturedAuth = new Headers(init?.headers).get("Authorization");
          return jsonRes({ name: "default", description: "" });
        },
      ]),
    });
    await c.vaultInfo();
    expect(capturedAuth).toBe("Bearer dynamic");
  });

  test("tokenProvider errors propagate unchanged (not wrapped in VaultAuthError)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      tokenProvider: () => {
        throw new Error("refresh-loop is offline");
      },
      fetchImpl: makeFetch([() => jsonRes({})]),
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("refresh-loop is offline");
    expect(thrown).not.toBeInstanceOf(VaultError);
  });
});

// ---- Error model: permission, server, base class ----

describe("VaultClient — error class refinements", () => {
  test("403 → VaultPermissionError (subclass of VaultAuthError)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ error_type: "insufficient_scope", message: "need vault:write" }, 403),
      ]),
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultPermissionError);
    expect(thrown).toBeInstanceOf(VaultAuthError);
    expect(thrown).toBeInstanceOf(VaultError);
    expect((thrown as VaultPermissionError).status).toBe(403);
    expect((thrown as VaultPermissionError).errorType).toBe("insufficient_scope");
  });

  test("401 → VaultAuthError but NOT VaultPermissionError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("nope", { status: 401 })]),
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultAuthError);
    expect(thrown).not.toBeInstanceOf(VaultPermissionError);
    expect((thrown as VaultAuthError).status).toBe(401);
  });

  test("5xx → VaultServerError (subclass of VaultUnreachableError)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("boom", { status: 503 })]),
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultServerError);
    expect(thrown).toBeInstanceOf(VaultUnreachableError);
    expect(thrown).toBeInstanceOf(VaultError);
    expect((thrown as VaultServerError).status).toBe(503);
    expect((thrown as VaultServerError).body).toBe("boom");
  });

  test("network failure → VaultUnreachableError but NOT VaultServerError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: (async () => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    let thrown: unknown;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultUnreachableError);
    expect(thrown).not.toBeInstanceOf(VaultServerError);
    expect((thrown as VaultUnreachableError).status).toBe(0);
  });

  test("all classed errors extend VaultError (catchable as one base)", async () => {
    const cases: Array<[Responder, new (...args: never[]) => Error]> = [
      [() => new Response("", { status: 401 }), VaultAuthError],
      [() => new Response("", { status: 403 }), VaultPermissionError],
      [() => new Response("", { status: 404 }), VaultNotFoundError],
      [
        () => jsonRes({ message: "stale" }, 409),
        VaultConflictError,
      ],
      [() => new Response("", { status: 502 }), VaultServerError],
    ];
    for (const [responder, klass] of cases) {
      const c = new VaultClient({
        vaultUrl: "http://vault.test",
        accessToken: "t",
        fetchImpl: makeFetch([responder]),
      });
      let thrown: unknown;
      try {
        await c.vaultInfo();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(klass);
      expect(thrown).toBeInstanceOf(VaultError);
    }
  });

  test("VaultError carries response body when one was available", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ error_type: "vault_scope_mismatch", message: "wrong vault" }, 401),
      ]),
    });
    let thrown: VaultAuthError | undefined;
    try {
      await c.vaultInfo();
    } catch (e) {
      thrown = e as VaultAuthError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.body).toContain("vault_scope_mismatch");
  });
});

// ---- Batch create ----

describe("VaultClient — createNotes (batch)", () => {
  test("POSTs a {notes: [...]} envelope", async () => {
    let capturedBody: unknown;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (_u, init) => {
          capturedBody = JSON.parse(init?.body as string);
          return jsonRes(
            [
              { id: "n1", createdAt: "2026-05-27" },
              { id: "n2", createdAt: "2026-05-27" },
            ],
            201,
          );
        },
      ]),
    });
    const result = await c.createNotes([{ content: "A" }, { content: "B" }]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result[0]!.id).toBe("n1");
    expect((capturedBody as { notes: unknown[] }).notes).toHaveLength(2);
  });

  test("path-conflict 409 → VaultConflictError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes(
            {
              error_type: "path_conflict",
              error: "path_conflict",
              path: "duplicate.md",
              message: "Path already exists",
            },
            409,
          ),
      ]),
    });
    await expect(
      c.createNotes([{ content: "x", path: "duplicate.md" }]),
    ).rejects.toBeInstanceOf(VaultConflictError);
  });

  test("oversized batch surfaces vault's 413 as Error (batch_too_large)", async () => {
    // 413 isn't class-discriminated yet — it's vault#213's batch cap.
    // Confirms the message gets through.
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes(
            {
              error_type: "batch_too_large",
              error: "BatchTooLarge",
              message: "max 500 notes per request, got 600",
              limit: 500,
            },
            413,
          ),
      ]),
    });
    await expect(c.createNotes(new Array(600).fill({ content: "x" }))).rejects.toThrow(
      /batch_too_large|BatchTooLarge|max 500/,
    );
  });

  test("empty array still POSTs (no client-side short-circuit)", async () => {
    let called = false;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => {
          called = true;
          return jsonRes([], 201);
        },
      ]),
    });
    const result = await c.createNotes([]);
    expect(called).toBe(true);
    expect(result).toEqual([]);
  });

  test("AbortSignal is plumbed through to fetch", async () => {
    let capturedSignal: AbortSignal | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (_u, init) => {
          capturedSignal = init?.signal ?? undefined;
          return jsonRes([], 201);
        },
      ]),
    });
    const ctrl = new AbortController();
    await c.createNotes([{ content: "x" }], { signal: ctrl.signal });
    expect(capturedSignal).toBe(ctrl.signal);
  });
});

// ---- findPath (graph) ----

describe("VaultClient — findPath", () => {
  test("GETs /api/find-path with source + target params", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ path: ["a", "b", "c"], relationships: ["mentions", "links_to"] });
        },
      ]),
    });
    const result = await c.findPath("a", "c");
    expect(result?.path).toEqual(["a", "b", "c"]);
    expect(result?.relationships).toEqual(["mentions", "links_to"]);
    expect(capturedUrl).toBe("http://vault.test/api/find-path?source=a&target=c");
  });

  test("max_depth is URL-encoded into the query", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes(null);
        },
      ]),
    });
    await c.findPath("a", "z", { maxDepth: 8 });
    expect(capturedUrl).toContain("max_depth=8");
  });

  test("source + target with special chars are URL-encoded", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes(null);
        },
      ]),
    });
    await c.findPath("path with space/n.md", "n2");
    // URLSearchParams uses + for spaces (form-encoded); both work
    expect(capturedUrl).toMatch(/source=path(\+|%20)with(\+|%20)space/);
  });

  test("returns null when no path exists", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes(null)]),
    });
    const result = await c.findPath("a", "b");
    expect(result).toBeNull();
  });

  test("404 → VaultNotFoundError (missing source or target)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ error: "Note not found: \"missing\"" }, 404),
      ]),
    });
    await expect(c.findPath("missing", "b")).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

// ---- deleteTag ----

describe("VaultClient — deleteTag", () => {
  test("DELETEs /api/tags/:name", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url, init) => {
          capturedUrl = url;
          capturedMethod = init?.method;
          return jsonRes({ deleted: true });
        },
      ]),
    });
    await c.deleteTag("project");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl).toBe("http://vault.test/api/tags/project");
  });

  test("URL-encodes the tag name", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ deleted: true });
        },
      ]),
    });
    await c.deleteTag("weird tag/name");
    expect(capturedUrl).toBe("http://vault.test/api/tags/weird%20tag%2Fname");
  });

  test("tag-in-use 409 → VaultConflictError with referenced_by in body", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes(
            {
              error: "TagInUseByTokens",
              error_type: "tag_in_use_by_tokens",
              message: "Tag \"project\" is referenced by 2 tag-scoped token(s)",
              tag: "project",
              referenced_by: [
                { id: "tok1", label: "automation" },
                { id: "tok2", label: "ci" },
              ],
            },
            409,
          ),
      ]),
    });
    let thrown: VaultConflictError | undefined;
    try {
      await c.deleteTag("project");
    } catch (e) {
      thrown = e as VaultConflictError;
    }
    expect(thrown).toBeInstanceOf(VaultConflictError);
    expect(thrown?.body).toContain("referenced_by");
  });

  test("404 on missing tag → VaultNotFoundError", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("Not Found", { status: 404 })]),
    });
    await expect(c.deleteTag("missing")).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

// ---- URL construction sanity ----

describe("VaultClient — URL construction", () => {
  test("getNote uses encoded id in the query string", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes([{ id: "n1", createdAt: "x" }]);
        },
      ]),
    });
    await c.getNote("n1");
    // Single-note reads always include include_content=true
    expect(capturedUrl).toContain("id=n1");
    expect(capturedUrl).toContain("include_content=true");
  });

  test("queryNotes builds the right path with no params", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes([]);
        },
      ]),
    });
    await c.queryNotes({});
    expect(capturedUrl).toBe("http://vault.test/api/notes");
  });

  test("updateNote PATCHes the right URL", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url, init) => {
          capturedUrl = url;
          capturedMethod = init?.method;
          return jsonRes({ id: "n1", createdAt: "x" });
        },
      ]),
    });
    await c.updateNote("n1", { content: "updated", force: true });
    expect(capturedMethod).toBe("PATCH");
    expect(capturedUrl).toBe("http://vault.test/api/notes/n1");
  });

  test("deleteNote DELETEs the right URL with encoded id", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url, init) => {
          capturedUrl = url;
          capturedMethod = init?.method;
          return new Response(null, { status: 204 });
        },
      ]),
    });
    await c.deleteNote("note/with-slash");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedUrl).toBe("http://vault.test/api/notes/note%2Fwith-slash");
  });
});
