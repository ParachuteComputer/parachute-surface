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
 * design names `${mount}/mcp`, but the host forwards ONLY
 * `${mount}/api/*` + `${mount}/ws` to a backend — so the kit serves
 * `${mount}/api/mcp` and ALSO declares `${mount}/mcp`, which becomes
 * live automatically if the host ever forwards the short namespace.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SurfaceHostContext } from "@openparachute/surface";
import { surfaceNameFromMount } from "../authz/grant-store.ts";
import type { RouteContext, SurfaceRoute } from "../authz/router.ts";
import type { Actor, Note } from "../types.ts";
import { paramsJsonSchema, parseParams } from "./params.ts";
import { type ProjectionDefinition, projectionAllows } from "./projection.ts";

export interface SurfaceProjectionsOptions {
  projections: ProjectionDefinition[];
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
   * route per projection plus the MCP endpoint. The router enforces
   * access; nothing here bypasses it.
   */
  routes: SurfaceRoute[];
  /** The compiled projection set (introspection / docs generation). */
  projections: readonly ProjectionDefinition[];
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
  const seen = new Set<string>();
  for (const p of projections) {
    if (seen.has(p.kebabName)) {
      throw new Error(
        `createSurfaceProjections: duplicate projection name "${p.kebabName}" — names must be unique after kebab-casing`,
      );
    }
    seen.add(p.kebabName);
  }

  const serverName = opts.serverName ?? `surface-${surfaceNameFromMount(ctx.mount)}`;
  const serverVersion = opts.serverVersion ?? "0.1.0";
  const instructions =
    opts.instructions ??
    `Domain projections over the ${surfaceNameFromMount(ctx.mount)} surface. Each tool is a read-only, parameterized query returning shaped JSON — domain vocabulary, not raw vault notes.`;

  // ---- face 1: REST -------------------------------------------------------
  const routes: SurfaceRoute[] = projections.map((p) => ({
    method: "GET",
    path: p.restPath,
    access: { kind: p.access },
    handler: (req: Request, route: RouteContext) => runRestProjection(ctx, p, req, route),
  }));

  // ---- face 2: MCP ---------------------------------------------------------
  const mcpHandler = (req: Request, route: RouteContext) =>
    handleMcpRequest(ctx, projections, route.actor, {
      serverName,
      serverVersion,
      instructions,
    })(req);
  // POST only — see the module header for why GET/DELETE 405 instead.
  routes.push(
    { method: "POST", path: "/api/mcp", access: { kind: "public" }, handler: mcpHandler },
    { method: "POST", path: "/mcp", access: { kind: "public" }, handler: mcpHandler },
  );

  return { routes, projections };
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
  const parsed = parseParams(p.params, raw);
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

function handleMcpRequest(
  ctx: SurfaceHostContext,
  projections: readonly ProjectionDefinition[],
  actor: Actor,
  info: McpServerInfo,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    // The router resolved `actor` for THIS request — visibility is
    // computed fresh every time (stateless: no session for it to go
    // stale on).
    const visible = projections.filter((p) => projectionAllows(p.access, actor));

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new Server(
      { name: info.serverName, version: info.serverVersion },
      { capabilities: { tools: {} }, instructions: info.instructions },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: visible.map((p) => ({
        name: p.kebabName,
        description: p.describe,
        inputSchema: paramsJsonSchema(p.params),
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      // Dispatch against the FILTERED list: a denied tool and a
      // nonexistent tool return the IDENTICAL error — no existence
      // oracle via differential messages (the router's 404 unification,
      // in tool vocabulary).
      const p = visible.find((t) => t.kebabName === name);
      if (!p) return toolError(`unknown tool: ${name}`);

      const parsed = parseParams(p.params, (args ?? {}) as Record<string, unknown>);
      if (!parsed.ok) {
        const issues = parsed.issues.map((i) => `${i.param}: ${i.message}`).join("; ");
        return toolError(`invalid params — ${issues}`);
      }

      try {
        const result = await runProjection(ctx, p, parsed.params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        // Generic outward, real error to the surface log — same no-leak
        // posture as the router's error boundary.
        ctx.log.error(`projection "${p.kebabName}" failed: ${(err as Error).message ?? err}`);
        return toolError(`projection "${p.kebabName}" failed — see the surface log`);
      }
    });

    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
