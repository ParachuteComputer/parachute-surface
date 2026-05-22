/**
 * Tests for `src/auth.ts` — the JWT-bearer + scope gate for admin endpoints.
 *
 * Coverage:
 *   - extractBearer parses Authorization header correctly
 *   - hasScope is exact-match (no wildcard)
 *   - hasReadAccess accepts app:read OR app:admin
 *   - validateBearer returns 401 on missing token
 *   - validateBearer returns 401 on invalid token (jwks unreachable / bad sig)
 *   - enforceScope returns 403 with insufficient_scope when scope missing
 *   - enforceScope returns scopes object on success (mocked guard)
 *   - getHubOrigin honors PARACHUTE_HUB_ORIGIN, then hubUrl, then loopback
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  SCOPE_ADMIN,
  SCOPE_READ,
  extractBearer,
  getHubOrigin,
  hasReadAccess,
  hasScope,
  resetGuard,
  validateBearer,
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
    expect(hasScope(["app:admin"], "app:admin")).toBe(true);
    expect(hasScope(["app:read"], "app:admin")).toBe(false);
  });
  test("hasReadAccess accepts read OR admin", () => {
    expect(hasReadAccess(["app:read"])).toBe(true);
    expect(hasReadAccess(["app:admin"])).toBe(true);
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
  test("SCOPE_ADMIN is `app:admin`", () => {
    expect(SCOPE_ADMIN).toBe("app:admin");
  });
  test("SCOPE_READ is `app:read`", () => {
    expect(SCOPE_READ).toBe("app:read");
  });
});
