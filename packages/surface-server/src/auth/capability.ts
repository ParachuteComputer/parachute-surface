/**
 * Capability-token core — Prism's HMAC core kept verbatim in spirit
 * (design §3): a token is an anonymous bearer of a capability id, signed
 * with a per-surface secret so the id can't be forged or enumerated.
 *
 * Token wire format: `<kind>_<id>.<sig>`
 *
 *   - `kind` — `cap` (shareable capability link) | `lnk` (personal link,
 *     single-use exchange).
 *   - `id` — 16 random bytes, base64url. The GrantStore subject for a
 *     capability is `cap:<id>`.
 *   - `sig` — HMAC-SHA256 over `<kind>:<id>` with the surface's secret,
 *     base64url. Verified with a timing-safe compare.
 *
 * The secret is 32 random bytes minted on first use and custodied in the
 * surface's own state store (`ctx.store`) — deleted with the surface on
 * removal, never in the vault (operational, not knowledge).
 *
 * Transport rules live one layer up (`surface-auth.ts`, design §4): the
 * raw token rides only the entry URL or an `Authorization: Capability`
 * header, never a lingering query param.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Two token kinds — see the module header. */
export const TOKEN_KINDS = ["cap", "lnk"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface ParsedToken {
  kind: TokenKind;
  id: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** New 128-bit id (base64url, no padding). */
export function newTokenId(): string {
  return b64url(randomBytes(16));
}

/** New 256-bit signing secret (raw bytes). */
export function newSecret(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

function signPayload(secret: Uint8Array, kind: TokenKind, id: string): Buffer {
  return createHmac("sha256", secret).update(`${kind}:${id}`).digest();
}

/** Build the bearer string for a capability / link id. */
export function signToken(secret: Uint8Array, kind: TokenKind, id: string): string {
  return `${kind}_${id}.${b64url(signPayload(secret, kind, id))}`;
}

/**
 * Parse + verify a presented token. Returns the parsed kind/id on a valid
 * signature, null on ANY failure (shape, unknown kind, bad sig) — callers
 * branch on null, never on why.
 */
export function verifyToken(secret: Uint8Array, token: string): ParsedToken | null {
  const m = /^(cap|lnk)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  const kind = m[1] as TokenKind;
  const id = m[2] as string;
  const sig = m[3] as string;
  let presented: Buffer;
  try {
    presented = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = signPayload(secret, kind, id);
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  return { kind, id };
}
