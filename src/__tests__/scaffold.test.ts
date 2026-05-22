/**
 * Phase 1.0 scaffold sanity check — the library entry imports cleanly
 * and the exported `VERSION` matches `package.json`. Every later phase
 * adds real test files alongside this one.
 */

import { describe, expect, it } from "bun:test";

import pkg from "../../package.json" with { type: "json" };
import { VERSION } from "../index.ts";

describe("parachute-app scaffold", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
