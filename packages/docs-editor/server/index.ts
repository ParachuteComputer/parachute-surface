/**
 * Docs — the collaborative-editor backed surface (R6). Server entry,
 * surface-runtime P1: the host imports this module and calls the default
 * export once per mount with the injected `SurfaceHostContext` (P2).
 *
 * Composition (every piece is the kit's; this file only wires):
 *
 *   - **Auth** (P7): capability + personal links for the audience; the
 *     operator branch is a hub JWT via scope-guard. The entry route,
 *     session cookies, and link minting all come from `createSurfaceAuth`.
 *   - **Authz** (P8): vault-native GrantStore (notes tagged
 *     `surface-acl/docs`), STARTED — the live-SSE cache is the per-doc
 *     enforcement read, failing CLOSED while degraded.
 *   - **Reconciliation** (P10): `createVaultReconciler` over the working
 *     tag — vault is source of truth, external edit WINS, writebacks ride
 *     `if_updated_at` verbatim and re-seed on conflict. Hooks are the
 *     doc-schema codec (P11) — markdown-canonical, one codec, both faces.
 *   - **Collab**: the Hocuspocus engine class, manually pumped through
 *     the host's WS handlers (see collab.ts for the wiring contract).
 *
 * No module-level side effects (the P1 contract): everything starts in
 * the factory and stops on `ctx.shutdownSignal` / `shutdown()`.
 */

import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import {
  GrantStore,
  type RateLimitOptions,
  type SurfaceAuthOptions,
  type VaultReconciler,
  createSurfaceAuth,
  createSurfaceAuthz,
  createSurfaceRouter,
  createVaultReconciler,
} from "@openparachute/surface-server";
import { seedDocFromMarkdown, serializeDocToMarkdown } from "./codec.ts";
import { type Collab, createCollab } from "./collab.ts";
import { buildRoutes } from "./routes.ts";
import { TicketStore } from "./tickets.ts";

/** Default working tag — admin-overridable via the surface config. */
export const DEFAULT_WORKING_TAG = "doc";

export interface BuildBackendOptions {
  /** Test seams forwarded to `createSurfaceAuth` (e.g. `validateHubJwt`). */
  authOptions?: SurfaceAuthOptions;
  /** Router rate-limit tuning (tests raise it; production = kit defaults). */
  rateLimit?: RateLimitOptions | false;
  /** Reconciler debounce override (tests shrink it). */
  reconcilerDebounceMs?: number;
  /** Ticket TTL override (tests). */
  ticketTtlMs?: number;
}

/** What the tests get back alongside the backend. */
export interface BuiltBackend {
  backend: SurfaceBackend;
  reconciler: VaultReconciler;
  collab: Collab;
  tickets: TicketStore;
  workingTag: string;
}

/** Inner factory — the default export plus the seams the tests need. */
export async function buildBackend(
  ctx: SurfaceHostContext,
  opts: BuildBackendOptions = {},
): Promise<BuiltBackend> {
  const configTag = ctx.config.get("working_tag");
  const workingTag =
    typeof configTag === "string" && configTag.trim().length > 0
      ? configTag.trim()
      : DEFAULT_WORKING_TAG;

  const auth = createSurfaceAuth(ctx, opts.authOptions ?? {});
  const grants = new GrantStore(ctx);
  const authz = createSurfaceAuthz(grants);

  const reconciler = createVaultReconciler(ctx, {
    tag: workingTag,
    hooks: {
      seed: (doc, note) => seedDocFromMarkdown(doc, note.content ?? ""),
      serialize: (doc) => serializeDocToMarkdown(doc),
    },
    ...(opts.reconcilerDebounceMs !== undefined ? { debounceMs: opts.reconcilerDebounceMs } : {}),
  });

  // Both subscriptions up before the first request: grants enforce, the
  // reconciler watches for external edits.
  await Promise.all([grants.start(), reconciler.start()]);

  const tickets = new TicketStore(
    opts.ticketTtlMs !== undefined ? { ttlMs: opts.ticketTtlMs } : {},
  );
  const collab = createCollab({ ctx, authz, reconciler, tickets });

  const router = createSurfaceRouter(ctx, auth, authz, {
    routes: buildRoutes({ ctx, auth, authz, tickets, collab, workingTag }),
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
  });

  const backend: SurfaceBackend = {
    fetch: router.fetch,
    websocket: collab.websocket,
    shutdown: async () => {
      await collab.shutdown();
      await reconciler.stop(); // final flush — fail-closed to the end
      grants.stop();
    },
  };

  return { backend, reconciler, collab, tickets, workingTag };
}

/** The P1 entry contract: `createBackend(ctx)` as the default export. */
export default async function createBackend(ctx: SurfaceHostContext): Promise<SurfaceBackend> {
  return (await buildBackend(ctx)).backend;
}
