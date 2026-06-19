/**
 * Meeting MCP — a READ-only BACKED surface that reads `#capture/meeting`
 * notes from the vault and exposes them as an end-user-friendly MCP tool
 * set + REST, surfacing DOMAIN VOCABULARY (recent meetings, search, one
 * meeting) — never raw vault notes.
 *
 * This is the reusable template for the "custom MCP over a vault" pattern
 * (e.g. a city-council-meetings vault). It demonstrates the P9 projection
 * primitive: declare a domain query once (`defineProjection`), and the
 * kit derives BOTH faces — REST + a per-surface Streamable-HTTP MCP
 * endpoint — riding the SAME deny-by-default gateway as every other
 * surface (rate limit → actor resolution → declared access).
 *
 * It composes downstream of an ingest surface: meeting-ingest WRITES
 * `#meeting` notes from provider webhooks; this surface READS them (point
 * both at the same tag). ingest → vault → this read-MCP.
 *
 * Composition is the kit's (this file only wires):
 *   - **Auth** (P7): `createSurfaceAuth` resolves the actor (operator hub
 *     JWT · capability/link session · anon) for every request.
 *   - **Authz** (P8): a `GrantStore` is constructed + started for the
 *     router contract. This surface declares no `note`-kind routes (the
 *     projections are their own access kind), so `can()` is never reached
 *     — but starting it keeps the kit contract and lets a future
 *     `"audience"` projection's grants Just Work.
 *   - **Projections** (P9): `createSurfaceProjections` turns the
 *     projection set into `SurfaceRoute[]` (one GET per projection + the
 *     `/api/mcp` endpoint), spread into `createSurfaceRouter`.
 *
 * READ-ONLY (hard invariant): the surface NEVER writes the vault — no
 * createNote/updateNote/deleteNote anywhere. It only ever calls
 * `ctx.vault.queryNotes`. The operator scopes the read credential to the
 * meeting tag at provision time (`scopes_required: ["vault:default:read"]`).
 *
 * No module-level side effects (the P1 contract): all work starts in the
 * factory and stops on `shutdown()`.
 */

import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import {
  GrantStore,
  type SurfaceAuthOptions,
  createSurfaceAuth,
  createSurfaceAuthz,
  createSurfaceProjections,
  createSurfaceRouter,
} from "@openparachute/surface-server";
import { DEFAULT_TAG, buildProjections } from "./projections.ts";

export interface BuildBackendOptions {
  /** Test seams forwarded to `createSurfaceAuth` (e.g. `validateHubJwt`). */
  authOptions?: SurfaceAuthOptions;
  /** Disable the router rate limiter (tests). */
  rateLimit?: false;
}

export interface BuiltBackend {
  backend: SurfaceBackend;
  grants: GrantStore;
  tag: string;
}

/** Resolve the working tag from config (`tag`), falling back to the default. */
export function resolveTag(ctx: SurfaceHostContext): string {
  const configTag = ctx.config.get("tag");
  return typeof configTag === "string" && configTag.trim().length > 0
    ? configTag.trim()
    : DEFAULT_TAG;
}

/** Inner factory — the default export plus the seams the tests need. */
export async function buildBackend(
  ctx: SurfaceHostContext,
  opts: BuildBackendOptions = {},
): Promise<BuiltBackend> {
  const tag = resolveTag(ctx);

  const auth = createSurfaceAuth(ctx, opts.authOptions ?? {});
  const grants = new GrantStore(ctx);
  const authz = createSurfaceAuthz(grants);
  // Start the live-grant cache for the router contract. This surface has no
  // note-kind routes, so `can()` is never invoked — but a future
  // `access: "audience"` projection would rely on it, so we keep it live.
  await grants.start();

  const projections = createSurfaceProjections(ctx, {
    projections: buildProjections(tag),
    serverName: "meeting-mcp",
    instructions:
      "Read-only domain projections over a vault's meeting notes. Each tool is a parameterized query returning curated JSON (id, title, date, summary/snippet/body) — never raw vault notes.",
  });

  const router = createSurfaceRouter(ctx, auth, authz, {
    routes: [...projections.routes],
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
  });

  const backend: SurfaceBackend = {
    fetch: router.fetch,
    shutdown: async () => {
      grants.stop();
    },
  };

  return { backend, grants, tag };
}

/** The P1 entry contract: `createBackend(ctx)` as the default export. */
export default async function createBackend(ctx: SurfaceHostContext): Promise<SurfaceBackend> {
  return (await buildBackend(ctx)).backend;
}
