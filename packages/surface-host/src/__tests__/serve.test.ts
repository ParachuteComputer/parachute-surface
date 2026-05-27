/**
 * Integration test for `serve()` — wires config + UI scan + HTTP server +
 * self-register together.
 *
 * Coverage:
 *   - Live bind + healthz reports correct UI count
 *   - Mounted UI serves index.html with correct headers
 *   - Hashed asset serves with immutable headers
 *   - Self-register row appears in services.json
 *   - Subsequent serve() preserves the operator-set port
 *   - skipSelfRegister skips the write
 *   - runOnce returns the scan result without binding a port
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runOnce, serve } from "../index.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let configPath: string;
let uisDir: string;
let manifestPath: string;

function seedUi(name: string, mountPath: string, files: Record<string, string>): void {
  const dir = path.join(uisDir, name);
  const distDir = path.join(dir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ name, displayName: name, path: mountPath }),
  );
  for (const [filename, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, filename), body);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-serve-"));
  configPath = path.join(tmpDir, "app", "config.json");
  uisDir = path.join(tmpDir, "app", "uis");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("serve — live integration", () => {
  test("mounts a UI and serves index.html", async () => {
    seedUi("test-ui", "/surface/test-ui", { "index.html": "Hello from test UI" });
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
    });
    try {
      const url = `http://127.0.0.1:${h.server.port}`;
      const r = await fetch(`${url}/surface/test-ui/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("Hello from test UI");
      expect(r.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");

      const health = await fetch(`${url}/surface/healthz`);
      const healthBody = (await health.json()) as { status: string; uis: number };
      expect(healthBody.status).toBe("ok");
      expect(healthBody.uis).toBe(1);

      // Hashed asset
      fs.writeFileSync(path.join(uisDir, "test-ui", "dist", "app.deadbeef.js"), "x=1");
      const r2 = await fetch(`${url}/surface/test-ui/app.deadbeef.js`);
      expect(r2.status).toBe(200);
      expect(r2.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      // SPA fallback
      const r3 = await fetch(`${url}/surface/test-ui/some/route`);
      expect(r3.status).toBe(200);
      expect(await r3.text()).toBe("Hello from test UI");
    } finally {
      await h.stop();
    }
  });

  test("self-registers into services.json", async () => {
    seedUi("test-ui", "/surface/test-ui", { "index.html": "x" });
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
    });
    try {
      // The services.json write happens synchronously inside `serve`; just check
      // the file.
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        services: Array<Record<string, unknown>>;
      };
      const entry = raw.services.find((s) => s.name === "parachute-surface");
      expect(entry).toBeDefined();
      expect(entry!.port).toBe(h.server.port);
      expect(entry!.paths).toEqual(["/surface", "/.parachute"]);
    } finally {
      await h.stop();
    }
  });

  test("subsequent serve preserves operator-set port", async () => {
    seedUi("test-ui", "/surface/test-ui", { "index.html": "x" });
    // Seed services.json with an operator-set port
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-surface",
            port: 1948,
            paths: ["/surface"],
            health: "/surface/healthz",
            version: "old",
          },
        ],
      }),
    );
    const h = serve({
      port: 0, // OS picks
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
    });
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        services: Array<Record<string, unknown>>;
      };
      const entry = raw.services.find((s) => s.name === "parachute-surface");
      // Operator-set port (1948) preserved, NOT the OS-picked test port.
      expect(entry!.port).toBe(1948);
    } finally {
      await h.stop();
    }
  });

  test("skipSelfRegister leaves services.json alone", async () => {
    seedUi("test-ui", "/surface/test-ui", { "index.html": "x" });
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      skipSelfRegister: true,
      logger: silentLogger,
    });
    try {
      expect(fs.existsSync(manifestPath)).toBe(false);
    } finally {
      await h.stop();
    }
  });

  test("starts even with no UIs", async () => {
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
      // Default config bootstraps notes-ui; skip in this test — we're
      // asserting the "empty install" path, not the bootstrap path.
      skipBootstrap: true,
    });
    try {
      const url = `http://127.0.0.1:${h.server.port}`;
      const r = await fetch(`${url}/healthz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; uis: number };
      expect(body.uis).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("config.disabled=true skips UI scan + healthz reports disabled", async () => {
    // Seed a UI that WOULD be mounted normally; with disabled=true it must not be.
    seedUi("test-ui", "/surface/test-ui", { "index.html": "should not be served" });
    // Write a config file with disabled: true so loadConfig picks it up.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ disabled: true }));
    const h = serve({
      port: 0,
      configPath,
      uisDir,
      manifestPath,
      logger: silentLogger,
    });
    try {
      const url = `http://127.0.0.1:${h.server.port}`;
      // Healthz reports disabled + zero UIs (scan was skipped).
      const r = await fetch(`${url}/surface/healthz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; uis: number };
      expect(body.status).toBe("disabled");
      expect(body.uis).toBe(0);
      // No UI is mounted — the would-be /surface/test-ui/ falls through to 404.
      const r2 = await fetch(`${url}/surface/test-ui/`);
      expect(r2.status).toBe(404);
      // `.parachute/*` admin surface still works (operator path back to re-enable).
      const r3 = await fetch(`${url}/.parachute/config`);
      expect(r3.status).toBe(200);
    } finally {
      await h.stop();
    }
  });
});

describe("runOnce", () => {
  test("returns scan result without binding a port", () => {
    seedUi("a", "/surface/a", { "index.html": "a" });
    seedUi("b", "/surface/b", { "index.html": "b" });
    const result = runOnce({ configPath, uisDir, logger: silentLogger });
    expect(result.state.registeredUis).toHaveLength(2);
    expect(result.state.skippedUis).toHaveLength(0);
    expect(result.config.hub_url).toBe("http://127.0.0.1:1939");
  });

  test("surfaces skipped UIs", () => {
    // valid
    seedUi("good", "/surface/good", { "index.html": "g" });
    // bad: missing dist/index.html
    const badDir = path.join(uisDir, "bad");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "meta.json"),
      JSON.stringify({ name: "bad", displayName: "Bad", path: "/surface/bad" }),
    );
    const result = runOnce({ configPath, uisDir, logger: silentLogger });
    expect(result.state.registeredUis).toHaveLength(1);
    expect(result.state.skippedUis).toHaveLength(1);
    expect(result.state.skippedUis[0]!.status).toBe("missing-dist");
  });
});
