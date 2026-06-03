/**
 * Minimal standalone Parachute surface — the whole thing in one file.
 *
 * Demonstrates the STANDALONE bootstrap (§3 of the surface-client design
 * doc): a surface with no Parachute surface-host in front of it self-registers
 * via RFC 7591 Dynamic Client Registration and drives the OAuth dance with
 * `ParachuteOAuth`, then queries the vault with `VaultClient`.
 *
 * Every Parachute interaction below comes from `@openparachute/surface-client`
 * — none of it is hand-rolled. That's the point: a custom surface is an
 * import, not a ~1,300-line fork.
 *
 * Framework-free on purpose so the flow is legible. A real surface wires the
 * same calls into React/Svelte/Vue/etc.
 */

import {
  type OAuthClientInfo,
  ParachuteOAuth,
  VaultAuthError,
  VaultClient,
  VaultError,
  VaultPermissionError,
  VaultUnreachableError,
  discoverAuthServer,
  registerClient,
} from "@openparachute/surface-client";

// --- configuration -------------------------------------------------------

/** Shown on the hub consent screen the first time the operator approves us. */
const CLIENT_NAME = "Standalone Surface Example";
/** Storage-key segment + the vault we request access to. */
const VAULT_NAME = "default";
/** Must exactly match the redirect URI we register via DCR. */
const REDIRECT_URI = `${window.location.origin}/oauth/callback`;
/** localStorage key for the cached DCR client_id (register once per browser). */
const DCR_CACHE_KEY = "example.dcr";

// --- DCR client_id cache --------------------------------------------------
//
// The hub binds client_id to redirect_uri, so we cache per (issuer,
// redirectUri) and re-register only when either changes.

interface CachedRegistration {
  issuer: string;
  redirectUri: string;
  clientId: string;
}

function loadCachedClientId(issuer: string): string | null {
  try {
    const raw = localStorage.getItem(DCR_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedRegistration;
    if (cached.issuer !== issuer) return null;
    if (cached.redirectUri !== REDIRECT_URI) return null;
    return cached.clientId;
  } catch {
    return null;
  }
}

function saveCachedClientId(issuer: string, clientId: string): void {
  try {
    localStorage.setItem(
      DCR_CACHE_KEY,
      JSON.stringify({ issuer, redirectUri: REDIRECT_URI, clientId } satisfies CachedRegistration),
    );
  } catch {
    // best-effort
  }
}

// --- bootstrap ------------------------------------------------------------

/**
 * Build a `ParachuteOAuth` for a standalone surface: discover the AS, reuse
 * or DCR-register a client_id, and seed it via `useClientId` so the driver
 * never calls the hosted-only `/surface/<name>/oauth-client` endpoint.
 */
async function bootstrapOAuth(hubUrl: string): Promise<ParachuteOAuth> {
  const oauth = new ParachuteOAuth({ appName: "standalone-example", hubUrl });

  // 1. RFC 8414 discovery — learn the AS endpoints (incl. registration).
  const metadata = await discoverAuthServer(hubUrl);

  // 2. Reuse a cached client_id, or RFC 7591 DCR-register a fresh one.
  let clientId = loadCachedClientId(metadata.issuer);
  if (!clientId) {
    const registration = await registerClient(metadata.registration_endpoint, {
      clientName: CLIENT_NAME,
      redirectUri: REDIRECT_URI,
    });
    clientId = registration.client_id;
    saveCachedClientId(metadata.issuer, clientId);
  }

  // 3. Hand the driver the standalone client identity.
  const info: OAuthClientInfo = { client_id: clientId, scopes: ["vault:read", "vault:write"] };
  oauth.useClientId(info);

  return oauth;
}

// --- flow: login ----------------------------------------------------------

export async function login(hubUrl: string): Promise<void> {
  sessionStorage.setItem("example.hubUrl", hubUrl);
  const oauth = await bootstrapOAuth(hubUrl);
  const { authorizeUrl } = await oauth.beginFlow({
    vaultName: VAULT_NAME,
    scope: "vault:read vault:write",
    redirectUri: REDIRECT_URI,
  });
  window.location.assign(authorizeUrl);
}

// --- flow: handle the callback -------------------------------------------

export async function handleCallback(): Promise<void> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("Callback missing code/state");

  const hubUrl = sessionStorage.getItem("example.hubUrl");
  if (!hubUrl) throw new Error("Lost the hub URL — start the sign-in again.");

  const oauth = await bootstrapOAuth(hubUrl);
  await oauth.handleCallback(code, state, VAULT_NAME);
  // Strip the code/state from the URL and return to the app root.
  window.history.replaceState({}, "", window.location.origin);
}

// --- using the vault ------------------------------------------------------

export async function loadNotes(hubUrl: string, tag: string): Promise<string> {
  const oauth = await bootstrapOAuth(hubUrl);
  const stored = oauth.getToken(VAULT_NAME);
  if (!stored) return "Not signed in.";

  const vault = new VaultClient({
    vaultUrl: `${hubUrl.replace(/\/$/, "")}/vault/${VAULT_NAME}`,
    accessToken: stored.accessToken,
    // Auto-refresh on 401 — the loop both real adopters wrote by hand.
    //
    // PRODUCTION NOTE: this example closes over `stored.refreshToken`, which is
    // a simplification. `refreshAccessToken` ROTATES the refresh token (RFC 6749
    // §6 rotation — each call returns a fresh one that supersedes the prior),
    // and `oauth.refreshAccessToken` already persists it. So in a real surface,
    // re-read the latest token from `oauth.getToken(VAULT_NAME)` here rather
    // than reusing the closed-over `stored.refreshToken` — otherwise a SECOND
    // 401 in the same client would replay the now-superseded refresh token and
    // fail. (The `createVaultSurface` factory's `getClient()` does exactly this
    // re-read; prefer it for new surfaces.)
    onAuthError: async () => {
      const current = oauth.getToken(VAULT_NAME);
      const refreshToken = current?.refreshToken;
      if (!refreshToken) return null;
      const { token } = await oauth.refreshAccessToken(refreshToken, VAULT_NAME);
      return token.access_token;
    },
  });

  try {
    const notes = await vault.queryNotes({ tag });
    // (queryNotes returns Note[].)
    return `Found ${notes.length} note(s) tagged "${tag}".`;
  } catch (err) {
    // Typed-error → UI affordance mapping (see README "Error handling").
    if (err instanceof VaultPermissionError) return "Your token lacks the scope for that vault.";
    if (err instanceof VaultAuthError) return "Session expired — sign in again.";
    if (err instanceof VaultUnreachableError)
      return "Can't reach your hub — check the URL / network.";
    if (err instanceof VaultError) return `Vault error: ${err.message}`;
    throw err;
  }
}
