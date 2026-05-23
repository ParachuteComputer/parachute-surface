/**
 * Integration tests for the `serve()` ↔ bootstrap wiring.
 *
 * Unlike `bootstrap.test.ts` (which exercises `maybeBootstrapDefaultApps`
 * in isolation with a mocked `add`), these tests run the full `serve()`
 * → `runBootstrap` → `addUiInternal` → `fetchNpmPackage` chain with a
 * fake npm spawn that writes a synthetic UI bundle to the staging dir.
 *
 * The point: catch wiring regressions where `addUiInternal` doesn't
 * receive the right opts, or where the post-bootstrap state swap +
 * services.json refresh don't land.
 *
 * Coverage:
 *   - Fresh PARACHUTE_HOME → empty uis/ → bootstrap installs the
 *     default app + healthz reports `uis: 1` afterward
 *   - bootstrap_default_apps.enabled = false → no install attempt
 *   - bootstrap_default_apps.apps = [] → no install attempt
 *   - Non-empty uis/ → no install attempt (operator was here)
 *   - skipBootstrap: true (test seam) → no install attempt
 *   - npm-fetch failure → daemon stays up, bootstrap result records
 *     `failed`, healthz still reports `uis: 0`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { serve } from "../index.ts";
import type { NpmSpawnFn } from "../npm-fetch.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let configPath: string;
let uisDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-boot-int-"));
  configPath = path.join(tmpDir, "app", "config.json");
  uisDir = path.join(tmpDir, "app", "uis");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg));
}

/**
 * Fake `bun add` that writes a synthetic UI bundle (meta.json + dist/)
 * into the staging dir's node_modules. Mirrors the real `@openparachute/
 * notes-ui` published shape closely enough that the add path succeeds
 * end-to-end without a registry roundtrip.
 */
function makeNotesUiSpawn(opts: { metaName?: string; metaPath?: string } = {}): NpmSpawnFn {
  return async (argv, cwd) => {
    // expect bun add @openparachute/notes-ui
    if (argv[0] !== "bun" || argv[1] !== "add") {
      return { exitCode: 1, stderr: `unexpected argv: ${argv.join(" ")}`, stdout: "" };
    }
    // The npm-fetch staging dir doesn't need a real install — just create
    // the synthetic shape it expects: node_modules/<pkg>/dist/index.html
    // + node_modules/<pkg>/meta.json
    const pkgScopeDir = path.join(cwd, "node_modules", "@openparachute");
    fs.mkdirSync(pkgScopeDir, { recursive: true });
    const pkgDir = path.join(pkgScopeDir, "notes-ui");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "dist", "index.html"),
      "<!doctype html><html><body>notes</body></html>",
    );
    fs.writeFileSync(
      path.join(pkgDir, "meta.json"),
      JSON.stringify({
        name: opts.metaName ?? "notes",
        displayName: "Notes",
        path: opts.metaPath ?? "/app/notes",
        version: "0.1.2",
        scopes_required: ["vault:*:read", "vault:*:write"],
        pwa: false,
        public: false,
      }),
    );
    return { exitCode: 0, stderr: "", stdout: "" };
  };
}

/** Spawn that always fails — simulates network down. */
const failingSpawn: NpmSpawnFn = async () => ({
  exitCode: 1,
  stderr: "ECONNREFUSED while contacting registry",
  stdout: "",
});

describe("serve ↔ bootstrap integration", () => {
  test("fresh uis/ + default config → installs notes-ui", async () => {
    // Default config is in-process — no config.json on disk means
    // loadConfig returns DEFAULTS which has bootstrap enabled.
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: makeNotesUiSpawn(),
    });
    try {
      // The bootstrap promise resolves after the add completes.
      const result = await h.bootstrap;
      expect(result).toBeDefined();
      // Default spec pins @rc per pre-1.0 governance (see config.ts docstring).
      expect(result!.bootstrapped).toEqual(["@openparachute/notes-ui@rc"]);
      expect(result!.failed).toEqual([]);
      // The UI is on disk + in-state.
      expect(fs.existsSync(path.join(uisDir, "notes", "dist", "index.html"))).toBe(true);
      expect(h.state.registeredUis.find((u) => u.meta.name === "notes")).toBeDefined();
      // Healthz reports the bootstrapped UI.
      const url = `http://127.0.0.1:${h.server.port}`;
      const r = await fetch(`${url}/app/healthz`);
      const body = (await r.json()) as { uis: number };
      expect(body.uis).toBe(1);
      // Notes mount serves index.html.
      const r2 = await fetch(`${url}/app/notes/`);
      expect(r2.status).toBe(200);
      expect(await r2.text()).toContain("notes");
    } finally {
      await h.stop();
    }
  });

  test("enabled:false → no install attempt", async () => {
    writeConfig({
      bootstrap_default_apps: { enabled: false, apps: ["@openparachute/notes-ui"] },
    });
    let spawnCalls = 0;
    const spawn: NpmSpawnFn = async () => {
      spawnCalls++;
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: spawn,
    });
    try {
      const result = await h.bootstrap;
      expect(result!.bootstrapped).toEqual([]);
      expect(result!.skipReason).toContain("enabled is false");
      expect(spawnCalls).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("apps:[] → no install attempt", async () => {
    writeConfig({ bootstrap_default_apps: { enabled: true, apps: [] } });
    let spawnCalls = 0;
    const spawn: NpmSpawnFn = async () => {
      spawnCalls++;
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: spawn,
    });
    try {
      const result = await h.bootstrap;
      expect(result!.skipReason).toContain("apps is empty");
      expect(spawnCalls).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("non-empty uis/ → no install attempt", async () => {
    // Pre-seed a UI so the dir isn't empty.
    fs.mkdirSync(path.join(uisDir, "existing", "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(uisDir, "existing", "meta.json"),
      JSON.stringify({ name: "existing", displayName: "Existing", path: "/app/existing" }),
    );
    fs.writeFileSync(path.join(uisDir, "existing", "dist", "index.html"), "x");
    let spawnCalls = 0;
    const spawn: NpmSpawnFn = async () => {
      spawnCalls++;
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: spawn,
    });
    try {
      // bootstrap promise is undefined when bootstrap was skipped at the
      // top-level "no UIs?" gate (registeredUis.length > 0).
      expect(h.bootstrap).toBeUndefined();
      expect(spawnCalls).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("skipBootstrap:true bypasses bootstrap entirely", async () => {
    let spawnCalls = 0;
    const spawn: NpmSpawnFn = async () => {
      spawnCalls++;
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: spawn,
      skipBootstrap: true,
    });
    try {
      expect(h.bootstrap).toBeUndefined();
      expect(spawnCalls).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("npm-fetch failure: daemon stays up, result records failed", async () => {
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: failingSpawn,
    });
    try {
      const result = await h.bootstrap;
      expect(result!.bootstrapped).toEqual([]);
      expect(result!.failed.length).toBe(1);
      expect(result!.failed[0]!.pkg).toBe("@openparachute/notes-ui@rc");
      // Daemon still healthy + serving healthz.
      const url = `http://127.0.0.1:${h.server.port}`;
      const r = await fetch(`${url}/app/healthz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { uis: number };
      expect(body.uis).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("disabled:true skips bootstrap (daemon is unmounted)", async () => {
    writeConfig({ disabled: true });
    let spawnCalls = 0;
    const spawn: NpmSpawnFn = async () => {
      spawnCalls++;
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      npmSpawnFn: spawn,
    });
    try {
      expect(h.bootstrap).toBeUndefined();
      expect(spawnCalls).toBe(0);
    } finally {
      await h.stop();
    }
  });
});
