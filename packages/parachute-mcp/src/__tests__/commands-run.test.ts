/**
 * Integration: the CLI face (`tools`, `call`, `http`) end to end — real SDK
 * client, real Streamable-HTTP transport, real signing fetch, real key file —
 * against in-process hubs on loopback. Same shape as bridge.test.ts, and the
 * same stubs, which ASSERT a valid NIP-98 header with a fresh event id on
 * EVERY request.
 *
 * Hermetic: loopback only, throwaway keys generated in-test, and `env`/`home`
 * are always overridden so nothing here can read the developer's real
 * ~/.config/parachute/mcp.json or PARACHUTE_NSEC_FILE.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nsecEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  EXIT,
  type Io,
  type SubcommandSplit,
  foldGlobals,
  runCli,
  splitSubcommand,
} from "../commands.js";
import { decodeAuthHeader, sha256Hex, tagValue } from "../nip98.js";
import { StubHub, type StubHubOptions, type StubTool, freePort } from "./stub-hub.js";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const nsec = nsecEncode(sk);
const skHex = Buffer.from(sk).toString("hex");

const USAGE = "USAGE-PLACEHOLDER\n";

/** The first real binding the design names: parachute-dev on the techne relay. */
const CHANNEL_ID = "3ff68a58-3f97-409a-b531-45d388b3c827";

const ECHO: StubTool = {
  name: "echo",
  description: "echoes text\nwith a second line the table must not print",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

const UPDATE_NOTE: StubTool = {
  name: "update-note",
  description: "update a note by id (id accepts an id or a path)",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

const DELETE_NOTE: StubTool = {
  name: "delete-note",
  description: "delete a note by id (id accepts an id or a path)",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function stub(label: string, tools: StubTool[], sessions = false): StubHub {
  const hub = new StubHub({ label, tools, sessions, expectPubkey: pubkey });
  cleanup.push(() => hub.stop());
  return hub;
}

/**
 * A server that ACCEPTS the connection and never answers. This is the failure
 * every subcommand used to hang on forever — worse than an error for an agent,
 * because the shell-out simply never returns.
 */
function blackhole(): string {
  const held: Array<() => void> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: () =>
      new Promise<Response>((resolve) => {
        held.push(() => resolve(new Response(null, { status: 503 })));
      }),
  });
  cleanup.push(() => {
    // Release every held request BEFORE stopping. `server.stop(true)` waits on
    // in-flight handlers, so a handler that never settles hangs the afterEach
    // hook itself — which then poisons every test that runs after it, as a
    // confusing failure somewhere else entirely.
    for (const release of held) release();
    server.stop(true);
  });
  return `http://127.0.0.1:${server.port}/mcp`;
}

/** A temp key file + config file; returns the env/home to inject. */
function configFor(hubs: Array<{ alias: string; url: string }>): {
  env: NodeJS.ProcessEnv;
  home: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-cli-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "agent.nsec");
  writeFileSync(keyFile, `${nsec}\n`, { mode: 0o600 });
  const configPath = join(dir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({ keyFile, hubs }));
  return { env: { PARACHUTE_MCP_CONFIG: configPath }, home: dir };
}

interface Captured {
  io: Io;
  stdout: () => string;
  stderr: () => string;
}

function capture(place: { env: NodeJS.ProcessEnv; home: string }, stdin = ""): Captured {
  const out: Array<string | Uint8Array> = [];
  const err: string[] = [];
  const decoder = new TextDecoder();
  return {
    io: {
      out: (chunk) => out.push(chunk),
      err: (msg) => err.push(msg),
      stdin: async () => stdin,
      env: place.env,
      home: place.home,
    },
    stdout: () => out.map((c) => (typeof c === "string" ? c : decoder.decode(c))).join(""),
    stderr: () => err.join("\n"),
  };
}

/** No auth violations, and every request signed a fresh event. */
function expectCleanAuth(...hubs: StubHub[]): void {
  for (const hub of hubs) {
    expect(hub.authViolations).toEqual([]);
    expect(hub.seenEventIds.size).toBe(hub.authedRequests);
    expect(hub.authedRequests).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------

describe("tools", () => {
  test("single hub → JSON of name + description on stdout, exit 0", async () => {
    const hub = stub("solo", [ECHO]);
    const place = configFor([{ alias: "home", url: hub.url }]);
    const cap = capture(place);

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toEqual([{ name: "echo", description: ECHO.description }]);
    expect(cap.stderr()).toBe("");
    expectCleanAuth(hub);
  });

  test("several hubs and no --hub → the bridge's <alias>__<tool> namespacing", async () => {
    const home = stub("home", [ECHO]);
    const techne = stub("techne", [{ ...ECHO, name: "create-note", description: "makes a note" }]);
    const place = configFor([
      { alias: "home", url: home.url },
      { alias: "techne", url: techne.url },
    ]);
    const cap = capture(place);

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout()).map((t: { name: string }) => t.name)).toEqual([
      "home__echo",
      "techne__create-note",
    ]);
    expectCleanAuth(home, techne);
  });

  test("several hubs omit a namespaced tool that exceeds the MCP name cap", async () => {
    const alias = "a".repeat(64);
    const tooLong = "x".repeat(63);
    const home = stub("home", [{ ...ECHO, name: tooLong }]);
    const techne = stub("techne", []);
    const cap = capture(
      configFor([
        { alias, url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toEqual([]);
    expect(cap.stderr()).toContain("namespaced name exceeds 128 characters");
  });

  test("--hub narrows to one hub and drops the namespace", async () => {
    const home = stub("home", [ECHO]);
    const techne = stub("techne", [{ ...ECHO, name: "create-note" }]);
    const place = configFor([
      { alias: "home", url: home.url },
      { alias: "techne", url: techne.url },
    ]);
    const cap = capture(place);

    expect(await runCli(["tools", "--hub", "techne"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout()).map((t: { name: string }) => t.name)).toEqual(["create-note"]);
    // The hub we did not ask for was never contacted.
    expect(home.authedRequests).toBe(0);
  });

  test("--table prints one line per tool, first description line only", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["tools", "--table"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(cap.stdout()).toBe("echo  echoes text\n");
  });

  test("--hub with an unknown alias is a usage error (exit 1), no hub contacted", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["tools", "--hub", "nope"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).toMatch(/no hub with that alias \(configured: home\)/);
    expect(hub.authedRequests).toBe(0);
  });

  test("a dead hub exits 2 but the live hub's tools are still printed", async () => {
    const live = stub("live", [ECHO]);
    const dead = `http://127.0.0.1:${freePort()}/mcp`;
    const cap = capture(
      configFor([
        { alias: "home", url: live.url },
        { alias: "gone", url: dead },
      ]),
    );

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.transport);
    expect(JSON.parse(cap.stdout()).map((t: { name: string }) => t.name)).toEqual(["home__echo"]);
    expect(cap.stderr()).toContain('hub "gone"');
  });

  test("a session-issuing hub gets its session DELETEd on the way out", async () => {
    const hub = stub("sessions", [ECHO], true);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(hub.issuedSessions).toHaveLength(1);
    expect(hub.methods).toContain("DELETE");
    expectCleanAuth(hub);
  });
});

describe("call", () => {
  test("a JSON literal positional reaches the hub; text result prints as-is", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["call", "echo", '{"text":"hi"}'], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toEqual({
      hub: "solo",
      tool: "echo",
      args: { text: "hi" },
    });
    expect(cap.stdout().endsWith("\n")).toBe(true);
    expect(hub.toolCalls).toEqual([{ tool: "echo", args: { text: "hi" } }]);
    expectCleanAuth(hub);
  });

  test("--args - reads the JSON from stdin (the shell-quoting escape hatch)", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(
      configFor([{ alias: "home", url: hub.url }]),
      '{"text":"quotes \\" and $dollars and `ticks`"}\n',
    );

    expect(await runCli(["call", "echo", "--args", "-"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(hub.toolCalls).toEqual([
      { tool: "echo", args: { text: 'quotes " and $dollars and `ticks`' } },
    ]);
  });

  test("no arguments at all sends {}", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["call", "echo"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(hub.toolCalls).toEqual([{ tool: "echo", args: {} }]);
  });

  test("an isError result exits 4, with the message on stderr and stdout empty", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    // The stub answers an unknown tool the way the hub does: isError, not a
    // JSON-RPC error.
    expect(await runCli(["call", "nosuch"], cap.io, USAGE)).toBe(EXIT.toolError);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("Unknown tool: nosuch");
  });

  test("several hubs → the namespaced name routes by prefix", async () => {
    const home = stub("home", [ECHO]);
    const techne = stub("techne", [ECHO]);
    const cap = capture(
      configFor([
        { alias: "home", url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["call", "techne__echo", '{"text":"x"}'], cap.io, USAGE)).toBe(EXIT.ok);
    expect(techne.toolCalls).toEqual([{ tool: "echo", args: { text: "x" } }]);
    expect(home.toolCalls).toEqual([]);
  });

  test("several hubs and a bare name is a usage error naming the aliases", async () => {
    const home = stub("home", [ECHO]);
    const techne = stub("techne", [ECHO]);
    const cap = capture(
      configFor([
        { alias: "home", url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["call", "echo"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).toMatch(/aliases: home, techne/);
  });

  test("--hub accepts the namespaced name too, so tools output can be pasted", async () => {
    const home = stub("home", [ECHO]);
    const techne = stub("techne", [ECHO]);
    const cap = capture(
      configFor([
        { alias: "home", url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["call", "home__echo", "--hub", "home"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(home.toolCalls).toEqual([{ tool: "echo", args: {} }]);
  });

  test("malformed JSON exits 1 with a CONTENT-FREE message (stdin may be a key)", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]), `${nsec}\n`);

    expect(await runCli(["call", "echo", "--args", "-"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).toContain("stdin is not valid JSON");
    expect(cap.stderr()).not.toContain(nsec);
    expect(hub.authedRequests).toBe(0);
  });

  test("JSON that is not an object is rejected before any request", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["call", "echo", "[1,2]"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).toContain("must be a JSON object");
    expect(hub.authedRequests).toBe(0);
  });

  // surface#236: `call update-note` with `path` and no `id` reached the hub
  // with `id` unset. The vault's `id` param is documented id-OR-path, and the
  // channel-context convention already sends `id: <path>` (channel.ts
  // `appendEntry`) — a caller reaching for the more obvious `path` key should
  // get the same resolution, not a hub-side crash dressed up as a tool error.
  test("update-note with `path` and no `id` resolves the note (surface#236)", async () => {
    const hub = new StubHub({
      label: "solo",
      tools: [UPDATE_NOTE],
      expectPubkey: pubkey,
      handleCall: (tool, args) => {
        if (tool !== "update-note") return undefined;
        // Mirrors the real hub: an `id` (or a path resolved into one)
        // succeeds; an unresolvable/absent id falls back to its unstructured
        // `Error: ...` isError text (vault core/src/mcp.ts `resolveNote`).
        if (typeof args.id === "string") {
          return {
            content: [{ type: "text", text: JSON.stringify({ id: args.id, updated: true }) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Error: undefined is not an object (evaluating 'idOrPath.match')",
            },
          ],
          isError: true,
        };
      },
    });
    cleanup.push(() => hub.stop());
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    const code = await runCli(
      ["call", "update-note", '{"vault":"v","path":"Channels/x","append":"\\n- test"}'],
      cap.io,
      USAGE,
    );

    expect(code).toBe(EXIT.ok);
    expect(cap.stderr()).toBe("");
    expect(JSON.parse(cap.stdout())).toEqual({ id: "Channels/x", updated: true });
    // `path` was translated to `id`, not merely echoed alongside it — the
    // hub never sees a call it would have to fall back on.
    expect(hub.toolCalls).toEqual([
      { tool: "update-note", args: { vault: "v", id: "Channels/x", append: "\n- test" } },
    ]);
  });

  // The other half of surface#236: whatever shape a tool failure takes out of
  // `tools/call` (an `isError` result OR the hub throwing, which the real MCP
  // SDK turns into a JSON-RPC error — see stub-hub.ts's `tools/call` catch),
  // the CLI must resolve to a real, non-zero exit code, and the SAME one
  // `doctor`/`channel-context` use for "the tool failed" (4), not the generic
  // transport default (2) a bare rethrow used to fall into.
  test("a JSON-RPC error out of tools/call exits non-zero as a tool error, not transport (surface#236)", async () => {
    const hub = new StubHub({
      label: "solo",
      tools: [UPDATE_NOTE],
      expectPubkey: pubkey,
      handleCall: (tool, args) => {
        if (tool === "update-note" && args.id === undefined) {
          const idOrPath = args.id as string | undefined;
          // @ts-expect-error — reproduces the exact vault-side TypeError
          // (core/src/mcp.ts `resolveNote`) an older/unpatched hub can still
          // throw instead of answering with `isError`.
          idOrPath.match(/^(.*)\.([a-z0-9]{1,16})$/i);
        }
        return undefined;
      },
    });
    cleanup.push(() => hub.stop());
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    const code = await runCli(["call", "update-note", '{"vault":"v"}'], cap.io, USAGE);

    expect(code).toBe(EXIT.toolError);
    expect(code).not.toBe(EXIT.ok);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("undefined is not an object");
    expect(cap.stderr()).toContain(".match");
  });

  // delete-note shares update-note's id-or-path contract byte-for-byte
  // (vault `core/src/mcp-manifest.ts:479`, `core/src/mcp.ts:2194-2199`'s
  // `requireNote(db, params.id)`, and `core/src/core.test.ts:4520` "delete-
  // note accepts path") and, unlike update-note, has no second meaning for
  // `path` — so the same `path` -> `id` mapping applies unconditionally
  // whenever `id` is absent.
  test("delete-note with `path` and no `id` resolves the note (surface#236)", async () => {
    const hub = new StubHub({
      label: "solo",
      tools: [DELETE_NOTE],
      expectPubkey: pubkey,
      handleCall: (tool, args) => {
        if (tool !== "delete-note") return undefined;
        if (typeof args.id === "string") {
          return {
            content: [{ type: "text", text: JSON.stringify({ deleted: true, id: args.id }) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: "Error: undefined is not an object (evaluating 'idOrPath.match')",
            },
          ],
          isError: true,
        };
      },
    });
    cleanup.push(() => hub.stop());
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    const code = await runCli(
      ["call", "delete-note", '{"vault":"v","path":"Channels/x"}'],
      cap.io,
      USAGE,
    );

    expect(code).toBe(EXIT.ok);
    expect(cap.stderr()).toBe("");
    expect(JSON.parse(cap.stdout())).toEqual({ deleted: true, id: "Channels/x" });
    expect(hub.toolCalls).toEqual([
      { tool: "delete-note", args: { vault: "v", id: "Channels/x" } },
    ]);
  });

  // Nit from review: a caller passing BOTH `id` and `path` to update-note
  // means "update this note AND move it to `path`" (vault
  // `core/src/mcp.ts:1960-1963`) — resolveIdOrPath must not clobber that
  // rename intent just because `path` also happens to look like a lookup
  // key.
  test("update-note with BOTH `id` and `path` leaves `path` untouched (rename stays a rename) (surface#236)", async () => {
    const hub = new StubHub({
      label: "solo",
      tools: [UPDATE_NOTE],
      expectPubkey: pubkey,
      handleCall: (tool, args) => {
        if (tool !== "update-note") return undefined;
        return {
          content: [
            { type: "text", text: JSON.stringify({ id: args.id, path: args.path, updated: true }) },
          ],
        };
      },
    });
    cleanup.push(() => hub.stop());
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    const code = await runCli(
      ["call", "update-note", '{"vault":"v","id":"note-123","path":"Renamed/Note"}'],
      cap.io,
      USAGE,
    );

    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toEqual({
      id: "note-123",
      path: "Renamed/Note",
      updated: true,
    });
    expect(hub.toolCalls).toEqual([
      { tool: "update-note", args: { vault: "v", id: "note-123", path: "Renamed/Note" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// http — a signed curl.
// ---------------------------------------------------------------------------

interface EchoServer {
  url: string;
  /** What the last request's NIP-98 event and body looked like. */
  seen: Array<{
    method: string;
    url: string;
    signed: boolean;
    tags: string[][];
    body: string;
    bodySha: string | null;
    custom: string | null;
  }>;
}

function echoServer(opts: { status?: number; body?: string } = {}): EchoServer {
  const seen: EchoServer["seen"] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const bytes = new Uint8Array(await req.arrayBuffer());
      let tags: string[][] = [];
      let signed = false;
      try {
        const event = decodeAuthHeader(req.headers.get("authorization") ?? "");
        tags = event.tags;
        signed = verifyEvent(event);
      } catch {
        /* recorded as unsigned */
      }
      seen.push({
        method: req.method,
        url: req.url,
        signed,
        tags,
        body: new TextDecoder().decode(bytes),
        bodySha: bytes.byteLength > 0 ? sha256Hex(bytes) : null,
        custom: req.headers.get("x-custom"),
      });
      return new Response(opts.body ?? '{"ok":true}', {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json", "x-served-by": "echo" },
      });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/api/notes`, seen };
}

/** `http` resolves its key through the quick path, so only a key is needed. */
function keyOnlyPlace(): { env: NodeJS.ProcessEnv; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-cli-key-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "agent.nsec");
  writeFileSync(keyFile, `${nsec}\n`, { mode: 0o600 });
  return { env: { PARACHUTE_NSEC_FILE: keyFile }, home: dir };
}

describe("http", () => {
  test("GET: signed, body to stdout, status + headers to stderr, exit 0", async () => {
    const server = echoServer();
    const cap = capture(keyOnlyPlace());

    expect(await runCli(["http", "GET", server.url], cap.io, USAGE)).toBe(EXIT.ok);
    expect(cap.stdout()).toBe('{"ok":true}');
    expect(cap.stderr()).toContain("< 200 OK");
    expect(cap.stderr()).toContain("< x-served-by: echo");

    const req = server.seen[0]!;
    expect(req.signed).toBe(true);
    expect(req.method).toBe("GET");
    expect(tagValue({ tags: req.tags } as never, "u")).toBe(server.url);
    expect(tagValue({ tags: req.tags } as never, "method")).toBe("GET");
    expect(tagValue({ tags: req.tags } as never, "nonce")).toBeTruthy();
  });

  test("payload tag is PRESENT and correct when the body is non-empty", async () => {
    const server = echoServer();
    const body = '{"title":"a note"}';
    const cap = capture(keyOnlyPlace(), body);

    expect(await runCli(["http", "POST", server.url, "--body", "-"], cap.io, USAGE)).toBe(EXIT.ok);
    const req = server.seen[0]!;
    expect(req.body).toBe(body);
    expect(tagValue({ tags: req.tags } as never, "payload")).toBe(req.bodySha);
    expect(req.bodySha).toBe(sha256Hex(new TextEncoder().encode(body)));
  });

  test("payload tag is ABSENT when --body - reads an empty stdin", async () => {
    const server = echoServer();
    const cap = capture(keyOnlyPlace(), "");

    expect(await runCli(["http", "POST", server.url, "--body", "-"], cap.io, USAGE)).toBe(EXIT.ok);
    const req = server.seen[0]!;
    expect(req.body).toBe("");
    expect(req.tags.some((t) => t[0] === "payload")).toBe(false);
  });

  test("-H headers are forwarded alongside the signature", async () => {
    const server = echoServer();
    const cap = capture(keyOnlyPlace());

    expect(await runCli(["http", "GET", server.url, "-H", "X-Custom: yes"], cap.io, USAGE)).toBe(
      EXIT.ok,
    );
    expect(server.seen[0]!.custom).toBe("yes");
    expect(server.seen[0]!.signed).toBe(true);
  });

  test("401 exits 3 and nothing key-shaped reaches stderr or stdout", async () => {
    const server = echoServer({ status: 401, body: "revocation list unavailable" });
    const cap = capture(keyOnlyPlace());

    expect(await runCli(["http", "GET", server.url], cap.io, USAGE)).toBe(EXIT.auth);
    for (const stream of [cap.stderr(), cap.stdout()]) {
      expect(stream).not.toContain(nsec);
      expect(stream).not.toContain(skHex);
      expect(stream).not.toContain("nsec1");
    }
    expect(cap.stderr()).toContain("< 401");
    expect(cap.stdout()).toBe("revocation list unavailable");
  });

  test("403 also exits 3; a 500 exits 2; a 2xx exits 0", async () => {
    for (const [status, code] of [
      [403, EXIT.auth],
      [500, EXIT.transport],
      [404, EXIT.transport],
      [204, EXIT.ok],
    ] as const) {
      const server = echoServer({ status, body: "" });
      const cap = capture(keyOnlyPlace());
      expect(await runCli(["http", "GET", server.url], cap.io, USAGE)).toBe(code);
    }
  });

  test("an unreachable host exits 2 without a stack trace on stdout", async () => {
    const cap = capture(keyOnlyPlace());
    const url = `http://127.0.0.1:${freePort()}/api`;

    expect(await runCli(["http", "GET", url], cap.io, USAGE)).toBe(EXIT.transport);
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain("http: GET");
  });

  test("no key anywhere is a config error (exit 1), not a transport one", async () => {
    const server = echoServer();
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-cli-nokey-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cap = capture({ env: {}, home: dir });

    expect(await runCli(["http", "GET", server.url], cap.io, USAGE)).toBe(EXIT.usage);
    expect(server.seen).toHaveLength(0);
  });

  test("a malformed key file never echoes its contents", async () => {
    const server = echoServer();
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-cli-badkey-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = join(dir, "agent.nsec");
    // A plausible near-miss: a real-looking nsec with one character wrong.
    const broken = `${nsec.slice(0, -1)}${nsec.endsWith("q") ? "p" : "q"}`;
    writeFileSync(keyFile, `${broken}\n`, { mode: 0o600 });
    const cap = capture({ env: { PARACHUTE_NSEC_FILE: keyFile }, home: dir });

    expect(await runCli(["http", "GET", server.url], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).not.toContain(broken.slice(5));
    expect(cap.stderr()).toContain("secret key bech32 does not decode");
    expect(server.seen).toHaveLength(0);
  });
});

describe("help", () => {
  test("`<subcommand> --help` prints USAGE to stdout and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-cli-help-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cap = capture({ env: {}, home: dir });

    expect(await runCli(["call", "--help"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(cap.stdout()).toBe(USAGE);
  });
});

describe("timeouts (--timeout)", () => {
  // A hub that accepts and never answers. Each of these used to hang forever.
  test("tools against a black-hole hub exits 2 with a content-free timeout", async () => {
    const cap = capture(configFor([{ alias: "home", url: blackhole() }]));

    const started = Date.now();
    expect(await runCli(["tools", "--timeout", "1"], cap.io, USAGE)).toBe(EXIT.transport);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cap.stderr()).toContain("timed out after 1.0s");
    // Nothing listed and something failed → stdout stays silent.
    expect(cap.stdout()).toBe("");
  });

  test("call against a black-hole hub exits 2", async () => {
    const cap = capture(configFor([{ alias: "home", url: blackhole() }]));

    const started = Date.now();
    expect(await runCli(["call", "echo", "--timeout", "1"], cap.io, USAGE)).toBe(EXIT.transport);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cap.stderr()).toContain("timed out after 1.0s");
    expect(cap.stdout()).toBe("");
  });

  test("http against a black-hole server exits 2", async () => {
    const url = blackhole();
    const cap = capture(keyOnlyPlace());

    const started = Date.now();
    expect(await runCli(["http", "GET", url, "--timeout", "1"], cap.io, USAGE)).toBe(
      EXIT.transport,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cap.stderr()).toContain("timed out after 1.0s");
    expect(cap.stdout()).toBe("");
  });

  test("a timeout message names no URL, arguments or key material", async () => {
    const cap = capture(configFor([{ alias: "home", url: blackhole() }]), `{"secret":"${nsec}"}`);

    expect(await runCli(["call", "echo", "--args", "-", "--timeout", "1"], cap.io, USAGE)).toBe(
      EXIT.transport,
    );
    expect(cap.stderr()).not.toContain(nsec);
    expect(cap.stderr()).not.toContain("nsec1");
    expect(cap.stderr()).not.toContain(skHex);
  });

  test("a healthy hub is unaffected by a generous timeout", async () => {
    const hub = stub("solo", [ECHO]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["tools", "--timeout", "30"], cap.io, USAGE)).toBe(EXIT.ok);
    expectCleanAuth(hub);
  });
});

describe("flags before the subcommand (end to end)", () => {
  test("REGRESSION: --config <path> tools lists tools instead of booting the bridge", async () => {
    const hub = stub("solo", [ECHO]);
    const place = configFor([{ alias: "home", url: hub.url }]);
    const configPath = place.env.PARACHUTE_MCP_CONFIG as string;
    // No PARACHUTE_MCP_CONFIG in the env: the flag is the only way in, so this
    // fails unless the pre-subcommand flag is really honoured.
    const cap = capture({ env: {}, home: place.home });

    const argv = foldGlobals(splitSubcommand(["--config", configPath, "tools"]) as SubcommandSplit);
    expect(await runCli(argv, cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toHaveLength(1);
  });

  test("REGRESSION: --config <path> call <tool> reaches the hub", async () => {
    const hub = stub("solo", [ECHO]);
    const place = configFor([{ alias: "home", url: hub.url }]);
    const configPath = place.env.PARACHUTE_MCP_CONFIG as string;
    const cap = capture({ env: {}, home: place.home });

    const argv = foldGlobals(
      splitSubcommand(["--config", configPath, "call", "echo", '{"text":"hi"}']) as SubcommandSplit,
    );
    expect(await runCli(argv, cap.io, USAGE)).toBe(EXIT.ok);
    expect(hub.toolCalls).toEqual([{ tool: "echo", args: { text: "hi" } }]);
  });
});

describe("tools: an empty list is never faked", () => {
  test("every hub failing prints NOTHING on stdout (not `[]`) and exits non-zero", async () => {
    const dead = `http://127.0.0.1:${freePort()}/mcp`;
    const cap = capture(configFor([{ alias: "gone", url: dead }]));

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.transport);
    // `[]` here would read to a JSON-consuming agent as "this hub has no
    // tools" rather than "the hub is unreachable".
    expect(cap.stdout()).toBe("");
    expect(cap.stderr()).toContain('hub "gone"');
  });

  test("a genuinely empty hub still prints [] and exits 0", async () => {
    const hub = stub("empty", []);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["tools"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(JSON.parse(cap.stdout())).toEqual([]);
  });
});

describe("http: redirects", () => {
  test("a 3xx is NOT followed and exits 2 rather than 0-with-an-empty-body", async () => {
    const target = "https://elsewhere.example.test/moved";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: target } }),
    });
    cleanup.push(() => server.stop(true));
    const cap = capture(keyOnlyPlace());

    expect(
      await runCli(["http", "GET", `http://127.0.0.1:${server.port}/old`], cap.io, USAGE),
    ).toBe(EXIT.transport);
    // Reported as-is, like curl without -L, so the caller can see where to go.
    expect(cap.stderr()).toContain("< 302");
    expect(cap.stderr()).toContain(`< location: ${target}`);
  });
});

// ---------------------------------------------------------------------------

/**
 * `doctor` end to end: real SDK client, real Streamable-HTTP transport, real
 * signing fetch, real key file, against an in-process hub that really stores
 * the probe note. doctor.test.ts covers the step machine's branches against a
 * fake; this covers the wiring — that the steps run over the SAME signed
 * session the other subcommands use, and that every request is NIP-98 clean.
 */
describe("doctor", () => {
  const VAULT_TOOLS: StubTool[] = [
    { name: "list-vaults", description: "list vaults", inputSchema: { type: "object" } },
    { name: "create-note", description: "make a note", inputSchema: { type: "object" } },
    { name: "query-notes", description: "read notes", inputSchema: { type: "object" } },
    { name: "delete-note", description: "remove a note", inputSchema: { type: "object" } },
  ];

  /** A hub with one vault that really holds what `create-note` writes. */
  function vaultHub(
    label: string,
    vaults: string[],
    channelVault?: StubHubOptions["channelVault"],
  ): StubHub {
    const notes = new Map<string, string>();
    const hub = new StubHub({
      label,
      tools: VAULT_TOOLS,
      expectPubkey: pubkey,
      ...(channelVault ? { channelVault } : {}),
      handleCall: (tool, args) => {
        const json = (value: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(value) }],
        });
        switch (tool) {
          case "list-vaults":
            return json({ covered: "listed", vaults: vaults.map((name) => ({ name })) });
          case "create-note":
            notes.set(String(args.path), String(args.content));
            return json({ id: args.path });
          case "query-notes": {
            const content = notes.get(String(args.id));
            return json({
              vaults_queried: [args.vault],
              results: [{ vault: args.vault, notes: content === undefined ? [] : { content } }],
            });
          }
          case "delete-note":
            notes.delete(String(args.id));
            return json({ deleted: true });
          default:
            return undefined;
        }
      },
    });
    cleanup.push(() => hub.stop());
    return hub;
  }

  test("one vault → the four access checks pass, exit 0, and the probe is cleaned up", async () => {
    const hub = vaultHub("solo", ["uni"]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["doctor"], cap.io, USAGE)).toBe(EXIT.ok);
    const out = cap.stdout();
    expect(out).toContain("PASS  key");
    expect(out).toContain("PASS  hub");
    expect(out).toContain("PASS  vaults");
    expect(out).toContain("PASS  write");
    // The channel step skips: no relay or channel id in this environment. It
    // is a SKIP, so the run is still a pass and the exit code is still 0.
    expect(out).toContain("SKIP  channel");
    expect(out).toContain("4/5 checks passed, 1 skipped");

    const called = hub.toolCalls.map((c) => c.tool);
    expect(called).toEqual(["list-vaults", "create-note", "query-notes", "delete-note"]);
    for (const call of hub.toolCalls.slice(1)) {
      expect(String(call.args.path ?? call.args.id)).toStartWith(".doctor/");
    }
    expectCleanAuth(hub);
  });

  test("a bound channel PASSES the channel step over the real signed REST call", async () => {
    const hub = vaultHub("solo", ["uni"], (relay, channel) =>
      relay === "buzz.techne.coop" && channel === CHANNEL_ID
        ? { vault: "parachute", mode: "sync", synced_at: "2026-09-03T12:00:00.000Z" }
        : null,
    );
    const place = configFor([{ alias: "home", url: hub.url }]);
    place.env.BUZZ_RELAY_URL = "wss://Buzz.Techne.Coop/";
    place.env.BUZZ_GIT_ORIGIN_CHANNEL_ID = CHANNEL_ID;
    const cap = capture(place);

    expect(await runCli(["doctor"], cap.io, USAGE)).toBe(EXIT.ok);
    const out = cap.stdout();
    expect(out).toContain("PASS  channel");
    expect(out).toContain('vault "parachute"');
    expect(out).toContain("5/5 checks passed");
    // The relay reached the hub lower-cased and scheme-free, which is what
    // keeps one channel to one binding on both sides.
    expect(hub.channelVaultQueries).toEqual([{ relay: "buzz.techne.coop", channel: CHANNEL_ID }]);
    // The REST call is NIP-98-signed on the same terms as every MCP request.
    expectCleanAuth(hub);
  });

  test("an unbound channel SKIPS, and exit 0 is unchanged", async () => {
    const hub = vaultHub("solo", ["uni"], () => null);
    const place = configFor([{ alias: "home", url: hub.url }]);
    place.env.BUZZ_RELAY_URL = "wss://buzz.techne.coop";
    place.env.BUZZ_CHANNEL_ID = CHANNEL_ID;
    const cap = capture(place);

    expect(await runCli(["doctor"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(cap.stdout()).toContain("SKIP  channel");
    expect(cap.stdout()).toContain("parachute vault attach-channel");
    expectCleanAuth(hub);
  });

  test("a hub with no such route SKIPS as too-old, not as unbound", async () => {
    // No `channelVault` handler: the stub falls through to the plain-text 404
    // parachute-hub's dispatch gives an unknown path.
    const hub = vaultHub("solo", ["uni"]);
    const place = configFor([{ alias: "home", url: hub.url }]);
    const cap = capture(place);

    expect(
      await runCli(
        ["doctor", "--relay", "wss://buzz.techne.coop", "--channel", CHANNEL_ID],
        cap.io,
        USAGE,
      ),
    ).toBe(EXIT.ok);
    const out = cap.stdout();
    expect(out).toContain("SKIP  channel");
    expect(out).toContain("does not serve /api/channel-vault yet");
    expect(out).not.toContain("attach-channel");
    expectCleanAuth(hub);
  });

  test("the report prints the npub and never any key material", async () => {
    const hub = vaultHub("solo", ["uni"]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    await runCli(["doctor"], cap.io, USAGE);
    const out = cap.stdout();
    expect(out).toContain("npub1");
    expect(out).not.toContain(nsec);
    expect(out).not.toContain(skHex);
    expect(cap.stderr()).toBe("");
  });

  test("--json emits one object with per-step results", async () => {
    const hub = vaultHub("solo", ["uni"]);
    const cap = capture(configFor([{ alias: "home", url: hub.url }]));

    expect(await runCli(["doctor", "--json"], cap.io, USAGE)).toBe(EXIT.ok);
    const report = JSON.parse(cap.stdout());
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.steps.map((s: { step: string }) => s.step)).toEqual([
      "key",
      "hub",
      "vaults",
      "write",
      "channel",
    ]);
    expect(
      report.steps
        .filter((s: { step: string }) => s.step !== "channel")
        .every((s: { status: string }) => s.status === "pass"),
    ).toBe(true);
    expect(report.steps.at(-1)).toMatchObject({ step: "channel", status: "skip" });
    expect(report.npub).toStartWith("npub1");
    expect(report.hub).toEqual({ alias: "home", url: hub.url });
  });

  test("several hubs and no --hub is a usage error naming the aliases, exit 1", async () => {
    const home = vaultHub("home", ["uni"]);
    const techne = vaultHub("techne", ["team"]);
    const cap = capture(
      configFor([
        { alias: "home", url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["doctor"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stdout()).toContain("FAIL  hub");
    expect(cap.stdout()).toContain("home, techne");
    // Neither hub was contacted: the ambiguity is resolvable before any I/O.
    expect(home.authedRequests).toBe(0);
    expect(techne.authedRequests).toBe(0);
  });

  test("--hub picks one of several, and --vault picks the vault", async () => {
    const home = vaultHub("home", ["uni", "team"]);
    const techne = vaultHub("techne", ["team"]);
    const cap = capture(
      configFor([
        { alias: "home", url: home.url },
        { alias: "techne", url: techne.url },
      ]),
    );

    expect(await runCli(["doctor", "--hub", "home", "--vault", "team"], cap.io, USAGE)).toBe(
      EXIT.ok,
    );
    expect(home.toolCalls.find((c) => c.tool === "create-note")?.args.vault).toBe("team");
    expect(techne.authedRequests).toBe(0);
  });

  test("no key at all fails at the key step with the resolution order, exit 1", async () => {
    const hub = vaultHub("solo", ["uni"]);
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-doctor-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cap = capture({ env: {}, home: dir });

    expect(await runCli(["doctor", "--hub", hub.url], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stdout()).toContain("FAIL  key");
    expect(cap.stdout()).toContain("PARACHUTE_NSEC_FILE");
    expect(cap.stdout()).toContain("BUZZ_PRIVATE_KEY");
    expect(hub.authedRequests).toBe(0);
  });

  test("an unreachable hub fails at the hub step, exit 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-doctor-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = join(dir, "agent.nsec");
    writeFileSync(keyFile, `${nsec}\n`, { mode: 0o600 });
    const cap = capture({ env: { PARACHUTE_NSEC_FILE: keyFile }, home: dir });

    const dead = `http://127.0.0.1:${freePort()}/mcp`;
    expect(await runCli(["doctor", "--hub", dead], cap.io, USAGE)).toBe(EXIT.transport);
    expect(cap.stdout()).toContain("PASS  key");
    expect(cap.stdout()).toContain("FAIL  hub");
  });

  test("a hub that never answers times out at the hub step rather than hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-doctor-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keyFile = join(dir, "agent.nsec");
    writeFileSync(keyFile, `${nsec}\n`, { mode: 0o600 });
    const cap = capture({ env: { PARACHUTE_NSEC_FILE: keyFile }, home: dir });

    const code = await runCli(["doctor", "--hub", blackhole(), "--timeout", "0.3"], cap.io, USAGE);
    expect(code).toBe(EXIT.transport);
    expect(cap.stdout()).toContain("timed out after");
  });

  test("BUZZ_PRIVATE_KEY alone is enough — the zero-config Buzz path", async () => {
    const hub = vaultHub("solo", ["uni"]);
    const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-doctor-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const cap = capture({ env: { BUZZ_PRIVATE_KEY: nsec }, home: dir });

    expect(await runCli(["doctor", "--hub", hub.url], cap.io, USAGE)).toBe(EXIT.ok);
    expect(cap.stdout()).toContain("BUZZ_PRIVATE_KEY (injected nsec value)");
    expect(cap.stdout()).not.toContain(nsec);
    expectCleanAuth(hub);
  });
});

describe("channel-context: resolving the vault from the hub", () => {
  const VAULT_TOOLS: StubTool[] = [
    "list-vaults",
    "create-note",
    "query-notes",
    "delete-note",
    "update-note",
  ].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

  function hubWithBinding(binding: { vault: string } | null): StubHub {
    const hub = new StubHub({
      label: "solo",
      tools: VAULT_TOOLS,
      expectPubkey: pubkey,
      channelVault: () => binding,
    });
    cleanup.push(() => hub.stop());
    return hub;
  }

  test("append with no --vault asks the hub and writes to the vault it names", async () => {
    const hub = hubWithBinding({ vault: "parachute" });
    const place = configFor([{ alias: "home", url: hub.url }]);
    place.env.BUZZ_RELAY_URL = "wss://buzz.techne.coop";
    place.env.BUZZ_CHANNEL_ID = CHANNEL_ID;
    const cap = capture(place, "an entry");

    expect(await runCli(["channel-context", "append"], cap.io, USAGE)).toBe(EXIT.ok);
    expect(hub.channelVaultQueries).toEqual([{ relay: "buzz.techne.coop", channel: CHANNEL_ID }]);
    const update = hub.toolCalls.find((c) => c.tool === "update-note");
    expect(update?.args.vault).toBe("parachute");
    expect(update?.args.id).toBe(`Channels/buzz.techne.coop/${CHANNEL_ID}`);
    expectCleanAuth(hub);
  });

  test("an explicit --vault wins and the hub is never asked", async () => {
    const hub = hubWithBinding({ vault: "parachute" });
    const place = configFor([{ alias: "home", url: hub.url }]);
    place.env.BUZZ_RELAY_URL = "wss://buzz.techne.coop";
    place.env.BUZZ_CHANNEL_ID = CHANNEL_ID;
    const cap = capture(place, "an entry");

    expect(await runCli(["channel-context", "append", "--vault", "uni"], cap.io, USAGE)).toBe(
      EXIT.ok,
    );
    expect(hub.channelVaultQueries).toEqual([]);
    expect(hub.toolCalls.find((c) => c.tool === "update-note")?.args.vault).toBe("uni");
  });

  test("an unbound channel exits 1 with the attach command, and writes nothing", async () => {
    const hub = hubWithBinding(null);
    const place = configFor([{ alias: "home", url: hub.url }]);
    place.env.BUZZ_RELAY_URL = "wss://buzz.techne.coop";
    place.env.BUZZ_CHANNEL_ID = CHANNEL_ID;
    const cap = capture(place, "an entry");

    expect(await runCli(["channel-context", "append"], cap.io, USAGE)).toBe(EXIT.usage);
    expect(cap.stderr()).toContain("parachute vault attach-channel");
    expect(cap.stderr()).toContain("--vault");
    expect(hub.toolCalls).toEqual([]);
  });
});
