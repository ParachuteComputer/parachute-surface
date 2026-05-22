/**
 * End-to-end Phase 1.3 tests via the real Bun.serve HTTP layer.
 *
 * Coverage:
 *   - With dev mode ON, GET /app/<name>/ injects the reload script
 *   - With dev mode OFF, GET /app/<name>/ does NOT inject
 *   - With dev mode ON, hashed-asset response has no-cache, no-store
 *     (smart-cache `immutable` is overridden)
 *   - With dev mode ON, SW response is no-cache, no-store (overrides
 *     even the PWA SW path which was already no-cache pre-1.3)
 *   - SSE endpoint receives reload broadcast end-to-end
 *   - Trigger endpoint via HTTP returns notified count
 *   - Trigger endpoint surfaces 409 when dev mode is off
 *   - Dev list endpoint reflects state
 *   - HEAD on index.html under dev mode includes the injected-length
 *     Content-Length (matches the body byte count of the injected doc)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resetDevMode } from "../dev-mode.ts";
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

const allowAll = async (_req: Request, scope: "app:admin" | "app:read") => ({
  scopes: [scope],
});

function startServer(state: AppState): {
  url: string;
  stop: () => void;
} {
  const server = startHttpServer({
    state,
    port: 0,
    startedAt: new Date(),
    parachuteDir,
    logger: silentLogger,
    adminOpts: { enforceScopeFn: allowAll, logger: silentLogger },
    devOpts: { enforceScopeFn: allowAll, logger: silentLogger },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-dev-"));
  parachuteDir = path.join(tmpDir, ".parachute");
  fs.mkdirSync(path.join(parachuteDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(parachuteDir, "info"),
    JSON.stringify({ name: "parachute-app", version: "0.1.0-rc.4" }),
  );
  fs.writeFileSync(
    path.join(parachuteDir, "config", "schema"),
    JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#" }),
  );
  resetDevMode();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetDevMode();
});

describe("dev mode — end-to-end through HTTP", () => {
  test("dev mode injects the reload script into index.html", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head><title>Notes</title></head><body>hi</body></html>",
    });
    const srv = startServer(makeState([ui]));
    try {
      // Pre-dev: no injection.
      const before = await fetch(`${srv.url}/app/notes/`);
      const beforeText = await before.text();
      expect(beforeText).not.toContain("parachute-app-dev-reload");

      // Enable
      const enable = await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      expect(enable.status).toBe(200);

      // Post-dev: injected.
      const after = await fetch(`${srv.url}/app/notes/`);
      const afterText = await after.text();
      expect(afterText).toContain(`id="parachute-app-dev-reload"`);
      expect(afterText).toContain(`new EventSource("/app/notes/_dev/reload")`);
      // Cache-Control overridden to no-store
      expect(after.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    } finally {
      srv.stop();
    }
  });

  test("dev mode overrides hashed-asset immutable header with no-store", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
      "app.a3b9f2c1.js": "console.log('x')",
    });
    const srv = startServer(makeState([ui]));
    try {
      const enable = await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      expect(enable.status).toBe(200);

      const asset = await fetch(`${srv.url}/app/notes/app.a3b9f2c1.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    } finally {
      srv.stop();
    }
  });

  test("dev mode overrides PWA SW cache header as well", async () => {
    const ui = makeUi(
      "notes",
      "/app/notes",
      {
        "index.html": "<!doctype html><html><head></head></html>",
        "sw.js": "self.skipWaiting()",
      },
      { pwa: true, pwa_service_worker: "sw.js" },
    );
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      const sw = await fetch(`${srv.url}/app/notes/sw.js`);
      expect(sw.status).toBe(200);
      // Pre-1.3 PWA SW was just `no-cache`; dev mode tightens it to no-store.
      expect(sw.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate");
    } finally {
      srv.stop();
    }
  });

  test("HEAD on index.html in dev mode reports injected byte length", async () => {
    const html = "<!doctype html><html><head></head><body>hi</body></html>";
    const ui = makeUi("notes", "/app/notes", { "index.html": html });
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      const head = await fetch(`${srv.url}/app/notes/`, { method: "HEAD" });
      expect(head.status).toBe(200);
      const cl = Number(head.headers.get("content-length") ?? "0");
      // Injected body is strictly larger than the original.
      expect(cl).toBeGreaterThan(html.length);
    } finally {
      srv.stop();
    }
  });

  test("SSE stream receives a broadcast when trigger fires", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
    });
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });

      const sseRes = await fetch(`${srv.url}/app/notes/_dev/reload`);
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toBe("text/event-stream");
      const reader = sseRes.body!.getReader();
      // Initial keepalive line
      const first = await reader.read();
      expect(first.done).toBe(false);

      // Trigger the broadcast over HTTP
      const trig = await fetch(`${srv.url}/app/notes/dev/trigger`, { method: "POST" });
      expect(trig.status).toBe(200);
      const trigBody = (await trig.json()) as { notified: number };
      expect(trigBody.notified).toBe(1);

      // Next read should be the reload frame
      const next = await reader.read();
      const frame = new TextDecoder().decode(next.value);
      expect(frame).toContain("event: reload");
      expect(frame).toMatch(/"timestamp":\d+/);

      await reader.cancel();
    } finally {
      srv.stop();
    }
  });

  test("trigger when off returns 409", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
    });
    const srv = startServer(makeState([ui]));
    try {
      const trig = await fetch(`${srv.url}/app/notes/dev/trigger`, { method: "POST" });
      expect(trig.status).toBe(409);
    } finally {
      srv.stop();
    }
  });

  test("disable closes active SSE streams", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
    });
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      const sseRes = await fetch(`${srv.url}/app/notes/_dev/reload`);
      const reader = sseRes.body!.getReader();
      await reader.read(); // consume keepalive

      // Disable + verify the reader sees end-of-stream
      await fetch(`${srv.url}/app/notes/dev/disable`, { method: "POST" });
      const done = await reader.read();
      expect(done.done).toBe(true);
    } finally {
      srv.stop();
    }
  });

  test("dev list endpoint reflects state", async () => {
    const ui1 = makeUi("foo", "/app/foo", { "index.html": "<html/>" });
    const ui2 = makeUi("bar", "/app/bar", { "index.html": "<html/>" });
    const srv = startServer(makeState([ui1, ui2]));
    try {
      // Initially empty
      let listRes = await fetch(`${srv.url}/app/dev/list`);
      let body = (await listRes.json()) as { uis: Array<{ name: string }> };
      expect(body.uis).toEqual([]);

      // Enable foo
      await fetch(`${srv.url}/app/foo/dev/enable`, { method: "POST" });

      listRes = await fetch(`${srv.url}/app/dev/list`);
      body = (await listRes.json()) as { uis: Array<{ name: string }> };
      expect(body.uis.map((u) => u.name)).toEqual(["foo"]);
    } finally {
      srv.stop();
    }
  });

  test("re-fetching index in dev mode doesn't duplicate the script", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
    });
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      const first = await (await fetch(`${srv.url}/app/notes/`)).text();
      const second = await (await fetch(`${srv.url}/app/notes/`)).text();
      // The on-disk file is unchanged between requests, so each response is
      // injected fresh against the original — both should have exactly one
      // marker. We're not deduping cross-request (different documents), so
      // each request gets one injection.
      const count = (first.match(/parachute-app-dev-reload/g) ?? []).length;
      expect(count).toBe(1);
      expect((second.match(/parachute-app-dev-reload/g) ?? []).length).toBe(1);
    } finally {
      srv.stop();
    }
  });

  test("disabling dev mode restores production headers + no injection", async () => {
    const ui = makeUi("notes", "/app/notes", {
      "index.html": "<!doctype html><html><head></head></html>",
      "app.a3b9f2c1.js": "x",
    });
    const srv = startServer(makeState([ui]));
    try {
      await fetch(`${srv.url}/app/notes/dev/enable`, { method: "POST" });
      const onText = await (await fetch(`${srv.url}/app/notes/`)).text();
      expect(onText).toContain("parachute-app-dev-reload");

      await fetch(`${srv.url}/app/notes/dev/disable`, { method: "POST" });
      const off = await fetch(`${srv.url}/app/notes/`);
      const offText = await off.text();
      expect(offText).not.toContain("parachute-app-dev-reload");
      expect(off.headers.get("cache-control")).toBe("no-cache, no-store, must-revalidate"); // index.html

      const asset = await fetch(`${srv.url}/app/notes/app.a3b9f2c1.js`);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    } finally {
      srv.stop();
    }
  });
});
