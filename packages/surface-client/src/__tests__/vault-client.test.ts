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
 *   - queryNotesCursor: bootstraps `?cursor=` on page 1, parses the
 *     `{notes, next_cursor}` envelope, walks a full pagination loop that
 *     terminates on an EMPTY page (next_cursor keeps advancing — it's a
 *     resumable watermark, not a null terminator), falls back to
 *     X-Next-Cursor only when the body omits next_cursor, rejects
 *     cursor+orderBy/sort:"desc" client-side, auth retry preserves cursor
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
  test("queryNotesCursor bootstraps `?cursor=` on the first call (no cursor arg)", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ notes: [{ id: "n1", createdAt: "x" }], next_cursor: "w1" });
        },
      ]),
    });
    const out = await c.queryNotesCursor({ tag: "x" }, undefined, 10);
    const url = new URL(capturedUrl!);
    // Presence, not truthiness: `cursor` must be SET (empty) on page 1, or
    // both doors treat the call as non-cursor and answer a bare array
    // forever (the bug this fix closes).
    expect(url.searchParams.has("cursor")).toBe(true);
    expect(url.searchParams.get("cursor")).toBe("");
    expect(out.items.length).toBe(1);
    expect(out.nextCursor).toBe("w1");
  });

  test("queryNotesCursor parses the {notes, next_cursor} envelope body", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes({
            notes: [
              { id: "n1", createdAt: "x" },
              { id: "n2", createdAt: "y" },
            ],
            next_cursor: "abc123",
          }),
      ]),
    });
    const out = await c.queryNotesCursor({ tag: "x" }, undefined, 10);
    expect(out.items.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(out.nextCursor).toBe("abc123");
  });

  test("queryNotesCursor falls back to X-Next-Cursor only when the body omits next_cursor", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes({ notes: [] }, 200, { "X-Next-Cursor": "from-header" })]),
    });
    const out = await c.queryNotesCursor({});
    expect(out.nextCursor).toBe("from-header");
  });

  test("queryNotesCursor: body next_cursor wins over a stale X-Next-Cursor header", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes({ notes: [], next_cursor: "from-body" }, 200, {
            "X-Next-Cursor": "stale-header",
          }),
      ]),
    });
    const out = await c.queryNotesCursor({});
    expect(out.nextCursor).toBe("from-body");
  });

  test("queryNotesCursor: an empty page still carries a REAL next_cursor — the resumable watermark, not a terminator", async () => {
    // Neither door ever sends `next_cursor: null`. Core's `queryNotesPaged`
    // (core/src/notes.ts:1741-1748) unconditionally encodes a watermark,
    // HOLDING at the prior value on an empty page — the "since last
    // checked" contract a caller polls against. `QueryNotesPage.next_cursor`
    // is typed `string` (core/src/types.ts:327-330), never nullable.
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes({ notes: [], next_cursor: "w1" })]),
    });
    const out = await c.queryNotesCursor({}, "w1");
    expect(out.items.length).toBe(0);
    expect(out.nextCursor).toBe("w1");
  });

  test("queryNotesCursor: next_cursor: null parses to undefined (defensive fallback — not a real wire shape)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => jsonRes({ notes: [{ id: "n1", createdAt: "x" }], next_cursor: null }),
      ]),
    });
    const out = await c.queryNotesCursor({}, "w1");
    expect(out.items.length).toBe(1);
    expect(out.nextCursor).toBeUndefined();
  });

  test("queryNotesCursor: full pagination walk — page 1 (bootstrap) → page 2 (?cursor=w1) → drains on an empty page", async () => {
    const urls: string[] = [];
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          urls.push(url);
          return jsonRes({ notes: [{ id: "n1", createdAt: "x" }], next_cursor: "w1" });
        },
        (url) => {
          urls.push(url);
          return jsonRes({ notes: [{ id: "n2", createdAt: "y" }], next_cursor: "w2" });
        },
        (url) => {
          urls.push(url);
          // The real termination signal: an empty page. `next_cursor` is
          // STILL a live watermark ("w2", not null) — a caller draining a
          // one-shot page set stops on `items.length === 0` and persists
          // this cursor to resume a later "since last checked" poll.
          return jsonRes({ notes: [], next_cursor: "w2" });
        },
      ]),
    });
    const allItems: string[] = [];
    let cursor: string | undefined;
    let page = await c.queryNotesCursor({ tag: "x" }, cursor);
    while (page.items.length > 0) {
      allItems.push(...page.items.map((n) => n.id));
      cursor = page.nextCursor;
      page = await c.queryNotesCursor({ tag: "x" }, cursor);
    }

    expect(allItems).toEqual(["n1", "n2"]);
    expect(page.nextCursor).toBe("w2");
    expect(new URL(urls[0]!).searchParams.get("cursor")).toBe("");
    expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("w1");
    expect(new URL(urls[2]!).searchParams.get("cursor")).toBe("w2");
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
          return jsonRes({ notes: [], next_cursor: "next2" });
        },
      ]),
      onAuthError: async () => "fresh",
    });
    const out = await c.queryNotesCursor({ tag: "x" }, "cur1", 5);
    expect(out.nextCursor).toBe("next2");
    expect(secondUrl).toContain("cursor=cur1");
    expect(secondUrl).toContain("limit=5");
  });

  test("queryNotesCursor rejects `orderBy` (mutually exclusive with cursor server-side)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([]),
    });
    await expect(c.queryNotesCursor({ tag: "x", orderBy: "created_at" })).rejects.toThrow(
      /orderBy/,
    );
  });

  test('queryNotesCursor rejects `sort: "desc"` (mutually exclusive with cursor server-side)', async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([]),
    });
    await expect(c.queryNotesCursor({ tag: "x", sort: "desc" })).rejects.toThrow(/sort/);
  });

  test('queryNotesCursor allows `sort: "asc"` alongside cursor (the forced order, not a conflict)', async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => jsonRes({ notes: [], next_cursor: "w1" })]),
    });
    await expect(c.queryNotesCursor({ tag: "x", sort: "asc" })).resolves.toEqual({
      items: [],
      nextCursor: "w1",
    });
  });
});

describe("VaultClient — queryNotes (non-cursor) stays byte-compatible", () => {
  test("queryNotes never sends a cursor param and returns the bare array unwrapped", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes([
            { id: "n1", createdAt: "x" },
            { id: "n2", createdAt: "y" },
          ]);
        },
      ]),
    });
    const out = await c.queryNotes({ tag: "x" });
    expect(new URL(capturedUrl!).searchParams.has("cursor")).toBe(false);
    expect(out.map((n) => n.id)).toEqual(["n1", "n2"]);
  });
});

describe("VaultClient — tag upsert", () => {
  test("updateTag PUTs to /api/tags/:name with JSON body", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url, init) => {
          capturedUrl = url;
          capturedInit = init;
          return jsonRes({
            name: "capture",
            description: "Quick captures",
            fields: { source: { type: "string" } },
          });
        },
      ]),
    });
    const out = await c.updateTag("capture", {
      description: "Quick captures",
      fields: { source: { type: "string" } },
    });
    expect(out.name).toBe("capture");
    expect(out.fields?.source?.type).toBe("string");
    expect(capturedUrl).toBe("http://vault.test/api/tags/capture");
    expect(capturedInit?.method).toBe("PUT");
    expect(capturedInit?.body).toContain("Quick captures");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("updateTag URL-encodes the tag name", async () => {
    let capturedUrl: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (url) => {
          capturedUrl = url;
          return jsonRes({ name: "weird tag" });
        },
      ]),
    });
    await c.updateTag("weird tag", {});
    expect(capturedUrl).toBe("http://vault.test/api/tags/weird%20tag");
  });

  test("updateTag is idempotent — second call with same payload re-resolves", async () => {
    // Vault's PUT is idempotent at the wire level; we exercise that the
    // client doesn't add client-side caching that would skip the second
    // call.
    let callCount = 0;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () => {
          callCount++;
          return jsonRes({ name: "capture", description: "v1" });
        },
        () => {
          callCount++;
          return jsonRes({ name: "capture", description: "v1" });
        },
      ]),
    });
    await c.updateTag("capture", { description: "v1" });
    await c.updateTag("capture", { description: "v1" });
    expect(callCount).toBe(2);
  });

  test("updateTag 401 → onAuthError refresh → retry", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([
        () => new Response("denied", { status: 401 }),
        () => jsonRes({ name: "capture" }),
      ]),
      onAuthError: async () => "fresh",
    });
    const out = await c.updateTag("capture", { description: "x" });
    expect(out.name).toBe("capture");
  });

  test("updateTag bubbles VaultAuthError when onAuthError returns null", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "stale",
      fetchImpl: makeFetch([
        () => jsonRes({ error_type: "insufficient_scope", message: "need vault:admin" }, 403),
      ]),
    });
    await expect(c.updateTag("capture", {})).rejects.toBeInstanceOf(VaultAuthError);
  });

  test("updateTag — explicit null clears the field", async () => {
    let capturedBody: string | undefined;
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        (_url, init) => {
          capturedBody = init?.body as string;
          return jsonRes({ name: "capture" });
        },
      ]),
    });
    await c.updateTag("capture", { description: null, fields: null });
    expect(capturedBody).toContain('"description":null');
    expect(capturedBody).toContain('"fields":null');
  });

  test("getTag returns the record on 200", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([
        () =>
          jsonRes({
            name: "capture",
            count: 7,
            description: "existing",
            fields: { source: { type: "string" } },
          }),
      ]),
    });
    const got = await c.getTag("capture");
    expect(got?.name).toBe("capture");
    expect(got?.count).toBe(7);
    expect(got?.fields?.source?.type).toBe("string");
  });

  test("getTag returns null on 404 (not VaultNotFoundError)", async () => {
    // Provisioning callers want a clean null so they can branch
    // "tag missing → create" without try/catch noise.
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("Not Found", { status: 404 })]),
    });
    const got = await c.getTag("nope");
    expect(got).toBeNull();
  });

  test("getTag still throws on 5xx (not swallowed by the 404 catch)", async () => {
    const c = new VaultClient({
      vaultUrl: "http://vault.test",
      accessToken: "t",
      fetchImpl: makeFetch([() => new Response("oops", { status: 502 })]),
    });
    await expect(c.getTag("capture")).rejects.toBeInstanceOf(VaultUnreachableError);
  });
});
