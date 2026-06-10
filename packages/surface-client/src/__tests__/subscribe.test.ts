/**
 * Tests for `VaultClient.subscribe()` — the live-query SSE consumer.
 *
 *   - SSE wire-format parsing (snapshot / upsert / remove / keepalive
 *     comments / multi-line data / CRLF) via `parseSSEStream` directly.
 *   - Header (not query-param) auth — the EventSource trap this design
 *     explicitly avoids.
 *   - Reconnect + fresh-snapshot self-correction.
 *   - 401 → refresh (the client's onAuthError seam) → resubscribe.
 *   - Unrecoverable auth (no refresh / refresh rejected) terminates.
 *   - Unsubscribe aborts the in-flight stream and stops delivery.
 *   - Client-side rejection of `search` / `near` / `cursor`.
 *
 * Server side is a real in-test `Bun.serve` emitting SSE frames, so the
 * whole loop (fetch → ReadableStream → parser → handlers) is exercised
 * end to end.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { parseSSEStream } from "../subscribe.ts";
import { VaultAuthError, VaultClient } from "../vault-client.ts";

// ---- plumbing ----

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events: { event: string; data: string }[] = [];
  for await (const ev of parseSSEStream(stream)) events.push(ev);
  return events;
}

/** Deferred you can await with a timeout that fails loudly. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function within<T>(p: Promise<T>, ms = 3_000, label = "condition"): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SSEController = ReadableStreamDefaultController<Uint8Array>;

/**
 * Minimal SSE test server. Each connection invokes `onConnect` with a
 * frame-writer + the request; the returned servers are closed in
 * afterEach.
 */
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function sseServer(
  handler: (req: Request, connection: number) => Response | Promise<Response>,
): { url: string } {
  let connection = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      connection++;
      return handler(req, connection);
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}` };
}

function sseResponse(
  onOpen: (write: (frame: string) => void, close: () => void) => void,
): Response {
  const enc = new TextEncoder();
  let ctrl: SSEController;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
      onOpen(
        (frame) => {
          try {
            ctrl.enqueue(enc.encode(frame));
          } catch {
            // client went away
          }
        },
        () => {
          try {
            ctrl.close();
          } catch {
            // already closed
          }
        },
      );
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const SNAPSHOT_2 = `event: snapshot\ndata: {"notes":[{"id":"a","createdAt":"2026-01-01"},{"id":"b","createdAt":"2026-01-02"}]}\n\n`;

// ---- wire-format parsing (parser unit level) ----

describe("parseSSEStream — wire format", () => {
  test("parses snapshot / upsert / remove event frames", async () => {
    const events = await collect(
      streamOf(
        SNAPSHOT_2,
        `event: upsert\ndata: {"note":{"id":"c","createdAt":"2026-01-03"}}\n\n`,
        `event: remove\ndata: {"id":"a"}\n\n`,
      ),
    );
    expect(events.map((e) => e.event)).toEqual(["snapshot", "upsert", "remove"]);
    expect(JSON.parse(events[0]!.data).notes).toHaveLength(2);
    expect(JSON.parse(events[1]!.data).note.id).toBe("c");
    expect(JSON.parse(events[2]!.data).id).toBe("a");
  });

  test("ignores comment keepalives (vault's `:` frames)", async () => {
    const events = await collect(streamOf(":\n\n", ": keepalive\n\n", SNAPSHOT_2, ":\n\n"));
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("snapshot");
  });

  test("joins multi-line data with newlines", async () => {
    // Intentionally pins the `\n` line-join itself, not JSON round-trip
    // validity — the payload is split at an arbitrary point a real emitter
    // wouldn't choose; the parse below just confirms the join is lossless.
    const events = await collect(streamOf(`event: upsert\ndata: {"note":\ndata: {"id":"x"}}\n\n`));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe(`{"note":\n{"id":"x"}}`);
    expect(JSON.parse(events[0]!.data).note.id).toBe("x");
  });

  test("handles frames split across arbitrary chunk boundaries", async () => {
    const whole = `event: remove\ndata: {"id":"split-id"}\n\n`;
    // Split mid-field-name and mid-value.
    const events = await collect(streamOf(whole.slice(0, 3), whole.slice(3, 17), whole.slice(17)));
    expect(events).toEqual([{ event: "remove", data: `{"id":"split-id"}` }]);
  });

  test("normalizes CRLF line endings", async () => {
    const events = await collect(streamOf(`event: remove\r\ndata: {"id":"crlf"}\r\n\r\n`));
    expect(events).toEqual([{ event: "remove", data: `{"id":"crlf"}` }]);
  });

  test("drops event-name-only frames with no data (per SSE spec)", async () => {
    const events = await collect(streamOf("event: snapshot\n\n", `data: {"id":"d"}\n\n`));
    expect(events).toEqual([{ event: "message", data: `{"id":"d"}` }]);
  });

  test("ignores id:/retry: fields", async () => {
    const events = await collect(streamOf(`id: 7\nretry: 100\nevent: remove\ndata: {"id":"k"}\n\n`));
    expect(events).toEqual([{ event: "remove", data: `{"id":"k"}` }]);
  });
});

// ---- subscribe() end to end ----

function makeClient(url: string, extra: Partial<ConstructorParameters<typeof VaultClient>[0]> = {}) {
  return new VaultClient({ vaultUrl: url, accessToken: "tok-1", ...extra });
}

describe("VaultClient.subscribe — transport + lifecycle", () => {
  test("authenticates via Authorization header, never a query param", async () => {
    const seen = deferred<{ auth: string | null; url: string }>();
    const srv = sseServer((req) => {
      seen.resolve({ auth: req.headers.get("authorization"), url: req.url });
      return sseResponse((write) => write(SNAPSHOT_2));
    });
    const snapshot = deferred<unknown>();
    const unsub = makeClient(srv.url).subscribe(
      { tag: "#x" },
      { onSnapshot: (n) => snapshot.resolve(n), onUpsert: () => {}, onRemove: () => {} },
    );
    const { auth, url } = await within(seen.promise, 3_000, "connect");
    expect(auth).toBe("Bearer tok-1");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/subscribe");
    expect(parsed.searchParams.get("tag")).toBe("#x");
    expect(parsed.searchParams.get("key")).toBeNull(); // no token in the URL
    expect(url).not.toContain("tok-1");
    await within(snapshot.promise, 3_000, "snapshot");
    unsub();
  });

  test("delivers snapshot, then upserts and removes, skipping keepalives", async () => {
    let writeFrame: ((f: string) => void) | undefined;
    const opened = deferred<void>();
    const srv = sseServer(() =>
      sseResponse((write) => {
        writeFrame = write;
        write(SNAPSHOT_2);
        opened.resolve();
      }),
    );
    const got: string[] = [];
    const removed = deferred<string>();
    const unsub = makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: (notes) => got.push(`snapshot:${notes.map((n) => n.id).join(",")}`),
        onUpsert: (note) => got.push(`upsert:${note.id}`),
        onRemove: (id) => {
          got.push(`remove:${id}`);
          removed.resolve(id);
        },
      },
    );
    await within(opened.promise, 3_000, "open");
    writeFrame!(":\n\n"); // keepalive — must be invisible to handlers
    writeFrame!(`event: upsert\ndata: {"note":{"id":"c","createdAt":"2026-01-03"}}\n\n`);
    writeFrame!(`event: remove\ndata: {"id":"a"}\n\n`);
    await within(removed.promise, 3_000, "remove event");
    expect(got).toEqual(["snapshot:a,b", "upsert:c", "remove:a"]);
    unsub();
  });

  test("reconnects after server close and re-delivers a fresh snapshot", async () => {
    const srv = sseServer((_req, connection) =>
      sseResponse((write, close) => {
        if (connection === 1) {
          write(SNAPSHOT_2);
          close(); // drop the stream → client should reconnect
        } else {
          write(`event: snapshot\ndata: {"notes":[{"id":"fresh","createdAt":"2026-02-01"}]}\n\n`);
        }
      }),
    );
    const snapshots: string[][] = [];
    const second = deferred<void>();
    const statuses: string[] = [];
    const unsub = makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: (notes) => {
          snapshots.push(notes.map((n) => n.id));
          if (snapshots.length === 2) second.resolve();
        },
        onUpsert: () => {},
        onRemove: () => {},
        onStatus: (s) => statuses.push(s),
      },
      { initialBackoffMs: 10, maxBackoffMs: 50 },
    );
    await within(second.promise, 3_000, "second snapshot");
    expect(snapshots).toEqual([["a", "b"], ["fresh"]]);
    // Lifecycle: connecting → open → reconnecting → open.
    expect(statuses.slice(0, 4)).toEqual(["connecting", "open", "reconnecting", "open"]);
    unsub();
  });

  test("401 drives the refresh seam once, then resubscribes with the fresh token", async () => {
    const tokens: (string | null)[] = [];
    const srv = sseServer((req) => {
      tokens.push(req.headers.get("authorization"));
      if (req.headers.get("authorization") !== "Bearer tok-2") {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return sseResponse((write) => write(SNAPSHOT_2));
    });
    let refreshCalls = 0;
    const snapshot = deferred<void>();
    const client = makeClient(srv.url, {
      onAuthError: async () => {
        refreshCalls++;
        return "tok-2";
      },
    });
    const unsub = client.subscribe(
      { tag: "#x" },
      { onSnapshot: () => snapshot.resolve(), onUpsert: () => {}, onRemove: () => {} },
      { initialBackoffMs: 10 },
    );
    await within(snapshot.promise, 3_000, "post-refresh snapshot");
    expect(refreshCalls).toBe(1);
    expect(tokens).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    unsub();
  });

  test("unrecoverable 401 (no refresh path) terminates with VaultAuthError + closed", async () => {
    const srv = sseServer(
      () => new Response(JSON.stringify({ error: "nope" }), { status: 401 }),
    );
    const errored = deferred<unknown>();
    const statuses: string[] = [];
    const closed = deferred<void>();
    makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {},
        onUpsert: () => {},
        onRemove: () => {},
        onError: (e) => errored.resolve(e),
        onStatus: (s) => {
          statuses.push(s);
          if (s === "closed") closed.resolve();
        },
      },
    );
    const err = await within(errored.promise, 3_000, "auth error");
    expect(err).toBeInstanceOf(VaultAuthError);
    await within(closed.promise, 3_000, "closed status");
    expect(statuses.at(-1)).toBe("closed");
  });

  test("onAuthError returning null (refresh impossible) terminates cleanly — no retry/spin", async () => {
    // Distinct from the no-callback case above: the refresh SEAM exists but
    // reports refresh-not-possible (e.g. no refresh token stored). Must be
    // terminal — one connection, one refresh attempt, no reconnect loop.
    let connections = 0;
    const srv = sseServer(() => {
      connections++;
      return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
    });
    let refreshCalls = 0;
    const errored = deferred<unknown>();
    const closed = deferred<void>();
    const statuses: string[] = [];
    makeClient(srv.url, {
      onAuthError: async () => {
        refreshCalls++;
        return null; // refresh not possible
      },
    }).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {},
        onUpsert: () => {},
        onRemove: () => {},
        onError: (e) => errored.resolve(e),
        onStatus: (s) => {
          statuses.push(s);
          if (s === "closed") closed.resolve();
        },
      },
      { initialBackoffMs: 5 },
    );
    expect(await within(errored.promise, 3_000, "auth error")).toBeInstanceOf(VaultAuthError);
    await within(closed.promise, 3_000, "closed status");
    await sleep(50); // would have reconnected several times at 5ms backoff
    expect(connections).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(statuses.at(-1)).toBe("closed");
  });

  test("400 (unsupported query reached the server) terminates — no retry loop", async () => {
    let connections = 0;
    const srv = sseServer(() => {
      connections++;
      return new Response(JSON.stringify({ code: "UNSUPPORTED_SUBSCRIPTION_QUERY" }), {
        status: 400,
      });
    });
    const closed = deferred<void>();
    const errored = deferred<unknown>();
    makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {},
        onUpsert: () => {},
        onRemove: () => {},
        onError: (e) => errored.resolve(e),
        onStatus: (s) => {
          if (s === "closed") closed.resolve();
        },
      },
      { initialBackoffMs: 5 },
    );
    await within(closed.promise, 3_000, "closed");
    expect(String(await errored.promise)).toContain("400");
    await sleep(50); // would have retried several times at 5ms backoff
    expect(connections).toBe(1);
  });

  test("unsubscribe aborts the stream and stops delivery", async () => {
    let writeFrame: ((f: string) => void) | undefined;
    const snapshotDelivered = deferred<void>();
    const aborted = deferred<void>();
    const srv = sseServer((req) => {
      req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return sseResponse((write) => {
        writeFrame = write;
        write(SNAPSHOT_2);
      });
    });
    const events: string[] = [];
    const statuses: string[] = [];
    const unsub = makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {
          events.push("snapshot");
          snapshotDelivered.resolve();
        },
        onUpsert: (n) => events.push(`upsert:${n.id}`),
        onRemove: () => events.push("remove"),
        onStatus: (s) => statuses.push(s),
      },
      { initialBackoffMs: 5 },
    );
    await within(snapshotDelivered.promise, 3_000, "snapshot delivered");
    unsub();
    await within(aborted.promise, 3_000, "server-side abort");
    writeFrame!(`event: upsert\ndata: {"note":{"id":"late","createdAt":"2026-01-01"}}\n\n`);
    await sleep(50);
    expect(events).toEqual(["snapshot"]); // nothing delivered after unsubscribe
    expect(statuses.at(-1)).toBe("closed");
    unsub(); // idempotent
    expect(statuses.filter((s) => s === "closed")).toHaveLength(1);
  });

  test("external AbortSignal closes the subscription", async () => {
    const opened = deferred<void>();
    const srv = sseServer(() => sseResponse((write) => {
      write(SNAPSHOT_2);
      opened.resolve();
    }));
    const ac = new AbortController();
    const statuses: string[] = [];
    const closed = deferred<void>();
    makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {},
        onUpsert: () => {},
        onRemove: () => {},
        onStatus: (s) => {
          statuses.push(s);
          if (s === "closed") closed.resolve();
        },
      },
      { signal: ac.signal },
    );
    await within(opened.promise, 3_000, "open");
    ac.abort();
    await within(closed.promise, 3_000, "closed after abort");
    expect(statuses.at(-1)).toBe("closed");
  });

  test("malformed event JSON reports onError but keeps the stream alive", async () => {
    let writeFrame: ((f: string) => void) | undefined;
    const opened = deferred<void>();
    const srv = sseServer(() =>
      sseResponse((write) => {
        writeFrame = write;
        write(SNAPSHOT_2);
        opened.resolve();
      }),
    );
    const errors: unknown[] = [];
    const upserted = deferred<string>();
    const unsub = makeClient(srv.url).subscribe(
      { tag: "#x" },
      {
        onSnapshot: () => {},
        onUpsert: (n) => upserted.resolve(n.id),
        onRemove: () => {},
        onError: (e) => errors.push(e),
      },
    );
    await within(opened.promise, 3_000, "open");
    writeFrame!(`event: upsert\ndata: {not json\n\n`);
    writeFrame!(`event: upsert\ndata: {"note":{"id":"ok","createdAt":"2026-01-01"}}\n\n`);
    expect(await within(upserted.promise, 3_000, "post-garbage upsert")).toBe("ok");
    expect(errors).toHaveLength(1);
    unsub();
  });
});

describe("VaultClient.subscribe — client-side query validation", () => {
  const client = new VaultClient({ vaultUrl: "http://localhost:9", accessToken: "t" });
  const handlers = { onSnapshot: () => {}, onUpsert: () => {}, onRemove: () => {} };

  test("rejects search", () => {
    expect(() => client.subscribe({ search: "x" }, handlers)).toThrow(/search/);
  });
  test("rejects near", () => {
    expect(() => client.subscribe({ "near[note_id]": "abc" }, handlers)).toThrow(/near/);
  });
  test("rejects cursor", () => {
    expect(() => client.subscribe({ cursor: "abc" }, handlers)).toThrow(/cursor/);
  });
  test("accepts the supported grammar untouched", async () => {
    // No server at :9 — but validation happens synchronously before any
    // connect, so a valid query must NOT throw.
    const unsub = client.subscribe(
      { tag: "#a,#b", "meta[status][eq]": "open", path_prefix: "Work/" },
      { ...handlers, onError: () => {} },
      { initialBackoffMs: 5 },
    );
    unsub();
  });
});
