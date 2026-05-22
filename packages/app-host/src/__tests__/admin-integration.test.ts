/**
 * Integration tests for the admin endpoints — wired through `Bun.serve` via
 * `startHttpServer`. Tests the full request → routing → admin-handler path,
 * with auth bypassed via the `enforceScopeFn` seam injected through
 * `HttpServerOpts.adminOpts`.
 *
 * Coverage:
 *   - 401 from /app/list without bearer (real auth path)
 *   - 200 from /app/list with auth bypassed
 *   - End-to-end add a local-path UI + verify dist is mounted at its path
 *   - End-to-end delete a UI + verify it's no longer mounted
 *   - End-to-end reload a UI after editing meta.json
 *   - /app/admin/ serves placeholder when no admin bundle is built
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { EnforceScopeFn } from "../admin-routes.ts";
import type { AppState } from "../http-server.ts";
import { startHttpServer } from "../http-server.ts";
import { scanUis } from "../ui-registry.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };
const allowAdmin: EnforceScopeFn = async () => ({ scopes: ["app:admin"] });

let tmpDir: string;
let uisDir: string;
let manifestPath: string;
let parachuteDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-admin-int-"));
  uisDir = path.join(tmpDir, "uis");
  manifestPath = path.join(tmpDir, "services.json");
  parachuteDir = path.join(tmpDir, ".parachute");
  fs.mkdirSync(uisDir, { recursive: true });
  fs.mkdirSync(path.join(parachuteDir, "config"), { recursive: true });
  fs.writeFileSync(path.join(parachuteDir, "info"), JSON.stringify({ name: "app" }));
  fs.writeFileSync(path.join(parachuteDir, "config", "schema"), "{}");
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(): AppState {
  const scan = scanUis({ uisDir, logger: silentLogger });
  return {
    config: {
      hub_url: "http://127.0.0.1:1939",
      auto_register_oauth_clients: false,
      disabled: false,
      default_scope_required: ["vault:*:read"],
      dev_mode_allowed: true,
    },
    registeredUis: scan.registered,
    skippedUis: scan.skipped.map((s) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    })),
  };
}

function startServer(state: AppState, enforce?: EnforceScopeFn): { url: string; stop: () => void } {
  const server = startHttpServer({
    state,
    port: 0,
    startedAt: new Date(),
    hostname: "127.0.0.1",
    logger: silentLogger,
    parachuteDir,
    adminDir: path.join(tmpDir, "nonexistent-admin-dir"),
    adminOpts: {
      uisDir,
      manifestPath,
      logger: silentLogger,
      skipSelfRegisterRefresh: true,
      ...(enforce ? { enforceScopeFn: enforce } : {}),
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(),
  };
}

describe("HTTP-level admin auth", () => {
  test("401 without bearer", async () => {
    const state = makeState();
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/app/list`);
      expect(r.status).toBe(401);
    } finally {
      srv.stop();
    }
  });

  test("200 with auth bypassed", async () => {
    const state = makeState();
    const srv = startServer(state, allowAdmin);
    try {
      const r = await fetch(`${srv.url}/app/list`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { uis: unknown[] };
      expect(Array.isArray(body.uis)).toBe(true);
    } finally {
      srv.stop();
    }
  });
});

describe("end-to-end add / delete / reload", () => {
  test("add a local UI + verify mount serves index.html", async () => {
    const state = makeState();
    const srcDir = path.join(tmpDir, "src", "myui");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "index.html"), "<h1>e2e</h1>");

    const srv = startServer(state, allowAdmin);
    try {
      const addRes = await fetch(`${srv.url}/app/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: srcDir,
          name: "e2eui",
          path: "/app/e2eui",
          displayName: "E2E UI",
        }),
      });
      expect(addRes.status).toBe(201);

      // The new UI is now mounted and serves its index.html.
      const fetched = await fetch(`${srv.url}/app/e2eui/`);
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toContain("e2e");

      // Listing surfaces it.
      const listRes = await fetch(`${srv.url}/app/list`);
      const listBody = (await listRes.json()) as { uis: Array<{ name: string }> };
      expect(listBody.uis.find((u) => u.name === "e2eui")).toBeDefined();
    } finally {
      srv.stop();
    }
  });

  test("delete a UI + verify mount returns 404", async () => {
    // Seed a UI directly on disk so the scan picks it up at boot.
    const dir = path.join(uisDir, "doomed");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ name: "doomed", displayName: "Doomed", path: "/app/doomed" }),
    );
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "doomed");
    const state = makeState();

    const srv = startServer(state, allowAdmin);
    try {
      // Confirm it's mounted first
      const before = await fetch(`${srv.url}/app/doomed/`);
      expect(before.status).toBe(200);

      const delRes = await fetch(`${srv.url}/app/doomed`, { method: "DELETE" });
      expect(delRes.status).toBe(200);

      // After delete, the mount returns 404 (no matching UI).
      const after = await fetch(`${srv.url}/app/doomed/`);
      expect(after.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  test("reload picks up meta.json changes", async () => {
    const dir = path.join(uisDir, "rel");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ name: "rel", displayName: "v1", path: "/app/rel" }),
    );
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "<x/>");
    const state = makeState();

    const srv = startServer(state, allowAdmin);
    try {
      // Change meta on disk
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ name: "rel", displayName: "v2", path: "/app/rel" }),
      );
      const r = await fetch(`${srv.url}/app/rel/reload`, { method: "POST" });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ui: { displayName: string } | null };
      expect(body.ui?.displayName).toBe("v2");
    } finally {
      srv.stop();
    }
  });

  test("/app/admin/ serves placeholder when bundle absent", async () => {
    const state = makeState();
    const srv = startServer(state, allowAdmin);
    try {
      const r = await fetch(`${srv.url}/app/admin/`);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toContain("parachute-app admin");
    } finally {
      srv.stop();
    }
  });

  test("/app/admin redirect-equivalent (no trailing slash) also serves the bundle", async () => {
    const state = makeState();
    const srv = startServer(state, allowAdmin);
    try {
      const r = await fetch(`${srv.url}/app/admin`);
      expect(r.status).toBe(200);
    } finally {
      srv.stop();
    }
  });
});

describe("/app/<name>/oauth-client (unauthenticated through HTTP)", () => {
  test("UI without oauth client → 404", async () => {
    const dir = path.join(uisDir, "noauth");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ name: "noauth", displayName: "noauth", path: "/app/noauth" }),
    );
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "x");
    const state = makeState();
    const srv = startServer(state, allowAdmin);
    try {
      const r = await fetch(`${srv.url}/app/noauth/oauth-client`);
      expect(r.status).toBe(404);
    } finally {
      srv.stop();
    }
  });
});
