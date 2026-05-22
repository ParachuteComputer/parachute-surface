/**
 * Tests for `bin/parachute-app.ts` — the CLI surface.
 *
 * Coverage:
 *   - --version prints package.json version
 *   - --help / -h / no-args prints usage referencing Phase 1.1
 *   - Unknown command exits non-zero
 *   - Phase 1.2 stubs (add/remove/list/reload) report not-yet-implemented
 *   - Phase 1.3 stub (dev) reports not-yet-implemented
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import pkg from "../../package.json" with { type: "json" };

const BIN = path.resolve(import.meta.dir, "..", "..", "bin", "parachute-app.ts");

async function runBin(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("parachute-app CLI", () => {
  test("--version prints package.json version", async () => {
    const r = await runBin(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("-v also prints version", async () => {
    const r = await runBin(["-v"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  test("--help references Phase 1.1", async () => {
    const r = await runBin(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("parachute-app");
    expect(r.stdout).toContain("Phase 1.1");
    expect(r.stdout).toContain("serve");
  });

  test("no args prints usage", async () => {
    const r = await runBin([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("unknown command exits non-zero", async () => {
    const r = await runBin(["bogus"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown command");
  });

  test("add reports Phase 1.2 stub", async () => {
    const r = await runBin(["add"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Phase 1.2");
  });

  test("list reports Phase 1.2 stub", async () => {
    const r = await runBin(["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Phase 1.2");
  });

  test("dev reports Phase 1.3 stub", async () => {
    const r = await runBin(["dev"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Phase 1.3");
  });
});
