/**
 * Tests for the R3b admin-API extensions in `src/admin-routes.ts`:
 *
 *   - POST /surface/inspect           — stage + parse, no install
 *   - URL-tarball sources             — POST /surface/add with an https source
 *   - `audience` override on add
 *   - PATCH /surface/<name>           — audience edit
 *   - POST /surface/<name>/register-oauth — DCR retry
 *   - GET /surface/api/credentials    — stored copies, tokens stripped
 *   - PATCH /surface/api/config       — credential_connections binding edits
 *   - `credential` summary on serialized UIs (list/info)
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
import { type StoredCredential, writeCredential } from "../credential-store.ts";
import type { AppState } from "../http-server.ts";
import { SURFACE_AUDIENCE_HUB_HINT } from "../meta-schema.ts";
import { scanUis } from "../ui-registry.ts";

// biome-ignore lint/suspicious/noExplicitAny: tests poke parsed JSON loosely
type AnyJson = Record<string, any>;

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let uisDir: string;
let manifestPath: string;
let credentialsDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-admin-revamp-"));
  uisDir = path.join(tmpDir, "uis");
  manifestPath = path.join(tmpDir, "services.json");
  credentialsDir = path.join(tmpDir, "credentials");
  configPath = path.join(tmpDir, "config.json");
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

function seedUi(
  name: string,
  mountPath: string,
  extraMeta: Record<string, unknown> = {},
  files: Record<string, string> = { "index.html": "<html></html>" },
): void {
  const dir = path.join(uisDir, name);
  const distDir = path.join(dir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ name, displayName: name, path: mountPath, ...extraMeta }),
  );
  for (const [filename, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(distDir, filename), body);
  }
}

function seedCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  const record: StoredCredential = {
    connection_id: "cred-surface-vault-default",
    key: "vault",
    vault: "default",
    scope: "vault:default:read",
    scoped_tags: ["meeting"],
    token: "SECRET-TOKEN",
    jti: "jti-1",
    expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    renew_path: "/admin/connections/cred-surface-vault-default/renew",
    status: "ok",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  writeCredential(record, credentialsDir);
  return record;
}

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
    credentialsDir,
    configPath,
    logger: silentLogger,
    skipSelfRegisterRefresh: true,
    enforceScopeFn: allowAdmin,
    ...extra,
  });
  if (!result.handled) throw new Error("routeAdmin did not handle this request");
  return await result.response;
}

function jsonReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

/** Build a real .tgz from a file map; returns the bytes. */
async function makeTarball(files: Record<string, string>): Promise<Uint8Array> {
  const srcDir = fs.mkdtempSync(path.join(tmpDir, "tar-src-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const out = path.join(tmpDir, `bundle-${Math.random()}.tgz`);
  const proc = Bun.spawn(["tar", "-czf", out, "-C", srcDir, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error("test tarball creation failed");
  return new Uint8Array(fs.readFileSync(out));
}

// ---------------------------------------------------------------------------
// POST /surface/inspect
// ---------------------------------------------------------------------------

describe("POST /surface/inspect", () => {
  test("auth-gated (401 without bearer)", async () => {
    const state = makeState();
    const result = routeAdmin(jsonReq("POST", "/surface/inspect", { source: "/x" }), {
      state,
      uisDir,
      logger: silentLogger,
      skipSelfRegisterRefresh: true,
    });
    expect(result.handled).toBe(true);
    if (result.handled) expect((await result.response).status).toBe(401);
  });

  test("local path with meta.json + server block → parsed preview, nothing installed", async () => {
    const src = path.join(tmpDir, "src-backed");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "dist", "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(src, "meta.json"),
      JSON.stringify({
        name: "backed",
        displayName: "Backed",
        path: "/surface/backed",
        audience: "public",
        server: { entry: "server/index.js", capabilities: ["websocket"], timeoutMs: 5000 },
      }),
    );
    const state = makeState();
    const res = await dispatch(jsonReq("POST", "/surface/inspect", { source: src }), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.source_kind).toBe("path");
    expect(body.has_meta).toBe(true);
    expect(body.meta.name).toBe("backed");
    expect(body.meta.audience).toBe("public");
    expect(body.server.entry).toBe("server/index.js");
    expect(body.server.capabilities).toEqual(["websocket"]);
    expect(body.server.timeoutMs).toBe(5000);
    // Nothing installed.
    expect(fs.existsSync(path.join(uisDir, "backed"))).toBe(false);
    expect(state.registeredUis).toHaveLength(0);
  });

  test("source without meta.json → has_meta false, meta null", async () => {
    const src = path.join(tmpDir, "src-bare");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "index.html"), "<html></html>");
    const res = await dispatch(jsonReq("POST", "/surface/inspect", { source: src }), makeState());
    const body = (await res.json()) as AnyJson;
    expect(body.has_meta).toBe(false);
    expect(body.meta).toBeNull();
    expect(body.server).toBeNull();
  });

  test("invalid staged meta.json → meta_errors detail list, still 200", async () => {
    const src = path.join(tmpDir, "src-bad-meta");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "dist", "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(src, "meta.json"),
      JSON.stringify({ name: "BadName!", displayName: "X", path: "/surface/x" }),
    );
    const res = await dispatch(jsonReq("POST", "/surface/inspect", { source: src }), makeState());
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.has_meta).toBe(true);
    expect(body.meta).toBeNull();
    expect(Array.isArray(body.meta_errors)).toBe(true);
    expect(body.meta_errors.some((d: { path: string }) => d.path === "name")).toBe(true);
  });

  test("bad source → same error shape as add", async () => {
    const res = await dispatch(
      jsonReq("POST", "/surface/inspect", { source: "/definitely/not/here" }),
      makeState(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_source");
  });

  test("URL source is staged + previewed via the tarball pipeline", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html></html>",
      "package/meta.json": JSON.stringify({
        name: "from-url",
        displayName: "From URL",
        path: "/surface/from-url",
      }),
    });
    const fetchFn = async () =>
      new Response(tarball, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      });
    const res = await dispatch(
      jsonReq("POST", "/surface/inspect", { source: "https://example.com/from-url.tgz" }),
      makeState(),
      { fetchFn },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.source_kind).toBe("url");
    expect(body.meta.name).toBe("from-url");
  });
});

// ---------------------------------------------------------------------------
// POST /surface/add — URL source + audience override
// ---------------------------------------------------------------------------

describe("POST /surface/add (R3b extensions)", () => {
  test("installs from a URL tarball", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html>url-installed</html>",
      "package/meta.json": JSON.stringify({
        name: "urlui",
        displayName: "Url UI",
        path: "/surface/urlui",
      }),
    });
    const fetchFn = async () =>
      new Response(tarball, { status: 200, headers: { "content-type": "application/gzip" } });
    const state = makeState();
    const res = await dispatch(
      jsonReq("POST", "/surface/add", { source: "https://example.com/urlui.tgz" }),
      state,
      { fetchFn },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.ui.name).toBe("urlui");
    expect(fs.readFileSync(path.join(uisDir, "urlui", "dist", "index.html"), "utf8")).toBe(
      "<html>url-installed</html>",
    );
  });

  test("URL fetch failure surfaces the UrlFetchError code", async () => {
    const fetchFn = async () => new Response("nope", { status: 500 });
    const res = await dispatch(
      jsonReq("POST", "/surface/add", { source: "https://example.com/x.tgz" }),
      makeState(),
      { fetchFn },
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("http_error");
  });

  test("audience override wins over the staged meta (legacy public dropped)", async () => {
    const src = path.join(tmpDir, "src-aud");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "dist", "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(src, "meta.json"),
      JSON.stringify({
        name: "audui",
        displayName: "Aud UI",
        path: "/surface/audui",
        public: true, // legacy boolean in the bundle
      }),
    );
    const state = makeState();
    const res = await dispatch(
      jsonReq("POST", "/surface/add", { source: src, audience: "operator" }),
      state,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnyJson;
    expect(body.ui.audience).toBe("operator");
    expect(body.ui.public).toBe(false);
    const written = JSON.parse(fs.readFileSync(path.join(uisDir, "audui", "meta.json"), "utf8"));
    expect(written.audience).toBe("operator");
    expect(written.public).toBe(false);
  });

  test("invalid audience override → 400 via parseMeta", async () => {
    const src = path.join(tmpDir, "src-aud2");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "index.html"), "<html></html>");
    const res = await dispatch(
      jsonReq("POST", "/surface/add", {
        source: src,
        name: "aud2",
        path: "/surface/aud2",
        audience: "everyone",
      }),
      makeState(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_meta");
  });
});

// ---------------------------------------------------------------------------
// GitHub-release shorthand sources (resolver in front of the URL branch)
// ---------------------------------------------------------------------------

describe("add/inspect via GitHub-release shorthand", () => {
  const DOWNLOAD_URL =
    "https://github.com/Unforced-Dev/WovenBoulder/releases/download/v1.2.3/woven-boulder-surface-1.2.3.tgz";

  /** fetchFn answering the GitHub API with a release + the CDN with a tarball. */
  function githubFetch(
    tarball: Uint8Array,
    log: string[] = [],
  ): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (url) => {
      const u = String(url);
      log.push(u);
      if (u.startsWith("https://api.github.com/")) {
        return Response.json({
          tag_name: "v1.2.3",
          assets: [
            { name: "woven-boulder-surface-1.2.3.tgz", browser_download_url: DOWNLOAD_URL },
            { name: "checksums.txt", browser_download_url: `${DOWNLOAD_URL}.txt` },
          ],
        });
      }
      return new Response(tarball, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      });
    };
  }

  test("inspect `owner/repo` resolves the latest release + reports it", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html></html>",
      "package/meta.json": JSON.stringify({
        name: "woven-boulder",
        displayName: "Woven Boulder",
        path: "/surface/woven-boulder",
      }),
    });
    const log: string[] = [];
    const res = await dispatch(
      jsonReq("POST", "/surface/inspect", { source: "Unforced-Dev/WovenBoulder" }),
      makeState(),
      { fetchFn: githubFetch(tarball, log) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.source_kind).toBe("url"); // resolver feeds the EXISTING url path
    expect(body.meta.name).toBe("woven-boulder");
    // The resolved release rides the response for the SPA's confirm step.
    expect(body.github_release).toEqual({
      owner: "Unforced-Dev",
      repo: "WovenBoulder",
      tag: "v1.2.3",
      asset_name: "woven-boulder-surface-1.2.3.tgz",
      download_url: DOWNLOAD_URL,
    });
    // One API call, then the asset's browser_download_url — nothing else.
    expect(log[0]).toBe("https://api.github.com/repos/Unforced-Dev/WovenBoulder/releases/latest");
    expect(log[1]).toBe(DOWNLOAD_URL);
  });

  test("add via a github.com release-tag URL installs through the URL pipeline", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html>from-release</html>",
      "package/meta.json": JSON.stringify({
        name: "woven-boulder",
        displayName: "Woven Boulder",
        path: "/surface/woven-boulder",
      }),
    });
    const log: string[] = [];
    const state = makeState();
    const res = await dispatch(
      jsonReq("POST", "/surface/add", {
        source: "https://github.com/Unforced-Dev/WovenBoulder/releases/tag/v1.2.3",
      }),
      state,
      { fetchFn: githubFetch(tarball, log) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.ui.name).toBe("woven-boulder");
    expect(body.github_release.tag).toBe("v1.2.3");
    expect(fs.readFileSync(path.join(uisDir, "woven-boulder", "dist", "index.html"), "utf8")).toBe(
      "<html>from-release</html>",
    );
    // The tag-named URL resolved by TAG, not latest.
    expect(log[0]).toBe(
      "https://api.github.com/repos/Unforced-Dev/WovenBoulder/releases/tags/v1.2.3",
    );
  });

  test("GitHub 404 maps to not_found with the private-repo message", async () => {
    const fetchFn = async () => new Response("{}", { status: 404 });
    const res = await dispatch(
      jsonReq("POST", "/surface/add", { source: "ghost/none" }),
      makeState(),
      { fetchFn },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as AnyJson;
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("public");
  });

  test("GitHub rate-limit 403 maps to 429 rate_limited", async () => {
    const fetchFn = async () =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const res = await dispatch(
      jsonReq("POST", "/surface/inspect", { source: "ghost/none" }),
      makeState(),
      { fetchFn },
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as AnyJson).error).toBe("rate_limited");
  });

  test("direct …/releases/download/… asset URL bypasses the resolver (passthrough)", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html></html>",
      "package/meta.json": JSON.stringify({
        name: "direct",
        displayName: "Direct",
        path: "/surface/direct",
      }),
    });
    const log: string[] = [];
    const fetchFn = async (url: string | URL | Request) => {
      log.push(String(url));
      return new Response(tarball, {
        status: 200,
        headers: { "content-type": "application/gzip" },
      });
    };
    const res = await dispatch(
      jsonReq("POST", "/surface/inspect", { source: DOWNLOAD_URL }),
      makeState(),
      { fetchFn },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.github_release).toBeNull(); // no resolution happened
    // The ONLY fetch is the pasted URL itself — api.github.com never called.
    expect(log).toEqual([DOWNLOAD_URL]);
  });

  test("non-github sources keep their existing error story (no resolver interference)", async () => {
    const res = await dispatch(
      jsonReq("POST", "/surface/add", { source: "/definitely/not/here" }),
      makeState(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as AnyJson).error).toBe("bad_source");
  });
});

// ---------------------------------------------------------------------------
// PATCH /surface/<name> — audience edit
// ---------------------------------------------------------------------------

describe("PATCH /surface/<name>", () => {
  test("updates audience + derived public, persists to meta.json", async () => {
    seedUi("alpha", "/surface/alpha");
    const state = makeState();
    const res = await dispatch(jsonReq("PATCH", "/surface/alpha", { audience: "public" }), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.ui.audience).toBe("public");
    expect(body.ui.public).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(uisDir, "alpha", "meta.json"), "utf8"));
    expect(written.audience).toBe("public");
    expect(written.public).toBe(true);
    // In-memory state re-scanned.
    expect(state.registeredUis.find((u) => u.meta.name === "alpha")?.meta.audience).toBe("public");
  });

  test("invalid audience → 400", async () => {
    seedUi("alpha", "/surface/alpha");
    const res = await dispatch(
      jsonReq("PATCH", "/surface/alpha", { audience: "everyone" }),
      makeState(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_audience");
  });

  test('audience: "surface" lands + the serialized row carries the hub-tier hint (#99)', async () => {
    seedUi("alpha", "/surface/alpha");
    const state = makeState();
    const res = await dispatch(jsonReq("PATCH", "/surface/alpha", { audience: "surface" }), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.ui.audience).toBe("surface");
    // No cheap hub-capability probe exists, so the heads-up is the
    // unconditional statusReason hint the admin SPA renders.
    expect(body.ui.statusReason).toContain(SURFACE_AUDIENCE_HUB_HINT);
    // Other audiences carry no hint.
    const back = await dispatch(
      jsonReq("PATCH", "/surface/alpha", { audience: "hub-users" }),
      state,
    );
    expect((((await back.json()) as AnyJson).ui as AnyJson).statusReason).toBeUndefined();
  });

  test("no editable fields → 400", async () => {
    seedUi("alpha", "/surface/alpha");
    const res = await dispatch(jsonReq("PATCH", "/surface/alpha", {}), makeState());
    expect(res.status).toBe(400);
  });

  test("missing UI → 404", async () => {
    const res = await dispatch(
      jsonReq("PATCH", "/surface/ghost", { audience: "public" }),
      makeState(),
    );
    expect(res.status).toBe(404);
  });

  test("auth-gated (401 without bearer)", async () => {
    seedUi("alpha", "/surface/alpha");
    const state = makeState();
    const result = routeAdmin(jsonReq("PATCH", "/surface/alpha", { audience: "public" }), {
      state,
      uisDir,
      logger: silentLogger,
      skipSelfRegisterRefresh: true,
    });
    expect(result.handled).toBe(true);
    if (result.handled) expect((await result.response).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /surface/<name>/register-oauth — DCR retry
// ---------------------------------------------------------------------------

describe("POST /surface/<name>/register-oauth", () => {
  test("re-registers + stamps .oauth-client.json with the hub's status", async () => {
    seedUi("alpha", "/surface/alpha");
    const state = makeState();
    let dcrBody: { redirect_uris?: string[] } | null = null;
    const fetchFn = async (_url: string | URL | Request, _init?: RequestInit) => {
      if (_init?.body) dcrBody = JSON.parse(String(_init.body)) as { redirect_uris?: string[] };
      return new Response(
        JSON.stringify({
          client_id: "client_alpha_retry",
          client_name: "alpha",
          redirect_uris: ["http://127.0.0.1:1939/surface/alpha/"],
          scope: "vault:*:read",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          client_id_issued_at: 1,
          status: "approved",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };
    const res = await dispatch(jsonReq("POST", "/surface/alpha/register-oauth"), state, {
      fetchFn,
      operatorTokenOverride: () => "op-token",
    });
    expect(res.status).toBe(200);
    // The registration must include surface-client's hosted-mode RUNTIME
    // callback (`/oauth/callback`) — the live docs editor sign-in broke
    // because only the legacy hyphen form was registered (surface#118).
    expect(dcrBody?.redirect_uris).toContain("http://127.0.0.1:1939/surface/alpha/oauth/callback");
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.oauth_client.client_id).toBe("client_alpha_retry");
    expect(body.oauth_client.status).toBe("approved");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(uisDir, "alpha", ".oauth-client.json"), "utf8"),
    );
    expect(onDisk.client_id).toBe("client_alpha_retry");
  });

  test("hub rejection surfaces the hub's words (honest failure)", async () => {
    seedUi("alpha", "/surface/alpha");
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "invalid_scope", error_description: "nope" }), {
        status: 400,
      });
    const res = await dispatch(jsonReq("POST", "/surface/alpha/register-oauth"), makeState(), {
      fetchFn,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as AnyJson;
    expect(body.error).toBe("hub_rejected");
    expect(body.hub_status).toBe(400);
    expect(String(body.hub_body)).toContain("invalid_scope");
  });

  test("hub unreachable → 502 hub_unreachable", async () => {
    seedUi("alpha", "/surface/alpha");
    const fetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await dispatch(jsonReq("POST", "/surface/alpha/register-oauth"), makeState(), {
      fetchFn,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("hub_unreachable");
  });

  test("missing UI → 404", async () => {
    const res = await dispatch(jsonReq("POST", "/surface/ghost/register-oauth"), makeState());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /surface/api/credentials
// ---------------------------------------------------------------------------

describe("GET /surface/api/credentials", () => {
  test("lists stored credentials with token + jti STRIPPED and used_by computed", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential();
    const res = await dispatch(jsonReq("GET", "/surface/api/credentials"), makeState());
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.ok).toBe(true);
    expect(body.credentials).toHaveLength(1);
    const entry = body.credentials[0];
    expect(entry.connection_id).toBe("cred-surface-vault-default");
    expect(entry.token).toBeUndefined();
    expect(entry.jti).toBeUndefined();
    expect(entry.scope).toBe("vault:default:read");
    expect(entry.used_by).toEqual(["backed"]);
  });

  test("empty store → empty list", async () => {
    const res = await dispatch(jsonReq("GET", "/surface/api/credentials"), makeState());
    expect(((await res.json()) as { credentials: unknown[] }).credentials).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /surface/api/config
// ---------------------------------------------------------------------------

describe("PATCH /surface/api/config", () => {
  test("sets a binding: in-memory + persisted, unknown file fields preserved", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ hub_url: "http://127.0.0.1:1939", some_future_field: 42 }),
    );
    const state = makeState();
    const res = await dispatch(
      jsonReq("PATCH", "/surface/api/config", {
        credential_connections: { backed: "cred-surface-vault-default" },
      }),
      state,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnyJson;
    expect(body.credential_connections).toEqual({ backed: "cred-surface-vault-default" });
    expect(state.config.credential_connections).toEqual({
      backed: "cred-surface-vault-default",
    });
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(onDisk.credential_connections).toEqual({ backed: "cred-surface-vault-default" });
    expect(onDisk.some_future_field).toBe(42); // read-modify-write preserves
    expect(onDisk.hub_url).toBe("http://127.0.0.1:1939");
  });

  test("null deletes a binding", async () => {
    const state = makeState({ credential_connections: { backed: "old-id" } });
    const res = await dispatch(
      jsonReq("PATCH", "/surface/api/config", { credential_connections: { backed: null } }),
      state,
    );
    expect(res.status).toBe(200);
    expect(state.config.credential_connections).toEqual({});
  });

  test("creates the config file when none exists", async () => {
    const state = makeState();
    await dispatch(
      jsonReq("PATCH", "/surface/api/config", { credential_connections: { a: "cred-1" } }),
      state,
    );
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test("invalid surface name / connection id → 400", async () => {
    const bad1 = await dispatch(
      jsonReq("PATCH", "/surface/api/config", { credential_connections: { "Bad Name": "x" } }),
      makeState(),
    );
    expect(bad1.status).toBe(400);
    const bad2 = await dispatch(
      jsonReq("PATCH", "/surface/api/config", { credential_connections: { ok: "bad id!" } }),
      makeState(),
    );
    expect(bad2.status).toBe(400);
  });

  test("nothing to update → 400", async () => {
    const res = await dispatch(jsonReq("PATCH", "/surface/api/config", {}), makeState());
    expect(res.status).toBe(400);
  });

  test("refuses to overwrite an unparseable config file", async () => {
    fs.writeFileSync(configPath, "{ not json");
    const state = makeState();
    const res = await dispatch(
      jsonReq("PATCH", "/surface/api/config", { credential_connections: { a: "cred-1" } }),
      state,
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("config_unreadable");
    // In-memory untouched on the failure path.
    expect(state.config.credential_connections).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// credential summary on serialized UIs
// ---------------------------------------------------------------------------

describe("credential summary (GET /surface/list)", () => {
  async function listUis(state: AppState): Promise<Array<AnyJson>> {
    const res = await dispatch(jsonReq("GET", "/surface/list"), state);
    return ((await res.json()) as { uis: Array<AnyJson> }).uis;
  }

  test("static surface → credential null", async () => {
    seedUi("static", "/surface/static");
    const [ui] = await listUis(makeState());
    expect(ui!.credential).toBeNull();
  });

  test("backed surface, no credential → state none with reason", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("none");
    expect(ui!.credential.vault).toBe("default");
    expect(String(ui!.credential.reason)).toContain("no vault credential");
  });

  test("backed surface, one matching credential → ok with identity fields, no token", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential();
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("ok");
    expect(ui!.credential.connection_id).toBe("cred-surface-vault-default");
    expect(ui!.credential.scoped_tags).toEqual(["meeting"]);
    expect(ui!.credential.token).toBeUndefined();
  });

  test("expired credential → state expired", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("expired");
  });

  test("inside the renewal window → state expiring", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential({ expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("expiring");
  });

  test("needs-operator credential → state needs-operator", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential({ status: "needs-operator" });
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("needs-operator");
  });

  test("two write credentials on the same vault → ambiguous with candidates", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    seedCredential({
      connection_id: "cred-a",
      scope: "vault:default:write",
      renew_path: "/admin/connections/cred-a/renew",
    });
    seedCredential({
      connection_id: "cred-b",
      scope: "vault:default:write",
      renew_path: "/admin/connections/cred-b/renew",
    });
    const [ui] = await listUis(makeState());
    expect(ui!.credential.state).toBe("ambiguous");
    expect(ui!.credential.candidates.sort()).toEqual(["cred-a", "cred-b"]);
  });

  test("explicit mapping to a missing credential → state missing", async () => {
    seedUi("backed", "/surface/backed", { server: { entry: "server/index.js" } });
    const [ui] = await listUis(makeState({ credential_connections: { backed: "gone-id" } }));
    expect(ui!.credential.state).toBe("missing");
    expect(ui!.credential.connection_id).toBe("gone-id");
  });

  test("two backed surfaces sharing one credential → shared_with populated", async () => {
    seedUi("backed-a", "/surface/backed-a", { server: { entry: "server/index.js" } });
    seedUi("backed-b", "/surface/backed-b", { server: { entry: "server/index.js" } });
    seedCredential();
    const uis = await listUis(makeState());
    const a = uis.find((u) => u.name === "backed-a");
    const b = uis.find((u) => u.name === "backed-b");
    expect(a!.credential.state).toBe("ok");
    expect(a!.credential.shared_with).toEqual(["backed-b"]);
    expect(b!.credential.shared_with).toEqual(["backed-a"]);
  });
});
