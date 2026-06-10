/**
 * defineProjection — P9, the woven-boulder primitive.
 *
 * A projection declares a DOMAIN query once — name, params, the vault
 * query it compiles to, the shape each note projects through, and a
 * human/AI-facing description — and the kit derives BOTH consumer faces
 * from that single definition:
 *
 *   - **REST**: `GET ${mount}/api/<kebab-name>` (createSurfaceProjections
 *     emits it as a `SurfaceRoute`, so it rides the SAME P7/P8 gateway —
 *     rate limit, actor resolution, access declaration — as every other
 *     route).
 *   - **MCP**: a tool named `<kebab-name>` on the per-surface
 *     Streamable-HTTP endpoint, `describe` as its description and the
 *     params declaration compiled to its `inputSchema`.
 *
 * Browsers and AI clients both get domain vocabulary ("upcoming
 * meetings"), never raw tags/notes/links: the ONLY data that leaves a
 * projection is `notes.map(shape)` — the note object itself never rides
 * out unless the author's shape function explicitly copies fields.
 *
 * Access is part of the definition (default `"audience"` — deny-by-
 * default; a public projection is an explicit opt-in) and is enforced
 * identically on both faces: the REST route declares it to the gateway,
 * and the MCP endpoint filters its tool list + dispatch by the SAME
 * predicate, so an anon caller sees only the projections the audience
 * policy allows.
 */

import type { NotesQueryInput } from "@openparachute/surface-client";
import type { Actor, Note } from "../types.ts";
import {
  type CompiledParams,
  type ParamsDecl,
  type ParamsOf,
  compileParamsDecl,
} from "./params.ts";

/**
 * Who may call a projection — the router's non-note access kinds.
 * (`note`-kind access doesn't apply: a projection is a query over many
 * notes, not an operation on one.)
 */
export type ProjectionAccess = "public" | "audience" | "operator";

const PROJECTION_ACCESS: readonly ProjectionAccess[] = ["public", "audience", "operator"];

/** Does `actor` clear a projection's access bar? (Shared REST/MCP.) */
export function projectionAllows(access: ProjectionAccess, actor: Actor): boolean {
  switch (access) {
    case "public":
      return true;
    case "audience":
      return actor.kind !== "anon";
    case "operator":
      return actor.kind === "operator";
  }
}

export interface DefineProjectionArgs<D extends ParamsDecl> {
  /**
   * Domain name, `camelCase` or `kebab-case` (`upcomingMeetings` →
   * REST `/api/upcoming-meetings`, MCP tool `upcoming-meetings`).
   */
  name: string;
  /** Param declarations (`{ from: 'date?' }`). Omit for a no-param query. */
  params?: D;
  /** Compile validated params into the vault query to run. */
  query: (params: ParamsOf<D>) => NotesQueryInput;
  /**
   * Project ONE note into the domain shape callers receive. This is the
   * no-raw-leak boundary: only what this function returns leaves the
   * surface. (Need `note.content`? Set `includeContent: true` in `query` —
   * vault list results omit content by default.)
   */
  shape: (note: Note, params: ParamsOf<D>) => unknown;
  /** The MCP tool description — domain vocabulary, written for an AI client. */
  describe: string;
  /** Who may call it. Default `"audience"` (deny-by-default). */
  access?: ProjectionAccess;
}

/**
 * A compiled projection. Type-erased relative to its declaration — the
 * param typing lives at the `defineProjection` call site (authors get
 * typed `params` in `query`/`shape`); the runtime contract is that
 * `query`/`shape` only ever receive params produced by `parseParams`
 * against this same declaration.
 */
export interface ProjectionDefinition {
  /** The declared domain name (as written). */
  name: string;
  /** Kebab-case identity: the REST path segment AND the MCP tool name. */
  kebabName: string;
  /** Mount-relative REST path (`/api/<kebab-name>`). */
  restPath: string;
  params: ParamsDecl;
  /**
   * The declaration compiled ONCE at define time — the request path
   * (REST + MCP) validates against this, never re-parsing spec strings.
   */
  compiledParams: CompiledParams;
  query: (params: Record<string, unknown>) => NotesQueryInput;
  shape: (note: Note, params: Record<string, unknown>) => unknown;
  describe: string;
  access: ProjectionAccess;
}

/**
 * Kebab segments the kit itself routes: `a` is the capability entry
 * prefix (`/api/a/<token>`) and `mcp` is the projection MCP endpoint.
 */
const RESERVED_NAMES = new Set(["a", "mcp", "ws"]);

/** `upcomingMeetings` → `upcoming-meetings`; kebab input passes through. */
export function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function defineProjection<D extends ParamsDecl = Record<string, never>>(
  args: DefineProjectionArgs<D>,
): ProjectionDefinition {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(args.name)) {
    throw new Error(
      `defineProjection: name "${args.name}" is invalid — letters/digits/hyphen, starting with a letter (camelCase or kebab-case)`,
    );
  }
  const kebabName = kebabCase(args.name);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(kebabName)) {
    throw new Error(`defineProjection: name "${args.name}" derives invalid kebab "${kebabName}"`);
  }
  if (RESERVED_NAMES.has(kebabName)) {
    throw new Error(
      `defineProjection: name "${args.name}" is reserved (${[...RESERVED_NAMES].join(", ")} are kit namespaces)`,
    );
  }
  if (typeof args.describe !== "string" || args.describe.trim().length === 0) {
    throw new Error(
      `defineProjection: "${args.name}" needs a non-empty describe — it IS the MCP tool description`,
    );
  }
  const access = args.access ?? "audience";
  if (!PROJECTION_ACCESS.includes(access)) {
    throw new Error(
      `defineProjection: "${args.name}" has invalid access "${access}" — expected ${PROJECTION_ACCESS.join("/")}`,
    );
  }
  const params = args.params ?? ({} as D);
  // Validate AND compile once — per-request validation consumes the
  // compiled `{type, optional}` form, never re-parsing spec strings.
  const compiledParams = compileParamsDecl(params);

  return {
    name: args.name,
    kebabName,
    restPath: `/api/${kebabName}`,
    params,
    compiledParams,
    // Safe erasure: both functions are only ever invoked with the output
    // of `parseParams(params, …)`, which produces exactly `ParamsOf<D>`.
    query: args.query as (p: Record<string, unknown>) => NotesQueryInput,
    shape: args.shape as (note: Note, p: Record<string, unknown>) => unknown,
    describe: args.describe,
    access,
  };
}
