/**
 * Tests for `src/http-server.ts` — Phase 1.1 routing + cache headers.
 *
 * Coverage:
 *   - /healthz + /app/healthz both 200 with UI counts
 *   - /.parachute/info, /.parachute/config/schema, /.parachute/config served
 *   - UI mount: GET /<path>/ → index.html with no-cache headers
 *   - UI mount: GET /<path> (no trailing slash) → same
 *   - UI mount: GET /<path>/<hashed-asset> → asset with immutable header
 *   - UI mount: GET /<path>/<non-hashed-asset> → 1-hour cache
 *   - SPA fallback: GET /<path>/some/spa/route → index.html
 *   - PWA opt-in: SW filename → no-cache
 *   - Path traversal attempt → SPA fallback (defense in depth)
 *   - 404 outside any mount
 *   - 405 for non-GET methods
 *   - HEAD returns same headers + no body
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type AppState, startHttpServer } from "../http-server.ts";
import type { RegisteredUi } from "../ui-registry.ts";

let tmpDir: string;
let parachuteDir: string;

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeUi(
  name: string,
  mountPath: string,
  files: Record<string, string>,
  extraMeta: Record<string, unknown> = {},
): RegisteredUi {
  const uiDir = path.join(tmpDir, "uis", name);
  const distDir = path.join(uiDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const [filename, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, filename), body);
  }
  return {
    dirName: name,
    uiDir,
    distDir,
    meta: {
      name,
      displayName: name,
      path: mountPath,
      scopes_required: ["vault:*:read"],
      pwa: false,
      public: false,
      ...extraMeta,
    },
  };
}

function makeState(uis: RegisteredUi[] = []): AppState {
  return {
    config: {
      hub_url: "http://127.0.0.1:1939",
      auto_register_oauth_clients: true,
      disabled: false,
      default_scope_required: ["vault:*:read"],
      dev_mode_allowed: true,
      bootstrap_default_apps: { enabled: false, apps: [] },
      auto_provision_required_schema: false,
    },
    registeredUis: uis,
    skippedUis: [],
  };
}

function startServer(state: AppState): {
  url: string;
  stop: () => void;
} {
  // parachuteDir holds the `info` and `config/schema` files served by /.parachute/*
  const server = startHttpServer({
    state,
    port: 0,
    startedAt: new Date(),
    parachuteDir,
    logger: silentLogger,
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-http-"));
  parachuteDir = path.join(tmpDir, ".parachute");
  fs.mkdirSync(path.join(parachuteDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(parachuteDir, "info"),
    JSON.stringify({ name: "parachute-app", version: "0.1.0-rc.2" }),
  );
  fs.writeFileSync(
    path.join(parachuteDir, "config", "schema"),
    JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#" }),
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("HTTP — healthz + .parachute/*", () => {
  test("/healthz returns 200 with UI count", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": "<!doctype html>" });
    const state = makeState([ui]);
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/healthz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; uis: number };
      expect(body.status).toBe("ok");
      expect(body.uis).toBe(1);
    } finally {
      srv.stop();
    }
  });

  test("/app/healthz mirrors /healthz", async () => {
    const state = makeState([]);
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/app/healthz`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { status: string; uis: number };
      expect(body.status).toBe("ok");
      expect(body.uis).toBe(0);
    } finally {
      srv.stop();
    }
  });

  test("/.parachute/info served from parachuteDir", async () => {
    const state = makeState([]);
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/.parachute/info`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { name: string };
      expect(body.name).toBe("parachute-app");
    } finally {
      srv.stop();
    }
  });

  test("/.parachute/config/schema served from parachuteDir", async () => {
    const state = makeState([]);
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/.parachute/config/schema`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { $schema: string };
      expect(body.$schema).toContain("draft-07");
    } finally {
      srv.stop();
    }
  });

  test("/.parachute/config returns current config", async () => {
    const state = makeState([]);
    const srv = startServer(state);
    try {
      const r = await fetch(`${srv.url}/.parachute/config`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { hub_url: string };
      expect(body.hub_url).toBe("http://127.0.0.1:1939");
    } finally {
      srv.stop();
    }
  });
});

describe("HTTP — UI mount paths", () => {
  test("GET /<path>/ serves index.html with no-cache", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": "Hello Notes" });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
      expect(await r.text()).toBe("Hello Notes");
    } finally {
      srv.stop();
    }
  });

  test("GET /<path> (no trailing slash) serves index.html", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": "Hello Notes" });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
      expect(await r.text()).toBe("Hello Notes");
    } finally {
      srv.stop();
    }
  });

  test("GET /<path>/<hashed-asset> serves with immutable header", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "i",
      "app.a3b9f2c1.js": "console.log('hi')",
    });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/app.a3b9f2c1.js`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("javascript");
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await r.text()).toBe("console.log('hi')");
    } finally {
      srv.stop();
    }
  });

  test("GET /<path>/<non-hashed-asset> serves with 1-hour cache", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "i",
      "icon.svg": "<svg/>",
    });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/icon.svg`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/svg+xml");
      expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    } finally {
      srv.stop();
    }
  });

  test("SPA fallback: unknown subpath under mount serves index.html", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": "Hello" });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/some/spa/route`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
      expect(await r.text()).toBe("Hello");
    } finally {
      srv.stop();
    }
  });

  test("PWA opt-in: SW served with no-cache", async () => {
    const ui = makeUi(
      "notes",
      "/app/notes",
      { "index.html": "i", "sw.js": "self.skipWaiting()" },
      { pwa: true, pwa_service_worker: "sw.js" },
    );
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/sw.js`);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-cache");
      expect(await r.text()).toBe("self.skipWaiting()");
    } finally {
      srv.stop();
    }
  });

  test("HEAD returns headers + no body", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "i",
      "app.a3b9f2c1.js": "x",
    });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/app.a3b9f2c1.js`, { method: "HEAD" });
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(r.headers.get("content-length")).toBe("1");
      // Body should be empty
      const body = await r.text();
      expect(body).toBe("");
    } finally {
      srv.stop();
    }
  });

  test("path traversal attempt → SPA fallback (defense in depth)", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": "safe" });
    // Write a sensitive file in the parent
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "very secret");
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/..%2Fsecret.txt`);
      expect(r.status).toBe(200);
      // We get index.html, not the secret.
      expect(await r.text()).toBe("safe");
    } finally {
      srv.stop();
    }
  });

  test("two UIs at different mounts", async () => {
    const ui1 = makeUi("foo", "/app/foo", { "index.html": "FOO" });
    const ui2 = makeUi("bar", "/app/bar", { "index.html": "BAR" });
    const srv = startServer(makeState([ui1, ui2]));
    try {
      const r1 = await fetch(`${srv.url}/app/foo/`);
      expect(await r1.text()).toBe("FOO");
      const r2 = await fetch(`${srv.url}/app/bar/`);
      expect(await r2.text()).toBe("BAR");
    } finally {
      srv.stop();
    }
  });
});

describe("HTTP — 404 + 405", () => {
  test("404 outside any mount", async () => {
    const srv = startServer(makeState([]));
    try {
      const r = await fetch(`${srv.url}/unrelated-path`);
      expect(r.status).toBe(404);
      // Body is the generic "Not Found" — must not leak any path / error detail.
      expect(await r.text()).toBe("Not Found");
    } finally {
      srv.stop();
    }
  });

  test("404 body is generic — no OS error path leak when file vanishes mid-request", async () => {
    // Register a UI, then delete index.html so serveFileWithHeaders catches the
    // readFileSync ENOENT and falls into the 404 path. The body must NOT contain
    // the absolute filesystem path that ENOENT's error message exposes.
    const ui = makeUi("notes", "/app/notes", { "index.html": "<!doctype html>" });
    fs.unlinkSync(path.join(ui.distDir, "index.html"));
    const srv = startServer(makeState([ui]));
    try {
      // Any subpath under the mount routes through serveUiAsset → SPA fallback
      // → serveFileWithHeaders(indexHtmlPath) → ENOENT → generic 404.
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(404);
      const body = await r.text();
      expect(body).toBe("Not Found");
      // Sanity: the OS error format ("ENOENT", absolute path, "no such file")
      // must NOT appear in the response body.
      expect(body).not.toContain("ENOENT");
      expect(body).not.toContain(ui.distDir);
      expect(body).not.toContain("no such file");
    } finally {
      srv.stop();
    }
  });

  test("404 under /app but no matching UI", async () => {
    const srv = startServer(makeState([]));
    try {
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  test("POST to a non-admin route returns 404", async () => {
    // Phase 1.2 opened POST/DELETE for admin endpoints. Non-admin paths still
    // fall through to 404 — the prior 405 shape only fit when no method ever
    // matched a write.
    const srv = startServer(makeState([]));
    try {
      const r = await fetch(`${srv.url}/healthz`, { method: "POST" });
      expect(r.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  test("DELETE to a non-admin route returns 404", async () => {
    // /not-an-app/x doesn't match the `/app/<name>` admin DELETE regex.
    const srv = startServer(makeState([]));
    try {
      const r = await fetch(`${srv.url}/not-an-app/something`, { method: "DELETE" });
      expect(r.status).toBe(404);
    } finally {
      srv.stop();
    }
  });

  test("PATCH (unsupported method) returns 405", async () => {
    const srv = startServer(makeState([]));
    try {
      const r = await fetch(`${srv.url}/app/healthz`, { method: "PATCH" });
      expect(r.status).toBe(405);
    } finally {
      srv.stop();
    }
  });
});
