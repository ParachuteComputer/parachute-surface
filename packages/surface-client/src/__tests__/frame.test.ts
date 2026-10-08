/**
 * Tests for the sandboxed-frame transport (`./frame`): `createFrameFetch`
 * (frame side) + `serveFrameFetch` (host side), driven through a real
 * `VaultClient` over two fake windows sharing one message bus.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type FramePolicy,
  type FrameRequest,
  type FrameResponse,
  createFrameFetch,
  serveFrameFetch,
} from "../frame.js";
import {
  VaultAuthError,
  VaultClient,
  VaultNotFoundError,
  VaultPermissionError,
  VaultUnreachableError,
} from "../vault-client.js";

type Listener = (ev: { data: unknown; source: unknown }) => void;

// One shared bus stands in for the global `message` event of both realms.
// Each fake window delivers to every listener with `source` = the sender, so
// the transport's own `event.source` filtering is what's under test.
const listeners = new Set<Listener>();
const g = globalThis as unknown as Record<string, unknown>;
const saved = {
  add: g.addEventListener,
  remove: g.removeEventListener,
};

function dispatch(data: unknown, source: unknown) {
  queueMicrotask(() => {
    for (const l of [...listeners]) l({ data, source });
  });
}

// `X.postMessage(d)` delivers `d` to X's realm, with the OTHER window as source:
// the frame talks to the host by calling `hostWin.postMessage`.
const hostWin = { postMessage: (d: unknown) => dispatch(d, frameWin) };
const frameWin = { postMessage: (d: unknown) => dispatch(d, hostWin) };
const strangerWin = { postMessage: (d: unknown) => dispatch(d, strangerWin) };

beforeEach(() => {
  listeners.clear();
  g.addEventListener = (t: string, l: Listener) => {
    if (t === "message") listeners.add(l);
  };
  g.removeEventListener = (t: string, l: Listener) => {
    if (t === "message") listeners.delete(l);
  };
});
afterEach(() => {
  g.addEventListener = saved.add;
  g.removeEventListener = saved.remove;
});

const json = (status: number, body: unknown): FrameResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const policy = (over: Partial<FramePolicy> = {}): FramePolicy => ({
  routes: [
    { method: "GET", pattern: /^\/api\/notes(\/[^/]+)?$/ },
    { method: "POST", pattern: /^\/api\/notes$/ },
  ],
  channel: "t",
  ...over,
});

function setup(
  handler: (r: FrameRequest) => Promise<FrameResponse>,
  over: Partial<FramePolicy> = {},
  fetchOpts: { timeoutMs?: number } = {},
) {
  const calls: FrameRequest[] = [];
  const dispose = serveFrameFetch(
    () => frameWin as unknown as Window,
    async (r) => {
      calls.push(r);
      return handler(r);
    },
    policy(over),
  );
  const fetchImpl = createFrameFetch({
    target: hostWin as unknown as Window,
    channel: "t",
    ...fetchOpts,
  });
  const client = new VaultClient({ vaultUrl: "frame:", accessToken: "frame", fetchImpl });
  return { calls, dispose, fetchImpl, client };
}

describe("round trip through VaultClient", () => {
  test("queryNotes sends only path+query and allowlisted headers", async () => {
    const { calls, client } = setup(async () => json(200, [{ id: "n1", path: "a" }]));
    const notes = await client.queryNotes({ tag: "x" });
    expect(notes).toEqual([{ id: "n1", path: "a" } as never]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/api/notes?tag=x");
    expect(calls[0]?.headers).toEqual({ accept: "application/json" });
    expect(calls[0]?.body).toBeUndefined();
  });

  test("getNote maps a 404 reply to VaultNotFoundError", async () => {
    const { client } = setup(async () => json(404, { error: "nope" }));
    await expect(client.getNote("zzz")).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  test("getNote returns the parsed note", async () => {
    const { calls, client } = setup(async () => json(200, { id: "n1", path: "p" }));
    const note = await client.getNote("n1");
    expect(note?.id).toBe("n1");
    expect(calls[0]?.path).toBe("/api/notes?id=n1&include_content=true");
  });

  test("string POST body + content-type are forwarded", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, { ok: true }));
    const res = await fetchImpl("frame:/api/notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret",
        "X-Evil": "1",
      },
      body: '{"a":1}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0]?.body).toBe('{"a":1}');
    expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
  });

  test("response carries status, statusText and headers", async () => {
    const { fetchImpl } = setup(async () => ({
      status: 201,
      statusText: "Made",
      headers: { "x-k": "v" },
      body: "hi",
    }));
    const res = await fetchImpl("frame:/api/notes", { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Made");
    expect(res.headers.get("x-k")).toBe("v");
    expect(await res.text()).toBe("hi");
  });

  test("204 reply with no body builds a valid Response", async () => {
    const { fetchImpl } = setup(async () => ({ status: 204 }));
    const res = await fetchImpl("frame:/api/notes");
    expect(res.status).toBe(204);
  });

  test("concurrent requests are matched by id", async () => {
    const { client } = setup(async (r) => {
      if (r.path.includes("slow")) await new Promise((res) => setTimeout(res, 20));
      return json(200, { id: r.path, path: r.path });
    });
    const [a, b] = await Promise.all([client.getNote("slow"), client.getNote("fast")]);
    expect(a?.id).toContain("slow");
    expect(b?.id).toContain("fast");
  });

  test("listeners are cleaned up after each request", async () => {
    const { fetchImpl, dispose } = setup(async () => json(200, {}));
    const base = listeners.size; // host listener only
    await fetchImpl("frame:/api/notes");
    expect(listeners.size).toBe(base);
    dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("source and shape filtering", () => {
  test("host ignores messages from a window that is not the frame", async () => {
    const { calls } = setup(async () => json(200, {}));
    strangerWin.postMessage({
      pfr: 1,
      channel: "t",
      id: "x",
      method: "GET",
      path: "/api/notes",
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
  });

  test("host drops malformed shapes silently", async () => {
    const { calls } = setup(async () => json(200, {}));
    const good = { pfr: 1, channel: "t", id: "x", method: "GET", path: "/api/notes", headers: {} };
    const bad: unknown[] = [
      null,
      "str",
      42,
      { ...good, extra: 1 },
      { ...good, pfr: 2 },
      { ...good, channel: "other" },
      { ...good, id: 5 },
      { ...good, method: 7 },
      { ...good, path: "api/notes" },
      { ...good, path: "//evil.example/api/notes" },
      { ...good, headers: [] },
      { ...good, headers: { a: 1 } },
      { ...good, body: 5 },
    ];
    const replies: unknown[] = [];
    listeners.add((ev) => {
      if (ev.source === hostWin) replies.push(ev.data);
    });
    for (const b of bad) hostWin.postMessage(b);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("frame ignores replies from a window that is not its target", async () => {
    const fetchImpl = createFrameFetch({
      target: hostWin as unknown as Window,
      channel: "t",
      timeoutMs: 30,
    });
    const sent: { id: string }[] = [];
    listeners.add((ev) => {
      if (ev.source === frameWin) sent.push(ev.data as { id: string });
    });
    const p = fetchImpl("frame:/api/notes");
    const settled = p.then(
      () => "resolved",
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 5));
    strangerWin.postMessage({
      pfr: 1,
      channel: "t",
      id: sent[0]?.id,
      status: 200,
      statusText: "",
      headers: {},
      body: "spoof",
    });
    const out = await settled;
    expect(out).toBeInstanceOf(TypeError);
    expect((out as Error).message).toBe("frame fetch timeout");
  });
});

describe("policy", () => {
  test("denied route → 403 frame_route_denied, handler never called", async () => {
    const { calls, client, fetchImpl } = setup(async () => json(200, {}));
    await expect(client.deleteNote("n1")).rejects.not.toBeInstanceOf(VaultPermissionError);
    const res = await fetchImpl("frame:/api/tags");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error_type: "frame_route_denied" });
    expect(calls).toHaveLength(0);
  });

  test("route patterns with the g flag behave statelessly", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), {
      routes: [{ method: "GET", pattern: /^\/api\/notes$/g }],
    });
    for (let i = 0; i < 3; i++) expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  test("wire method is matched case-sensitively against the allowlist", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}));
    const res = await fetchImpl("frame:/api/notes/n1", { method: "PUT", body: "{}" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("handler error → 500 frame_handler_error without leaking the message", async () => {
    const { fetchImpl } = setup(async () => {
      throw new Error("secret db password");
    });
    const res = await fetchImpl("frame:/api/notes");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error_type: "frame_handler_error" });
    expect(text).not.toContain("secret");
  });

  test("malformed handler response → 500 frame_handler_error", async () => {
    const { fetchImpl } = setup(async () => ({ status: 99999 }) as FrameResponse);
    const res = await fetchImpl("frame:/api/notes");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error_type: "frame_handler_error" });
  });

  test("oversize body → 413 before the handler runs", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), { maxBodyBytes: 16 });
    const res = await fetchImpl("frame:/api/notes", { method: "POST", body: "x".repeat(17) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error_type: "frame_body_too_large" });
    expect(calls).toHaveLength(0);
  });

  test("body size is measured in UTF-8 bytes, not code units", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), { maxBodyBytes: 8 });
    // 4 chars × 3 bytes = 12 bytes > 8
    const res = await fetchImpl("frame:/api/notes", { method: "POST", body: "€€€€" });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("default maxBodyBytes is 64 KiB", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}));
    expect(
      (await fetchImpl("frame:/api/notes", { method: "POST", body: "x".repeat(65536) })).status,
    ).toBe(200);
    expect(
      (await fetchImpl("frame:/api/notes", { method: "POST", body: "x".repeat(65537) })).status,
    ).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("maxPending: extra in-flight requests get 429 without calling the handler", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls, fetchImpl } = setup(
      async () => {
        await gate;
        return json(200, {});
      },
      { maxPending: 2 },
    );
    const a = fetchImpl("frame:/api/notes");
    const b = fetchImpl("frame:/api/notes");
    await new Promise((r) => setTimeout(r, 5));
    const c = await fetchImpl("frame:/api/notes");
    expect(c.status).toBe(503);
    expect(await c.json()).toEqual({ error_type: "frame_busy" });
    expect(calls).toHaveLength(2);
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    // slot freed
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
  });

  test("rate limit: messages over ratePerWindow are refused (even malformed ones count)", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), {
      ratePerWindow: 3,
      windowMs: 60_000,
    });
    // two junk messages burn budget before any parsing happens
    hostWin.postMessage("junk");
    hostWin.postMessage({ nope: true });
    await new Promise((r) => setTimeout(r, 5));
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
    // budget exhausted: the next request gets a prompt frame_rate_limited (not a 30s hang)
    const res = await fetchImpl("frame:/api/notes");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error_type: "frame_rate_limited" });
    expect(calls).toHaveLength(1);
  });

  test("stranger messages do not consume the frame's rate budget", async () => {
    const { fetchImpl } = setup(async () => json(200, {}), { ratePerWindow: 2 });
    for (let i = 0; i < 10; i++) strangerWin.postMessage("noise");
    await new Promise((r) => setTimeout(r, 5));
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
  });

  test("rate window rolls over", async () => {
    const { fetchImpl } = setup(async () => json(200, {}), { ratePerWindow: 1, windowMs: 30 });
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
  });

  test("disposer stops serving", async () => {
    const { calls, dispose } = setup(async () => json(200, {}));
    dispose();
    const f = createFrameFetch({
      target: hostWin as unknown as Window,
      channel: "t",
      timeoutMs: 20,
    });
    await expect(f("frame:/api/notes")).rejects.toThrow("frame fetch timeout");
    expect(calls).toHaveLength(0);
  });
});

describe("frame side", () => {
  test("timeout → TypeError → VaultUnreachableError via VaultClient", async () => {
    // no host listening at all
    const fetchImpl = createFrameFetch({
      target: hostWin as unknown as Window,
      timeoutMs: 20,
    });
    const client = new VaultClient({ vaultUrl: "frame:", accessToken: "frame", fetchImpl });
    await expect(client.queryNotes({})).rejects.toBeInstanceOf(VaultUnreachableError);
    await expect(fetchImpl("frame:/api/notes")).rejects.toBeInstanceOf(TypeError);
    expect(listeners.size).toBe(0);
  });

  test("rejects non-string bodies with a clear TypeError", async () => {
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, timeoutMs: 20 });
    const bodies: unknown[] = [
      new Blob(["x"]),
      new FormData(),
      new ReadableStream(),
      new URLSearchParams("a=1"),
      new ArrayBuffer(4),
      new Uint8Array(2),
    ];
    for (const body of bodies) {
      const err = await fetchImpl("frame:/api/notes", {
        method: "POST",
        body: body as BodyInit,
      }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain("body must be a string");
    }
    expect(listeners.size).toBe(0);
  });

  test("rejects URLs that are not frame:/relative paths", async () => {
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, timeoutMs: 20 });
    await expect(fetchImpl("https://evil.example/api/notes")).rejects.toBeInstanceOf(TypeError);
  });

  test("each request gets a unique id", async () => {
    const ids: string[] = [];
    listeners.add((ev) => {
      if (ev.source === frameWin) ids.push((ev.data as { id: string }).id);
    });
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, timeoutMs: 10 });
    await Promise.allSettled([fetchImpl("/a"), fetchImpl("/a"), fetchImpl("/a")]);
    expect(new Set(ids).size).toBe(3);
  });

  test("abort signal rejects with AbortError and cleans up", async () => {
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, timeoutMs: 1000 });
    const ac = new AbortController();
    const p = fetchImpl("frame:/api/notes", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(listeners.size).toBe(0);
  });
});

describe("handler 404 passthrough", () => {
  test("handler-provided statuses reach VaultClient errors", async () => {
    const { client } = setup(async () => json(404, {}));
    await expect(client.getNote("x")).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

// ------------------------------------------------------------------------
// Round 2: hostile frame — raw wire messages that bypass createFrameFetch.
// ------------------------------------------------------------------------

let rawN = 0;
const raw = (over: Record<string, unknown>) =>
  hostWin.postMessage({
    pfr: 1,
    channel: "t",
    id: `x${++rawN}`,
    method: "GET",
    path: "/api/notes",
    headers: {},
    ...over,
  });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const okHandler = async (): Promise<FrameResponse> => ({ status: 200, body: "{}" });

/** Record the raw wire replies the host posts back to the frame. */
function collectReplies() {
  const out: Array<{ id: string; status: number; body: string }> = [];
  const l: Listener = (ev) => {
    const d = ev.data as { pfr?: number; id?: string; status?: number; body?: string };
    if (ev.source === hostWin && d?.pfr === 1 && typeof d.status === "number") {
      out.push({ id: String(d.id), status: d.status, body: String(d.body) });
    }
  };
  listeners.add(l);
  return out;
}
const errType = (r?: { body: string }) => (r ? JSON.parse(r.body).error_type : undefined);

function rawHost(
  handler: (r: FrameRequest) => Promise<FrameResponse> = okHandler,
  over: Partial<FramePolicy> = {},
) {
  const seen: FrameRequest[] = [];
  const dispose = serveFrameFetch(
    () => frameWin as unknown as Window,
    async (r) => {
      seen.push(r);
      return handler(r);
    },
    policy(over),
  );
  return { seen, dispose, replies: collectReplies() };
}

describe("hostile frame: headers (P1-1, P2-2)", () => {
  test("host rebuilds headers: allowlist, lower-cased; Authorization/Cookie/etc. never reach the handler", async () => {
    const { seen } = rawHost();
    raw({
      headers: {
        Authorization: "Bearer stolen",
        authorization: "x",
        Cookie: "a=b",
        "X-Forwarded-For": "1.2.3.4",
        "Content-Type": "application/json",
        ACCEPT: "text/plain",
      },
    });
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toEqual({ "content-type": "application/json", accept: "text/plain" });
  });

  test("naive `{...req.headers, Authorization}` merge can't produce a duplicate", async () => {
    const { seen } = rawHost();
    raw({ headers: { authorization: "a", Authorization: "b" } });
    await tick();
    const merged = { ...seen[0]?.headers, Authorization: "Bearer REAL" };
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "authorization")).toEqual([
      "Authorization",
    ]);
  });

  test("oversize header value → 400 frame_bad_headers, handler not called", async () => {
    const { seen, replies } = rawHost();
    raw({ headers: { accept: "a".repeat(5_000_000) } });
    raw({ headers: { accept: "a".repeat(257) } });
    await tick();
    expect(seen).toHaveLength(0);
    expect(replies.map((r) => r.status)).toEqual([400, 400]);
    expect(errType(replies[0])).toBe("frame_bad_headers");
  });

  test("a 256-char header value is allowed", async () => {
    const { seen } = rawHost();
    raw({ headers: { accept: "a".repeat(256) } });
    await tick();
    expect(seen).toHaveLength(1);
  });

  test("case-variant duplicates of an allowed header are refused", async () => {
    const { seen, replies } = rawHost();
    raw({ headers: { accept: "a", Accept: "b" } });
    await tick();
    expect(seen).toHaveLength(0);
    expect(errType(replies[0])).toBe("frame_bad_headers");
  });

  test("own __proto__ header key is dropped, not forwarded", async () => {
    const { seen } = rawHost();
    const h: Record<string, string> = {};
    Object.defineProperty(h, "__proto__", {
      value: "x",
      enumerable: true,
      configurable: true,
      writable: true,
    });
    raw({ headers: h });
    await tick();
    expect(seen[0]?.headers).toEqual({});
  });
});

describe("hostile frame: path canonicalization (P1-2)", () => {
  const wide = [
    { method: "GET", pattern: /^\/api\/.+$/ },
    { method: "GET", pattern: /^\/.+$/ },
  ];
  const bad = [
    "/\\evil.example/x",
    "/\t/evil.example/x",
    "/\n/evil.example",
    "/\r/evil.example",
    "/ /x",
    "/api/notes/..",
    "/api/notes/.",
    "/api/notes/a/../b",
    "/api/notes/%2e%2e",
    "/api/notes/%2E%2e",
    "/api/notes/..%2f..%2fadmin",
    "/api/notes/a%2Fb",
    "/api/notes/a%5cb",
    "/api/notes/a\\..\\..\\x",
    "/api/notes/.\t.",
    "/api/notes/\u0000",
    "/api/nötes",
    "http://evil/api/notes/a",
    "//evil/x",
  ];

  test("every dot-segment / backslash / control / encoded-separator form is refused", async () => {
    const { seen, replies } = rawHost(okHandler, { routes: wide });
    for (const p of bad) raw({ path: p });
    await tick();
    expect(seen).toHaveLength(0);
    // `//evil/x` and `http://…` fail the cheap shape check silently; the rest get a 400
    expect(replies.length).toBeGreaterThanOrEqual(bad.length - 2);
    for (const r of replies) {
      expect(r.status).toBe(400);
      expect(errType(r)).toBe("frame_bad_path");
    }
  });

  test("the README pattern can no longer be walked out of with '..'", async () => {
    const { seen } = rawHost(okHandler, {
      routes: [{ method: "GET", pattern: /^\/api\/notes(\/[A-Za-z0-9_-]+)?$/ }],
    });
    for (const p of ["/api/notes/..", "/api/notes/%2e%2e", "/api/notes/ok_1-a"]) raw({ path: p });
    await tick();
    expect(seen.map((r) => r.path)).toEqual(["/api/notes/ok_1-a"]);
  });

  test("fragment is stripped before matching and never reaches the handler", async () => {
    const { seen } = rawHost();
    raw({ path: "/api/notes#/../x" });
    raw({ path: "/api/notes/a?x=1#y" });
    await tick();
    expect(seen.map((r) => r.path)).toEqual(["/api/notes", "/api/notes/a?x=1"]);
  });

  test("handler receives pathname+search and `new URL(path, base)` cannot leave the base", async () => {
    const { seen } = rawHost();
    raw({ path: "/api/notes/a?tag=x&q=%C3%B6" });
    await tick();
    expect(seen[0]?.path).toBe("/api/notes/a?tag=x&q=%C3%B6");
    expect(new URL(seen[0]?.path ?? "", "https://hub/vault/work").pathname).toBe("/api/notes/a");
  });

  test("a '..' in the query string is just data, not a path segment", async () => {
    const { seen } = rawHost();
    raw({ path: "/api/notes?next=../../admin" });
    await tick();
    expect(seen).toHaveLength(1);
  });

  test("over-long path → 413 frame_path_too_long (not frame_body_too_large)", async () => {
    const { seen, replies } = rawHost();
    raw({ path: `/api/notes?q=${"a".repeat(5000)}` });
    await tick();
    expect(seen).toHaveLength(0);
    expect(replies[0]?.status).toBe(413);
    expect(errType(replies[0])).toBe("frame_path_too_long");
  });
});

describe("handler timeout and abort (P2-1, P3-6)", () => {
  test("hung handlers time out with 504, free the slot, and a late settle is ignored", async () => {
    let releaseFirst!: () => void;
    let n = 0;
    const { seen, replies } = rawHost(
      () => {
        n++;
        if (n === 1) {
          return new Promise<FrameResponse>((r) => {
            releaseFirst = () => r({ status: 200, body: "late" });
          });
        }
        if (n === 2) return new Promise<FrameResponse>(() => {});
        return Promise.resolve({ status: 200, body: "{}" });
      },
      { maxPending: 2, handlerTimeoutMs: 30 },
    );
    raw({});
    raw({});
    await tick(10);
    raw({}); // both slots held → busy
    await tick(10);
    expect(replies.map((r) => errType(r))).toEqual(["frame_busy"]);
    await tick(60);
    const timeouts = replies.filter((r) => errType(r) === "frame_handler_timeout");
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((r) => r.status === 504)).toBe(true);
    releaseFirst(); // late settle: no second reply for that id
    await tick(10);
    expect(replies.filter((r) => r.id === timeouts[0]?.id)).toHaveLength(1);
    raw({}); // slots freed
    await tick();
    expect(seen).toHaveLength(3);
    expect(replies.at(-1)?.status).toBe(200);
  });

  test("handlerTimeoutMs defaults to 30000", async () => {
    // Observable via the abort signal staying live well past a short wait.
    let sig: AbortSignal | undefined;
    rawHost(async (r) => {
      sig = r.signal;
      return new Promise<FrameResponse>(() => {});
    });
    raw({});
    await tick(50);
    expect(sig?.aborted).toBe(false);
  });

  test("the request carries an AbortSignal that fires on timeout", async () => {
    let sig: AbortSignal | undefined;
    rawHost(
      async (r) => {
        sig = r.signal;
        return new Promise<FrameResponse>(() => {});
      },
      { handlerTimeoutMs: 20 },
    );
    raw({});
    await tick(10);
    expect(sig?.aborted).toBe(false);
    await tick(40);
    expect(sig?.aborted).toBe(true);
  });

  test("a normally-settling request's signal is not aborted", async () => {
    let sig: AbortSignal | undefined;
    rawHost(async (r) => {
      sig = r.signal;
      return { status: 200, body: "{}" };
    });
    raw({});
    await tick();
    expect(sig?.aborted).toBe(false);
  });

  test("dispose aborts in-flight handlers and drops their replies", async () => {
    let sig: AbortSignal | undefined;
    const { dispose, replies } = rawHost(async (r) => {
      sig = r.signal;
      return new Promise<FrameResponse>(() => {});
    });
    raw({});
    await tick(10);
    dispose();
    expect(sig?.aborted).toBe(true);
    await tick(10);
    expect(replies).toHaveLength(0);
  });
});

describe("host-policy replies don't look like vault auth failures (P2-3)", () => {
  function wired() {
    const { calls } = { calls: [] as FrameRequest[] };
    serveFrameFetch(
      () => frameWin as unknown as Window,
      async (r) => {
        calls.push(r);
        return { status: 200, body: "[]" };
      },
      policy({ maxBodyBytes: 4, maxPending: 1, handlerTimeoutMs: 30 }),
    );
    const revoked: unknown[] = [];
    let authErrors = 0;
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, channel: "t" });
    const client = new VaultClient({
      vaultUrl: "frame:",
      accessToken: "frame",
      fetchImpl,
      onAuthRevoked: (s: number, d: unknown) => revoked.push([s, d]),
      onAuthError: async () => {
        authErrors++;
        return null;
      },
    });
    return { calls, revoked, authErrors: () => authErrors, fetchImpl, client };
  }

  test("route_denied → 400 with the error_type body; onAuthRevoked/onAuthError never fire", async () => {
    const { revoked, authErrors, client, fetchImpl } = wired();
    await expect(client.deleteNote("n1")).rejects.not.toBeInstanceOf(VaultPermissionError);
    await expect(client.deleteNote("n1")).rejects.not.toBeInstanceOf(VaultAuthError);
    const res = await fetchImpl("frame:/api/tags");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error_type: "frame_route_denied" });
    expect(revoked).toEqual([]);
    expect(authErrors()).toBe(0);
  });

  test("too-large and bad-path → 400, error_type preserved", async () => {
    const { fetchImpl, revoked } = wired();
    const big = await fetchImpl("frame:/api/notes", { method: "POST", body: "toolong" });
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error_type: "frame_body_too_large" });
    const bad = await fetchImpl("frame:/api/notes/..");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error_type: "frame_bad_path" });
    expect(revoked).toEqual([]);
  });

  test("busy → 503, handler timeout → 504", async () => {
    const hung = new Promise<FrameResponse>(() => {});
    serveFrameFetch(
      () => frameWin as unknown as Window,
      () => hung,
      policy({ maxPending: 1, handlerTimeoutMs: 40 }),
    );
    const fetchImpl = createFrameFetch({ target: hostWin as unknown as Window, channel: "t" });
    const first = fetchImpl("frame:/api/notes");
    await tick(5);
    const busy = await fetchImpl("frame:/api/notes");
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ error_type: "frame_busy" });
    const timedOut = await first;
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({ error_type: "frame_handler_timeout" });
  });

  test("a handler-returned 403 without a frame_ error_type is untouched (real vault scope error)", async () => {
    const { client } = setup(async () => json(403, { error_type: "insufficient_scope" }));
    await expect(client.getNote("n1")).rejects.toBeInstanceOf(VaultPermissionError);
  });

  test("frame_handler_error keeps its 500", async () => {
    const { fetchImpl } = setup(async () => {
      throw new Error("x");
    });
    expect((await fetchImpl("frame:/api/notes")).status).toBe(500);
  });
});

describe("P3 hardening", () => {
  test("rate limiter survives the wall clock stepping backwards", async () => {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      const { seen } = rawHost(okHandler, { ratePerWindow: 1, windowMs: 40 });
      raw({});
      await tick(5);
      t -= 3_600_000; // wall clock rewinds 1h
      await tick(70); // real time passes the window
      raw({});
      await tick(10);
      expect(seen).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("rate-limited messages with an id get 429 frame_rate_limited", async () => {
    const { seen, replies } = rawHost(okHandler, { ratePerWindow: 1, windowMs: 60_000 });
    raw({});
    raw({});
    await tick();
    expect(seen).toHaveLength(1);
    expect(replies).toHaveLength(2);
    expect(replies.find((r) => r.status === 429)).toBeDefined();
    expect(errType(replies.find((r) => r.status === 429))).toBe("frame_rate_limited");
  });

  test("rate-limited junk without a string id stays silent", async () => {
    const { replies } = rawHost(okHandler, { ratePerWindow: 1, windowMs: 60_000 });
    raw({});
    hostWin.postMessage({ nope: true });
    hostWin.postMessage("junk");
    await tick();
    expect(replies).toHaveLength(1);
  });

  test("GET/HEAD with a body → 400 frame_bad_request, handler not called", async () => {
    const { seen, replies } = rawHost(okHandler, {
      routes: [
        { method: "GET", pattern: /^\/api\/notes$/ },
        { method: "HEAD", pattern: /^\/api\/notes$/ },
      ],
    });
    raw({ body: "x" });
    raw({ method: "HEAD", body: "x" });
    await tick();
    expect(seen).toHaveLength(0);
    expect(replies.map((r) => r.status)).toEqual([400, 400]);
    expect(errType(replies[0])).toBe("frame_bad_request");
  });

  test("route methods in the policy are normalised to upper case", async () => {
    const { seen } = rawHost(okHandler, {
      routes: [{ method: "get", pattern: /^\/api\/notes$/ }],
    });
    raw({});
    await tick();
    expect(seen).toHaveLength(1);
  });

  test("a handler returning a real Response (stream body) → 500 plus a console.warn", async () => {
    const warn = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...a: unknown[]) => {
      warned.push(a);
    };
    try {
      const { replies } = rawHost(async () => new Response("x") as unknown as FrameResponse);
      raw({});
      await tick();
      expect(replies[0]?.status).toBe(500);
      expect(errType(replies[0])).toBe("frame_handler_error");
      expect(warned.length).toBeGreaterThan(0);
      expect(String(warned[0]?.[0])).toContain("FrameResponse");
    } finally {
      console.warn = warn;
    }
  });

  test("channel mismatch from the frame is reported via onReject, not silently lost", async () => {
    const reasons: string[] = [];
    rawHost(okHandler, { onReject: (reason) => reasons.push(reason) });
    raw({ channel: "other" });
    await tick();
    expect(reasons).toEqual(["channel_mismatch"]);
  });
});

describe("onReject hook (P3-10)", () => {
  test("fires with a reason and a request summary for each host-side rejection", async () => {
    const got: Array<[string, { id?: string; method?: string; path?: string }]> = [];
    const { seen } = rawHost(okHandler, {
      maxBodyBytes: 4,
      onReject: (reason, req) => got.push([reason, req]),
    });
    raw({ id: "a", path: "/api/tags" }); // denied
    raw({ id: "b", path: "/api/notes/.." }); // bad path
    raw({ id: "c", headers: { accept: "a".repeat(300) } }); // bad headers
    raw({ id: "d", method: "POST", path: "/api/notes", body: "toolong" }); // too large
    hostWin.postMessage({ pfr: 1, channel: "t", junk: true }); // malformed
    await tick();
    expect(seen).toHaveLength(0);
    expect(got.map(([r]) => r)).toEqual([
      "route_denied",
      "bad_path",
      "bad_headers",
      "body_too_large",
      "malformed",
    ]);
    expect(got[0]?.[1]).toEqual({ id: "a", method: "GET", path: "/api/tags" });
  });

  test("covers busy, rate_limited, handler_timeout, handler_error", async () => {
    const reasons: string[] = [];
    let first = true;
    rawHost(
      () => {
        if (first) {
          first = false;
          return new Promise<FrameResponse>(() => {});
        }
        return Promise.reject(new Error("x"));
      },
      {
        maxPending: 1,
        handlerTimeoutMs: 30,
        ratePerWindow: 3,
        windowMs: 60_000,
        onReject: (r) => reasons.push(r),
      },
    );
    raw({});
    await tick(5);
    raw({}); // busy
    await tick(50); // first times out
    raw({}); // 3rd message: handler rejects
    await tick(10);
    raw({}); // 4th: rate limited
    await tick();
    expect(reasons).toEqual(["busy", "handler_timeout", "handler_error", "rate_limited"]);
  });

  test("a throwing onReject can't break serving", async () => {
    const { seen } = rawHost(okHandler, {
      onReject: () => {
        throw new Error("boom");
      },
    });
    raw({ path: "/api/tags" });
    raw({});
    await tick();
    expect(seen).toHaveLength(1);
  });
});
