/**
 * `@openparachute/surface-client` — shared browser-side library for apps
 * hosted under parachute-app.
 *
 * Each hosted app today re-implements OAuth + vault client + token
 * storage from scratch (Notes did this; Gitcoin Brain has its own).
 * This library extracts the canonical pattern so future apps depend on
 * one well-tested implementation. Same trajectory as
 * `@openparachute/scope-guard` for resource-server JWT validation.
 *
 * Design doc: 2026-06-03-surface-client.md (parachute.computer) — the
 * make-custom-surfaces-a-thin-import plan; supersedes the barrel-module
 * reference that previously pointed at 2026-05-21-parachute-apps-design.md
 * (still the surface-host design; §16 is the migration arc that produced
 * this package).
 * Surface:
 *   - `create-vault-surface` — `createVaultSurface` turnkey factory (hosted/standalone auto-detect)
 *   - `oauth`         — `ParachuteOAuth` driver class, PKCE + DCR + same-hub auto-trust
 *   - `vault-client`  — REST client with auto-refresh on 401/403
 *   - `token-storage` — localStorage-backed token persistence (per app, per vault)
 *   - `sw-reload`     — service-worker reload helper (PWA-mode apps)
 *   - `vault-id`      — canonical URL → vault-id mapping (URL drift fix)
 *
 * Consumers can import from the barrel (`@openparachute/surface-client`)
 * or the named subpath (`@openparachute/surface-client/oauth`) — both
 * resolve to the same modules; subpaths exist for tree-shake
 * friendliness when a consumer only needs one piece.
 */

// Quick-start factory — the turnkey one-call entry (hosted/standalone
// auto-detect + sane defaults + an auto-refresh-wired VaultClient). The
// recommended starting point for a new surface; the lower-level pieces below
// remain available for advanced flows.
export {
  createVaultSurface,
  type CreateVaultSurfaceOpts,
  type VaultSurface,
  type SurfaceBootstrap,
  type SimpleStorageLike,
} from "./create-vault-surface.js";

// OAuth driver — public class, errors, helper types.
export {
  ParachuteOAuth,
  PendingApprovalError,
  RefreshHttpError,
  InsecureContextError,
  type ParachuteOAuthOpts,
  type BeginFlowOpts,
  type BeginFlowResult,
  type OAuthClientInfo,
  type SessionStorageLike,
  type TokenStorageLike,
} from "./oauth.js";

// PKCE primitives — exposed so callers driving custom OAuth dances can
// reuse the secure-context-guarded helpers.
export {
  generateCodeVerifier,
  generateState,
  deriveCodeChallenge,
} from "./pkce.js";

// AS discovery + DCR — exposed for one-off uses outside ParachuteOAuth.
export { discoverAuthServer, registerClient, type RegisterClientOpts } from "./discovery.js";

// Vault REST client + structured errors.
export {
  VaultClient,
  VaultError,
  VaultAuthError,
  VaultPermissionError,
  VaultNotFoundError,
  VaultUnreachableError,
  VaultServerError,
  VaultConflictError,
  VaultTargetExistsError,
  VaultUploadError,
  type VaultClientOptions,
} from "./vault-client.js";

// Typed notes-query builder — `NotesQuery` objects serialize to vault's
// exact wire grammar; accepted by queryNotes / queryNotesCursor / subscribe
// alongside the raw URLSearchParams / Record forms.
export {
  buildNotesQuery,
  isNotesQuery,
  toNotesSearchParams,
  type MetadataFilter,
  type MetadataOps,
  type MetadataScalar,
  type NotesDateFilter,
  type NotesQuery,
  type NotesQueryInput,
  type RawNotesQuery,
} from "./notes-query.js";

// Live-query SSE subscription — `VaultClient.subscribe()` is the consumer
// API; the parser + loop primitives are exported for advanced/raw use.
export {
  parseSSEStream,
  startSubscription,
  assertSubscribableQuery,
  type SSEEvent,
  type SubscribeHandlers,
  type SubscribeOptions,
  type SubscribeStatus,
  type SubscribeTransport,
} from "./subscribe.js";

// Vault REST resource types.
export type {
  TagExpandMode,
  VaultInfo,
  Note,
  NoteSummary,
  NoteLink,
  NoteAttachment,
  TagSummary,
  TagFieldSchema,
  TagRecord,
  TagUpsertPayload,
  UpdateNotePayload,
  CreateNotePayload,
  FindPathResult,
  StorageUploadResult,
  UploadProgress,
  ReachabilitySignal,
} from "./vault-types.js";

// Token persistence.
export {
  loadToken,
  saveToken,
  clearToken,
  clearAllTokensForApp,
  storedFromTokenResponse,
  tokenKey,
  TOKEN_KEY_PREFIX,
  type TokenStorageOpts,
} from "./token-storage.js";

// Service-worker reload helper (PWA-mode apps).
export {
  reloadAfterServiceWorkerUpdate,
  SW_RELOAD_FALLBACK_MS,
  __resetReloadArmedForTests,
  type ReloadAfterSWUpdateOpts,
} from "./sw-reload.js";

// Vault-id helpers — canonical URL → storage key, URL normalization.
export { vaultIdFromUrl, normalizeVaultUrl } from "./vault-id.js";

// Runtime tenancy contract helpers — read the meta tags parachute-surface's
// host injects into every served `index.html`. Apps get typed accessors
// for mount path, tenant id, hub origin, and bound vault URL instead of
// regex-parsing the DOM themselves. See
// `parachute-patterns/patterns/runtime-tenancy-contract.md`.
export { getMountBase, getTenantId, getHubOrigin, getVaultUrl } from "./mount.js";

// Common OAuth + storage types.
export type {
  TokenScope,
  AuthorizationServerMetadata,
  ClientRegistration,
  ServiceCatalogEntry,
  ServicesCatalog,
  TokenResponse,
  StoredToken,
  PendingOAuthState,
} from "./types.js";

/**
 * Library semver — surfaced by consumers in "surface-client 0.2.0" diagnostics
 * banners. Auto-derived from `package.json` at build time via
 * `scripts/gen-version.ts` (the `prebuild` step), so it can never drift from
 * the version the package actually ships at. See #57 — this previously stalled
 * at `0.1.0-rc.4` while `package.json` shipped `0.1.0`. Do not hand-edit; bump
 * `package.json` and the build regenerates `src/version.ts`.
 */
export { SURFACE_CLIENT_VERSION } from "./version.js";
// Local binding required to reference the value in the APP_CLIENT_VERSION alias
// below — a re-export alone doesn't bring the name into local value scope.
import { SURFACE_CLIENT_VERSION } from "./version.js";

/**
 * @deprecated Renamed to {@link SURFACE_CLIENT_VERSION} when
 * `parachute-app` → `parachute-surface` (2026-05-27). Retained as an
 * alias so existing diagnostics banners keep resolving; prefer
 * `SURFACE_CLIENT_VERSION` in new code.
 */
export const APP_CLIENT_VERSION = SURFACE_CLIENT_VERSION;
