/**
 * Drift guard for the library version constant (see #57).
 *
 * `SURFACE_CLIENT_VERSION` is codegen'd from `package.json` by
 * `scripts/gen-version.ts` (the `prebuild` step). This test fails if the
 * committed `src/version.ts` has drifted from `package.json` — e.g. someone
 * bumped `package.json` but didn't regenerate. The build regenerates it at
 * publish time, but this catches a stale commit in CI before that.
 */
import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { SURFACE_CLIENT_VERSION } from "../version.js";

describe("SURFACE_CLIENT_VERSION", () => {
  test("matches package.json version (no drift — see #57)", () => {
    expect(SURFACE_CLIENT_VERSION).toBe(pkg.version);
  });
});
