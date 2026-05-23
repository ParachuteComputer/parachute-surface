/**
 * `@openparachute/app-client` — shared browser-side library for apps
 * hosted under parachute-app.
 *
 * Each hosted app today re-implements OAuth + vault client + token
 * storage from scratch (Notes did this; Gitcoin Brain has its own).
 * This library extracts the canonical pattern so future apps depend on
 * one well-tested implementation. Same trajectory as
 * `@openparachute/scope-guard` for resource-server JWT validation.
 *
 * Design doc: 2026-05-21-parachute-apps-design.md (parachute.computer)
 * Surface:
 *   - `oauth`         — `ParachuteOAuth` driver class, PKCE + same-hub auto-trust
 *   - `vault-client`  — REST client with auto-refresh on 401/403
 *   - `token-storage` — localStorage-backed token persistence (per app, per vault)
 *   - `sw-reload`     — service-worker reload helper (PWA-mode apps)
 *   - `vault-id`      — canonical URL → vault-id mapping (URL drift fix)
 *
 * Consumers can import from the barrel (`@openparachute/app-client`)
 * or the named subpath (`@openparachute/app-client/oauth`) — both
 * resolve to the same modules; subpaths exist for tree-shake
 * friendliness when a consumer only needs one piece.
 */

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
  VaultAuthError,
  VaultNotFoundError,
  VaultUnreachableError,
  VaultConflictError,
  VaultTargetExistsError,
  VaultUploadError,
  type VaultClientOptions,
} from "./vault-client.js";

// Vault REST resource types.
export type {
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

// Runtime tenancy contract helpers — read the meta tags parachute-app's
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
 * Library semver — kept in sync with `package.json` so consumers can
 * surface "app-client 0.1.0" diagnostics in a banner.
 */
export const APP_CLIENT_VERSION = "0.1.0-rc.4";
