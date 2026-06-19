/**
 * Projection logic + the DISCLOSURE BOUNDARY — exercised through the real
 * composed backend (REST + MCP), with a mock vault (no network).
 *
 * The headline guarantee: the ONLY data that leaves a projection is
 * `notes.map(shape)`. A raw-note field outside a shape (a distinctive
 * content/tag/metadata marker) must NEVER appear in any response. The
 * "disclosure boundary" tests below seed notes carrying such markers and
 * assert they are absent from every face.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  FakeVault,
  MOUNT,
  type MadeBackend,
  ORIGIN,
  TAG,
  get,
  makeBackend,
  mcpPost,
} from "./helpers.ts";

// A marker that lives in the raw note but is NEVER in any shape.
const SECRET_MARKER = "RAW-SECRET-MARKER-must-not-leak";
const SECRET_TAG = "internal-private-tag";
const SECRET_PATH = "private/internal/path.md";

function seededVault(): FakeVault {
  const vault = new FakeVault();
  vault.seed("n-budget", {
    createdAt: "2026-06-10T00:00:00Z",
    tags: [TAG, SECRET_TAG],
    path: SECRET_PATH,
    // The marker lives DEEP in the body (a later line) — not the first
    // content line — so it is genuinely outside every LIST shape (the
    // summary derives from the first non-heading line). The `meeting` shape
    // includes the full body, so the marker IS expected there (by design).
    content: `# Budget review\n\nWe approved the 2026 budget.\n\n## Transcript\n\n**Ada:** ${SECRET_MARKER}`,
    metadata: {
      title: "Budget review",
      held_on: "2026-06-10",
      external_id: "fireflies:abc123",
      attendees: "Ada, Grace",
      attendee_count: 2,
      secret_handle: SECRET_MARKER,
    },
  });
  vault.seed("n-roadmap", {
    createdAt: "2026-06-12T00:00:00Z",
    tags: [TAG],
    content: "# Roadmap sync\n\nDiscussed Q3 roadmap and staffing.",
    metadata: {
      title: "Roadmap sync",
      held_on: "2026-06-12",
      external_id: "fireflies:def456",
      attendees: "Linus",
    },
  });
  return vault;
}

let made: MadeBackend;

beforeEach(async () => {
  made = await makeBackend({ vault: seededVault() });
});

afterAll(async () => {
  await made.backend.shutdown?.();
  made.controller.abort();
});

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: Record<string, unknown> };
  expect(body.result).toBeDefined();
  return body.result as Record<string, unknown>;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const res = await mcpPost(made.backend, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return (await rpcResult(res)) as never;
}

// ---------------------------------------------------------------------------
// recent-meetings
// ---------------------------------------------------------------------------

describe("recent-meetings", () => {
  test("shapes each note to {id,title,date,summary}, newest first", async () => {
    const body = await jsonBody(await get(made.backend, "/api/recent-meetings"));
    expect(body.projection).toBe("recent-meetings");
    expect(body.count).toBe(2);
    const items = body.items as Array<Record<string, unknown>>;
    // sort=desc → roadmap (06-12) before budget (06-10)
    expect(items[0]).toEqual({
      id: "n-roadmap",
      title: "Roadmap sync",
      date: "2026-06-12",
      summary: "Discussed Q3 roadmap and staffing.",
    });
    // The budget summary is the clean FIRST content line — proving the
    // summary fallback never reaches the deep body line carrying the marker.
    expect(items[1]).toEqual({
      id: "n-budget",
      title: "Budget review",
      date: "2026-06-10",
      summary: "We approved the 2026 budget.",
    });
  });

  test("recent-meetings query uses sort, NOT orderBy (vault 400s order_by on created_at)", async () => {
    await get(made.backend, "/api/recent-meetings");
    const q = made.vault.queryInputs.at(-1) as { orderBy?: unknown; sort?: unknown };
    // Direct regression assertion: created_at-desc must ride on `sort`, never
    // `orderBy` (order_by is for indexed metadata only — live vault FIELD_NOT_INDEXED).
    expect(q.orderBy).toBeUndefined();
    expect(q.sort).toBe("desc");
  });

  test("default limit is 20, cap is enforced at 100", async () => {
    await get(made.backend, "/api/recent-meetings");
    expect((made.vault.queryInputs.at(-1) as { limit?: number }).limit).toBe(20);

    await get(made.backend, "/api/recent-meetings?limit=500");
    expect((made.vault.queryInputs.at(-1) as { limit?: number }).limit).toBe(100);

    await get(made.backend, "/api/recent-meetings?limit=5");
    expect((made.vault.queryInputs.at(-1) as { limit?: number }).limit).toBe(5);
  });

  test("a non-numeric limit is a 400 with a per-param issue — never a 500", async () => {
    const res = await get(made.backend, "/api/recent-meetings?limit=lots");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ param: string }> };
    expect(body.error).toBe("invalid_params");
    expect(body.issues.some((i) => i.param === "limit")).toBe(true);
  });

  test("an unknown param is a 400 (strict validation)", async () => {
    const res = await get(made.backend, "/api/recent-meetings?limt=5");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// search-meetings
// ---------------------------------------------------------------------------

describe("search-meetings", () => {
  test("required `query` missing → 400 with a per-param issue", async () => {
    const res = await get(made.backend, "/api/search-meetings");
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      issues: Array<{ param: string; message: string }>;
    };
    expect(body.error).toBe("invalid_params");
    expect(body.issues).toEqual([{ param: "query", message: "required" }]);
  });

  test("matches scope to the meeting tag + shape to {id,title,date,snippet}", async () => {
    const body = await jsonBody(await get(made.backend, "/api/search-meetings?query=roadmap"));
    expect(body.count).toBe(1);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]?.id).toBe("n-roadmap");
    expect(items[0]?.title).toBe("Roadmap sync");
    expect(items[0]?.date).toBe("2026-06-12");
    expect(typeof items[0]?.snippet).toBe("string");
    // The query passes through to the vault scoped by the meeting tag.
    const q = made.vault.queryInputs.at(-1) as { tag?: string; search?: string };
    expect(q.tag).toBe(TAG);
    expect(q.search).toBe("roadmap");
  });

  test("empty result is a well-formed empty envelope", async () => {
    const body = await jsonBody(await get(made.backend, "/api/search-meetings?query=zzz-no-match"));
    expect(body).toEqual({ projection: "search-meetings", count: 0, items: [] });
  });
});

// ---------------------------------------------------------------------------
// meeting (one)
// ---------------------------------------------------------------------------

describe("meeting", () => {
  test("required `id` missing → 400", async () => {
    const res = await get(made.backend, "/api/meeting");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: Array<{ param: string }> };
    expect(body.issues.some((i) => i.param === "id")).toBe(true);
  });

  test("resolves one meeting by external id → curated subset {id,title,date,attendees,body}", async () => {
    const body = await jsonBody(await get(made.backend, "/api/meeting?id=fireflies:abc123"));
    expect(body.count).toBe(1);
    const item = (body.items as Array<Record<string, unknown>>)[0];
    expect(item).toEqual({
      id: "fireflies:abc123",
      title: "Budget review",
      date: "2026-06-10",
      attendees: "Ada, Grace",
      body: `# Budget review\n\nWe approved the 2026 budget.\n\n## Transcript\n\n**Ada:** ${SECRET_MARKER}`,
    });
    // The query is scoped + metadata-shorthand by external_id.
    const q = made.vault.queryInputs.at(-1) as { tag?: string; metadata?: Record<string, unknown> };
    expect(q.tag).toBe(TAG);
    expect(q.metadata).toEqual({ external_id: "fireflies:abc123" });
  });

  test("unknown id is a well-formed empty envelope (no existence oracle)", async () => {
    const body = await jsonBody(await get(made.backend, "/api/meeting?id=fireflies:nope"));
    expect(body).toEqual({ projection: "meeting", count: 0, items: [] });
  });
});

// ---------------------------------------------------------------------------
// THE DISCLOSURE BOUNDARY — the whole point of the template
// ---------------------------------------------------------------------------

describe("disclosure boundary — only the shape leaves", () => {
  // The list shapes (recent/search) do NOT include the body, the secret
  // metadata handle, the private tag, or the path — none may appear.
  test("recent-meetings never leaks raw note fields outside the shape", async () => {
    const text = await (await get(made.backend, "/api/recent-meetings")).text();
    expect(text).not.toContain(SECRET_MARKER);
    expect(text).not.toContain(SECRET_TAG);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("attendee_count");
    expect(text).not.toContain("secret_handle");
  });

  test("search-meetings never leaks raw note fields OUTSIDE the shape", async () => {
    const text = await (await get(made.backend, "/api/search-meetings?query=budget")).text();
    // The snippet is a body window (IN the shape — by design), so body content
    // CAN appear. The boundary is about fields NOT in the shape: the private
    // tag, the path, and the extra metadata never appear, ever.
    expect(text).not.toContain(SECRET_TAG);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("secret_handle");
    expect(text).not.toContain("attendee_count");
  });

  test("search-meetings snippet IS a body window (by design) — proves the window reaches body content", async () => {
    // Searching a term right before the deep marker pulls it into the window.
    // This makes the documented snippet body-exposure trade-off VERIFIABLE
    // (and explains why the test above does not assert SECRET_MARKER absent).
    const body = await (await get(made.backend, "/api/search-meetings?query=Ada")).json();
    const items = (body as { items: Array<{ snippet?: string }> }).items;
    expect(items.length).toBe(1);
    expect(items[0]?.snippet).toContain(SECRET_MARKER);
  });

  test("meeting (single): tag/path/secret-metadata never ride out, even with the body", async () => {
    const text = await (await get(made.backend, "/api/meeting?id=fireflies:abc123")).text();
    // The `meeting` shape DOES include `body` (curated decision), so the body
    // marker IS present — that's by design. The boundary holds for everything
    // NOT in the shape: the private tag, the path, the extra metadata.
    expect(text).not.toContain(SECRET_TAG);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("secret_handle");
    expect(text).not.toContain("attendee_count");
    // The shaped fields ARE present.
    expect(text).toContain("fireflies:abc123");
    expect(text).toContain("Budget review");
  });

  test("MCP tools/call returns the SAME shaped envelope — boundary holds on the AI face too", async () => {
    const result = await callTool("recent-meetings", {});
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain(SECRET_TAG);
    expect(text).not.toContain(SECRET_PATH);
    expect(text).not.toContain("secret_handle");
    expect(text).not.toContain("attendee_count");
    const envelope = JSON.parse(text);
    expect(envelope.projection).toBe("recent-meetings");
    expect(envelope.count).toBe(2);
  });

  test("MCP face: search-meetings + meeting ALSO hold the boundary (pin both AI-face paths)", async () => {
    // The MCP + REST faces share runProjection, but pin the MCP path for EVERY
    // projection so a future divergence in the MCP handler can't silently leak.
    for (const [tool, args] of [
      ["search-meetings", { query: "budget" }],
      ["meeting", { id: "fireflies:abc123" }],
    ] as const) {
      const result = await callTool(tool, args);
      expect(result.isError).toBeUndefined();
      const text = result.content[0]?.text ?? "";
      expect(text).not.toContain(SECRET_TAG);
      expect(text).not.toContain(SECRET_PATH);
      expect(text).not.toContain("secret_handle");
      expect(text).not.toContain("attendee_count");
    }
  });
});

// ---------------------------------------------------------------------------
// MCP face — tool list + dispatch
// ---------------------------------------------------------------------------

describe("MCP face", () => {
  test("tools/list shows all three projections (all public) with descriptions + schemas", async () => {
    const res = await mcpPost(made.backend, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = await rpcResult(res);
    const tools = result.tools as Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "meeting",
      "recent-meetings",
      "search-meetings",
    ]);
    const search = tools.find((t) => t.name === "search-meetings");
    expect(search?.description).toContain("Full-text search");
    // Required param shows up in the generated inputSchema.
    expect((search?.inputSchema as { required?: string[] }).required).toContain("query");
  });

  test("a tool-call with a missing required arg is an in-band tool error, not a 500", async () => {
    const result = await callTool("search-meetings", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid params");
    expect(result.content[0]?.text).toContain("query");
  });

  test("GET on the MCP endpoint is a 405 (stateless: no standalone stream)", async () => {
    const res = await get(made.backend, "/api/mcp", { accept: "text/event-stream" });
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// read-only invariant + error hygiene
// ---------------------------------------------------------------------------

describe("read-only + error hygiene", () => {
  test("no vault write ever happens (createNote/updateNote/deleteNote throw if called)", async () => {
    await get(made.backend, "/api/recent-meetings");
    await get(made.backend, "/api/search-meetings?query=budget");
    await get(made.backend, "/api/meeting?id=fireflies:abc123");
    // The FakeVault's write methods throw; reaching here means none were
    // called. (Belt-and-suspenders: assert the surface only ever queried.)
    expect(made.vault.queryInputs.length).toBeGreaterThan(0);
  });

  test("a vault failure is the router's generic 500 — logged, not leaked", async () => {
    made.vault.queryError = new Error("vault exploded at /internal/path");
    const res = await get(made.backend, "/api/recent-meetings");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("exploded");
    expect(text).not.toContain("/internal/path");
    expect(made.logs.errors.some((e) => e.includes("exploded"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// re-targeting seam — the config `tag` overrides the default
// ---------------------------------------------------------------------------

describe("config `tag` override (the re-targeting seam)", () => {
  test("a custom config tag drives the projection queries", async () => {
    const vault = new FakeVault();
    // Seed a note under a DIFFERENT tag (the council-meetings re-target case).
    vault.seed("n-council", {
      createdAt: "2026-06-15T00:00:00Z",
      tags: ["council/meeting"],
      content: "# Council session",
      metadata: { title: "Council session", external_id: "ext:council-1" },
    });
    const custom = await makeBackend({ vault, config: { tag: "council/meeting" } });
    try {
      const body = await jsonBody(await get(custom.backend, "/api/recent-meetings"));
      expect(body.count).toBe(1);
      expect((body.items as Array<{ title?: string }>)[0]?.title).toBe("Council session");
      // The query went out scoped to the configured tag, not the default.
      expect((custom.vault.queryInputs.at(-1) as { tag?: string }).tag).toBe("council/meeting");
    } finally {
      await custom.backend.shutdown?.();
      custom.controller.abort();
    }
  });
});
