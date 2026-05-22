/**
 * PKCE (RFC 7636) helpers for OAuth 2.1 with S256 code challenge.
 *
 * Pure Web Crypto — no dependencies. Mirrors the Notes implementation
 * (notes/src/lib/vault/pkce.ts) byte-for-byte; the only delta is the
 * file lives in app-client now so future apps can drop the copy.
 *
 * ## Secure context requirement
 *
 * `crypto.subtle` is only available in secure contexts (HTTPS,
 * localhost, 127.0.0.1). An IP-on-LAN deployment over plain HTTP will
 * have `crypto.subtle === undefined`. We throw `InsecureContextError`
 * up front instead of letting the call land on a cryptic
 * `Cannot read property 'digest' of undefined`.
 */

export class InsecureContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureContextError";
  }
}

const INSECURE_CONTEXT_MESSAGE =
  "OAuth requires a secure context (HTTPS or http://localhost). " +
  "This page is loaded in an insecure context — Web Crypto isn't available. " +
  "Reload via HTTPS (e.g. through Tailscale Serve, Cloudflare Tunnel, or a reverse proxy) " +
  "or access the hub at http://localhost directly.";

function assertWebCryptoDigest(): void {
  if (typeof crypto === "undefined" || !crypto.subtle?.digest) {
    throw new InsecureContextError(INSECURE_CONTEXT_MESSAGE);
  }
}

function assertWebCryptoRandom(): void {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new InsecureContextError(INSECURE_CONTEXT_MESSAGE);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(bytes = 32): string {
  if (bytes < 32 || bytes > 96) {
    throw new Error("code_verifier entropy must be between 32 and 96 bytes");
  }
  assertWebCryptoRandom();
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function deriveCodeChallenge(verifier: string): Promise<string> {
  assertWebCryptoDigest();
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

export function generateState(bytes = 16): string {
  assertWebCryptoRandom();
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}
