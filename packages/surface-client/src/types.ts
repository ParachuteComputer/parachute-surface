/**
 * Public types shared across the app-client surface.
 *
 * These mirror the shapes parachute-notes uses today (see
 * `parachute-notes/src/lib/vault/types.ts` — Notes is the canonical
 * implementation app-client generalizes). Names + shapes intentionally
 * line up so the Notes migration to app (design doc section 16) is a
 * mechanical swap from the in-repo lib path to `@openparachute/surface-client`.
 */

/**
 * OAuth scope strings are whitespace-separated lists per RFC 6749 §3.3.
 * The vocabulary follows `parachute-patterns/oauth-scopes.md` —
 * `<service>:<verb>` (`vault:read vault:write`). Type stays open: the
 * parser is liberal; unknown scopes pass through.
 */
export type TokenScope = string;

/**
 * RFC 8414 Authorization Server Metadata — the discovery doc shape every
 * Parachute hub serves at `/.well-known/oauth-authorization-server`.
 */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

/**
 * RFC 7591 Dynamic Client Registration response shape — what hub returns
 * after a public-client (PKCE-only) registration.
 */
export interface ClientRegistration {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

/**
 * Hub-as-portal Phase 1 service catalog — the hub returns this alongside
 * the token so the client doesn't have to ask for service URLs. Vault-
 * issued tokens omit it; clients must tolerate its absence.
 */
export interface ServiceCatalogEntry {
  url: string;
  version?: string;
}

export interface ServicesCatalog {
  vault?: ServiceCatalogEntry;
  scribe?: ServiceCatalogEntry;
  [key: string]: ServiceCatalogEntry | undefined;
}

/** Token-endpoint response shape (RFC 6749 §4.1.4 + hub extensions). */
export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
  scope: TokenScope;
  vault?: string;
  refresh_token?: string;
  expires_in?: number;
  services?: ServicesCatalog;
}

/**
 * Persisted token shape (the on-disk envelope for `token-storage`). Notes
 * stores one of these per (app, vaultScope) pair; refresh-on-401 mutates
 * the in-memory copy and writes back via `saveToken`.
 */
export interface StoredToken {
  accessToken: string;
  /** Absolute UTC ms (`Date.now()` baseline) — `now + expires_in * 1000`. */
  expiresAt?: number;
  refreshToken?: string;
  scope: TokenScope;
  /**
   * The vault binding the token applies to. For multi-vault apps this is
   * the concrete vault name (e.g. `"gitcoin"`); for single-vault tokens
   * it's the value the token endpoint returned.
   */
  vault?: string;
}

/** Pending OAuth flow state (sessionStorage, cleared on completion). */
export interface PendingOAuthState {
  issuerUrl: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
  scope: TokenScope;
  startedAt: string;
}
