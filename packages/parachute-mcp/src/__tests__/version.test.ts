/**
 * Drift guard for the version constant (mirrors account-client /
 * surface-client #57): `PARACHUTE_MCP_VERSION` is codegen'd from
 * `package.json` by `scripts/gen-version.ts` (the `prebuild` step). This test
 * fails if the committed `src/version.ts` has drifted — e.g. someone bumped
 * `package.json` but didn't regenerate.
 */
import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { PARACHUTE_MCP_VERSION } from "../version.js";

describe("PARACHUTE_MCP_VERSION", () => {
  test("matches package.json version (no drift)", () => {
    expect(PARACHUTE_MCP_VERSION).toBe(pkg.version);
  });
});
