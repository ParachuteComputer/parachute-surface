/**
 * createSurfaceProjections — compiles a projection set into BOTH derived
 * faces (P9): REST routes + the per-surface Streamable-HTTP MCP endpoint.
 *
 * The output is a list of `SurfaceRoute`s the author spreads into
 * `createSurfaceRouter`, so EVERYTHING — both faces — rides the same
 * deny-by-default gateway: rate limit first, actor resolution
 * (presented-but-invalid is a 401, never anon), declared access. The
 * projection layer adds no second trust path; it only declares routes.
 *
 *   - **REST**: `GET ${mount}/api/<kebab-name>` per projection, access
 *     enforced BY THE ROUTER from the projection's declaration. The
 *     handler validates query-string params (400 + per-param issues on
 *     bad input — never a thrown 500), runs the compiled vault query,
 *     and returns `{ projection, count, items: notes.map(shape) }`.
 *   - **MCP**: `POST ${mount}/api/mcp` — STATELESS Streamable HTTP
 *     (vault's `mcp-http.ts` precedent: fresh transport+server per
 *     request, `sessionIdGenerator: undefined`, JSON responses; no
 *     initialize handshake required, server restarts never strand a
 *     client). Channel's `mcp-http.ts` is the STATEFUL cousin — it needs
 *     sessions because its headline feature is the server-push idle
 *     wake; projections are read-only queries with nothing to push, so
 *     statelessness is the engineering-right shape (and means no session
 *     registry to leak or clean up). GET/DELETE are NOT routed: in
 *     stateless mode a GET would open a server-push stream that can
 *     never receive anything and would hang into the host's request
 *     timeout (counting toward crash-loop quarantine) — the router's
 *     declared-path 405 answers instead, which the MCP spec explicitly
 *     allows for servers that offer no standalone stream.
 *
 * The MCP endpoint rides the SAME actor resolution as everything else:
 * its route is declared `public`, and the per-ACTOR gate is applied
 * per TOOL — `tools/list` shows only the projections the caller's
 * access clears, and dispatching an unlisted tool returns the SAME
 * "unknown tool" error whether it doesn't exist or is merely denied (no
 * existence oracle, matching the router's 404 unification). An anon
 * caller therefore sees exactly the audience policy's public slice.
 *
 * ENTRY-PATH NOTE (same containment reality as P7's entry route): the
 * host forwards ONLY `${mount}/api/*` + `${mount}/ws` to a backend, so
 * `${mount}/api/mcp` is the CANONICAL (and only) MCP path — the spec
 * was amended to name it (#104). A bare `${mount}/mcp` route used to be
 * forward-declared here but never received traffic; it was dropped
 * rather than asking the host to grow a second forwarding rule.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SurfaceHostContext } from "@openparachute/surface";
import { surfaceNameFromMount } from "../authz/grant-store.ts";
import type { RouteContext, SurfaceRoute } from "../authz/router.ts";
import { type ToolDefinition, toolAllows } from "../tool/tool.ts";
import type { Actor, Note } from "../types.ts";
import { paramsJsonSchema, parseParams } from "./params.ts";
import { type ProjectionDefinition, projectionAllows } from "./projection.ts";

export interface SurfaceProjectionsOptions {
  projections: ProjectionDefinition[];
  /**
   * Write-capable tools (P9's write sibling). They ride the SAME
   * `/api/mcp` endpoint as projections: `tools/list` shows both (filtered
   * per actor), `tools/call` dispatches to whichever owns the name. Names
   * share ONE kebab space with projections — a collision throws at build.
   * Tools are MCP-only (no REST face): a write face would need its own
   * CSRF/idempotency contract; the MCP `tools/call` carries the actor and
   * is the canonical agent write path. Default `[]`.
   */
  tools?: ToolDefinition[];
  /** MCP server name. Default `surface-<name>` (from the mount). */
  serverName?: string;
  /** MCP server version. Default `"0.1.0"`. */
  serverVersion?: string;
  /** MCP connect-time instructions. Default: generated one-liner. */
  instructions?: string;
}

export interface SurfaceProjections {
  /**
   * Spread these into `createSurfaceRouter({ routes: [...] })` — one GET
   * route per projection plus the MCP endpoint (which serves both
   * projections and any defined tools). The router enforces access;
   * nothing here bypasses it.
   */
  routes: SurfaceRoute[];
  /** The compiled projection set (introspection / docs generation). */
  projections: readonly ProjectionDefinition[];
  /** The compiled tool set, if any (introspection / docs generation). */
  tools: readonly ToolDefinition[];
}

/** The envelope BOTH faces return (MCP serializes it as JSON text). */
interface ProjectionResult {
  projection: string;
  count: number;
  items: unknown[];
}

export function createSurfaceProjections(
  ctx: SurfaceHostContext,
  opts: SurfaceProjectionsOptions,
): SurfaceProjections {
  const projections = [...opts.projections];
  const tools = [...(opts.tools ?? [])];
  // Projections AND tools share ONE kebab name space on `/api/mcp` —
  // `tools/list` returns a single flat list, so a name owned by both faces
  // would be ambiguous at dispatch. Reject at build (fail at mount, not at
  // request), the same discipline projections already enforce among
  // themselves.
  const seen = new Map<string, "projection" | "tool">();
  for (const p of projections) {
    if (seen.has(p.kebabName)) {
      throw new Error(
        `createSurfaceProjections: duplicate projection name "${p.kebabName}" — names must be unique after kebab-casing`,
      );
    }
    seen.set(p.kebabName, "projection");
  }
  for (const t of tools) {
    const prior = seen.get(t.kebabName);
    if (prior !== undefined) {
      throw new Error(
        `createSurfaceProjections: tool name "${t.kebabName}" collides with an existing ${prior} — projections and tools share one MCP name space`,
      );
    }
    seen.set(t.kebabName, "tool");
  }

  const serverName = opts.serverName ?? `surface-${surfaceNameFromMount(ctx.mount)}`;
  const serverVersion = opts.serverVersion ?? "0.1.0";
  const instructions =
    opts.instructions ??
    (tools.length > 0
      ? `Domain tools over the ${surfaceNameFromMount(ctx.mount)} surface. Read tools are parameterized queries returning shaped JSON; write tools perform domain actions. Domain vocabulary, not raw vault notes.`
      : `Domain projections over the ${surfaceNameFromMount(ctx.mount)} surface. Each tool is a read-only, parameterized query returning shaped JSON — domain vocabulary, not raw vault notes.`);

  // ---- face 1: REST -------------------------------------------------------
  const routes: SurfaceRoute[] = projections.map((p) => ({
    method: "GET",
    path: p.restPath,
    access: { kind: p.access },
    handler: (req: Request, route: RouteContext) => runRestProjection(ctx, p, req, route),
  }));

  // ---- face 2: MCP (projections AND tools on ONE endpoint) ----------------
  const mcpHandler = (req: Request, route: RouteContext) =>
    handleMcpRequest(ctx, projections, tools, route.actor, {
      serverName,
      serverVersion,
      instructions,
    })(req);
  // POST only — see the module header for why GET/DELETE 405 instead.
  // `/api/mcp` is the canonical MCP path (#104): the host forwards only
  // `${mount}/api/*`, so a bare `/mcp` route would be dead code.
  routes.push({
    method: "POST",
    path: "/api/mcp",
    access: { kind: "public" },
    handler: mcpHandler,
  });

  return { routes, projections, tools };
}

/**
 * createSurfaceTools — the write-face convenience: stand up `/api/mcp`
 * with tools (and optionally projections) WITHOUT any REST routes. Sugar
 * over `createSurfaceProjections({ projections: [], tools, ... })` for the
 * common "I only have write tools" backend. The returned `routes` are just
 * the MCP endpoint; spread them into `createSurfaceRouter` exactly like a
 * projection set. Read+write coexistence is the default — pass both
 * `tools` and `projections` here, or add `tools` to your existing
 * `createSurfaceProjections` call.
 */
export interface SurfaceToolsOptions {
  tools: ToolDefinition[];
  /** Read projections to co-host on the same `/api/mcp`. Default `[]`. */
  projections?: ProjectionDefinition[];
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
}

export function createSurfaceTools(
  ctx: SurfaceHostContext,
  opts: SurfaceToolsOptions,
): SurfaceProjections {
  return createSurfaceProjections(ctx, {
    projections: opts.projections ?? [],
    tools: opts.tools,
    ...(opts.serverName !== undefined ? { serverName: opts.serverName } : {}),
    ...(opts.serverVersion !== undefined ? { serverVersion: opts.serverVersion } : {}),
    ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
  });
}

// ---------------------------------------------------------------------------
// Shared execution — params already validated by the caller
// ---------------------------------------------------------------------------

async function runProjection(
  ctx: SurfaceHostContext,
  p: ProjectionDefinition,
  params: Record<string, unknown>,
): Promise<ProjectionResult> {
  const notes: Note[] = await ctx.vault.queryNotes(p.query(params));
  return {
    projection: p.kebabName,
    count: notes.length,
    items: notes.map((note) => p.shape(note, params)),
  };
}

// ---------------------------------------------------------------------------
// REST face
// ---------------------------------------------------------------------------

async function runRestProjection(
  ctx: SurfaceHostContext,
  p: ProjectionDefinition,
  req: Request,
  _route: RouteContext,
): Promise<Response> {
  const url = new URL(req.url);
  const raw: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    raw[key] = value; // repeated params: last occurrence wins
  }
  const parsed = parseParams(p.compiledParams, raw);
  if (!parsed.ok) {
    return Response.json({ error: "invalid_params", issues: parsed.issues }, { status: 400 });
  }
  // Query/shape failures propagate to the router's error boundary — a
  // generic 500 with the real error in the surface log (never a leak).
  const result = await runProjection(ctx, p, parsed.params);
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// MCP face — stateless Streamable HTTP (the vault precedent)
// ---------------------------------------------------------------------------

interface McpServerInfo {
  serverName: string;
  serverVersion: string;
  instructions: string;
}

function toolError(text: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * One dispatch entry on the shared `/api/mcp` list — a read projection or
 * a write tool. The unified view is what makes the no-oracle invariant
 * hold ACROSS both kinds: a denied tool, a denied projection, and a
 * nonexistent name all resolve to the same "not in the visible map".
 */
type McpEntry =
  | { kind: "projection"; def: ProjectionDefinition }
  | { kind: "tool"; def: ToolDefinition };

function handleMcpRequest(
  ctx: SurfaceHostContext,
  projections: readonly ProjectionDefinition[],
  tools: readonly ToolDefinition[],
  actor: Actor,
  info: McpServerInfo,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // The router resolved `actor` for THIS request — visibility is
    // computed fresh every time (stateless: no session for it to go
    // stale on). Projections AND tools filter through the SAME predicate
    // (`projectionAllows` === `toolAllows`), so the two faces can never
    // diverge on who-sees-what.
    const visible = new Map<string, McpEntry>();
    for (const p of projections) {
      if (projectionAllows(p.access, actor)) {
        visible.set(p.kebabName, { kind: "projection", def: p });
      }
    }
    for (const t of tools) {
      if (toolAllows(t.access, actor)) {
        visible.set(t.kebabName, { kind: "tool", def: t });
      }
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new Server(
      { name: info.serverName, version: info.serverVersion },
      { capabilities: { tools: {} }, instructions: info.instructions },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...visible.values()].map((e) => ({
        name: e.def.kebabName,
        description: e.def.describe,
        inputSchema: paramsJsonSchema(e.def.compiledParams),
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      // Dispatch against the FILTERED map: a denied entry (read OR write)
      // and a nonexistent name return the IDENTICAL error — no existence
      // oracle via differential messages (the router's 404 unification,
      // in tool vocabulary).
      const entry = visible.get(name);
      if (!entry) return toolError(`unknown tool: ${name}`);

      const parsed = parseParams(entry.def.compiledParams, (args ?? {}) as Record<string, unknown>);
      if (!parsed.ok) {
        const issues = parsed.issues.map((i) => `${i.param}: ${i.message}`).join("; ");
        return toolError(`invalid params — ${issues}`);
      }

      try {
        const result =
          entry.kind === "projection"
            ? await runProjection(ctx, entry.def, parsed.params)
            : // The write face: the handler MAY mutate via `ctx.vault`. Its
              // return value is serialized as the tool result. `force: true`
              // is already rejected host-side by the ScopedVaultClient.
              await entry.def.handler({ params: parsed.params, actor, ctx });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        // Generic outward, real error to the surface log — same no-leak
        // posture as the router's error boundary. (A handler that tried
        // `force: true` surfaces here as the wrapper's rejection.)
        const kind = entry.kind;
        ctx.log.error(`${kind} "${entry.def.kebabName}" failed: ${(err as Error).message ?? err}`);
        return toolError(`${kind} "${entry.def.kebabName}" failed — see the surface log`);
      }
    });

    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
