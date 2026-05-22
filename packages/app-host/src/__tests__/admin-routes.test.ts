/**
 * Tests for `src/admin-routes.ts` — the Phase 1.2 admin endpoints.
 *
 * Coverage:
 *   - Auth gates: 401 without bearer (real auth path) for each protected route
 *   - Test-seam auth bypass exercises the post-auth behavior
 *   - GET /app/list returns serialized UI summaries (+ oauth_client_id when known)
 *   - GET /app/<name>/info returns full meta + oauth + paths
 *   - GET /app/<name>/oauth-client UNAUTHENTICATED + returns client_id
 *   - GET /app/<name>/oauth-client 404 when UI exists but no OAuth record
 *   - GET /app/<name>/oauth-client 404 when UI doesn't exist
 *   - POST /app/add with a local path → copy + meta.json + re-scan
 *   - POST /app/add with overrides (name + path from body) overrides meta.json
 *   - POST /app/add with bad source → 400
 *   - POST /app/add with reserved /app/admin path → 409 reserved_path
 *   - POST /app/add with collision → 409 path_taken
 *   - POST /app/add with name_exists no-force → 409
 *   - POST /app/add with auto_register=true triggers DCR + persists client_id
 *   - DELETE /app/<name> removes dir, revokes OAuth, updates state
 *   - DELETE /app/<name> 404 on missing UI
 *   - POST /app/<name>/reload re-scans + returns updated UI
 *   - POST /app/<name>/reload 404 on missing UI dir
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type AdminHandlerOpts,
  type AdminMutableState,
  type EnforceScopeFn,
  routeAdmin,
} from "../admin-routes.ts";
import { writeOauthClientFile } from "../dcr.ts";
import type { AppState } from "../http-server.ts";
import type { NpmSpawnFn } from "../npm-fetch.ts";
import { scanUis } from "../ui-registry.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let uisDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-admin-"));
  uisDir = path.join(tmpDir, "uis");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<AppState["config"]> = {}): AppState {
  const scan = scanUis({ uisDir, logger: silentLogger });
  return {
    config: {
      hub_url: "http://127.0.0.1:1939",
      auto_register_oauth_clients: false,
      disabled: false,
      default_scope_required: ["vault:*:read"],
      dev_mode_allowed: true,
      bootstrap_default_apps: { enabled: false, apps: [] },
      auto_provision_required_schema: false,
      ...overrides,
    },
    registeredUis: scan.registered,
    skippedUis: scan.skipped.map((s) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    })),
  };
}

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

function seedLocalSource(localName: string, files: Record<string, string>): string {
  const root = path.join(tmpDir, "src", localName);
  fs.mkdirSync(root, { recursive: true });
  for (const [filename, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, filename), body);
  }
  return root;
}

/** Allow-all auth shim for tests. */
const allowAdmin: EnforceScopeFn = async () => ({ scopes: ["app:admin"] });

async function dispatch(
  req: Request,
  state: AdminMutableState,
  extra: Partial<AdminHandlerOpts> = {},
): Promise<Response> {
  const result = routeAdmin(req, {
    state,
    uisDir,
    manifestPath,
    logger: silentLogger,
    skipSelfRegisterRefresh: true,
    ...extra,
  });
  if (!result.handled) {
    throw new Error("routeAdmin did not handle this request");
  }
  return await result.response;
}

describe("auth gates (no bearer → 401)", () => {
  test("GET /app/list", async () => {
    // No enforceScopeFn override → real auth path → no Authorization → 401.
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/app/list"), state);
    expect(res.status).toBe(401);
  });
  test("POST /app/add", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", { method: "POST", body: "{}" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("DELETE /app/test", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/test", { method: "DELETE" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("POST /app/test/reload", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/test/reload", { method: "POST" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("GET /app/test/info", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/app/test/info"), state);
    expect(res.status).toBe(401);
  });
});

describe("GET /app/<name>/oauth-client (UNAUTHENTICATED)", () => {
  test("returns client_id when record exists", async () => {
    seedUi("test", "/app/test", { "index.html": "<html></html>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_abc",
      client_name: "Test",
      redirect_uris: ["http://hub/app/test/"],
      scope: "vault:*:read",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/app/test/oauth-client"), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id: string; hub_url: string; scope: string };
    expect(body.client_id).toBe("client_abc");
    expect(body.hub_url).toBe("http://hub");
    expect(body.scope).toBe("vault:*:read");
  });

  test("404 when UI exists but no OAuth record", async () => {
    seedUi("test", "/app/test", { "index.html": "<html></html>" });
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/app/test/oauth-client"), state);
    expect(res.status).toBe(404);
  });

  test("404 when UI doesn't exist", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/app/nope/oauth-client"), state);
    expect(res.status).toBe(404);
  });
});

describe("GET /app/list", () => {
  test("returns serialized UIs + oauth_client_id when present", async () => {
    seedUi("alpha", "/app/alpha", { "index.html": "<a/>" });
    seedUi("beta", "/app/beta", { "index.html": "<b/>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_alpha",
      client_name: "alpha",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/app/list"), state, {
      enforceScopeFn: allowAdmin,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uis: Array<{ name: string; path: string; oauthClientId?: string }>;
    };
    expect(body.uis).toHaveLength(2);
    const alpha = body.uis.find((u) => u.name === "alpha");
    expect(alpha?.oauthClientId).toBe("client_alpha");
    const beta = body.uis.find((u) => u.name === "beta");
    expect(beta?.oauthClientId).toBeUndefined();
  });
});

describe("GET /app/<name>/info", () => {
  test("returns full info incl. meta + paths + oauth", async () => {
    seedUi("test", "/app/test", { "index.html": "<x/>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_info",
      client_name: "Test",
      redirect_uris: [],
      scope: "",
      registered_at: "2026-05-21T00:00:00Z",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/app/test/info"), state, {
      enforceScopeFn: allowAdmin,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ui: { name: string };
      meta: { path: string };
      paths: { uiDir: string; distDir: string };
      oauth_client: { client_id: string } | null;
    };
    expect(body.ui.name).toBe("test");
    expect(body.meta.path).toBe("/app/test");
    expect(body.paths.distDir).toContain("test");
    expect(body.oauth_client?.client_id).toBe("client_info");
  });

  test("404 on unknown name", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/app/nope/info"), state, {
      enforceScopeFn: allowAdmin,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /app/add", () => {
  test("invalid JSON body → 400", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", { method: "POST", body: "{not json" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(400);
  });

  test("missing source → 400 bad_request", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", { method: "POST", body: "{}" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  test("non-existent local path + bad npm spec → 400 bad_source", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: "/this/does/not/exist", name: "x", path: "/app/x" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_source");
  });

  test("local source with no index.html → 400 bad_source", async () => {
    const src = seedLocalSource("nohtml", { "main.js": "" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "x", path: "/app/x" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(400);
  });

  test("happy path: local source copied + meta.json written + state updated", async () => {
    const src = seedLocalSource("good", { "index.html": "<html>good</html>" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "myui",
          path: "/app/myui",
          displayName: "My UI",
          scopes_required: ["vault:default:read"],
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; ui: { name: string; path: string } };
    expect(body.ok).toBe(true);
    expect(body.ui.name).toBe("myui");
    expect(body.ui.path).toBe("/app/myui");

    // Files on disk
    const targetDir = path.join(uisDir, "myui");
    expect(fs.existsSync(path.join(targetDir, "dist", "index.html"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(targetDir, "meta.json"), "utf8"));
    expect(meta.name).toBe("myui");
    expect(meta.path).toBe("/app/myui");
    expect(meta.displayName).toBe("My UI");
    expect(meta.scopes_required).toEqual(["vault:default:read"]);

    // State updated
    expect(state.registeredUis.find((u) => u.meta.name === "myui")).toBeDefined();
  });

  test("body overrides override on-disk meta.json", async () => {
    const src = seedLocalSource("override", {
      "index.html": "<x/>",
    });
    // Add a sibling meta.json that the body should override.
    fs.writeFileSync(
      path.join(src, "meta.json"),
      JSON.stringify({ name: "from-disk", displayName: "From Disk", path: "/app/from-disk" }),
    );
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "from-body", path: "/app/from-body" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(201);
    expect(state.registeredUis.find((u) => u.meta.name === "from-body")).toBeDefined();
  });

  test("reserved path /app/admin → 409 reserved_path", async () => {
    const src = seedLocalSource("badadm", { "index.html": "<x/>" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "evil", path: "/app/admin" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reserved_path");
  });

  test("name collision (no force) → 409 name_exists", async () => {
    seedUi("conflict", "/app/conflict", { "index.html": "<x/>" });
    const state = makeState();
    const src = seedLocalSource("conflict-src", { "index.html": "<y/>" });
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "conflict",
          path: "/app/conflict-other",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name_exists");
  });

  test("path collision → 409 path_taken", async () => {
    seedUi("alpha", "/app/shared", { "index.html": "<x/>" });
    const state = makeState();
    const src = seedLocalSource("beta-src", { "index.html": "<y/>" });
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "beta", path: "/app/shared" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_taken");
  });

  test("force=true replaces existing UI", async () => {
    seedUi("replaceme", "/app/replaceme", { "index.html": "old" });
    const state = makeState();
    const src = seedLocalSource("newcontent", { "index.html": "new" });
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "replaceme",
          path: "/app/replaceme",
          force: true,
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(201);
    const target = path.join(uisDir, "replaceme", "dist", "index.html");
    expect(fs.readFileSync(target, "utf8")).toBe("new");
  });

  test("auto_register_oauth_clients=true triggers DCR + persists client_id", async () => {
    const src = seedLocalSource("dcr", { "index.html": "<x/>" });
    const state = makeState({ auto_register_oauth_clients: true });
    let dcrCalled = false;
    const fakeFetch: import("../dcr.ts").FetchFn = (url, init) => {
      dcrCalled = true;
      expect(url).toBe("http://127.0.0.1:1939/oauth/register");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.client_name).toBe("DCR UI");
      expect(body.scope).toBe("vault:default:read");
      return Promise.resolve(
        new Response(JSON.stringify({ client_id: "client_dcr_abc", status: "approved" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "dcr",
          path: "/app/dcr",
          displayName: "DCR UI",
          scopes_required: ["vault:default:read"],
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin, fetchFn: fakeFetch, operatorTokenOverride: () => "op-token" },
    );
    expect(res.status).toBe(201);
    expect(dcrCalled).toBe(true);
    const body = (await res.json()) as { oauth_client_id: string; oauth_status: string };
    expect(body.oauth_client_id).toBe("client_dcr_abc");
    expect(body.oauth_status).toBe("approved");
    // File persisted
    const oauthFile = path.join(uisDir, "dcr", ".oauth-client.json");
    expect(fs.existsSync(oauthFile)).toBe(true);
  });

  test("auto_register_oauth_clients=true with hub unreachable → warning, not failure", async () => {
    const src = seedLocalSource("offline", { "index.html": "<x/>" });
    const state = makeState({ auto_register_oauth_clients: true });
    const fakeFetch: import("../dcr.ts").FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "offline",
          path: "/app/offline",
          displayName: "Offline",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin, fetchFn: fakeFetch },
    );
    expect(res.status).toBe(201); // install succeeded
    const body = (await res.json()) as { warning?: string; oauth_client_id?: string };
    expect(body.warning).toContain("hub unreachable");
    expect(body.oauth_client_id).toBeUndefined();
  });
});

describe("POST /app/add via npm-fetch", () => {
  test("happy path via mocked bun add", async () => {
    const state = makeState();
    const npmSpawn: NpmSpawnFn = async (argv, cwd) => {
      expect(argv).toEqual(["bun", "add", "--ignore-scripts", "@openparachute/notes-ui"]);
      const root = path.join(cwd, "node_modules", "@openparachute", "notes-ui");
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "dist", "index.html"), "<n>notes</n>");
      fs.writeFileSync(
        path.join(root, "meta.json"),
        JSON.stringify({
          name: "notes",
          displayName: "Notes",
          path: "/app/notes",
          version: "0.1.0",
          scopes_required: ["vault:*:read", "vault:*:write"],
        }),
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({ source: "@openparachute/notes-ui" }),
      }),
      state,
      { enforceScopeFn: allowAdmin, npmSpawnFn: npmSpawn },
    );
    expect(res.status).toBe(201);
    expect(state.registeredUis.find((u) => u.meta.name === "notes")).toBeDefined();
    // Target dist contains the staged file
    const indexPath = path.join(uisDir, "notes", "dist", "index.html");
    expect(fs.readFileSync(indexPath, "utf8")).toBe("<n>notes</n>");
  });

  test("npm package not found → 404", async () => {
    const state = makeState();
    const npmSpawn: NpmSpawnFn = async () => ({
      exitCode: 1,
      stderr: "error: 404 not found",
      stdout: "",
    });
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: "@doesnt/exist",
          name: "x",
          path: "/app/x",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin, npmSpawnFn: npmSpawn },
    );
    expect(res.status).toBe(404);
  });

  test("package without dist/ → 422", async () => {
    const state = makeState();
    const npmSpawn: NpmSpawnFn = async (_argv, cwd) => {
      fs.mkdirSync(path.join(cwd, "node_modules", "@foo", "no-dist"), { recursive: true });
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const res = await dispatch(
      new Request("http://localhost/app/add", {
        method: "POST",
        body: JSON.stringify({
          source: "@foo/no-dist",
          name: "x",
          path: "/app/x",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin, npmSpawnFn: npmSpawn },
    );
    expect(res.status).toBe(422);
  });
});

describe("DELETE /app/<name>", () => {
  test("happy path removes dir + updates state", async () => {
    seedUi("victim", "/app/victim", { "index.html": "x" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_victim",
      client_name: "victim",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    let dcrDeleted = false;
    const fakeFetch: import("../dcr.ts").FetchFn = (url, init) => {
      if ((init as RequestInit).method === "DELETE") {
        dcrDeleted = true;
        expect(url).toContain("/oauth/clients/client_victim");
        return Promise.resolve(new Response("", { status: 204 }));
      }
      return Promise.resolve(new Response("nope", { status: 404 }));
    };
    const res = await dispatch(
      new Request("http://localhost/app/victim", { method: "DELETE" }),
      state,
      { enforceScopeFn: allowAdmin, fetchFn: fakeFetch },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: string };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe("victim");
    expect(fs.existsSync(path.join(uisDir, "victim"))).toBe(false);
    expect(state.registeredUis.find((u) => u.meta.name === "victim")).toBeUndefined();
    expect(dcrDeleted).toBe(true);
  });

  test("404 when UI dir doesn't exist", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/nope", { method: "DELETE" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(404);
  });

  test("removes even when DCR revoke fails (hub unreachable)", async () => {
    seedUi("offlineremove", "/app/offlineremove", { "index.html": "x" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "x",
      client_name: "x",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const fakeFetch: import("../dcr.ts").FetchFn = () => Promise.reject(new Error("ECONNREFUSED"));
    const res = await dispatch(
      new Request("http://localhost/app/offlineremove", { method: "DELETE" }),
      state,
      { enforceScopeFn: allowAdmin, fetchFn: fakeFetch },
    );
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(uisDir, "offlineremove"))).toBe(false);
  });
});

describe("POST /app/<name>/reload", () => {
  test("re-scans + returns updated UI", async () => {
    seedUi("rel", "/app/rel", { "index.html": "v1" });
    const state = makeState();
    expect(state.registeredUis.find((u) => u.meta.name === "rel")).toBeDefined();
    // Mutate the meta.json on disk
    fs.writeFileSync(
      path.join(uisDir, "rel", "meta.json"),
      JSON.stringify({
        name: "rel",
        displayName: "Rel V2",
        path: "/app/rel",
        version: "2.0.0",
      }),
    );
    const res = await dispatch(
      new Request("http://localhost/app/rel/reload", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ui: { displayName: string; version?: string } | null };
    expect(body.ui?.displayName).toBe("Rel V2");
    expect(body.ui?.version).toBe("2.0.0");
  });

  test("404 when UI dir absent", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/gone/reload", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(404);
  });

  test("returns null + reason when UI exists on disk but is invalid", async () => {
    const dir = path.join(uisDir, "broken");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    // No meta.json, no index.html — scan will report skipped.
    fs.writeFileSync(path.join(dir, "meta.json"), "not valid json {");
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/app/broken/reload", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ui: unknown; skipped: unknown };
    expect(body.ui).toBeNull();
    expect(body.skipped).toBeDefined();
  });
});

describe("routeAdmin returns handled:false for unknown routes", () => {
  test("GET /foo isn't an admin route", () => {
    const state = makeState();
    const result = routeAdmin(new Request("http://localhost/foo"), {
      state,
      uisDir,
      logger: silentLogger,
    });
    expect(result.handled).toBe(false);
  });
});
