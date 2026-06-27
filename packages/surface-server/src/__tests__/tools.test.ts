/**
 * P9 (write): `defineTool` — write-capable MCP tools sharing the ONE
 * `/api/mcp` endpoint with read projections. The four load-bearing claims:
 *
 *   1. a write tool invoked via `tools/call` actually creates a note
 *      (asserted against the fake vault);
 *   2. actor-gating + no-existence-oracle — an anon/denied actor doesn't
 *      see the tool in `tools/list`, and a denied `tools/call` returns the
 *      IDENTICAL shape as an unknown tool;
 *   3. read (projection) + write (tool) coexist on ONE `/api/mcp` — both
 *      listed/callable for an authorized actor;
 *   4. access is enforced — an `operator` tool denies an audience/anon
 *      actor (and a write never rides out of the projection harness).
 *
 * Wired through the REAL gateway (`createSurfaceRouter`), same as the
 * projection suite, so the actor resolution + deny-by-default path is the
 * production one, not a stub.
 */

import { describe, expect, test } from "bun:test";
import type { HubJwtClaims } from "@openparachute/scope-guard";
import { createSurfaceAuth } from "../auth/surface-auth.ts";
import { GrantStore } from "../authz/grant-store.ts";
import { createSurfaceRouter } from "../authz/router.ts";
import { createSurfaceAuthz } from "../authz/surface-authz.ts";
import { defineProjection } from "../projection/projection.ts";
import { createSurfaceProjections, createSurfaceTools } from "../projection/projections.ts";
import { defineTool } from "../tool/tool.ts";
import type { Actor, Note } from "../types.ts";
import { deliverSnapshot, makeTestCtx } from "./helpers.ts";

const MOUNT = "/surface/demo";
const ORIGIN = "https://hub.test";

const MEETING_NOTE: Note = {
  id: "n-meeting",
  createdAt: "2026-06-01T00:00:00Z",
  content: "AGENDA-SECRET-MARKER full agenda body",
  tags: ["meeting", "internal-tag"],
  path: "meetings/council.md",
  metadata: { date: "2026-06-12", title: "City Council" },
};

function operatorClaims(): HubJwtClaims {
  return {
    sub: "op",
    scopes: ["vault:default:write"],
    aud: "vault.default",
    jti: "j",
    clientId: undefined,
    vaultScope: [],
  };
}

// A public WRITE tool: anyone (incl. anon) may drop feedback. This is the
// headline use case — an explicit world-writable opt-in, never a default.
const sendFeedback = () =>
  defineTool({
    name: "sendFeedback",
    params: { body: "string", email: "string?" },
    describe: "Leave feedback — writes a feedback note to the vault.",
    access: "public",
    handler: async ({ params, ctx }) => {
      const note = await ctx.vault.createNote({
        content: params.body,
        tags: ["feedback"],
        ...(params.email !== undefined ? { metadata: { email: params.email } } : {}),
      });
      return { ok: true, id: note.id };
    },
  });

// An operator-only WRITE tool — used to prove access enforcement on the
// write face.
const purgeFeedback = () =>
  defineTool({
    name: "purgeFeedback",
    params: { id: "string" },
    describe: "Delete a feedback note (operator only).",
    access: "operator",
    handler: async ({ params, ctx }) => {
      await ctx.vault.deleteNote(params.id);
      return { ok: true };
    },
  });

// A read projection to prove read+write coexistence on one endpoint.
const upcomingMeetings = () =>
  defineProjection({
    name: "upcomingMeetings",
    params: { from: "date?" },
    query: (p) => ({
      tag: "meeting",
      metadata: { date: { gte: p.from ?? "2026-01-01" } },
      includeContent: true,
    }),
    shape: (note) => ({ title: note.metadata?.title, date: note.metadata?.date }),
    describe: "Upcoming public meetings, soonest first.",
    access: "public",
  });

interface Wiring {
  fetch(req: Request): Promise<Response>;
}

async function wiring(opts: {
  projections?: ReturnType<typeof defineProjection>[];
  tools?: ReturnType<typeof defineTool>[];
  via?: "projections" | "tools";
}): Promise<{
  router: Wiring;
  cap: { token: string };
  vault: ReturnType<typeof makeTestCtx>["vault"];
}> {
  const t = makeTestCtx({ mount: MOUNT });
  t.vault.notes.set(MEETING_NOTE.id, MEETING_NOTE);
  const auth = createSurfaceAuth(t.ctx, {
    validateHubJwt: async (token) => {
      if (token !== "valid-operator-jwt") throw new Error("bad token");
      return operatorClaims();
    },
  });
  const cap = auth.mintCapability();
  const grants = new GrantStore(t.ctx);
  const ready = grants.start();
  deliverSnapshot(t.vault.subscriptions[0]!, []);
  await ready;
  const authz = createSurfaceAuthz(grants);

  const surface =
    opts.via === "tools"
      ? createSurfaceTools(t.ctx, {
          tools: opts.tools ?? [],
          ...(opts.projections !== undefined ? { projections: opts.projections } : {}),
        })
      : createSurfaceProjections(t.ctx, {
          projections: opts.projections ?? [],
          ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        });

  const router = createSurfaceRouter(t.ctx, auth, authz, {
    routes: [...surface.routes],
    rateLimit: { windowMs: 60_000, max: 10_000 },
  });
  return { router: { fetch: (req) => router.fetch(req) }, cap, vault: t.vault };
}

function mcpPost(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${MOUNT}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: Record<string, unknown> };
  expect(body.result).toBeDefined();
  return body.result as Record<string, unknown>;
}

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function listTools(
  router: Wiring,
  headers: Record<string, string> = {},
): Promise<ToolEntry[]> {
  const res = await router.fetch(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers));
  const result = await rpcResult(res);
  return result.tools as ToolEntry[];
}

async function callTool(
  router: Wiring,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const res = await router.fetch(
    mcpPost(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      headers,
    ),
  );
  return (await rpcResult(res)) as never;
}

describe("defineTool — the write face actually mutates", () => {
  test("a write tool invoked via tools/call creates a note (asserted via the vault)", async () => {
    const { router, vault } = await wiring({ tools: [sendFeedback()] });
    const before = vault.createdNotes.length;
    const result = await callTool(router, "send-feedback", {
      body: "the search is slow",
      email: "user@example.com",
    });
    expect(result.isError).toBeUndefined();
    // The handler's return value is the tool result, JSON-serialized.
    const payload = JSON.parse(result.content[0]?.text ?? "");
    expect(payload.ok).toBe(true);
    expect(typeof payload.id).toBe("string");
    // The note really landed in the vault — not a scripted echo.
    expect(vault.createdNotes.length).toBe(before + 1);
    const created = vault.createdNotes.at(-1)!;
    expect(created.content).toBe("the search is slow");
    expect(created.tags).toEqual(["feedback"]);
    expect(created.metadata).toEqual({ email: "user@example.com" });
    expect(vault.notes.get(payload.id)?.content).toBe("the search is slow");
  });

  test("bad arguments are an in-band tool error before any write", async () => {
    const { router, vault } = await wiring({ tools: [sendFeedback()] });
    const result = await callTool(router, "send-feedback", { email: "x@y.z" }); // missing required body
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid params");
    expect(result.content[0]?.text).toContain("body");
    expect(vault.createdNotes.length).toBe(0); // never reached the handler
  });

  test("a handler throw is a generic in-band error — logged, not leaked", async () => {
    const explode = () =>
      defineTool({
        name: "explode",
        describe: "always throws",
        access: "public",
        handler: async () => {
          throw new Error("secret internal detail at /etc/passwd");
        },
      });
    const { router } = await wiring({ tools: [explode()] });
    const result = await callTool(router, "explode", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("/etc/passwd");
    expect(result.content[0]?.text).toContain("explode");
  });
});

describe("defineTool — actor-gating + no existence oracle", () => {
  test("anon does NOT see an operator write tool in tools/list", async () => {
    const { router } = await wiring({ tools: [purgeFeedback()] });
    const tools = await listTools(router);
    expect(tools.map((t) => t.name)).toEqual([]);
  });

  test("a denied tools/call returns the IDENTICAL shape as an unknown tool", async () => {
    const { router } = await wiring({ tools: [purgeFeedback()] });
    // purge-feedback exists but anon can't see it; no-such-tool doesn't exist.
    const denied = await callTool(router, "purge-feedback", { id: "n-1" });
    const missing = await callTool(router, "no-such-tool", {});
    expect(denied.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(denied.content[0]?.text).toBe("unknown tool: purge-feedback");
    expect(missing.content[0]?.text).toBe("unknown tool: no-such-tool");
    // Same error TEXT — no differential message betraying existence.
    expect(denied.content[0]?.text.replace("purge-feedback", "X")).toBe(
      missing.content[0]?.text.replace("no-such-tool", "X"),
    );
  });

  test("a denied write tool never reaches its handler (no silent mutation)", async () => {
    const { router, vault } = await wiring({ tools: [purgeFeedback()] });
    vault.notes.set("n-target", MEETING_NOTE);
    await callTool(router, "purge-feedback", { id: "n-target" });
    expect(vault.deletedIds).toEqual([]); // handler never ran
    expect(vault.notes.has("n-target")).toBe(true);
  });
});

describe("defineTool — access enforcement on the write face", () => {
  test("operator tool: anon hidden, audience denied, operator runs", async () => {
    const { router, cap, vault } = await wiring({ tools: [purgeFeedback()] });
    vault.notes.set("n-x", MEETING_NOTE);

    // anon: not listed, call denied (no oracle)
    expect((await listTools(router)).map((t) => t.name)).toEqual([]);

    // audience (capability): still not listed, call denied
    const audHeaders = { authorization: `Capability ${cap.token}` };
    expect((await listTools(router, audHeaders)).map((t) => t.name)).toEqual([]);
    const audDenied = await callTool(router, "purge-feedback", { id: "n-x" }, audHeaders);
    expect(audDenied.content[0]?.text).toBe("unknown tool: purge-feedback");
    expect(vault.deletedIds).toEqual([]);

    // operator: listed AND runs the mutation
    const opHeaders = { authorization: "Bearer valid-operator-jwt" };
    expect((await listTools(router, opHeaders)).map((t) => t.name)).toEqual(["purge-feedback"]);
    const opResult = await callTool(router, "purge-feedback", { id: "n-x" }, opHeaders);
    expect(opResult.isError).toBeUndefined();
    expect(vault.deletedIds).toEqual(["n-x"]);
  });

  test("audience write tool: anon hidden+denied, capability actor runs", async () => {
    const memberNote = () =>
      defineTool({
        name: "memberNote",
        params: { body: "string" },
        describe: "Members can post a note.",
        access: "audience",
        handler: async ({ params, ctx }) => {
          const n = await ctx.vault.createNote({ content: params.body, tags: ["member-note"] });
          return { id: n.id };
        },
      });
    const { router, cap, vault } = await wiring({ tools: [memberNote()] });

    // anon: hidden + denied, no write
    expect((await listTools(router)).map((t) => t.name)).toEqual([]);
    const anonDenied = await callTool(router, "member-note", { body: "hi" });
    expect(anonDenied.content[0]?.text).toBe("unknown tool: member-note");
    expect(vault.createdNotes.length).toBe(0);

    // capability actor: listed + runs
    const headers = { authorization: `Capability ${cap.token}` };
    expect((await listTools(router, headers)).map((t) => t.name)).toEqual(["member-note"]);
    const ok = await callTool(router, "member-note", { body: "hi" }, headers);
    expect(ok.isError).toBeUndefined();
    expect(vault.createdNotes.length).toBe(1);
  });

  test("invalid credentials are a 401 BEFORE any MCP/tool handling", async () => {
    const { router } = await wiring({ tools: [sendFeedback()] });
    const res = await router.fetch(
      mcpPost(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send-feedback", arguments: { body: "x" } },
        },
        { authorization: "Bearer forged" },
      ),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
  });
});

describe("read + write coexist on ONE /api/mcp", () => {
  test("an authorized actor lists and calls BOTH a projection and a tool", async () => {
    const { router, vault } = await wiring({
      projections: [upcomingMeetings()],
      tools: [sendFeedback()],
    });
    // Both public → anon sees both, in one flat list.
    const tools = await listTools(router);
    expect(tools.map((t) => t.name).sort()).toEqual(["send-feedback", "upcoming-meetings"]);

    // Call the READ face.
    const read = await callTool(router, "upcoming-meetings", { from: "2026-06-10" });
    expect(read.isError).toBeUndefined();
    const readEnvelope = JSON.parse(read.content[0]?.text ?? "");
    expect(readEnvelope.projection).toBe("upcoming-meetings");
    expect(readEnvelope.count).toBe(1);

    // Call the WRITE face — on the SAME endpoint, same session.
    const write = await callTool(router, "send-feedback", { body: "loved it" });
    expect(write.isError).toBeUndefined();
    expect(vault.createdNotes.at(-1)?.content).toBe("loved it");
  });

  test("mixed access: anon sees the public projection but the operator tool stays hidden (no oracle across the merged map)", async () => {
    const { router } = await wiring({
      projections: [upcomingMeetings()], // public READ
      tools: [purgeFeedback()], // operator-only WRITE
    });
    // Anon: the public projection lists; the operator tool is invisible. The
    // two-pass merge filters projections AND tools through the SAME predicate,
    // so a steeper-access tool can't leak into a list that shows public reads.
    const anon = await listTools(router);
    expect(anon.map((t) => t.name)).toEqual(["upcoming-meetings"]);
    // Calling the hidden operator tool as anon is indistinguishable from a tool
    // that doesn't exist — no existence oracle across the projection+tool map.
    const deniedTool = await callTool(router, "purge-feedback", { id: "n-1" });
    const missing = await callTool(router, "no-such-thing", {});
    expect(deniedTool.isError).toBe(true);
    expect(deniedTool.content[0]?.text.replace("purge-feedback", "X")).toBe(
      missing.content[0]?.text.replace("no-such-thing", "X"),
    );
  });

  test("createSurfaceTools co-hosts projections + tools the same way", async () => {
    const { router, vault } = await wiring({
      via: "tools",
      projections: [upcomingMeetings()],
      tools: [sendFeedback()],
    });
    const tools = await listTools(router);
    expect(tools.map((t) => t.name).sort()).toEqual(["send-feedback", "upcoming-meetings"]);
    const write = await callTool(router, "send-feedback", { body: "via tools" });
    expect(write.isError).toBeUndefined();
    expect(vault.createdNotes.at(-1)?.content).toBe("via tools");
  });
});

describe("defineTool — build-time validation", () => {
  test("access is REQUIRED — omitting it throws (no implicit access)", () => {
    expect(() =>
      // @ts-expect-error access is required by the type; this proves the runtime guard too
      defineTool({ name: "noAccess", describe: "missing access", handler: async () => ({}) }),
    ).toThrow("must declare access");
  });

  test("an invalid access value throws", () => {
    expect(() =>
      defineTool({
        name: "badAccess",
        describe: "bad",
        // @ts-expect-error proving the runtime guard rejects an off-list value
        access: "everyone",
        handler: async () => ({}),
      }),
    ).toThrow("invalid access");
  });

  test("a non-empty describe is required", () => {
    expect(() =>
      defineTool({
        name: "noDescribe",
        describe: "  ",
        access: "public",
        handler: async () => ({}),
      }),
    ).toThrow("non-empty describe");
  });

  test("a tool name colliding with a projection throws at build", () => {
    const t = makeTestCtx({ mount: MOUNT });
    const collide = () =>
      defineTool({
        name: "upcomingMeetings", // same kebab as the projection
        describe: "collides",
        access: "public",
        handler: async () => ({}),
      });
    expect(() =>
      createSurfaceProjections(t.ctx, {
        projections: [upcomingMeetings()],
        tools: [collide()],
      }),
    ).toThrow("collides");
  });

  test("two tools with the same kebab name throw at build", () => {
    const t = makeTestCtx({ mount: MOUNT });
    expect(() => createSurfaceTools(t.ctx, { tools: [sendFeedback(), sendFeedback()] })).toThrow(
      "collides",
    );
  });

  test("a reserved name (mcp) throws", () => {
    expect(() =>
      defineTool({
        name: "mcp",
        describe: "reserved",
        access: "public",
        handler: async () => ({}),
      }),
    ).toThrow("reserved");
  });

  test("the handler receives the resolved actor", async () => {
    let seen: Actor | null = null;
    const whoAmI = () =>
      defineTool({
        name: "whoAmI",
        describe: "echoes actor kind",
        access: "public",
        handler: async ({ actor }) => {
          seen = actor;
          return { kind: actor.kind };
        },
      });
    const { router } = await wiring({ tools: [whoAmI()] });
    const result = await callTool(router, "who-am-i", {});
    expect(result.isError).toBeUndefined();
    expect(seen).not.toBeNull();
    expect((seen as unknown as Actor).kind).toBe("anon");
  });
});
