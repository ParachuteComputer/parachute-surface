/**
 * P9 integration: one projection set wired through the real gateway, both
 * faces exercised — REST (param validation, envelope, shaping, access)
 * and MCP (per-actor tool visibility, dispatch, in-band errors) — plus a
 * conformance-suite pass over the projection routes, since "audience-
 * gated REST endpoint wired through the P7/P8 gates" should be provable
 * with the kit's own public suite.
 */

import { describe, expect, test } from "bun:test";
import type { HubJwtClaims } from "@openparachute/scope-guard";
import { createSurfaceAuth } from "../auth/surface-auth.ts";
import { GrantStore } from "../authz/grant-store.ts";
import { createSurfaceRouter } from "../authz/router.ts";
import { createSurfaceAuthz } from "../authz/surface-authz.ts";
import { gatewayConformanceCases } from "../conformance.ts";
import { defineProjection } from "../projection/projection.ts";
import { createSurfaceProjections } from "../projection/projections.ts";
import type { Note } from "../types.ts";
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

const upcomingMeetings = () =>
  defineProjection({
    name: "upcomingMeetings",
    params: { from: "date?" },
    query: (p) => ({
      tag: "meeting",
      metadata: { date: { gte: p.from ?? "2026-01-01" } },
      includeContent: true,
    }),
    shape: (note) => ({
      title: note.metadata?.title,
      date: note.metadata?.date,
    }),
    describe: "Upcoming public meetings, soonest first.",
    access: "public",
  });

const memberDigest = () =>
  defineProjection({
    name: "memberDigest",
    params: {},
    query: () => ({ tag: "meeting" }),
    shape: (note) => ({ id: note.id }),
    describe: "Digest for invited members.",
    // default access: "audience"
  });

const adminStats = () =>
  defineProjection({
    name: "adminStats",
    params: {},
    query: () => ({ tag: "meeting" }),
    shape: (note) => ({ id: note.id }),
    describe: "Operator-only stats.",
    access: "operator",
  });

async function wiring() {
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
  const projections = createSurfaceProjections(t.ctx, {
    projections: [upcomingMeetings(), memberDigest(), adminStats()],
  });
  const router = createSurfaceRouter(t.ctx, auth, authz, {
    routes: [...projections.routes],
    rateLimit: { windowMs: 60_000, max: 10_000 },
  });
  return { t, auth, router, cap, projections };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

function mcpPost(
  body: unknown,
  headers: Record<string, string> = {},
  path = `${MOUNT}/api/mcp`,
): Request {
  return new Request(`${ORIGIN}${path}`, {
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
  router: { fetch(req: Request): Promise<Response> },
  headers: Record<string, string> = {},
  path?: string,
): Promise<ToolEntry[]> {
  const res = await router.fetch(
    mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, headers, path),
  );
  const result = await rpcResult(res);
  return result.tools as ToolEntry[];
}

async function callTool(
  router: { fetch(req: Request): Promise<Response> },
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

describe("REST face", () => {
  test("public projection serves anon with the shaped envelope — never raw notes", async () => {
    const { router } = await wiring();
    const res = await router.fetch(get(`${MOUNT}/api/upcoming-meetings`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      projection: "upcoming-meetings",
      count: 1,
      items: [{ title: "City Council", date: "2026-06-12" }],
    });
    // The raw note's tags/content/path never ride out of a shape.
    const text = JSON.stringify(body);
    expect(text).not.toContain("internal-tag");
    expect(text).not.toContain("AGENDA-SECRET-MARKER");
    expect(text).not.toContain("meetings/council.md");
  });

  test("validated params flow into the compiled query", async () => {
    const { router, t } = await wiring();
    const res = await router.fetch(get(`${MOUNT}/api/upcoming-meetings?from=2026-06-10`));
    expect(res.status).toBe(200);
    expect(t.vault.queryInputs.at(-1)).toEqual({
      tag: "meeting",
      metadata: { date: { gte: "2026-06-10" } },
      includeContent: true,
    });
  });

  test("bad params are a 400 with per-param issues — never a 500", async () => {
    const { router } = await wiring();
    const bad = await router.fetch(get(`${MOUNT}/api/upcoming-meetings?from=not-a-date`));
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("invalid_params");
    expect(body.issues).toEqual([
      { param: "from", message: "expected an ISO date (YYYY-MM-DD) or ISO datetime" },
    ]);
    const unknown = await router.fetch(get(`${MOUNT}/api/upcoming-meetings?form=2026-06-10`));
    expect(unknown.status).toBe(400);
  });

  test("audience projection: anon 401; capability actor 200; operator 200", async () => {
    const { router, cap } = await wiring();
    expect((await router.fetch(get(`${MOUNT}/api/member-digest`))).status).toBe(401);
    expect(
      (
        await router.fetch(
          get(`${MOUNT}/api/member-digest`, { authorization: `Capability ${cap.token}` }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await router.fetch(
          get(`${MOUNT}/api/member-digest`, { authorization: "Bearer valid-operator-jwt" }),
        )
      ).status,
    ).toBe(200);
  });

  test("operator projection: audience 403, operator 200", async () => {
    const { router, cap } = await wiring();
    expect(
      (
        await router.fetch(
          get(`${MOUNT}/api/admin-stats`, { authorization: `Capability ${cap.token}` }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await router.fetch(
          get(`${MOUNT}/api/admin-stats`, { authorization: "Bearer valid-operator-jwt" }),
        )
      ).status,
    ).toBe(200);
  });

  test("a vault failure is the router's generic 500 — logged, not leaked", async () => {
    const { router, t } = await wiring();
    t.vault.queryError = new Error("vault exploded at /internal/path");
    const res = await router.fetch(get(`${MOUNT}/api/upcoming-meetings`));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("/internal/path");
    expect(t.logs.errors.some((e) => e.includes("exploded"))).toBe(true);
  });
});

describe("MCP face — per-actor tool visibility", () => {
  test("anon sees only public projections", async () => {
    const { router } = await wiring();
    const tools = await listTools(router);
    expect(tools.map((t) => t.name)).toEqual(["upcoming-meetings"]);
    expect(tools[0]?.description).toBe("Upcoming public meetings, soonest first.");
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date (YYYY-MM-DD) or ISO datetime" },
      },
      required: [],
      additionalProperties: false,
    });
  });

  test("audience actor sees public + audience; operator sees all", async () => {
    const { router, cap } = await wiring();
    const audienceTools = await listTools(router, {
      authorization: `Capability ${cap.token}`,
    });
    expect(audienceTools.map((t) => t.name).sort()).toEqual(["member-digest", "upcoming-meetings"]);
    const operatorTools = await listTools(router, {
      authorization: "Bearer valid-operator-jwt",
    });
    expect(operatorTools.map((t) => t.name).sort()).toEqual([
      "admin-stats",
      "member-digest",
      "upcoming-meetings",
    ]);
  });

  test("invalid credentials are a 401 refusal BEFORE any MCP handling", async () => {
    const { router } = await wiring();
    const res = await router.fetch(
      mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer forged" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
  });

  test("the short `${mount}/mcp` namespace answers too (future host forwarding)", async () => {
    const { router } = await wiring();
    const tools = await listTools(router, {}, `${MOUNT}/mcp`);
    expect(tools.map((t) => t.name)).toEqual(["upcoming-meetings"]);
  });

  test("GET on the MCP endpoint is a 405, not a hanging stream", async () => {
    const { router } = await wiring();
    const res = await router.fetch(get(`${MOUNT}/api/mcp`, { accept: "text/event-stream" }));
    expect(res.status).toBe(405);
  });
});

describe("MCP face — dispatch", () => {
  test("tools/call returns the shaped envelope as JSON text", async () => {
    const { router } = await wiring();
    const result = await callTool(router, "upcoming-meetings", { from: "2026-06-10" });
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "");
    expect(envelope).toEqual({
      projection: "upcoming-meetings",
      count: 1,
      items: [{ title: "City Council", date: "2026-06-12" }],
    });
  });

  test("bad arguments are an in-band tool error, never a protocol failure", async () => {
    const { router } = await wiring();
    const result = await callTool(router, "upcoming-meetings", { from: "tomorrow-ish" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid params");
    expect(result.content[0]?.text).toContain("from");
  });

  test("a denied tool and a nonexistent tool return the IDENTICAL error shape", async () => {
    const { router } = await wiring();
    // member-digest exists but anon can't see it; no-such-tool doesn't exist.
    const denied = await callTool(router, "member-digest", {});
    const missing = await callTool(router, "no-such-tool", {});
    expect(denied.isError).toBe(true);
    expect(missing.isError).toBe(true);
    expect(denied.content[0]?.text).toBe("unknown tool: member-digest");
    expect(missing.content[0]?.text).toBe("unknown tool: no-such-tool");
  });

  test("an allowed actor can call its gated tool", async () => {
    const { router, cap } = await wiring();
    const result = await callTool(
      router,
      "member-digest",
      {},
      {
        authorization: `Capability ${cap.token}`,
      },
    );
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "");
    expect(envelope.projection).toBe("member-digest");
  });

  test("a vault failure during a tool call is an in-band error — logged, not leaked", async () => {
    const { router, t } = await wiring();
    t.vault.queryError = new Error("vault exploded at /internal/path");
    const result = await callTool(router, "upcoming-meetings", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain("exploded");
    expect(result.content[0]?.text).toContain("upcoming-meetings");
    expect(t.logs.errors.some((e) => e.includes("exploded"))).toBe(true);
  });
});

describe("projection set validation", () => {
  test("duplicate kebab names are rejected at build (fail at mount, not at request)", async () => {
    const { t } = await (async () => {
      const w = makeTestCtx({ mount: MOUNT });
      return { t: w };
    })();
    expect(() =>
      createSurfaceProjections(t.ctx, {
        projections: [upcomingMeetings(), upcomingMeetings()],
      }),
    ).toThrow("duplicate");
  });
});

describe("conformance over projection routes", async () => {
  const { router } = await wiring();
  const cases = gatewayConformanceCases({
    fetch: (req) => router.fetch(req),
    mount: MOUNT,
    protectedProbes: [
      // The audience + operator REST faces must refuse anon without leaking.
      { path: "/api/member-digest", mustNotContain: ["AGENDA-SECRET-MARKER"] },
      { path: "/api/admin-stats", mustNotContain: ["AGENDA-SECRET-MARKER"] },
    ],
  });

  for (const c of cases) {
    test(c.name, async () => {
      await c.run();
    });
  }
});
