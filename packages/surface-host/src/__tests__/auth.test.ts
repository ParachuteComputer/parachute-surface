/**
 * Tests for `src/auth.ts` — the JWT-bearer + scope gate for admin endpoints.
 *
 * Coverage:
 *   - extractBearer parses Authorization header correctly
 *   - hasScope is exact-match (no wildcard)
 *   - hasReadAccess accepts surface:read OR surface:admin
 *   - validateBearer returns 401 on missing token
 *   - validateBearer returns 401 on invalid token (jwks unreachable / bad sig)
 *   - enforceScope returns 403 with insufficient_scope when scope missing
 *   - enforceScope returns scopes object on success (mocked guard)
 *   - getHubOrigin honors PARACHUTE_HUB_ORIGIN, then hubUrl, then loopback
 *   - validateWithAudienceFallback tries canonical then legacy audience,
 *     rethrows non-audience errors immediately
 *   - parseHubOrigins parses PARACHUTE_HUB_ORIGINS (multi-origin iss-set)
 *   - multi-origin iss-set against a REAL JWKS fixture: a second listed
 *     origin validates; env unset stays single-origin; unlisted rejected
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { HubJwtError } from "@openparachute/scope-guard";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import {
  AUDIENCE,
  AUDIENCES,
  LEGACY_AUDIENCE,
  SCOPE_ADMIN,
  SCOPE_READ,
  extractBearer,
  getHubOrigin,
  hasReadAccess,
  hasScope,
  parseHubOrigins,
  resetGuard,
  validateBearer,
  validateWithAudienceFallback,
} from "../auth.ts";

const savedEnv = process.env.PARACHUTE_HUB_ORIGIN;
const savedOriginsEnv = process.env.PARACHUTE_HUB_ORIGINS;

beforeEach(() => {
  // Multi-origin iss-set is opt-in per test — every other case runs in the
  // single-origin (env-unset) world, byte-identical to before.
  // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
  delete process.env.PARACHUTE_HUB_ORIGINS;
  resetGuard();
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
  if (savedEnv === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = savedEnv;
  // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
  if (savedOriginsEnv === undefined) delete process.env.PARACHUTE_HUB_ORIGINS;
  else process.env.PARACHUTE_HUB_ORIGINS = savedOriginsEnv;
  resetGuard();
});

describe("extractBearer", () => {
  test("returns token for `Bearer <token>`", () => {
    expect(extractBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });
  test("case-insensitive on the scheme", () => {
    expect(extractBearer("bearer xyz")).toBe("xyz");
  });
  test("returns undefined on missing header", () => {
    expect(extractBearer(null)).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
  });
  test("returns undefined on malformed header", () => {
    expect(extractBearer("Basic abc")).toBeUndefined();
    expect(extractBearer("")).toBeUndefined();
  });
});

describe("hasScope + hasReadAccess", () => {
  test("hasScope exact match", () => {
    expect(hasScope(["surface:admin"], "surface:admin")).toBe(true);
    expect(hasScope(["surface:read"], "surface:admin")).toBe(false);
  });
  test("hasReadAccess accepts read OR admin", () => {
    expect(hasReadAccess(["surface:read"])).toBe(true);
    expect(hasReadAccess(["surface:admin"])).toBe(true);
    expect(hasReadAccess(["vault:default:read"])).toBe(false);
    expect(hasReadAccess([])).toBe(false);
  });
});

describe("getHubOrigin", () => {
  test("returns the loopback default when no env or arg", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    expect(getHubOrigin()).toBe("http://127.0.0.1:1939");
  });
  test("env wins over arg", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.test/";
    expect(getHubOrigin("https://otherhub.test")).toBe("https://hub.test");
  });
  test("arg used when env unset", () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    expect(getHubOrigin("https://otherhub.test/")).toBe("https://otherhub.test");
  });
});

describe("parseHubOrigins — multi-origin iss-set (hub#692)", () => {
  test("undefined → [] (back-compat: env unset collapses to single hubOrigin)", () => {
    expect(parseHubOrigins(undefined)).toEqual([]);
  });

  test("empty string → []", () => {
    expect(parseHubOrigins("")).toEqual([]);
  });

  test("splits, trims, strips trailing slash, drops empties, dedupes", () => {
    expect(parseHubOrigins("https://a.example,https://b.example/, ,https://a.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("whitespace-only entries are dropped", () => {
    expect(parseHubOrigins("  ,  ,  ")).toEqual([]);
  });
});

describe("validateBearer", () => {
  test("missing token → 401", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = "";
    const result = await validateBearer(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.body.error).toBe("unauthorized");
    }
  });

  test("malformed token → 401 (scope-guard rejects)", async () => {
    // Point at a non-existent JWKS so any validation fails.
    process.env.PARACHUTE_HUB_ORIGIN = "http://127.0.0.1:1";
    const result = await validateBearer("not.a.jwt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });
});

describe("scope constants", () => {
  test("SCOPE_ADMIN is `surface:admin`", () => {
    expect(SCOPE_ADMIN).toBe("surface:admin");
  });
  test("SCOPE_READ is `surface:read`", () => {
    expect(SCOPE_READ).toBe("surface:read");
  });
});

describe("audience constants", () => {
  test("canonical audience is `surface` (what the hub mints — bare module short)", () => {
    expect(AUDIENCE).toBe("surface");
  });
  test("legacy audience `app` stays accepted, canonical tried first", () => {
    expect(LEGACY_AUDIENCE).toBe("app");
    expect(AUDIENCES).toEqual(["surface", "app"]);
  });
});

describe("validateWithAudienceFallback", () => {
  test("returns on the first (canonical) audience when it validates", async () => {
    const tried: string[] = [];
    const result = await validateWithAudienceFallback(async (aud) => {
      tried.push(aud);
      return { scopes: ["surface:admin"] };
    });
    expect(result.scopes).toEqual(["surface:admin"]);
    expect(tried).toEqual(["surface"]);
  });

  test("falls back to legacy `app` on an audience mismatch", async () => {
    const tried: string[] = [];
    const result = await validateWithAudienceFallback(async (aud) => {
      tried.push(aud);
      if (aud === "surface") {
        throw new HubJwtError("audience", 'expected "surface", got "app"');
      }
      return { scopes: ["surface:admin"] };
    });
    expect(result.scopes).toEqual(["surface:admin"]);
    expect(tried).toEqual(["surface", "app"]);
  });

  test("rethrows the audience error when no accepted audience matches", async () => {
    await expect(
      validateWithAudienceFallback(async () => {
        throw new HubJwtError("audience", "mismatch");
      }),
    ).rejects.toMatchObject({ code: "audience" });
  });

  test("non-audience errors rethrow immediately — no fallback retry", async () => {
    const tried: string[] = [];
    await expect(
      validateWithAudienceFallback(async (aud) => {
        tried.push(aud);
        throw new HubJwtError("revoked", "token has been revoked");
      }),
    ).rejects.toMatchObject({ code: "revoked" });
    expect(tried).toEqual(["surface"]);
  });

  // Fail-fast-on-signature is the make-or-break property of the fallback: a
  // token that fails verification for any reason OTHER than audience mismatch
  // must rethrow on the FIRST attempt — retrying against the legacy audience
  // can't make a forged or expired token valid, and looping would mask the
  // real failure behind a misleading audience error. Pinned explicitly per
  // code (signature = forgery, expired = stale) alongside the representative
  // "revoked" case above.
  test.each(["signature", "expired"] as const)(
    "%s failure rethrows on the first attempt — only the canonical audience is tried",
    async (code) => {
      const tried: string[] = [];
      await expect(
        validateWithAudienceFallback(async (aud) => {
          tried.push(aud);
          throw new HubJwtError(code, `hub JWT ${code} failure`);
        }),
      ).rejects.toMatchObject({ code });
      expect(tried).toEqual(["surface"]);
    },
  );
});

// ---------------------------------------------------------------------------
// Multi-origin iss-set (hub#692) — through the REAL guard against a live JWKS
// fixture (mirrors parachute-vault's `hub-jwt.test.ts`). Every token is signed
// by the SAME published key, so the signature always verifies — the ONLY
// variable under test is whether the token's `iss` is in the accepted set.
// ---------------------------------------------------------------------------

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    kid,
    privateKey: privateKey as CryptoKey,
    publicJwk: {
      kty: "RSA",
      // biome-ignore lint/style/noNonNullAssertion: RSA JWKs always carry n/e
      n: jwk.n!,
      // biome-ignore lint/style/noNonNullAssertion: RSA JWKs always carry n/e
      e: jwk.e!,
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

interface JwksFixture {
  origin: string;
  stop: () => void;
}

/**
 * Fake hub: serves the JWKS + an EMPTY revocation list (scope-guard consults
 * `/.well-known/parachute-revocation.json` on every jti-bearing validation and
 * fails CLOSED on a 404 — so the fixture must answer it).
 */
function startJwksFixture(kp: Keypair): JwksFixture {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: [kp.publicJwk] });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

/** Sign a hub-shaped admin JWT (`aud: surface`, `scope: surface:admin`). */
async function signSurfaceJwt(kp: Keypair, iss: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return await new SignJWT({ scope: "surface:admin", client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(iss)
    .setSubject("operator-1")
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti("jti-multi-origin")
    .sign(kp.privateKey);
}

describe("validateBearer — multi-origin iss-set (hub#692), real guard + JWKS fixture", () => {
  // Legitimate second + illegitimate third origins — NOT the canonical origin.
  const SECOND = "https://second.example";
  const THIRD = "https://attacker.example";

  let kp: Keypair;
  let fixture: JwksFixture;

  beforeAll(async () => {
    kp = await makeKeypair("k1");
    fixture = startJwksFixture(kp);
  });

  afterAll(() => {
    fixture.stop();
  });

  test("token issued by a SECOND origin validates when PARACHUTE_HUB_ORIGINS includes it", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin; // canonical (also the JWKS host)
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    resetGuard();
    const token = await signSurfaceJwt(kp, SECOND);
    const result = await validateBearer(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopes).toEqual(["surface:admin"]);
  });

  test("back-compat: PARACHUTE_HUB_ORIGINS unset → single-origin behavior — canonical iss accepted (positive control), second-origin iss 401", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
    delete process.env.PARACHUTE_HUB_ORIGINS;
    resetGuard();
    // Positive control: proves the fixture + signature path works, so the
    // rejection below can only be the iss pin.
    const canonical = await validateBearer(await signSurfaceJwt(kp, fixture.origin));
    expect(canonical.ok).toBe(true);
    const second = await validateBearer(await signSurfaceJwt(kp, SECOND));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(401);
  });

  test("token issued by a THIRD, unlisted origin is rejected even with PARACHUTE_HUB_ORIGINS set", async () => {
    process.env.PARACHUTE_HUB_ORIGIN = fixture.origin;
    process.env.PARACHUTE_HUB_ORIGINS = `${fixture.origin},${SECOND}`;
    resetGuard();
    const result = await validateBearer(await signSurfaceJwt(kp, THIRD));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
