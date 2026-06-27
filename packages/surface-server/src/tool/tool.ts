/**
 * defineTool — P9's WRITE-capable sibling of `defineProjection`.
 *
 * A projection declares a read-only DOMAIN query; a tool declares a
 * write-capable DOMAIN ACTION. Both ride the SAME per-surface
 * Streamable-HTTP MCP endpoint (`POST ${mount}/api/mcp`): `tools/list`
 * shows projections AND tools (only those the caller's access clears) and
 * `tools/call` dispatches to whichever owns the name. The difference is
 * the handler's reach:
 *
 *   - a projection's `query`/`shape` only ever call `ctx.vault.queryNotes`;
 *   - a tool's `handler` is `async ({ params, actor, ctx }) => result` and
 *     MAY call `ctx.vault.createNote` / `updateNote` / `deleteNote` — the
 *     whole point (e.g. a "send-feedback" tool that writes a note).
 *
 * THREE invariants carry over from the projection harness, verbatim,
 * because they are the load-bearing security of the shared endpoint:
 *
 *   1. **Per-actor visibility.** A denied/anon actor never sees the tool
 *      in `tools/list`; dispatch runs against the FILTERED list so a
 *      denied tool and a nonexistent tool return the IDENTICAL "unknown
 *      tool" error (no existence oracle).
 *   2. **Access is REQUIRED — there is NO default.** A write tool that
 *      forgot its access bar would be a footgun far worse than a leaky
 *      read (a read leak shows data; a write footgun lets anon mutate the
 *      vault). So unlike `defineProjection` (which defaults to `audience`),
 *      `defineTool` makes `access` a required field and `defineTool`
 *      THROWS if it is omitted. Deny-by-default is enforced identically to
 *      the router/projections via `toolAllows` (the same predicate as
 *      `projectionAllows`, re-exported for one source of truth).
 *   3. **Host-custodied write boundary.** The handler writes through
 *      `ctx.vault` (the `ScopedVaultClient`), which already REJECTS
 *      `force: true` host-side (the host never constructs it with
 *      `allowForce`). The kit adds no second force path; a tool that tries
 *      `force: true` is rejected by the wrapper, surfacing as the same
 *      in-band tool error as any other handler throw — generic outward,
 *      real error to the surface log.
 *
 * Access kinds reuse the router's non-note vocabulary
 * (`public` / `audience` / `operator`) exactly as projections do.
 * `public` IS expressible — but it is an explicit, eyes-open opt-in for a
 * world-writable action (e.g. an anonymous feedback drop), never a
 * default. The PR documenting this primitive states the posture: write
 * tools are deny-by-default with NO implicit access; the author must name
 * the bar.
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import {
  type CompiledParams,
  type ParamsDecl,
  type ParamsOf,
  compileParamsDecl,
} from "../projection/params.ts";
import { type ProjectionAccess, kebabCase, projectionAllows } from "../projection/projection.ts";
import type { Actor } from "../types.ts";

/**
 * Who may call a tool — the router's non-note access kinds, identical to
 * `ProjectionAccess`. (`note`-kind access doesn't apply: a tool is a
 * domain action, not an operation the router resolves a single note for.
 * A tool that mutates a specific note enforces note-level authorization
 * inside its handler via `ctx`/the GrantStore if needed.)
 */
export type ToolAccess = ProjectionAccess;

/**
 * Does `actor` clear a tool's access bar? Shared with the read face — the
 * SAME predicate gates projection visibility and tool visibility, so the
 * two faces of `/api/mcp` can never diverge on who-sees-what.
 */
export const toolAllows = projectionAllows;

/** What a tool handler receives — params validated, actor + ctx in hand. */
export interface ToolHandlerArgs<P> {
  /** Validated + coerced params (exactly the declared shape). */
  params: P;
  /** The actor resolved for THIS request (already cleared the access bar). */
  actor: Actor;
  /** The host context — `ctx.vault` is the write-capable ScopedVaultClient. */
  ctx: SurfaceHostContext;
}

export interface DefineToolArgs<D extends ParamsDecl> {
  /**
   * Domain name, `camelCase` or `kebab-case` (`sendFeedback` →
   * MCP tool `send-feedback`). Shares the projection name space — a tool
   * and a projection may not collide (enforced at `createSurfaceTools`).
   */
  name: string;
  /** Param declarations (`{ body: 'string', email: 'string?' }`). */
  params?: D;
  /** The MCP tool description — domain vocabulary, written for an AI client. */
  describe: string;
  /**
   * Who may call it. **REQUIRED — no default.** A write tool with no
   * declared access is a footgun; deny-by-default here means the author
   * must name the bar. `public` is expressible but is an explicit opt-in
   * for a world-writable action, never implicit.
   */
  access: ToolAccess;
  /**
   * The action. MAY mutate via `ctx.vault.createNote/updateNote/...`. Its
   * return value is JSON-serialized as the tool result. Throwing yields a
   * generic in-band tool error (real error to the surface log) — same
   * no-leak posture as the projection harness.
   */
  handler: (args: ToolHandlerArgs<ParamsOf<D>>) => unknown | Promise<unknown>;
}

/**
 * A compiled tool. Type-erased relative to its declaration (the param
 * typing lives at the `defineTool` call site); the runtime contract is
 * that `handler` only ever receives params produced by `parseParams`
 * against this same declaration.
 */
export interface ToolDefinition {
  /** The declared domain name (as written). */
  name: string;
  /** Kebab-case identity: the MCP tool name (shares the projection space). */
  kebabName: string;
  params: ParamsDecl;
  /** The declaration compiled ONCE at define time (no per-request re-parse). */
  compiledParams: CompiledParams;
  describe: string;
  access: ToolAccess;
  /** Marks this as a write tool when both faces share the dispatch list. */
  readonly mutates: true;
  handler: (args: {
    params: Record<string, unknown>;
    actor: Actor;
    ctx: SurfaceHostContext;
  }) => unknown | Promise<unknown>;
}

const TOOL_ACCESS: readonly ToolAccess[] = ["public", "audience", "operator"];

/**
 * Kit-routed kebab segments a tool may not claim — same reserved set as
 * projections (`a` entry prefix, `mcp` endpoint, `ws`).
 */
const RESERVED_NAMES = new Set(["a", "mcp", "ws"]);

export function defineTool<D extends ParamsDecl = Record<string, never>>(
  args: DefineToolArgs<D>,
): ToolDefinition {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(args.name)) {
    throw new Error(
      `defineTool: name "${args.name}" is invalid — letters/digits/hyphen, starting with a letter (camelCase or kebab-case)`,
    );
  }
  const kebabName = kebabCase(args.name);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(kebabName)) {
    throw new Error(`defineTool: name "${args.name}" derives invalid kebab "${kebabName}"`);
  }
  if (RESERVED_NAMES.has(kebabName)) {
    throw new Error(
      `defineTool: name "${args.name}" is reserved (${[...RESERVED_NAMES].join(", ")} are kit namespaces)`,
    );
  }
  if (typeof args.describe !== "string" || args.describe.trim().length === 0) {
    throw new Error(
      `defineTool: "${args.name}" needs a non-empty describe — it IS the MCP tool description`,
    );
  }
  // REQUIRED, NO DEFAULT — a write tool with no access bar is a footgun.
  // (`undefined` reaches here from a JS caller that skipped the field; the
  // type system blocks it for TS callers, this catches the dynamic path.)
  if (args.access === undefined) {
    throw new Error(
      `defineTool: "${args.name}" must declare access (public/audience/operator) — write tools are deny-by-default with NO implicit access`,
    );
  }
  if (!TOOL_ACCESS.includes(args.access)) {
    throw new Error(
      `defineTool: "${args.name}" has invalid access "${args.access}" — expected ${TOOL_ACCESS.join("/")}`,
    );
  }
  if (typeof args.handler !== "function") {
    throw new Error(`defineTool: "${args.name}" needs a handler function`);
  }
  const params = args.params ?? ({} as D);
  const compiledParams = compileParamsDecl(params);

  return {
    name: args.name,
    kebabName,
    params,
    compiledParams,
    describe: args.describe,
    access: args.access,
    mutates: true,
    // Safe erasure: the handler is only ever invoked with the output of
    // `parseParams(params, …)`, which produces exactly `ParamsOf<D>`.
    handler: args.handler as (a: {
      params: Record<string, unknown>;
      actor: Actor;
      ctx: SurfaceHostContext;
    }) => unknown | Promise<unknown>,
  };
}
