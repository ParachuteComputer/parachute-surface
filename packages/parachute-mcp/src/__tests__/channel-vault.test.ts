/**
 * Unit tests for the `/api/channel-vault` client, against a fetch STUB.
 *
 * The value here is the wire contract with parachute-hub (`api-channel-vaults.ts`,
 * hub#947) and the one distinction the whole feature rests on: a 404 carrying
 * the route's own `{"error":"not_found"}` means "this channel is unbound", and
 * any other 404 means "this hub does not serve the route". Conflating them
 * sends an operator to a hub command that does not exist there.
 *
 * A stub `fetch` rather than a server, because what is being asserted is the
 * REQUEST (URL, method, no redirect following) and the classification of each
 * response — neither of which needs a socket. The signed end-to-end path over
 * a real hub is covered in commands-run.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { OLD_HUB_HINT, attachHint, channelVaultUrl, lookupChannelVault } from "../channel-vault.js";
import { EXIT } from "../exit.js";

const HUB = "https://hub.example.test/mcp";
const RELAY = "buzz.techne.coop";
const CHANNEL = "3ff68a58-3f97-409a-b531-45d388b3c827";

interface StubbedFetch {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
}

/** A `fetch` that always answers with one canned response. */
function stubFetch(status: number, body: string, headers?: Record<string, string>): StubbedFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), ...(init ? { init: init as RequestInit } : {}) });
      return new Response(body, { status, ...(headers ? { headers } : {}) });
    },
  };
}

function query(fetchImpl: FetchLike) {
  return lookupChannelVault({
    hubUrl: HUB,
    relayHost: RELAY,
    channelId: CHANNEL,
    fetch: fetchImpl,
  });
}

describe("channelVaultUrl", () => {
  test("drops the /mcp door segment and hangs the REST route beside it", () => {
    expect(channelVaultUrl("https://hub.example.test/mcp", RELAY, CHANNEL)).toBe(
      `https://hub.example.test/api/channel-vault?relay=${RELAY}&channel=${CHANNEL}`,
    );
  });

  test("a hub mounted at the origin root works", () => {
    expect(channelVaultUrl("https://hub.example.test/", RELAY, CHANNEL)).toStartWith(
      "https://hub.example.test/api/channel-vault?",
    );
  });

  test("a hub under a path prefix stays under it — the route is not at the origin", () => {
    expect(channelVaultUrl("https://host.test/pfx/mcp", RELAY, CHANNEL)).toStartWith(
      "https://host.test/pfx/api/channel-vault?",
    );
  });

  test("the relay is sent as normalized, which is what keeps one channel to one binding", () => {
    // `relayHostOf` lower-cases and strips the scheme before this is called;
    // the hub normalizes the same way (`normalizeRelayHost`), so the two agree
    // by construction. A relay differing only in case must not fork a channel
    // into two bindings and two notes.
    const url = new URL(channelVaultUrl(HUB, "buzz.techne.coop", CHANNEL));
    expect(url.searchParams.get("relay")).toBe("buzz.techne.coop");
    expect(url.searchParams.get("channel")).toBe(CHANNEL);
  });

  test("a channel id needing escaping is encoded, not interpolated", () => {
    const url = new URL(channelVaultUrl(HUB, RELAY, "a b&c=d"));
    expect(url.searchParams.get("channel")).toBe("a b&c=d");
    expect(url.pathname).toBe("/api/channel-vault");
  });
});

describe("lookupChannelVault — the request", () => {
  test("is a GET at the derived URL and does not follow redirects", async () => {
    // Redirects would carry a NIP-98 signature pinned to the OLD url, and the
    // hub would reject it as an auth failure three steps from the real cause.
    const stub = stubFetch(200, JSON.stringify({ vault: "parachute" }));
    await query(stub.fetch);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toBe(channelVaultUrl(HUB, RELAY, CHANNEL));
    expect(stub.calls[0]?.init?.method).toBe("GET");
    expect(stub.calls[0]?.init?.redirect).toBe("manual");
  });
});

describe("lookupChannelVault — classification", () => {
  test("200 with a binding is `bound`, carrying mode and synced_at", async () => {
    const stub = stubFetch(
      200,
      JSON.stringify({ vault: "parachute", mode: "sync", synced_at: "2026-09-03T12:00:00.000Z" }),
    );
    const lookup = await query(stub.fetch);
    expect(lookup).toEqual({
      status: "bound",
      binding: { vault: "parachute", mode: "sync", syncedAt: "2026-09-03T12:00:00.000Z" },
    });
  });

  test("a never-synced binding reports a null synced_at as absent, not as a string", async () => {
    const stub = stubFetch(
      200,
      JSON.stringify({ vault: "ch-3ff68a58", mode: "sync", synced_at: null }),
    );
    const lookup = await query(stub.fetch);
    expect(lookup).toEqual({
      status: "bound",
      binding: { vault: "ch-3ff68a58", mode: "sync" },
    });
  });

  test("404 with the route's own not_found body is `unbound`", async () => {
    const stub = stubFetch(
      404,
      JSON.stringify({
        error: "not_found",
        error_description: "no vault is attached to that channel on this hub",
      }),
    );
    expect(await query(stub.fetch)).toEqual({ status: "unbound" });
  });

  test("404 with the hub's generic text body is `unsupported`, NOT unbound", async () => {
    // parachute-hub's dispatch 404s unknown paths with a plain `not found`.
    // Reading that as "unbound" would tell an operator to run an attach
    // command their hub does not have.
    const lookup = await query(stubFetch(404, "not found").fetch);
    expect(lookup.status).toBe("unsupported");
  });

  test("404 with unrelated JSON is `unsupported` too — only not_found means unbound", async () => {
    const lookup = await query(stubFetch(404, JSON.stringify({ error: "no_such_route" })).fetch);
    expect(lookup.status).toBe("unsupported");
  });

  test("405 is `unsupported` — something else claims that path here", async () => {
    const lookup = await query(stubFetch(405, "").fetch);
    expect(lookup.status).toBe("unsupported");
  });

  test("401 is an auth error carrying exit 3, not a transport failure", async () => {
    const lookup = await query(stubFetch(401, "unauthorized").fetch);
    expect(lookup).toMatchObject({ status: "error", exitCode: EXIT.auth });
  });

  test("403 is an auth error too", async () => {
    expect(await query(stubFetch(403, "forbidden").fetch)).toMatchObject({
      status: "error",
      exitCode: EXIT.auth,
    });
  });

  test("a 500 is a transport error, not a silent unbound", async () => {
    const lookup = await query(stubFetch(500, "boom").fetch);
    expect(lookup).toMatchObject({ status: "error", exitCode: EXIT.transport });
    expect((lookup as { reason: string }).reason).toContain("500");
  });

  test("200 with a body this build cannot read is an error, not a fake binding", async () => {
    const lookup = await query(stubFetch(200, "<html>hello</html>").fetch);
    expect(lookup).toMatchObject({ status: "error", exitCode: EXIT.transport });
  });

  test("200 with an empty vault name is not a binding", async () => {
    const lookup = await query(stubFetch(200, JSON.stringify({ vault: "" })).fetch);
    expect(lookup.status).toBe("error");
  });

  test("a thrown fetch is a transport error, never a throw of its own", async () => {
    const lookup = await lookupChannelVault({
      hubUrl: HUB,
      relayHost: RELAY,
      channelId: CHANNEL,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(lookup).toMatchObject({ status: "error", exitCode: EXIT.transport });
    expect((lookup as { reason: string }).reason).toContain("ECONNREFUSED");
  });

  test("an unusable hub URL is a usage error and never echoes the input", async () => {
    const lookup = await lookupChannelVault({
      hubUrl: "not a url",
      relayHost: RELAY,
      channelId: CHANNEL,
      fetch: async () => new Response("", { status: 200 }),
    });
    expect(lookup).toMatchObject({ status: "error", exitCode: EXIT.usage });
    // `new URL` puts the FULL raw input on `error.input`; a hub URL is
    // user-supplied, so nothing of it may reach a message.
    expect((lookup as { reason: string }).reason).not.toContain("not a url");
  });

  test("a huge error body is truncated before it reaches a one-line reason", async () => {
    const lookup = await query(stubFetch(500, "x".repeat(5000)).fetch);
    expect((lookup as { reason: string }).reason.length).toBeLessThan(400);
  });
});

describe("the operator hints", () => {
  test("attachHint names the hub's real CLI grammar and this exact channel", () => {
    const hint = attachHint(RELAY, CHANNEL);
    // parachute-hub `src/commands/vault-channels.ts` — the design calls the
    // verb `attach-channel-vault`, the shipped CLI calls it `attach-channel`.
    expect(hint).toContain("parachute vault attach-channel");
    expect(hint).toContain(`--relay ${RELAY}`);
    expect(hint).toContain(`--channel ${CHANNEL}`);
  });

  test("the old-hub hint names the route and the escape hatch", () => {
    expect(OLD_HUB_HINT).toContain("/api/channel-vault");
    expect(OLD_HUB_HINT).toContain("--vault");
  });
});
