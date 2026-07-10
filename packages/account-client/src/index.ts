/**
 * `@openparachute/account-client` — browser-side SDK for the Parachute
 * account/door contract.
 *
 * The client half of the `/account/*` wire contract (Phase-2 breakdown §1,
 * CONCEPT-2 §7): capability discovery, the cookie→account-token mint (held in
 * memory, never persisted — F6), and vault lifecycle (list/create/delete/
 * mint-token) against one door origin (Hub self-hosted or Cloud hosted).
 *
 * Sibling to `@openparachute/surface-client`: where surface-client is the
 * per-VAULT data plane (OAuth + vault REST), account-client is the per-ACCOUNT
 * control plane above it. It is deliberately dependency-free — the app passes
 * the door origin in (resolved via surface-client's `getHubOrigin()`), so this
 * package never carries a `workspace:` protocol into its published manifest.
 *
 * Import from the barrel (`@openparachute/account-client`) or the named
 * subpaths (`/account-client`, `/errors`) — both resolve to the same modules.
 */

// The account/door client + its helpers.
export {
  AccountClient,
  defaultVaultScopes,
  CSRF_FIELD_NAME,
  TOKEN_EXPIRY_SKEW_MS,
  type AccountClientOptions,
  type CsrfTokenSource,
} from "./account-client.js";

// Structured error hierarchy + the classifier helpers.
export {
  AccountError,
  AccountUnreachableError,
  AccountServerError,
  AccountAuthError,
  AccountPermissionError,
  VaultLimitError,
  AccountBadRequestError,
  AccountNotFoundError,
  AccountConflictError,
  AccountHttpError,
  classifyErrorResponse,
  parseErrorBody,
  type AccountErrorOptions,
  type ParsedErrorBody,
} from "./errors.js";

// Wire types for the account/door contract.
export type {
  Door,
  AccountCapabilities,
  AccountFeatures,
  AccountLimits,
  VaultUsage,
  VaultSummary,
  VaultService,
  CreatedVault,
  VaultToken,
  AccountTokenResponse,
  AccountInfo,
  PlanInfo,
  BillingKind,
  CreateVaultOptions,
} from "./types.js";

/**
 * Library semver — surfaced by consumers in diagnostics banners. Auto-derived
 * from `package.json` at build time via `scripts/gen-version.ts` (the
 * `prebuild` step), so it can never drift from the shipped version. Do not
 * hand-edit; bump `package.json` and the build regenerates `src/version.ts`.
 */
export { ACCOUNT_CLIENT_VERSION } from "./version.js";
