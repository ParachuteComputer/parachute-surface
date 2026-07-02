import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HubJwtClaims } from "@openparachute/scope-guard";
import { HubJwtError } from "@openparachute/scope-guard";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { SESSION_COOKIE, createSurfaceAuth, parseHubOrigins } from "../auth/surface-auth.ts";
import { makeTestCtx } from "./helpers.ts";

const MOUNT = "/surface/demo";

function claims(overrides: Partial<HubJwtClaims> = {}): HubJwtClaims {
  return {
    sub: "operator-1",
    scopes: ["vault:default:write"],
    aud: "vault.default",
    jti: "jti-1",
    clientId: undefined,
    vaultScope: [],
    ...overrides,
  };
}

function makeAuth(opts: Parameters<typeof createSurfaceAuth>[1] = {}) {
  const t = makeTestCtx({ mount: MOUNT });
  const auth = createSurfaceAuth(t.ctx, {
    validateHubJwt: async () => claims(),
    ...opts,
  });
  return { ...t, auth };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://hub.test${path}`, init);
}

describe("resolveActor — the three branches", () => {
  test("anon when nothing is presented", async () => {
    const { auth } = makeAuth();
    const result = await auth.resolveActor(req(`${MOUNT}/api/x`));
    expect(result).toEqual({ ok: true, actor: { kind: "anon" } });
  });

  test("operator: valid hub JWT with the vault write scope", async () => {
    const seen: Array<{ token: string; aud: string }> = [];
    const { auth } = makeAuth({
      validateHubJwt: async (token, aud) => {
        seen.push({ token, aud });
        return claims();
      },
    });
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: "Bearer jwt-abc" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toEqual({
        kind: "operator",
        subject: "operator-1",
        scopes: ["vault:default:write"],
      });
    }
    // The audience pin is vault.<name> (v1 owner branch).
    expect(seen).toEqual([{ token: "jwt-abc", aud: "vault.default" }]);
  });

  test("operator: missing write scope is a refusal, not anon", async () => {
    const { auth } = makeAuth({
      validateHubJwt: async () => claims({ scopes: ["vault:default:read"] }),
    });
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: "Bearer jwt-abc" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.status).toBe(401);
      expect(result.refusal.code).toBe("insufficient_scope");
    }
  });

  test("operator: invalid JWT is a refusal, not anon", async () => {
    const { auth } = makeAuth({
      validateHubJwt: async () => {
        throw new HubJwtError("expired", "token expired");
      },
    });
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: "Bearer stale" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("invalid_token");
  });

  test("audience: valid Capability header yields a sessionless audience actor", async () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: `Capability ${minted.token}` } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toEqual({
        kind: "audience",
        sessionId: "",
        capabilityId: minted.id,
        subjectId: null,
      });
    }
  });

  test("audience: forged / revoked capabilities are refusals", async () => {
    const { auth } = makeAuth();
    const forged = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: "Capability cap_x.y" } }),
    );
    expect(forged.ok).toBe(false);

    const minted = auth.mintCapability();
    auth.revokeCapability(minted.id);
    const revoked = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: `Capability ${minted.token}` } }),
    );
    expect(revoked.ok).toBe(false);
  });

  test("audience: a personal link cannot ride the Capability header", async () => {
    const { auth } = makeAuth();
    const link = await auth.mintPersonalLink({ email: "pat@example.com" });
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: `Capability ${link.token}` } }),
    );
    expect(result.ok).toBe(false);
  });

  test("unsupported Authorization scheme is a refusal", async () => {
    const { auth } = makeAuth();
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: "Basic dXNlcjpwdw==" } }),
    );
    expect(result.ok).toBe(false);
  });

  test("cookie session resolves to an audience actor; dead cookie falls to anon", async () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    const entry = auth.handleEntry(req(`${MOUNT}/api/a/${minted.token}`));
    expect(entry.session).toBeDefined();
    const sessionId = entry.session?.id ?? "";

    const live = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } }),
    );
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.actor).toEqual({
        kind: "audience",
        sessionId,
        capabilityId: minted.id,
        subjectId: null,
      });
    }

    const dead = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { cookie: `${SESSION_COOKIE}=nonsense` } }),
    );
    expect(dead).toEqual({ ok: true, actor: { kind: "anon" } });
  });
});

describe("entry route (design §4)", () => {
  test("valid capability: 302 to a clean URL + httpOnly path-scoped cookie", async () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    expect(minted.entryPath).toBe(`${MOUNT}/api/a/${minted.token}`);

    const { response } = auth.handleEntry(req(minted.entryPath));
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe(`${MOUNT}/`);
    expect(location.includes(minted.token)).toBe(false);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain(`Path=${MOUNT}/`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("legacy short entry path (`${mount}/a/<token>`) is accepted too", () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    const { response } = auth.handleEntry(req(`${MOUNT}/a/${minted.token}`));
    expect(response.status).toBe(302);
  });

  test("https request gets a Secure cookie", () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    const { response } = auth.handleEntry(
      req(minted.entryPath, { headers: { "x-forwarded-proto": "https" } }),
    );
    expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  test("?to= is honored inside the mount, rejected outside (no open redirect)", () => {
    const { auth } = makeAuth();
    const mint = () => auth.mintCapability();
    const cases: Array<[string, string]> = [
      [`${MOUNT}/doc/42`, `${MOUNT}/doc/42`], // inside → honored
      ["/surface/other/page", `${MOUNT}/`], // sibling surface → root
      ["https://evil.example/x", `${MOUNT}/`], // absolute → root
      [`${MOUNT}/../admin`, `${MOUNT}/`], // traversal → root
      [`${MOUNT}/a/sneaky`, `${MOUNT}/`], // re-entry → root
      [`${MOUNT}/api/a/sneaky`, `${MOUNT}/`], // re-entry (api form) → root
    ];
    for (const [to, expected] of cases) {
      const minted = mint();
      const { response } = auth.handleEntry(
        req(`${minted.entryPath}?to=${encodeURIComponent(to)}`),
      );
      expect(response.headers.get("location")).toBe(expected);
    }
  });

  test("invalid / expired / revoked tokens get one uniform 401", () => {
    const { auth } = makeAuth();
    const revoked = auth.mintCapability();
    auth.revokeCapability(revoked.id);
    for (const path of [
      `${MOUNT}/api/a/garbage`,
      `${MOUNT}/api/a/`,
      `${MOUNT}/api/a/${revoked.token}`,
    ]) {
      const { response, session } = auth.handleEntry(req(path));
      expect(response.status).toBe(401);
      expect(session).toBeUndefined();
    }
  });

  test("personal links are single-use: second exchange refused", async () => {
    const { auth } = makeAuth();
    const link = await auth.mintPersonalLink({ email: "pat@example.com" });
    const first = auth.handleEntry(req(link.entryPath));
    expect(first.response.status).toBe(302);
    expect(first.session?.subjectId).toBe(link.subjectId);
    const second = auth.handleEntry(req(link.entryPath));
    expect(second.response.status).toBe(401);
  });

  test("non-GET entry is refused", () => {
    const { auth } = makeAuth();
    const minted = auth.mintCapability();
    const { response } = auth.handleEntry(req(minted.entryPath, { method: "POST" }));
    expect(response.status).toBe(405);
  });
});

describe("personal-link delivery (module-credential-ownership)", () => {
  test("no sender configured → delivered:false, link renders inline", async () => {
    const { auth } = makeAuth();
    const link = await auth.mintPersonalLink({ email: "pat@example.com" });
    expect(link.delivered).toBe(false);
    expect(link.token.startsWith("lnk_")).toBe(true);
    expect(link.entryPath).toContain(link.token);
  });

  test("configured sender → delivered:true", async () => {
    const sent: string[] = [];
    const { auth } = makeAuth({
      sendEmail: async ({ to }) => {
        sent.push(to);
      },
    });
    const link = await auth.mintPersonalLink({ email: "pat@example.com" });
    expect(link.delivered).toBe(true);
    expect(sent).toEqual(["pat@example.com"]);
  });

  test("sender failure → delivered:false (inline fallback), warn logged", async () => {
    const t = makeTestCtx({ mount: MOUNT });
    const auth = createSurfaceAuth(t.ctx, {
      validateHubJwt: async () => claims(),
      sendEmail: async () => {
        throw new Error("smtp down");
      },
    });
    const link = await auth.mintPersonalLink({ email: "pat@example.com" });
    expect(link.delivered).toBe(false);
    expect(t.logs.warns.some((w) => w.includes("smtp down"))).toBe(true);
  });

  test("re-issuing to the same email reuses the subject (recovery flow)", async () => {
    const { auth } = makeAuth();
    const first = await auth.mintPersonalLink({ email: "pat@example.com" });
    const second = await auth.mintPersonalLink({ email: "pat@example.com" });
    expect(second.subjectId).toBe(first.subjectId);
    expect(second.id).not.toBe(first.id);
  });
});

describe("parseHubOrigins — multi-origin iss-set (hub#692)", () => {
  test("undefined / empty → [] (back-compat: env unset collapses to single hubOrigin)", () => {
    expect(parseHubOrigins(undefined)).toEqual([]);
    expect(parseHubOrigins("")).toEqual([]);
  });

  test("splits, trims, strips trailing slash, drops empties, dedupes", () => {
    expect(parseHubOrigins("https://a.example,https://b.example/, ,https://a.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Multi-origin iss-set (hub#692) — through the REAL scope-guard (no
// validateHubJwt seam) against a live JWKS fixture. Every token is signed by
// the SAME published key, so the signature always verifies — the ONLY variable
// under test is whether the token's `iss` is in the accepted set.
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

describe("resolveActor operator branch — multi-origin iss-set (hub#692), real guard + JWKS fixture", () => {
  const SECOND = "https://second.example";
  const THIRD = "https://attacker.example";

  let kp: Keypair;
  let server: ReturnType<typeof Bun.serve>;
  let jwksOrigin: string;
  const savedOriginsEnv = process.env.PARACHUTE_HUB_ORIGINS;

  beforeAll(async () => {
    kp = await makeKeypair("k1");
    // Fake hub: JWKS + an EMPTY revocation list (scope-guard consults
    // `/.well-known/parachute-revocation.json` on every jti-bearing
    // validation and fails CLOSED on a 404).
    server = Bun.serve({
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
    jwksOrigin = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
    if (savedOriginsEnv === undefined) delete process.env.PARACHUTE_HUB_ORIGINS;
    else process.env.PARACHUTE_HUB_ORIGINS = savedOriginsEnv;
  });

  /** Sign an operator-shaped JWT (`aud: vault.default`, the owner-branch pin). */
  async function signOperatorJwt(iss: string): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return await new SignJWT({ scope: "vault:default:write", client_id: "test-client" })
      .setProtectedHeader({ alg: "RS256", kid: kp.kid })
      .setIssuer(iss)
      .setSubject("operator-1")
      .setAudience("vault.default")
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .setJti("jti-multi-origin")
      .sign(kp.privateKey);
  }

  /** Fresh SurfaceAuth on the REAL guard (no seam), pinned at the fixture origin. */
  function makeRealAuth() {
    const t = makeTestCtx({ mount: MOUNT });
    return createSurfaceAuth(t.ctx, { hubOrigin: jwksOrigin });
  }

  test("token issued by a SECOND origin resolves the operator when PARACHUTE_HUB_ORIGINS includes it", async () => {
    process.env.PARACHUTE_HUB_ORIGINS = `${jwksOrigin},${SECOND}`;
    const auth = makeRealAuth();
    const token = await signOperatorJwt(SECOND);
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor).toEqual({
        kind: "operator",
        subject: "operator-1",
        scopes: ["vault:default:write"],
      });
    }
  });

  test("back-compat: PARACHUTE_HUB_ORIGINS unset → single-origin — canonical iss accepted (positive control), second-origin iss refused", async () => {
    // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
    delete process.env.PARACHUTE_HUB_ORIGINS;
    const auth = makeRealAuth();
    // Positive control: proves the fixture + signature path works, so the
    // refusal below can only be the iss pin.
    const canonical = await auth.resolveActor(
      req(`${MOUNT}/api/x`, {
        headers: { authorization: `Bearer ${await signOperatorJwt(jwksOrigin)}` },
      }),
    );
    expect(canonical.ok).toBe(true);
    const second = await auth.resolveActor(
      req(`${MOUNT}/api/x`, {
        headers: { authorization: `Bearer ${await signOperatorJwt(SECOND)}` },
      }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.status).toBe(401);
  });

  test("token issued by a THIRD, unlisted origin is refused even with PARACHUTE_HUB_ORIGINS set", async () => {
    process.env.PARACHUTE_HUB_ORIGINS = `${jwksOrigin},${SECOND}`;
    const auth = makeRealAuth();
    const result = await auth.resolveActor(
      req(`${MOUNT}/api/x`, {
        headers: { authorization: `Bearer ${await signOperatorJwt(THIRD)}` },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.status).toBe(401);
  });
});
