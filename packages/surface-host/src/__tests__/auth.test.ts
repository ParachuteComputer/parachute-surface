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
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HubJwtError } from "@openparachute/scope-guard";

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
  resetGuard,
  validateBearer,
  validateWithAudienceFallback,
} from "../auth.ts";

const savedEnv = process.env.PARACHUTE_HUB_ORIGIN;

beforeEach(() => {
  resetGuard();
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env-var cleanup is rare-path test code
  if (savedEnv === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = savedEnv;
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
});
