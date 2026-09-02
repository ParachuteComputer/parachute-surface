/**
 * Integration: the real bridge (real SDK client, real StreamableHTTP
 * transport, real signing fetch) against in-process stub hubs on loopback.
 * The stubs ASSERT a valid NIP-98 header with a fresh event id on EVERY
 * request — the same replay semantics as the production hub door.
 *
 * Hermetic: loopback only, throwaway keys generated in-test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { ParachuteBridge } from "../bridge.js";
import { makeSigningFetch } from "../signing-fetch.js";
import { StubHub, type StubHubOptions, freePort } from "./stub-hub.js";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "what to echo" } },
  required: ["text"],
};

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function stub(opts: StubHubOptions): StubHub {
  const hub = new StubHub({ expectPubkey: pubkey, ...opts });
  cleanup.push(() => hub.stop());
  return hub;
}

function bridgeFor(hubs: Array<{ alias: string; url: string }>): ParachuteBridge {
  const bridge = new ParachuteBridge(hubs, makeSigningFetch(sk));
  cleanup.push(() => bridge.close());
  return bridge;
}

function expectCleanAuth(...hubs: StubHub[]): void {
  for (const hub of hubs) {
    expect(hub.authViolations).toEqual([]);
    // Every authed request carried its own freshly-signed event.
    expect(hub.seenEventIds.size).toBe(hub.authedRequests);
    expect(hub.authedRequests).toBeGreaterThan(0);
  }
}

describe("single hub", () => {
  test("passes tool names, descriptions and schemas through unchanged", async () => {
    const hub = stub({
      label: "solo",
      tools: [{ name: "echo", description: "echoes text", inputSchema: ECHO_SCHEMA }],
    });
    const bridge = bridgeFor([{ alias: "home", url: hub.url }]);
    const report = await bridge.start();
    expect(report).toEqual({ connected: ["home"], failed: [] });

    const tools = await bridge.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo"); // NOT home__echo
    expect(tools[0]!.description).toBe("echoes text");
    expect(tools[0]!.inputSchema).toEqual(ECHO_SCHEMA);

    const result = await bridge.callTool("echo", { text: "hi" });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({ hub: "solo", tool: "echo", args: { text: "hi" } });
    expect(hub.toolCalls).toEqual([{ tool: "echo", args: { text: "hi" } }]);
    expectCleanAuth(hub);
  });
});

describe("two hubs", () => {
  test("namespaces as <alias>__<tool> and routes calls by prefix", async () => {
    const home = stub({
      label: "home",
      tools: [
        { name: "echo", description: "home echo", inputSchema: ECHO_SCHEMA },
        { name: "query-notes", description: "home notes", inputSchema: { type: "object" } },
      ],
    });
    const techne = stub({
      label: "techne",
      tools: [{ name: "echo", description: "techne echo", inputSchema: ECHO_SCHEMA }],
    });
    const bridge = bridgeFor([
      { alias: "home", url: home.url },
      { alias: "techne", url: techne.url },
    ]);
    const report = await bridge.start();
    expect(report.connected.toSorted()).toEqual(["home", "techne"]);

    const tools = await bridge.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      "home__echo",
      "home__query-notes",
      "techne__echo",
    ]);
    // Namespaced names stay valid MCP tool names (SEP-986).
    for (const t of tools) expect(t.name).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    // Descriptions/schemas ride through verbatim.
    expect(tools.find((t) => t.name === "techne__echo")!.description).toBe("techne echo");
    expect(tools.find((t) => t.name === "home__echo")!.inputSchema).toEqual(ECHO_SCHEMA);

    const result = await bridge.callTool("techne__echo", { text: "route me" });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).hub).toBe("techne");
    expect(techne.toolCalls).toEqual([{ tool: "echo", args: { text: "route me" } }]);
    expect(home.toolCalls).toEqual([]); // never touched

    await bridge.callTool("home__query-notes", {});
    expect(home.toolCalls).toEqual([{ tool: "query-notes", args: {} }]);

    expect(bridge.callTool("nowhere__echo", {})).rejects.toThrow(/unknown tool "nowhere__echo"/);
    expectCleanAuth(home, techne);
  });
});

describe("resilience", () => {
  test("a hub that is down at startup does not kill the bridge, and is retried lazily", async () => {
    const live = stub({
      label: "live",
      tools: [{ name: "echo", description: "live echo", inputSchema: ECHO_SCHEMA }],
    });
    const deadPort = freePort();
    const bridge = bridgeFor([
      { alias: "live", url: live.url },
      { alias: "flaky", url: `http://127.0.0.1:${deadPort}/mcp` },
    ]);

    const report = await bridge.start();
    expect(report.connected).toEqual(["live"]);
    expect(report.failed).toEqual(["flaky"]);

    // The live hub's tools are exposed (namespaced — two hubs configured)...
    let tools = await bridge.listTools();
    expect(tools.map((t) => t.name)).toEqual(["live__echo"]);
    // ...and calling the dead hub is an error, not a crash.
    expect(bridge.callTool("flaky__echo", {})).rejects.toThrow();

    // The hub comes up on the same port → the next list finds it, no restart.
    const revived = stub({
      label: "flaky",
      port: deadPort,
      tools: [{ name: "echo", description: "revived echo", inputSchema: ECHO_SCHEMA }],
    });
    tools = await bridge.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(["flaky__echo", "live__echo"]);

    const result = await bridge.callTool("flaky__echo", { text: "back" });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).hub).toBe("flaky");
    expectCleanAuth(live, revived);
  });

  test("session expiry (404) re-initializes and retries once", async () => {
    const hub = stub({
      label: "sessioned",
      sessions: true,
      tools: [{ name: "echo", description: "echo", inputSchema: ECHO_SCHEMA }],
    });
    const bridge = bridgeFor([{ alias: "home", url: hub.url }]);
    await bridge.start();
    expect(hub.issuedSessions).toHaveLength(1);

    await bridge.callTool("echo", { text: "before" });

    // The hub forgets the session — the next POST with the old id gets 404.
    hub.expireSessions();
    const result = await bridge.callTool("echo", { text: "after" });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).args).toEqual({ text: "after" });

    // The bridge opened exactly one fresh session to recover.
    expect(hub.issuedSessions).toHaveLength(2);
    expect(hub.toolCalls.map((c) => c.args)).toEqual([{ text: "before" }, { text: "after" }]);
    // Fresh signatures throughout — including on the failed 404 attempt.
    expectCleanAuth(hub);
  });
});
