/**
 * Operator auth — the canonical surface-client path (hosted-mode hub
 * OAuth). The operator's vault DATA path stays direct-to-hub like every
 * static surface; this surface only needs the hub JWT to present as a
 * per-request Bearer on its own backend routes (grants, doc create,
 * tickets) — the backend validates it via scope-guard like any resource
 * server. The AUDIENCE never sees any of this: their identity is the
 * link-session cookie.
 */

import { type VaultSurface, createVaultSurface } from "@openparachute/surface-client";
import { loadToken } from "@openparachute/surface-client";

const APP_NAME = "docs";
const VAULT_NAME = "default";

export function createOperatorAuth(): VaultSurface {
  return createVaultSurface({
    clientName: "Docs",
    appName: APP_NAME,
    vaultName: VAULT_NAME,
    // The backend's operator branch requires the vault-pinned write scope
    // (`vault:default:write`) — request exactly that shape.
    scope: `vault:${VAULT_NAME}:read vault:${VAULT_NAME}:write`,
  });
}

/** The stored hub JWT for Bearer presentation, or null (not signed in). */
export function operatorBearer(): string | null {
  const stored = loadToken(APP_NAME, VAULT_NAME);
  return stored?.accessToken ?? null;
}

/** True when the current URL is the OAuth redirect callback. */
export function isOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has("code") && params.has("state");
}
