/**
 * Tests for `src/bootstrap.ts` — Phase 2.1 first-boot default-app
 * bootstrap.
 *
 * Coverage:
 *   - Empty uisDir + enabled config → calls add() for each pkg
 *   - Empty uisDir + apps:[] → skips with explicit reason
 *   - Empty uisDir + enabled:false → skips with explicit reason
 *   - Non-empty uisDir → skips (existing operator install)
 *   - Missing uisDir → treated as empty + bootstraps
 *   - Per-spec add() failure logs warning + continues to next spec
 *   - Dotfile-only uisDir → counts as empty + bootstraps (no .DS_Store
 *     ambush)
 *
 * The `add` callback is mocked here; integration with `addUiInternal`
 * lives in serve.test.ts (live wiring through `runBootstrap`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type BootstrapOpts, maybeBootstrapDefaultApps } from "../bootstrap.ts";
import type { AppConfig } from "../config.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let uisDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-bootstrap-"));
  uisDir = path.join(tmpDir, "uis");
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hub_url: "http://127.0.0.1:1939",
    auto_register_oauth_clients: false,
    disabled: false,
    default_scope_required: ["vault:*:read"],
    dev_mode_allowed: true,
    bootstrap_default_apps: { enabled: true, apps: ["@openparachute/notes-ui"] },
    auto_provision_required_schema: false,
    credential_connections: {},
    ...overrides,
  };
}

function makeOpts(
  overrides: Partial<BootstrapOpts> = {},
  addImpl?: BootstrapOpts["add"],
): BootstrapOpts {
  const add: BootstrapOpts["add"] =
    addImpl ??
    (async (spec) => ({ name: spec.split("/").pop()!.replace(/\W/g, ""), path: "/surface/x" }));
  return {
    config: makeConfig(),
    uisDir,
    add,
    logger: silentLogger,
    ...overrides,
  };
}

describe("maybeBootstrapDefaultApps", () => {
  test("empty uisDir + enabled config → bootstraps each declared app", async () => {
    fs.mkdirSync(uisDir, { recursive: true });
    const calls: string[] = [];
    const result = await maybeBootstrapDefaultApps(
      makeOpts(
        {
          config: makeConfig({
            bootstrap_default_apps: {
              enabled: true,
              apps: ["@openparachute/notes-ui", "@example/foo-ui"],
            },
          }),
        },
        async (spec) => {
          calls.push(spec);
          return { name: spec.split("/").pop()!, path: `/surface/${spec.split("/").pop()}` };
        },
      ),
    );
    expect(calls).toEqual(["@openparachute/notes-ui", "@example/foo-ui"]);
    expect(result.bootstrapped).toEqual(["@openparachute/notes-ui", "@example/foo-ui"]);
    expect(result.failed).toEqual([]);
    expect(result.skipReason).toBeUndefined();
  });

  test("enabled:false → skips with explicit reason", async () => {
    fs.mkdirSync(uisDir, { recursive: true });
    const calls: string[] = [];
    const result = await maybeBootstrapDefaultApps(
      makeOpts(
        {
          config: makeConfig({
            bootstrap_default_apps: { enabled: false, apps: ["@openparachute/notes-ui"] },
          }),
        },
        async (spec) => {
          calls.push(spec);
          return { name: "x", path: "/surface/x" };
        },
      ),
    );
    expect(calls).toEqual([]);
    expect(result.bootstrapped).toEqual([]);
    expect(result.skipReason).toContain("enabled is false");
  });

  test("apps:[] → skips with explicit reason", async () => {
    fs.mkdirSync(uisDir, { recursive: true });
    const result = await maybeBootstrapDefaultApps(
      makeOpts({
        config: makeConfig({
          bootstrap_default_apps: { enabled: true, apps: [] },
        }),
      }),
    );
    expect(result.bootstrapped).toEqual([]);
    expect(result.skipReason).toContain("apps is empty");
  });

  test("non-empty uisDir → skips (existing operator install)", async () => {
    fs.mkdirSync(uisDir, { recursive: true });
    fs.mkdirSync(path.join(uisDir, "preexisting"));
    const calls: string[] = [];
    const result = await maybeBootstrapDefaultApps(
      makeOpts({}, async (spec) => {
        calls.push(spec);
        return { name: "x", path: "/surface/x" };
      }),
    );
    expect(calls).toEqual([]);
    expect(result.skipReason).toContain("non-empty");
  });

  test("missing uisDir → treated as empty + bootstraps", async () => {
    // uisDir path is set but the dir doesn't exist on disk.
    const calls: string[] = [];
    const result = await maybeBootstrapDefaultApps(
      makeOpts({}, async (spec) => {
        calls.push(spec);
        return { name: "notes", path: "/surface/notes" };
      }),
    );
    expect(calls).toEqual(["@openparachute/notes-ui"]);
    expect(result.bootstrapped).toEqual(["@openparachute/notes-ui"]);
  });

  test("dotfile-only uisDir → counts as empty + bootstraps", async () => {
    // macOS sprinkles .DS_Store everywhere; don't count it as "operator
    // was here".
    fs.mkdirSync(uisDir, { recursive: true });
    fs.writeFileSync(path.join(uisDir, ".DS_Store"), "x");
    const calls: string[] = [];
    const result = await maybeBootstrapDefaultApps(
      makeOpts({}, async (spec) => {
        calls.push(spec);
        return { name: "notes", path: "/surface/notes" };
      }),
    );
    expect(calls).toEqual(["@openparachute/notes-ui"]);
    expect(result.bootstrapped).toEqual(["@openparachute/notes-ui"]);
  });

  test("per-spec add() failure logs + continues to next spec", async () => {
    fs.mkdirSync(uisDir, { recursive: true });
    const warns: string[] = [];
    const logger = {
      log: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    const result = await maybeBootstrapDefaultApps(
      makeOpts(
        {
          config: makeConfig({
            bootstrap_default_apps: {
              enabled: true,
              apps: ["@a/will-fail", "@b/will-succeed"],
            },
          }),
          logger,
        },
        async (spec) => {
          if (spec === "@a/will-fail") throw new Error("network down");
          return { name: "ok", path: "/surface/ok" };
        },
      ),
    );
    expect(result.bootstrapped).toEqual(["@b/will-succeed"]);
    expect(result.failed).toEqual([{ pkg: "@a/will-fail", error: "network down" }]);
    expect(warns.some((w) => w.includes("@a/will-fail"))).toBe(true);
  });

  test("file (not dir) at uisDir path → treated as empty", async () => {
    // Pathological case — operator wrote a file where the directory
    // should be. We don't bootstrap into a file; treat as "missing dir."
    // Today's impl returns "treated as empty" because statSync throws
    // OR isDirectory()===false. Either way we run bootstrap; the
    // downstream add will fail at copyDir time. We assert that the
    // bootstrap iteration is at least attempted (matches "missing
    // uisDir" path).
    fs.writeFileSync(uisDir, "not a directory");
    const calls: string[] = [];
    await maybeBootstrapDefaultApps(
      makeOpts({}, async (spec) => {
        calls.push(spec);
        return { name: "x", path: "/surface/x" };
      }),
    );
    expect(calls.length).toBe(1);
  });
});
