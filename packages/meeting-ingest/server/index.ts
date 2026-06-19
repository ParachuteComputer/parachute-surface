/**
 * Meeting Ingest — a BACKED surface that turns a meeting provider's
 * "Transcription complete" webhook into a `#meeting` note in the vault.
 *
 * Server-side flow (Fireflies.ai today; structured so Read.ai can be added
 * as a second `/api/webhook/<provider>` later):
 *
 *   1. Provider POSTs a minimal webhook (no transcript body).
 *   2. We verify its HMAC signature against the operator-set shared secret,
 *      classify the event, dedup by `external_id`, fetch the full transcript
 *      from the provider's API, transform it to portable markdown + metadata,
 *      and write ONE `#meeting` note via the host-custodied vault credential.
 *
 * Composition is the kit's (this file only wires):
 *   - **Auth** (P7): `createSurfaceAuth` resolves the operator (hub JWT) for
 *     the config-status route; the webhook is public + HMAC-authed.
 *   - **Authz** (P8): a GrantStore is constructed for the router contract,
 *     but this surface declares no `note`-kind routes, so `can()` is never
 *     reached — there is no sharing/ACL surface here.
 *   - **Router**: `createSurfaceRouter` deny-by-default gateway.
 *
 * No module-level side effects (the P1 contract): all work starts in the
 * factory and stops on `ctx.shutdownSignal` / `shutdown()`.
 *
 * SECURITY: secrets live ONLY in `ctx.config`; they are never logged, never
 * written to a note, never returned in a response. The note write is the
 * surface's only vault effect.
 */

import type { SurfaceBackend, SurfaceHostContext } from "@openparachute/surface";
import {
  GrantStore,
  type SurfaceAuthOptions,
  createSurfaceAuth,
  createSurfaceAuthz,
  createSurfaceRouter,
} from "@openparachute/surface-server";
import { firefliesProvider } from "./providers/fireflies.ts";
import type { MeetingProvider } from "./providers/types.ts";
import { DEFAULT_TAG, buildRoutes } from "./routes.ts";

/** Providers this surface ships. Add Read.ai here when it lands. */
export const PROVIDERS: Record<string, MeetingProvider> = {
  [firefliesProvider.name]: firefliesProvider,
};

export interface BuildBackendOptions {
  /** Test seams forwarded to `createSurfaceAuth` (e.g. `validateHubJwt`). */
  authOptions?: SurfaceAuthOptions;
  /** Disable the router rate limiter (tests). */
  rateLimit?: false;
  /** Test seam for the transcript fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Override the provider set (tests). Defaults to {@link PROVIDERS}. */
  providers?: Record<string, MeetingProvider>;
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
  const providers = opts.providers ?? PROVIDERS;

  const auth = createSurfaceAuth(ctx, opts.authOptions ?? {});
  const grants = new GrantStore(ctx);
  const authz = createSurfaceAuthz(grants);
  // The live-grant cache backs `can()`; this surface has no note-kind routes
  // (no sharing), so `can()` is never invoked — but we start it so the kit's
  // contract holds and a future sharing route would Just Work.
  await grants.start();

  const router = createSurfaceRouter(ctx, auth, authz, {
    routes: buildRoutes({
      ctx,
      providers,
      tag,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    }),
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
