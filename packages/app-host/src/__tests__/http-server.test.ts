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

  test("path traversal attempt with asset extension → 404 (defense in depth)", async () => {
    // Asset-shaped traversal attempts must NOT fall through to the SPA shell —
    // returning HTML for a `.txt` (or `.js`, `.json`, etc.) request would make
    // the browser try to parse the SPA HTML as text/JS, masking the real
    // failure. With the asset-vs-navigation split, traversal attempts whose
    // suffix looks like an asset return 404.
    const ui = makeUi("notes", "/app/notes", { "index.html": "safe" });
    // Write a sensitive file in the parent
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "very secret");
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/..%2Fsecret.txt`);
      expect(r.status).toBe(404);
      // Body is the generic "Not Found" — definitely not the secret.
      const body = await r.text();
      expect(body).toBe("Not Found");
      expect(body).not.toContain("very secret");
    } finally {
      srv.stop();
    }
  });

  test("path traversal attempt with no extension → SPA fallback (still defended)", async () => {
    // A traversal attempt whose suffix is a route-shape (no extension) still
    // falls through to the SPA shell — the index.html is served, NOT the
    // traversal target. The defense-in-depth check fires before path.resolve
    // ever sees the segments.
    const ui = makeUi("notes", "/app/notes", { "index.html": "safe" });
    fs.writeFileSync(path.join(tmpDir, "secret"), "very secret");
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/..%2Fsecret`);
      expect(r.status).toBe(200);
      // SPA shell, not the secret.
      expect(await r.text()).toBe("safe");
    } finally {
      srv.stop();
    }
  });

  describe("asset-vs-navigation miss policy", () => {
    // The SPA-fallback rule masks missing-asset failures: a request for a
    // missing `.js` chunk that's answered with HTML triggers a confusing
    // "Expected JavaScript-or-Wasm module, got 'text/html'" in the browser.
    // Missing assets must return 404; only navigation requests (no extension,
    // or .html) fall through to the SPA shell.

    test("missing .js asset returns 404 (not SPA shell)", async () => {
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/missing-chunk.js`);
        expect(r.status).toBe(404);
        const body = await r.text();
        expect(body).toBe("Not Found");
        // The SPA-shell body must NOT leak through — that's the whole bug.
        expect(body).not.toContain("SPA SHELL");
      } finally {
        srv.stop();
      }
    });

    test("missing .webmanifest returns 404 (not SPA shell)", async () => {
      // The motivating real-world symptom: a missing PWA manifest answered
      // with HTML triggers "Manifest: Line: 1, column: 1, Syntax error."
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/manifest.webmanifest`);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Not Found");
      } finally {
        srv.stop();
      }
    });

    test("missing .mjs asset returns 404 (not SPA shell)", async () => {
      // Native ES module chunks. Some Vite configs emit .mjs; the policy must
      // cover them identically to .js.
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/assets/chunk.mjs`);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe("Not Found");
      } finally {
        srv.stop();
      }
    });

    test("missing .css asset returns 404 (not SPA shell)", async () => {
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/styles/missing.css`);
        expect(r.status).toBe(404);
      } finally {
        srv.stop();
      }
    });

    test("missing path with no extension serves SPA shell (client-side route)", async () => {
      // Navigation requests must still hit the SPA shell so the client-side
      // router can decide what to render — this is the SPA-fallback behavior
      // we want to preserve.
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/some/route/without/extension`);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(await r.text()).toBe("SPA SHELL");
      } finally {
        srv.stop();
      }
    });

    test("missing path with .html extension serves SPA shell", async () => {
      // .html is explicitly treated as a navigation request, not an asset —
      // routers that use `.html` suffixes for their routes still get the SPA
      // shell served.
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/route.html`);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toContain("text/html");
        expect(await r.text()).toBe("SPA SHELL");
      } finally {
        srv.stop();
      }
    });

    test("missing bare segment (e.g. /app/notes/notes) serves SPA shell", async () => {
      const ui = makeUi("notes", "/app/notes", { "index.html": "SPA SHELL" });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/notes`);
        expect(r.status).toBe(200);
        expect(await r.text()).toBe("SPA SHELL");
      } finally {
        srv.stop();
      }
    });

    test("present .js asset still serves correctly (regression guard)", async () => {
      // Existing asset-served-when-present path must not regress — the fix
      // only changes the miss branch.
      const ui = makeUi("notes", "/app/notes", {
        "index.html": "SPA SHELL",
        "real.js": "console.log('hi')",
      });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/real.js`);
        expect(r.status).toBe(200);
        expect(r.headers.get("content-type")).toContain("javascript");
        expect(await r.text()).toBe("console.log('hi')");
      } finally {
        srv.stop();
      }
    });
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

describe("HTTP — runtime tenancy contract injection", () => {
  // Verifies parachute-app implements the producer side of
  // `parachute-patterns/patterns/runtime-tenancy-contract.md`:
  // every `index.html` served on behalf of a hosted UI gets <base href> +
  // <meta name="parachute-mount"> + <meta name="parachute-hub"> injected.

  const HEAD_HTML = "<!doctype html><html><head><title>x</title></head><body>SPA</body></html>";

  test("root document GET /app/notes/ — tags injected", async () => {
    const ui = makeUi("notes", "/app/notes", { "index.html": HEAD_HTML });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('<base href="/app/notes/">');
      expect(body).toContain('<meta name="parachute-mount" content="/app/notes">');
      expect(body).toContain('<meta name="parachute-hub" content="http://127.0.0.1:1939">');
    } finally {
      srv.stop();
    }
  });

  test("GET /app/notes (no trailing slash) — tags also injected", async () => {
    // The no-trailing-slash path is Aaron's concrete reproducer for the bug
    // this fixes: without <base href>, Vite-built relative URLs resolve
    // against `/app/` and break.
    const ui = makeUi("notes", "/app/notes", { "index.html": HEAD_HTML });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('<base href="/app/notes/">');
      expect(body).toContain('<meta name="parachute-mount" content="/app/notes">');
    } finally {
      srv.stop();
    }
  });

  test("custom mount slug — <base href> + parachute-mount reflect it", async () => {
    // Operators can `parachute-app add @openparachute/notes-ui --name my-notes`
    // to mount a UI at /app/my-notes. The bundle is identical; only the host's
    // injected metadata reveals the chosen mount.
    const ui = makeUi("my-notes", "/app/my-notes", { "index.html": HEAD_HTML });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/my-notes/`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('<base href="/app/my-notes/">');
      expect(body).toContain('<meta name="parachute-mount" content="/app/my-notes">');
    } finally {
      srv.stop();
    }
  });

  test("SPA-fallback path /app/notes/some/route — also injects", async () => {
    // The SPA-fallback path serves index.html for any unknown navigation
    // request under the mount. The injection must run there too, otherwise
    // operators who hit a deep link as their first request lose the contract.
    const ui = makeUi("notes", "/app/notes", { "index.html": HEAD_HTML });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/some/spa/route`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain('<base href="/app/notes/">');
      expect(body).toContain('<meta name="parachute-mount" content="/app/notes">');
      expect(body).toContain('<meta name="parachute-hub" content="http://127.0.0.1:1939">');
    } finally {
      srv.stop();
    }
  });

  test("idempotent — bundle that already declares parachute-mount is served unchanged", async () => {
    // Defense-in-depth: a future bundle that ships its own meta tag must not
    // get a double-injection.
    const pre = `<!doctype html><html><head>
      <meta name="parachute-mount" content="/app/notes">
      <title>bundle-owned</title>
    </head><body>OK</body></html>`;
    const ui = makeUi("notes", "/app/notes", { "index.html": pre });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(200);
      const body = await r.text();
      // Exactly one occurrence of the meta tag (bundle's), no duplicate.
      const matches = body.match(/<meta\s+name=["']parachute-mount["']/gi) ?? [];
      expect(matches.length).toBe(1);
      // Original body still served verbatim.
      expect(body).toBe(pre);
    } finally {
      srv.stop();
    }
  });

  test("malformed (no <head>) index.html — served unmodified", async () => {
    // A bundle with no <head> in its index.html still serves. Operator gets a
    // warning in the logs (silenced in this test); the body comes through raw.
    const malformed = "<!doctype html><html><body>only body</body></html>";
    const ui = makeUi("notes", "/app/notes", { "index.html": malformed });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/`);
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toBe(malformed);
      expect(body).not.toContain("parachute-mount");
    } finally {
      srv.stop();
    }
  });

  test("PARACHUTE_HUB_ORIGIN env var overrides config.hub_url", async () => {
    // `getHubOrigin()` reads PARACHUTE_HUB_ORIGIN first, then state.config.hub_url.
    // Set the env var, expect the injected meta tag to reflect it.
    const prev = process.env.PARACHUTE_HUB_ORIGIN;
    process.env.PARACHUTE_HUB_ORIGIN = "https://parachute.example.com";
    try {
      const ui = makeUi("notes", "/app/notes", { "index.html": HEAD_HTML });
      const srv = startServer(makeState([ui]));
      try {
        const r = await fetch(`${srv.url}/app/notes/`);
        expect(r.status).toBe(200);
        const body = await r.text();
        expect(body).toContain(
          '<meta name="parachute-hub" content="https://parachute.example.com">',
        );
      } finally {
        srv.stop();
      }
    } finally {
      if (prev === undefined) {
        process.env.PARACHUTE_HUB_ORIGIN = undefined;
      } else {
        process.env.PARACHUTE_HUB_ORIGIN = prev;
      }
    }
  });

  test("non-index assets are NOT touched (regression guard)", async () => {
    // Injection is gated on `filenameForHeaders === "index.html"`. A JS bundle
    // that happens to contain `<head>` substrings must come through bit-exact.
    const js = "/* <head>not html</head> */\nconsole.log('hi');\n";
    const ui = makeUi("notes", "/app/notes", {
      "index.html": HEAD_HTML,
      "app.js": js,
    });
    const srv = startServer(makeState([ui]));
    try {
      const r = await fetch(`${srv.url}/app/notes/app.js`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe(js);
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
