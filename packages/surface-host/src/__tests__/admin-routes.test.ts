/**
 * Tests for `src/admin-routes.ts` — the Phase 1.2 admin endpoints.
 *
 * Coverage:
 *   - Auth gates: 401 without bearer (real auth path) for each protected route
 *   - Test-seam auth bypass exercises the post-auth behavior
 *   - GET /surface/list returns serialized UI summaries (+ oauth_client_id when known)
 *   - GET /surface/<name>/info returns full meta + oauth + paths
 *   - GET /surface/<name>/oauth-client UNAUTHENTICATED + returns client_id
 *   - GET /surface/<name>/oauth-client 404 when UI exists but no OAuth record
 *   - GET /surface/<name>/oauth-client 404 when UI doesn't exist
 *   - POST /surface/add with a local path → copy + meta.json + re-scan
 *   - POST /surface/add with overrides (name + path from body) overrides meta.json
 *   - POST /surface/add with bad source → 400
 *   - POST /surface/add with reserved /surface/admin path → 409 reserved_path
 *   - POST /surface/add with collision → 409 path_taken
 *   - POST /surface/add with name_exists no-force → 409
 *   - POST /surface/add with auto_register=true triggers DCR + persists client_id
 *   - DELETE /surface/<name> removes dir, revokes OAuth, updates state
 *   - DELETE /surface/<name> 404 on missing UI
 *   - POST /surface/<name>/reload re-scans + returns updated UI
 *   - POST /surface/<name>/reload 404 on missing UI dir
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
      credential_connections: {},
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
const allowAdmin: EnforceScopeFn = async () => ({ scopes: ["surface:admin"] });

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
  test("GET /surface/list", async () => {
    // No enforceScopeFn override → real auth path → no Authorization → 401.
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/surface/list"), state);
    expect(res.status).toBe(401);
  });
  test("POST /surface/add", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/add", { method: "POST", body: "{}" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("DELETE /surface/test", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/test", { method: "DELETE" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("POST /surface/test/reload", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/test/reload", { method: "POST" }),
      state,
    );
    expect(res.status).toBe(401);
  });
  test("GET /surface/test/info", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/surface/test/info"), state);
    expect(res.status).toBe(401);
  });
});

describe("GET /surface/<name>/oauth-client (UNAUTHENTICATED)", () => {
  test("returns client_id when record exists", async () => {
    seedUi("test", "/surface/test", { "index.html": "<html></html>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_abc",
      client_name: "Test",
      redirect_uris: ["http://hub/surface/test/"],
      scope: "vault:*:read",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/surface/test/oauth-client"), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_id: string; hub_url: string; scope: string };
    expect(body.client_id).toBe("client_abc");
    expect(body.hub_url).toBe("http://hub");
    expect(body.scope).toBe("vault:*:read");
  });

  test("404 when UI exists but no OAuth record", async () => {
    seedUi("test", "/surface/test", { "index.html": "<html></html>" });
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/surface/test/oauth-client"), state);
    expect(res.status).toBe(404);
  });

  test("404 when UI doesn't exist", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/surface/nope/oauth-client"), state);
    expect(res.status).toBe(404);
  });
});

describe("GET /surface/list", () => {
  test("returns serialized UIs + oauth_client_id when present", async () => {
    seedUi("alpha", "/surface/alpha", { "index.html": "<a/>" });
    seedUi("beta", "/surface/beta", { "index.html": "<b/>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_alpha",
      client_name: "alpha",
      redirect_uris: [],
      scope: "",
      registered_at: "now",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/surface/list"), state, {
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

describe("GET /surface/<name>/info", () => {
  test("returns full info incl. meta + paths + oauth", async () => {
    seedUi("test", "/surface/test", { "index.html": "<x/>" });
    const state = makeState();
    writeOauthClientFile(state.registeredUis[0]!.uiDir, {
      client_id: "client_info",
      client_name: "Test",
      redirect_uris: [],
      scope: "",
      registered_at: "2026-05-21T00:00:00Z",
      hub_url: "http://hub",
    });
    const res = await dispatch(new Request("http://localhost/surface/test/info"), state, {
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
    expect(body.meta.path).toBe("/surface/test");
    expect(body.paths.distDir).toContain("test");
    expect(body.oauth_client?.client_id).toBe("client_info");
  });

  test("404 on unknown name", async () => {
    const state = makeState();
    const res = await dispatch(new Request("http://localhost/surface/nope/info"), state, {
      enforceScopeFn: allowAdmin,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /surface/add", () => {
  test("invalid JSON body → 400", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/add", { method: "POST", body: "{not json" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(400);
  });

  test("missing source → 400 bad_request", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/add", { method: "POST", body: "{}" }),
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: "/this/does/not/exist", name: "x", path: "/surface/x" }),
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "x", path: "/surface/x" }),
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "myui",
          path: "/surface/myui",
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
    expect(body.ui.path).toBe("/surface/myui");

    // Files on disk
    const targetDir = path.join(uisDir, "myui");
    expect(fs.existsSync(path.join(targetDir, "dist", "index.html"))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(targetDir, "meta.json"), "utf8"));
    expect(meta.name).toBe("myui");
    expect(meta.path).toBe("/surface/myui");
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
      JSON.stringify({ name: "from-disk", displayName: "From Disk", path: "/surface/from-disk" }),
    );
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "from-body", path: "/surface/from-body" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(201);
    expect(state.registeredUis.find((u) => u.meta.name === "from-body")).toBeDefined();
  });

  test("reserved path /surface/admin → 409 reserved_path", async () => {
    const src = seedLocalSource("badadm", { "index.html": "<x/>" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "evil", path: "/surface/admin" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reserved_path");
  });

  test("name collision (no force) → 409 name_exists", async () => {
    seedUi("conflict", "/surface/conflict", { "index.html": "<x/>" });
    const state = makeState();
    const src = seedLocalSource("conflict-src", { "index.html": "<y/>" });
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "conflict",
          path: "/surface/conflict-other",
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
    seedUi("alpha", "/surface/shared", { "index.html": "<x/>" });
    const state = makeState();
    const src = seedLocalSource("beta-src", { "index.html": "<y/>" });
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: src, name: "beta", path: "/surface/shared" }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_taken");
  });

  test("force=true replaces existing UI", async () => {
    seedUi("replaceme", "/surface/replaceme", { "index.html": "old" });
    const state = makeState();
    const src = seedLocalSource("newcontent", { "index.html": "new" });
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "replaceme",
          path: "/surface/replaceme",
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "dcr",
          path: "/surface/dcr",
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "offline",
          path: "/surface/offline",
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

describe("POST /surface/add via npm-fetch", () => {
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
          path: "/surface/notes",
          version: "0.1.0",
          scopes_required: ["vault:*:read", "vault:*:write"],
        }),
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const res = await dispatch(
      new Request("http://localhost/surface/add", {
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: "@doesnt/exist",
          name: "x",
          path: "/surface/x",
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
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: "@foo/no-dist",
          name: "x",
          path: "/surface/x",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin, npmSpawnFn: npmSpawn },
    );
    expect(res.status).toBe(422);
  });
});

describe("DELETE /surface/<name>", () => {
  test("happy path removes dir + updates state", async () => {
    seedUi("victim", "/surface/victim", { "index.html": "x" });
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
      new Request("http://localhost/surface/victim", { method: "DELETE" }),
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
      new Request("http://localhost/surface/nope", { method: "DELETE" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(404);
  });

  test("removes even when DCR revoke fails (hub unreachable)", async () => {
    seedUi("offlineremove", "/surface/offlineremove", { "index.html": "x" });
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
      new Request("http://localhost/surface/offlineremove", { method: "DELETE" }),
      state,
      { enforceScopeFn: allowAdmin, fetchFn: fakeFetch },
    );
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(uisDir, "offlineremove"))).toBe(false);
  });
});

describe("POST /surface/<name>/reload", () => {
  test("re-scans + returns updated UI", async () => {
    seedUi("rel", "/surface/rel", { "index.html": "v1" });
    const state = makeState();
    expect(state.registeredUis.find((u) => u.meta.name === "rel")).toBeDefined();
    // Mutate the meta.json on disk
    fs.writeFileSync(
      path.join(uisDir, "rel", "meta.json"),
      JSON.stringify({
        name: "rel",
        displayName: "Rel V2",
        path: "/surface/rel",
        version: "2.0.0",
      }),
    );
    const res = await dispatch(
      new Request("http://localhost/surface/rel/reload", { method: "POST" }),
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
      new Request("http://localhost/surface/gone/reload", { method: "POST" }),
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
      new Request("http://localhost/surface/broken/reload", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ui: unknown; skipped: unknown };
    expect(body.ui).toBeNull();
    expect(body.skipped).toBeDefined();
  });

  // Regression — Phase 2.0 → 2.1: the meta.json projection written by
  // `POST /surface/add` originally dropped `required_schema`, which meant a
  // subsequent `POST /surface/<name>/reload` (which re-reads from disk) lost
  // the declaration. Fixed in `admin-routes.ts` by carrying
  // `required_schema` through the projection (see Phase 2.0 comment in
  // `handleAdd`). This test pins the round-trip: add → reload → still
  // present.
  test("reload preserves required_schema after a write/read round-trip", async () => {
    const src = seedLocalSource("schema-src", {
      "index.html": "<html>schema</html>",
      "meta.json": JSON.stringify({
        name: "schema-app",
        displayName: "Schema App",
        path: "/surface/schema-app",
        required_schema: {
          tags: [
            {
              name: "capture",
              description: "Quick captures",
              fields: {
                source: { type: "string", required: true },
                createdAt: { type: "date" },
              },
            },
          ],
        },
      }),
    });
    const state = makeState();

    // POST /surface/add — writes the projected meta.json to disk + re-scans.
    const addRes = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({
          source: src,
          name: "schema-app",
          path: "/surface/schema-app",
        }),
      }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(addRes.status).toBe(201);
    const addBody = (await addRes.json()) as {
      ui: { name: string; required_schema?: { tags?: Array<{ name: string }> } };
    };
    expect(addBody.ui.required_schema?.tags?.[0]?.name).toBe("capture");

    // Sanity: the projected meta.json on disk preserved required_schema.
    const written = JSON.parse(
      fs.readFileSync(path.join(uisDir, "schema-app", "meta.json"), "utf8"),
    );
    expect(written.required_schema?.tags?.[0]?.name).toBe("capture");
    expect(written.required_schema?.tags?.[0]?.fields?.source).toEqual({
      type: "string",
      required: true,
    });

    // POST /surface/<name>/reload — re-reads from disk via scanUis.
    const reloadRes = await dispatch(
      new Request("http://localhost/surface/schema-app/reload", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(reloadRes.status).toBe(200);
    const reloadBody = (await reloadRes.json()) as {
      ok: boolean;
      ui: {
        name: string;
        required_schema?: {
          tags?: Array<{
            name: string;
            description?: string;
            fields?: Record<string, { type: string; required?: boolean }>;
          }>;
        };
      } | null;
    };
    expect(reloadBody.ok).toBe(true);
    expect(reloadBody.ui).not.toBeNull();
    // The whole envelope must survive — name, description, and fields.
    expect(reloadBody.ui?.required_schema?.tags?.[0]?.name).toBe("capture");
    expect(reloadBody.ui?.required_schema?.tags?.[0]?.description).toBe("Quick captures");
    expect(reloadBody.ui?.required_schema?.tags?.[0]?.fields?.source).toEqual({
      type: "string",
      required: true,
    });
    expect(reloadBody.ui?.required_schema?.tags?.[0]?.fields?.createdAt).toEqual({
      type: "date",
    });
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

describe("POST /surface/<name>/provision-schema (Phase 2.1)", () => {
  test("401 without bearer (real auth path)", async () => {
    seedUi("notes", "/surface/notes", { "index.html": "<html></html>" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/notes/provision-schema", { method: "POST" }),
      state,
    );
    expect(res.status).toBe(401);
  });

  test("404 when UI doesn't exist", async () => {
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/nope/provision-schema", { method: "POST" }),
      state,
      { enforceScopeFn: allowAdmin },
    );
    expect(res.status).toBe(404);
  });

  test("UI with required_schema + vault_default → provisions tags", async () => {
    // Seed a UI whose meta.json declares required_schema.
    const name = "notes";
    const dir = path.join(uisDir, name);
    const distDir = path.join(dir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        name,
        displayName: "Notes",
        path: "/surface/notes",
        vault_default: "default",
        required_schema: {
          tags: [{ name: "capture", description: "Quick captures" }],
        },
      }),
    );
    fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>");
    const state = makeState();

    const fetchCalls: Array<{ url: string; method: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ name: "capture" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await dispatch(
      new Request("http://localhost/surface/notes/provision-schema", { method: "POST" }),
      state,
      {
        enforceScopeFn: allowAdmin,
        operatorTokenOverride: () => "op-tok",
        fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      name: string;
      provisioned: string[];
      errors: Array<{ tag: string; error: string }>;
      vaultUrl?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("notes");
    expect(body.provisioned).toEqual(["capture"]);
    expect(body.errors).toEqual([]);
    expect(body.vaultUrl).toBe("http://127.0.0.1:1939/vault/default");
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.method).toBe("PUT");
    expect(fetchCalls[0]!.url).toContain("/api/tags/capture");
  });

  test("UI without required_schema → 200 with skipReason", async () => {
    seedUi("plain", "/surface/plain", { "index.html": "<html></html>" });
    const state = makeState();
    const res = await dispatch(
      new Request("http://localhost/surface/plain/provision-schema", { method: "POST" }),
      state,
      {
        enforceScopeFn: allowAdmin,
        operatorTokenOverride: () => "op-tok",
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; skipReason?: string };
    expect(body.ok).toBe(true);
    expect(body.skipReason).toContain("no required_schema");
  });

  test("provision endpoint is idempotent (running twice → same shape)", async () => {
    const name = "notes";
    const dir = path.join(uisDir, name);
    const distDir = path.join(dir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        name,
        displayName: "Notes",
        path: "/surface/notes",
        vault_default: "default",
        required_schema: { tags: [{ name: "capture" }] },
      }),
    );
    fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>");
    const state = makeState();

    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      return new Response(JSON.stringify({ name: "capture" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    for (let i = 0; i < 2; i++) {
      const res = await dispatch(
        new Request("http://localhost/surface/notes/provision-schema", { method: "POST" }),
        state,
        {
          enforceScopeFn: allowAdmin,
          operatorTokenOverride: () => "op-tok",
          fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
        },
      );
      expect(res.status).toBe(200);
    }
    expect(callCount).toBe(2);
  });
});

describe("POST /surface/add — Phase 2.1 auto-provision wiring", () => {
  test("required_schema + vault_default + auto_provision_required_schema:true → provisions on add", async () => {
    // Seed a local source whose meta.json declares required_schema.
    const sourceRoot = path.join(tmpDir, "src", "notes-src");
    const sourceDist = path.join(sourceRoot, "dist");
    fs.mkdirSync(sourceDist, { recursive: true });
    fs.writeFileSync(path.join(sourceDist, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(sourceRoot, "meta.json"),
      JSON.stringify({
        name: "notes",
        displayName: "Notes",
        path: "/surface/notes",
        vault_default: "default",
        required_schema: {
          tags: [
            {
              name: "capture",
              description: "Quick captures",
              fields: { source: { type: "string", required: true } },
            },
          ],
        },
      }),
    );

    const state = makeState({ auto_provision_required_schema: true });

    const fetchCalls: Array<{ url: string; method: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ name: "capture" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: sourceRoot }),
      }),
      state,
      {
        enforceScopeFn: allowAdmin,
        operatorTokenOverride: () => "op-tok",
        fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ui: { name: string } | null;
      provision_schema?: {
        provisioned: string[];
        errors: Array<{ tag: string; error: string }>;
      };
    };
    expect(body.ui?.name).toBe("notes");
    expect(body.provision_schema?.provisioned).toEqual(["capture"]);
    expect(body.provision_schema?.errors).toEqual([]);
    // PUT to vault was attempted.
    expect(fetchCalls.some((c) => c.method === "PUT" && c.url.includes("/api/tags/capture"))).toBe(
      true,
    );
  });

  test("auto_provision_required_schema: false → no provisioning on add (default in tests)", async () => {
    const sourceRoot = path.join(tmpDir, "src", "notes-src");
    const sourceDist = path.join(sourceRoot, "dist");
    fs.mkdirSync(sourceDist, { recursive: true });
    fs.writeFileSync(path.join(sourceDist, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(sourceRoot, "meta.json"),
      JSON.stringify({
        name: "notes",
        displayName: "Notes",
        path: "/surface/notes",
        vault_default: "default",
        required_schema: { tags: [{ name: "capture" }] },
      }),
    );

    // makeState() default is auto_provision_required_schema:false (per test
    // config). Verify no vault calls happen.
    const state = makeState();
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      return new Response("not used", { status: 500 });
    }) as unknown as typeof fetch;

    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: sourceRoot }),
      }),
      state,
      {
        enforceScopeFn: allowAdmin,
        operatorTokenOverride: () => "op-tok",
        fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      },
    );
    expect(res.status).toBe(201);
    expect(fetchCalls).toBe(0);
  });

  test("auto-provision: vault PUT failure → install succeeds, errors recorded", async () => {
    const sourceRoot = path.join(tmpDir, "src", "notes-src");
    const sourceDist = path.join(sourceRoot, "dist");
    fs.mkdirSync(sourceDist, { recursive: true });
    fs.writeFileSync(path.join(sourceDist, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(sourceRoot, "meta.json"),
      JSON.stringify({
        name: "notes",
        displayName: "Notes",
        path: "/surface/notes",
        vault_default: "default",
        required_schema: { tags: [{ name: "capture" }] },
      }),
    );
    const state = makeState({ auto_provision_required_schema: true });
    // vault returns 403 — provisioning fails per-tag.
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error_type: "insufficient_scope", message: "need admin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const res = await dispatch(
      new Request("http://localhost/surface/add", {
        method: "POST",
        body: JSON.stringify({ source: sourceRoot }),
      }),
      state,
      {
        enforceScopeFn: allowAdmin,
        operatorTokenOverride: () => "op-tok",
        fetchFn: fetchFn as unknown as import("../dcr.ts").FetchFn,
      },
    );
    // Add succeeds — provisioning is best-effort.
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      ui: { name: string } | null;
      provision_schema?: { provisioned: string[]; errors: Array<{ tag: string; error: string }> };
    };
    expect(body.ui?.name).toBe("notes");
    expect(body.provision_schema?.provisioned).toEqual([]);
    expect(body.provision_schema?.errors.length).toBe(1);
    expect(body.provision_schema?.errors[0]!.tag).toBe("capture");
  });
});
