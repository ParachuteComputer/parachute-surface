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
    await expect(client.deleteNote("n1")).rejects.toBeInstanceOf(VaultPermissionError);
    const res = await fetchImpl("frame:/api/tags");
    expect(res.status).toBe(403);
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

  test("method is matched case-sensitively against the allowlist", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}));
    const res = await fetchImpl("frame:/api/notes/n1", { method: "PUT", body: "{}" });
    expect(res.status).toBe(403);
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
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error_type: "frame_body_too_large" });
    expect(calls).toHaveLength(0);
  });

  test("body size is measured in UTF-8 bytes, not code units", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), { maxBodyBytes: 8 });
    // 4 chars × 3 bytes = 12 bytes > 8
    const res = await fetchImpl("frame:/api/notes", { method: "POST", body: "€€€€" });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test("default maxBodyBytes is 64 KiB", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}));
    expect(
      (await fetchImpl("frame:/api/notes", { method: "POST", body: "x".repeat(65536) })).status,
    ).toBe(200);
    expect(
      (await fetchImpl("frame:/api/notes", { method: "POST", body: "x".repeat(65537) })).status,
    ).toBe(413);
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
    expect(c.status).toBe(429);
    expect(await c.json()).toEqual({ error_type: "frame_busy" });
    expect(calls).toHaveLength(2);
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    // slot freed
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
  });

  test("rate limit: messages over ratePerWindow are dropped (even malformed ones count)", async () => {
    const { calls, fetchImpl } = setup(async () => json(200, {}), {
      ratePerWindow: 3,
      windowMs: 60_000,
    });
    // two junk messages burn budget before any parsing happens
    hostWin.postMessage("junk");
    hostWin.postMessage({ nope: true });
    await new Promise((r) => setTimeout(r, 5));
    expect((await fetchImpl("frame:/api/notes")).status).toBe(200);
    // budget exhausted: the next request is dropped → frame times out
    const f = createFrameFetch({
      target: hostWin as unknown as Window,
      channel: "t",
      timeoutMs: 30,
    });
    await expect(f("frame:/api/notes")).rejects.toThrow("frame fetch timeout");
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
