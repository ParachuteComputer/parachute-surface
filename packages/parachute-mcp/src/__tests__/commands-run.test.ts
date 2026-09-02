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
import { StubHub, type StubTool, freePort } from "./stub-hub.js";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const nsec = nsecEncode(sk);
const skHex = Buffer.from(sk).toString("hex");

const USAGE = "USAGE-PLACEHOLDER\n";

const ECHO: StubTool = {
  name: "echo",
  description: "echoes text\nwith a second line the table must not print",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
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
    expect(cap.stderr()).toContain("timed out after 1s");
    // Nothing listed and something failed → stdout stays silent.
    expect(cap.stdout()).toBe("");
  });

  test("call against a black-hole hub exits 2", async () => {
    const cap = capture(configFor([{ alias: "home", url: blackhole() }]));

    const started = Date.now();
    expect(await runCli(["call", "echo", "--timeout", "1"], cap.io, USAGE)).toBe(EXIT.transport);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cap.stderr()).toContain("timed out after 1s");
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
    expect(cap.stderr()).toContain("timed out after 1s");
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
