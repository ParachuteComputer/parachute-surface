/**
 * @openparachute/surface-server — the server kit for backed surfaces
 * (surface-runtime design R4: P7–P9).
 *
 * A LIBRARY a surface backend imports inside `createBackend(ctx)` — never
 * a host object. The host (`@openparachute/surface`) injects the
 * `SurfaceHostContext`; this kit builds the trust machinery on top of it:
 *
 *   - **P7 `createSurfaceAuth`** — actor resolution (hub-JWT operator via
 *     scope-guard · capability/link sessions · anon), the AudienceStore,
 *     capability mint/verify/exchange, origin + rate-limit middleware.
 *   - **P8 `SurfaceAuthz`** — `can(actor, note, action)`, the
 *     vault-native GrantStore with a live-SSE fail-closed cache, the
 *     level→action table, and `createSurfaceRouter` (deny-by-default).
 *   - **P9 `defineProjection` + `createSurfaceProjections`** — declare a
 *     domain query once; the kit derives BOTH the audience-gated REST
 *     endpoint AND an MCP tool on the per-surface Streamable-HTTP
 *     endpoint, all riding the same gateway.
 *   - **conformance** (`./conformance` subpath) — the gateway invariants
 *     as a runnable suite any surface points at its own routes.
 *
 * Typical wiring:
 *
 * ```ts
 * import {
 *   createSurfaceAuth,
 *   createSurfaceAuthz,
 *   createSurfaceRouter,
 *   GrantStore,
 * } from "@openparachute/surface-server";
 *
 * export default async function createBackend(ctx: SurfaceHostContext) {
 *   const auth = createSurfaceAuth(ctx);
 *   const grants = new GrantStore(ctx);
 *   await grants.start(); // live-SSE grant cache (fail-closed)
 *   const authz = createSurfaceAuthz(grants);
 *   const router = createSurfaceRouter(ctx, auth, authz, { routes: [...] });
 *   return { fetch: router.fetch, shutdown: async () => grants.stop() };
 * }
 * ```
 */

// Shared vocabulary (levels, actions, actors, grants)
export {
  ACTIONS,
  ANON,
  grantMatchesNote,
  grantSubjectsFor,
  isLevel,
  LEVEL_ACTIONS,
  levelAllows,
  levelRank,
  LEVELS,
  RESOURCE_TYPES,
  type Action,
  type Actor,
  type AnonActor,
  type AudienceActor,
  type Grant,
  type Level,
  type Note,
  type OperatorActor,
  type ResourceType,
  type SurfaceHostContext,
  type SurfaceLogger,
  type TrustLayer,
} from "./types.ts";

// P7 — createSurfaceAuth + the pieces underneath it
export {
  newSecret,
  newTokenId,
  signToken,
  TOKEN_KINDS,
  verifyToken,
  type ParsedToken,
  type TokenKind,
} from "./auth/capability.ts";
export {
  AudienceStore,
  type AudienceStoreOptions,
  type CapabilityRecord,
  type SessionRecord,
  type SubjectRecord,
} from "./auth/audience-store.ts";
export { isMutation, originAllowed, requestHost } from "./auth/origin-check.ts";
export {
  RateLimiter,
  rateLimitedResponse,
  type RateLimitOptions,
  type RateLimitVerdict,
} from "./auth/rate-limit.ts";
export {
  AuthRefusal,
  createSurfaceAuth,
  getHubOrigin,
  SESSION_COOKIE,
  SurfaceAuth,
  type EmailSender,
  type ExchangeResult,
  type MintCapabilityArgs,
  type MintedCapability,
  type MintedPersonalLink,
  type MintPersonalLinkArgs,
  type ResolveActorResult,
  type SurfaceAuthOptions,
} from "./auth/surface-auth.ts";

// P8 — SurfaceAuthz + GrantStore + the deny-by-default router
export {
  aclTagFor,
  GrantStore,
  parseGrantNote,
  surfaceNameFromMount,
  type CreateGrantArgs,
  type GrantStoreOptions,
  type GrantSubjectType,
} from "./authz/grant-store.ts";
export { createSurfaceAuthz, SurfaceAuthz } from "./authz/surface-authz.ts";
export {
  createSurfaceRouter,
  type RouteAccess,
  type RouteContext,
  type RouteHandler,
  type SurfaceRoute,
  type SurfaceRouter,
  type SurfaceRouterOptions,
} from "./authz/router.ts";

// P9 — projections (one definition → REST + MCP)
export {
  PARAM_TYPES,
  paramsJsonSchema,
  parseParams,
  type ParamIssue,
  type ParamsDecl,
  type ParamsJsonSchema,
  type ParamsOf,
  type ParamSpec,
  type ParamType,
  type ParamValue,
  type ParseParamsResult,
} from "./projection/params.ts";
export {
  defineProjection,
  kebabCase,
  projectionAllows,
  type DefineProjectionArgs,
  type ProjectionAccess,
  type ProjectionDefinition,
} from "./projection/projection.ts";
export {
  createSurfaceProjections,
  type SurfaceProjections,
  type SurfaceProjectionsOptions,
} from "./projection/projections.ts";

// Conformance suite (also importable via the `./conformance` subpath)
export {
  gatewayConformanceCases,
  type ConformanceCase,
  type ConformanceProbe,
  type GatewayConformanceOptions,
  type ScopedActorSpec,
} from "./conformance.ts";
