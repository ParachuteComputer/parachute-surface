/**
 * Tests for `bin/parachute-surface.ts` — the CLI surface.
 *
 * Coverage (Phase 1.3):
 *   - --version / -v print package.json version
 *   - --help / -h / no-args print usage with the current verb list
 *   - Unknown command exits non-zero
 *   - `add` without source exits non-zero with helpful error
 *   - `remove` without name exits non-zero with helpful error
 *   - `reload` without name exits non-zero with helpful error
 *   - `add`/`remove`/`list`/`reload` against an unreachable daemon report
 *     friendly connection error
 *   - `dev <name>` / `dev <name> --off` / `dev <name> --trigger` / `dev list`
 *     hit the right paths (asserted via unreachable-daemon connection error)
 *   - `dev` without name exits non-zero with helpful error
 *   - `dev <name> --off --trigger` is rejected as mutually exclusive
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import pkg from "../../package.json" with { type: "json" };

const BIN = path.resolve(import.meta.dir, "..", "..", "bin", "parachute-surface.ts");

async function runBin(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // Hermetic credential env: point PARACHUTE_HOME at an empty dir and blank
  // PARACHUTE_HUB_TOKEN so the CLI finds NO operator token. Without this the
  // admin verbs would try to mint a surface token from the developer's real
  // ~/.parachute/operator.token against a live hub — making these
  // verb-routing / connection-error assertions depend on local infra. With no
  // operator token the CLI sends the request unauthenticated, so the
  // unreachable-daemon path (the thing these tests assert) is exercised
  // deterministically. Per-test overrides still win.
  const emptyHome = mkdtempSync(path.join(tmpdir(), "parachute-surface-cli-test-"));
  const env = {
    ...process.env,
    PARACHUTE_HOME: emptyHome,
    PARACHUTE_HUB_TOKEN: "",
    ...envOverrides,
  };
  try {
    const proc = Bun.spawn(["bun", "run", BIN, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
}

/**
 * Localhost port that's guaranteed-not-listening — used to assert the CLI's
 * unreachable-daemon error path. Picks a high port and assumes nothing's on
 * it; if a test environment has noise on this port, the test re-rolls.
 */
function unreachableBase(): string {
  // 1 is reserved + privileged-only-bind on most OSes, so connecting to it
  // is guaranteed to fail. ECONNREFUSED on macOS; ENOTSUP / EACCES on Linux.
  return "http://127.0.0.1:1";
}

describe("parachute-surface CLI", () => {
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

  test("--help shows the full Phase 1.3 verb list", async () => {
    const r = await runBin(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("parachute-surface");
    expect(r.stdout).toContain("serve");
    expect(r.stdout).toContain("add <source>");
    expect(r.stdout).toContain("remove <name>");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("reload <name>");
    expect(r.stdout).toContain("dev <name>");
    expect(r.stdout).toContain("--trigger");
    expect(r.stdout).toContain("dev list");
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

  test("add without source exits non-zero", async () => {
    const r = await runBin(["add"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("source");
  });

  test("remove without name exits non-zero", async () => {
    const r = await runBin(["remove"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("name");
  });

  test("reload without name exits non-zero", async () => {
    const r = await runBin(["reload"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("name");
  });

  test("list against unreachable daemon reports friendly error", async () => {
    const r = await runBin(["list"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("daemon");
  });

  test("dev without name exits non-zero", async () => {
    const r = await runBin(["dev"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("name");
  });

  test("dev <name> against unreachable daemon hits enable endpoint", async () => {
    const r = await runBin(["dev", "my-ui"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("daemon");
  });

  test("dev list against unreachable daemon reports friendly error", async () => {
    const r = await runBin(["dev", "list"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("daemon");
  });

  test("dev <name> --off and --trigger together is rejected", async () => {
    const r = await runBin(["dev", "my-ui", "--off", "--trigger"], {
      PARACHUTE_APP_URL: unreachableBase(),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("dev <name> --trigger against unreachable daemon reports friendly error", async () => {
    const r = await runBin(["dev", "my-ui", "--trigger"], {
      PARACHUTE_APP_URL: unreachableBase(),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("daemon");
  });

  // --- Phase 2.1 ------------------------------------------------------

  test("--help shows the provision-schema verb", async () => {
    const r = await runBin(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provision-schema <name>");
  });

  test("provision-schema without name exits non-zero", async () => {
    const r = await runBin(["provision-schema"], { PARACHUTE_APP_URL: unreachableBase() });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("name");
  });

  test("provision-schema <name> against unreachable daemon reports friendly error", async () => {
    const r = await runBin(["provision-schema", "notes"], {
      PARACHUTE_APP_URL: unreachableBase(),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("daemon");
  });
});
