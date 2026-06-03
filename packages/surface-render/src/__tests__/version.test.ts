/**
 * Drift guard for the library version constant (see #57; mirrors
 * surface-client's guard).
 *
 * `SURFACE_RENDER_VERSION` is codegen'd from `package.json` by
 * `scripts/gen-version.ts` (the `prebuild` step). This test fails if the
 * committed `src/version.ts` has drifted from `package.json` — e.g. someone
 * bumped `package.json` but didn't regenerate. The build regenerates it at
 * publish time, but this catches a stale commit in CI before that.
 */
import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { SURFACE_RENDER_VERSION } from "../version.js";

describe("SURFACE_RENDER_VERSION", () => {
  it("matches package.json version (no drift — see #57)", () => {
    expect(SURFACE_RENDER_VERSION).toBe(pkg.version);
  });
});
