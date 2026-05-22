/**
 * RFC 8414 OAuth Authorization Server Metadata discovery + RFC 7591
 * Dynamic Client Registration helpers.
 *
 * Lives in app-client so every hosted app can run the same discovery
 * dance against the hub it's served from. Mirrors Notes' implementation
 * (`notes/src/lib/vault/discovery.ts`) with the same liberal-parser +
 * fail-loud-on-shape posture.
 */

import type { AuthorizationServerMetadata, ClientRegistration } from "./types.js";

const REQUIRED_FIELDS: (keyof AuthorizationServerMetadata)[] = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
];

/**
 * Fetch the AS metadata document for an issuer URL. The issuer URL is
 * the origin (or path-rooted issuer) whose `/.well-known/oauth-
 * authorization-server` resolves the discovery doc.
 *
 * Failure cases:
 *   - network failure → throws "Could not reach …" so the caller can
 *     distinguish from a hub-side error.
 *   - non-2xx response → throws "Discovery failed (…)" with the status.
 *   - missing required fields → throws "Discovery response missing X".
 *   - S256 not advertised → throws (PKCE-only clients can't continue).
 */
export async function discoverAuthServer(
  issuerUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<AuthorizationServerMetadata> {
  const metadataUrl = `${issuerUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;

  let res: Response;
  try {
    res = await fetchImpl(metadataUrl, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(`Could not reach hub at ${issuerUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(
      `Discovery failed (${res.status}). Is this a Parachute hub URL? Tried ${metadataUrl}`,
    );
  }

  const data = (await res.json()) as AuthorizationServerMetadata;
  for (const field of REQUIRED_FIELDS) {
    if (typeof data[field] !== "string" || !data[field]) {
      throw new Error(`Discovery response missing ${field}`);
    }
  }
  if (!data.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("Hub does not advertise S256 PKCE — cannot complete OAuth safely");
  }
  return data;
}

export type RegisterClientOpts = {
  /** Public client name surfaced on the hub consent screen. */
  clientName: string;
  /** Redirect URI the AS will bounce the browser back to after consent. */
  redirectUri: string;
};

/**
 * Register a public OAuth client with the hub (PKCE-only, no secret).
 * Sends `credentials: "include"` so hub-side same-hub auto-trust (design
 * doc section 6) can short-circuit the consent screen when the
 * operator's session cookie is already present.
 */
export async function registerClient(
  registrationEndpoint: string,
  opts: RegisterClientOpts,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<ClientRegistration> {
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // Same rationale as Notes: same-origin sends the hub session cookie
    // by default, but setting `include` is forward-compat for cross-
    // origin auto-approve once hub#201's CORS work lands.
    credentials: "include",
    body: JSON.stringify({
      client_name: opts.clientName,
      redirect_uris: [opts.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as ClientRegistration;
  if (!data.client_id) {
    throw new Error("Registration response missing client_id");
  }
  return data;
}
