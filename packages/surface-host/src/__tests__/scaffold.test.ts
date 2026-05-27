/**
 * Library-entry sanity check — the public exports import cleanly, `VERSION`
 * matches `package.json`, and the documented constants are in place.
 */

import { describe, expect, it } from "bun:test";

import pkg from "../../package.json" with { type: "json" };
import { DEFAULT_MOUNT, DEFAULT_PORT, VERSION } from "../index.ts";

describe("parachute-surface library entry", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("exports canonical port 1946", () => {
    expect(DEFAULT_PORT).toBe(1946);
  });

  it("exports canonical mount path /surface", () => {
    expect(DEFAULT_MOUNT).toBe("/surface");
  });
});
