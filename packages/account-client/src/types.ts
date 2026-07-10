/**
 * Wire types for the Parachute account/door contract.
 *
 * These mirror the JSON shapes in the Phase-2 breakdown §1 (the `/account/*`
 * REST surface both doors mount) and CONCEPT-2 §7 (the SDK API surface). The
 * two doors — Hub (self-hosted) and Cloud (hosted) — expose the SAME wire
 * contract; the capability descriptor (`AccountCapabilities`) is the honest
 * per-door difference the UI reads to know which features exist.
 *
 * The server endpoints do not exist yet (Hub H2 / Cloud C3 build them); this
 * package is the CLIENT against the SPEC, so these types ARE the contract the
 * door implementations must satisfy.
 */

/** Which door answered the discovery descriptor. */
export type Door = "cloud" | "hub";

/**
 * The `GET /.well-known/parachute-account` descriptor (public, no auth). One
 * handler per door; the ONLY thing that differs between an app talking to Hub
 * vs Cloud. Drives honest per-door UI: gate a feature on `features.*`, decide
 * whether the caps editor is writable on `caps_writable`.
 *
 * §1 "Discovery":
 *   { door, issuer, account_token, features{…}, caps_writable, limits{…} }
 */
export interface AccountCapabilities {
  door: Door;
  /** The token issuer origin (e.g. `https://cloud.parachute.computer`). */
  issuer: string;
  /** How to mint the account credential (§4 — POST + cookie). */
  account_token: {
    endpoint: string;
    method: string;
    /** The auth scheme the mint expects — `"cookie"` today. */
    scheme: string;
  };
  features: AccountFeatures;
  /**
   * Whether `PUT /account/vaults/<name>/caps` accepts operator-set caps
   * (Hub: true) or refuses them because caps are plan-derived (Cloud: false).
   * [PLAN-DECISION D2-a] — an explicit flag, since `features` alone can't
   * disambiguate the two `PUT caps` postures.
   */
  caps_writable: boolean;
  limits: AccountLimits;
}

/** Per-door feature flags. `plans` is the tier list on Cloud, `null` on Hub. */
export interface AccountFeatures {
  vault_create: boolean;
  vault_delete: boolean;
  import: boolean;
  export: boolean;
  billing: boolean;
  /** Plan tiers on Cloud (e.g. `["entry","standard","plus","power"]`); `null` on Hub. */
  plans: string[] | null;
  modules: boolean;
  expose: boolean;
}

export interface AccountLimits {
  /** The owner's plan ceiling on vault count; `null` when unlimited (Hub). */
  vaults_max: number | null;
}

/** Byte usage for a vault, when the door reports it. */
export interface VaultUsage {
  notes_bytes: number;
  attachment_bytes: number;
}

/**
 * One row from `GET /account/vaults`. `usage` + `caps` are present when the
 * door reports them (the console already renders these on Cloud); `caps` is
 * a door-specific shape, held opaque here.
 */
export interface VaultSummary {
  name: string;
  url: string;
  created_at: string;
  usage?: VaultUsage;
  caps?: Record<string, unknown>;
}

/** Service-catalog entry attached to a minted vault token (`aud`, url, version). */
export interface VaultService {
  url: string;
  version: string;
}

/**
 * The `POST /account/vaults` 201 response — **the hinge** (§1, CONCEPT-2 §6):
 * a ready-to-use vault token so the app lands the user IN the vault with zero
 * extra OAuth round-trips.
 *
 * `vault_token` can be `""` on the Hub when no hub origin was reachable at
 * mint time (§1 caveat, `admin-vaults.ts`); {@link AccountClient.createVault}
 * transparently falls back to a `POST …/token` mint in that case, so callers
 * always receive a non-empty token or a thrown error.
 */
export interface CreatedVault {
  name: string;
  url: string;
  /** `aud=vault.<name>` token scoped `vault:<name>:read vault:<name>:write`. */
  vault_token: string;
  services?: Record<string, VaultService>;
}

/**
 * The `POST /account/vaults/<name>/token` response — the per-vault mint that
 * bypasses the OAuth redirect (CONCEPT-2 §4).
 */
export interface VaultToken {
  vault_token: string;
  /** ISO-8601 expiry, when the door reports it. */
  expires_at?: string;
  services?: Record<string, VaultService>;
}

/**
 * The `POST /account/token` response — the account credential minted from the
 * session cookie (§2, §4). Short-TTL, `aud="account"`; the SDK holds it IN
 * MEMORY only and never persists it (F6). `expires_in` is seconds (OAuth
 * style), so the SDK can derive a near-expiry re-mint window.
 */
export interface AccountTokenResponse {
  account_token: string;
  /** Seconds until expiry (OAuth `expires_in`). */
  expires_in: number;
  token_type?: string;
}

/** `GET /account` bootstrap — who the account is. */
export interface AccountInfo {
  account_id: string;
  email: string;
  plan?: string;
  door: Door;
}

/** `GET /account/plan` — `{ tier, usage, options }` (Cloud-only; `null` on Hub). */
export interface PlanInfo {
  tier: string;
  usage: Record<string, unknown>;
  /** Available plan options the owner can switch to. */
  options: string[];
}

/** Which Stripe surface `openBilling` targets. */
export type BillingKind = "checkout" | "portal";

/** Options for {@link AccountClient.createVault}. */
export interface CreateVaultOptions {
  name: string;
  /** Optional seed pack the door provisions the new vault from. */
  seedPack?: string;
}
