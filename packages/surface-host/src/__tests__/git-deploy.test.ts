/**
 * Tests for the Surface Git Transport pull + sandboxed build (Phase 0b):
 *   - `pullSurfaceSource` — clone argv + the bearer rides in ENV not argv;
 *     a clone failure → GitDeployError pull_failed.
 *   - `buildSurface` — prebuilt-dist passthrough; build-script path drives the
 *     runner; build failure → GitDeployError; source meta.json identity is
 *     PINNED to the pushed name (no mount hijack).
 *   - `POST /surface/api/git-pushed` — 401 without bearer; happy path builds +
 *     serves; a failed build is FAIL-CLOSED (last-good keeps serving); bad
 *     payloads rejected; a backed-surface `server` block refused.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { type AdminHandlerOpts, type EnforceScopeFn, routeAdmin } from "../admin-routes.ts";
import { homeTreeDenyRoot } from "../build-sandbox.ts";
import {
  type BuildRunner,
  GitDeployError,
  type GitSpawnFn,
  buildSurface,
  constrainedSubprocessRunner,
  makeBuildSrcDir,
  pullSurfaceSource,
} from "../git-deploy.ts";
import type { AppState } from "../http-server.ts";
import { scanUis } from "../ui-registry.ts";

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const allowAdmin: EnforceScopeFn = async () => ({ scopes: ["surface:admin"] });

/** Whether this host can genuinely kernel-sandbox — gates the live-runner tests
 * (green-skip on an incapable CI runner; the real boundary runs on a capable box). */
const CAN_SANDBOX =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

let tmpDir: string;
let uisDir: string;
let srcDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-gitdeploy-"));
  uisDir = path.join(tmpDir, "uis");
  srcDir = path.join(tmpDir, "src");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<AppState["config"]> = {}): AppState {
  const scan = scanUis({ uisDir, logger: silent });
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

/** Seed an already-served surface under uis/<name>/ (the "last-good"). */
function seedServed(name: string, mount: string, body: string): void {
  const dist = path.join(uisDir, name, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(uisDir, name, "meta.json"),
    JSON.stringify({ name, displayName: name, path: mount }),
  );
  fs.writeFileSync(path.join(dist, "index.html"), body);
}

/**
 * A GitSpawnFn stub that "clones" by writing a source tree into destDir (the
 * last argv element). `files` is a path→content map placed under destDir.
 */
function fakeClone(
  files: Record<string, string>,
  exitCode = 0,
): {
  fn: GitSpawnFn;
  calls: Array<{ argv: string[]; env: Record<string, string> }>;
} {
  const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const fn: GitSpawnFn = async (argv, _cwd, env) => {
    calls.push({ argv, env });
    if (exitCode === 0) {
      const dest = argv[argv.length - 1]!;
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dest, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    }
    return { exitCode, stdout: "", stderr: exitCode === 0 ? "" : "fatal: auth failed" };
  };
  return { fn, calls };
}

async function dispatch(
  req: Request,
  state: AppState,
  extra: Partial<AdminHandlerOpts> = {},
): Promise<Response> {
  const result = routeAdmin(req, {
    state,
    uisDir,
    srcDir,
    manifestPath,
    logger: silent,
    skipSelfRegisterRefresh: true,
    ...extra,
  });
  if (!result.handled) throw new Error("routeAdmin did not handle git-pushed");
  return await result.response;
}

function pushReq(body: unknown): Request {
  return new Request("http://localhost/surface/api/git-pushed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── pullSurfaceSource ────────────────────────────────────────────────────────

describe("pullSurfaceSource", () => {
  test("clones with --depth 1 and puts the bearer in ENV, never argv", async () => {
    const { fn, calls } = fakeClone({ "index.html": "<h1>hi</h1>" });
    const dest = path.join(srcDir, "brain");
    const out = await pullSurfaceSource({
      cloneUrl: "http://127.0.0.1:1939/git/brain",
      token: "SECRET.JWT.TOKEN",
      destDir: dest,
      spawnFn: fn,
      logger: silent,
    });
    expect(out.sourceDir).toBe(dest);
    expect(fs.existsSync(path.join(dest, "index.html"))).toBe(true);

    const call = calls[0]!;
    expect(call.argv).toContain("clone");
    expect(call.argv).toContain("--depth");
    // The token must NOT appear anywhere in argv (no `ps` leak)...
    expect(call.argv.some((a) => a.includes("SECRET.JWT.TOKEN"))).toBe(false);
    // ...but must ride the git config env as an Authorization header.
    expect(call.env.GIT_CONFIG_VALUE_0).toContain("Authorization: Bearer SECRET.JWT.TOKEN");
    expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("rejects a non-http clone_url", async () => {
    const { fn } = fakeClone({});
    await expect(
      pullSurfaceSource({
        cloneUrl: "file:///etc/passwd",
        token: "t",
        destDir: path.join(srcDir, "x"),
        spawnFn: fn,
        logger: silent,
      }),
    ).rejects.toMatchObject({ code: "bad_clone_url" });
  });

  test("a clone failure → pull_failed (and stderr is token-scrubbed)", async () => {
    const { fn } = fakeClone({}, 128);
    await expect(
      pullSurfaceSource({
        cloneUrl: "http://127.0.0.1:1939/git/brain",
        token: "t",
        destDir: path.join(srcDir, "brain"),
        spawnFn: fn,
        logger: silent,
      }),
    ).rejects.toMatchObject({ code: "pull_failed" });
  });
});

// ─── makeBuildSrcDir ──────────────────────────────────────────────────────────

describe("makeBuildSrcDir", () => {
  test("resolves a private throwaway OUTSIDE the home tree (the build-cwd fix)", () => {
    const { parentDir, sourceDir } = makeBuildSrcDir("brain");
    try {
      // The clone/build dir must NOT sit under EITHER platform's home-tree deny
      // root — that ancestor-under-deny is exactly what broke `bun run build`
      // (CouldntReadCurrentDirectory). It must live under os.tmpdir() instead.
      for (const root of [homeTreeDenyRoot("darwin"), homeTreeDenyRoot("linux")]) {
        expect(sourceDir.startsWith(`${root}/`)).toBe(false);
        expect(parentDir.startsWith(`${root}/`)).toBe(false);
      }
      expect(sourceDir.startsWith(os.tmpdir())).toBe(true);
      // `<parent>/<name>` shape; the parent (a real 0700 mkdtemp) is what the
      // caller removes; it carries the surface name for legibility.
      expect(path.dirname(sourceDir)).toBe(parentDir);
      expect(path.basename(sourceDir)).toBe("brain");
      expect(path.basename(parentDir)).toContain("parachute-surface-src-brain-");
      expect(fs.existsSync(parentDir)).toBe(true);
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("each call is a fresh, unique dir (no shared predictable path)", () => {
    const a = makeBuildSrcDir("brain");
    const b = makeBuildSrcDir("brain");
    try {
      expect(a.parentDir).not.toBe(b.parentDir);
    } finally {
      fs.rmSync(a.parentDir, { recursive: true, force: true });
      fs.rmSync(b.parentDir, { recursive: true, force: true });
    }
  });
});

// ─── buildSurface ─────────────────────────────────────────────────────────────

describe("buildSurface", () => {
  test("prebuilt dist/ + no build script → serves as-is, no runner invoked", async () => {
    const src = path.join(srcDir, "brain");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "dist", "index.html"), "<h1>brain</h1>");
    let runnerCalls = 0;
    const runner: BuildRunner = async () => {
      runnerCalls++;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const out = await buildSurface({ sourceDir: src, name: "brain", runner, logger: silent });
    expect(runnerCalls).toBe(0);
    expect(out.built).toBe(false);
    expect(out.meta.name).toBe("brain");
    expect(out.meta.path).toBe("/surface/brain");
  });

  test("package.json build script → drives the runner, then serves produced dist", async () => {
    const src = path.join(srcDir, "brain");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "brain", scripts: { build: "vite build" } }),
    );
    const argvs: string[][] = [];
    const runner: BuildRunner = async ({ argv }) => {
      argvs.push(argv);
      // Simulate `bun run build` producing dist/ on the second call.
      if (argv.join(" ") === "bun run build") {
        fs.mkdirSync(path.join(src, "dist"), { recursive: true });
        fs.writeFileSync(path.join(src, "dist", "index.html"), "<h1>built</h1>");
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    const out = await buildSurface({ sourceDir: src, name: "brain", runner, logger: silent });
    expect(out.built).toBe(true);
    expect(argvs).toEqual([
      ["bun", "install", "--ignore-scripts"],
      ["bun", "run", "build"],
    ]);
    expect(fs.readFileSync(`${out.distDir}/index.html`, "utf8")).toContain("built");
  });

  test("REAL constrained runner builds + scrubs the env (no hub secrets, redirected HOME)", async () => {
    // A no-dep source with a portable build that (a) copies index.html into
    // dist/ and (b) records the env the build actually ran with. `bun install`
    // of a dep-less package.json is an offline no-op.
    const src = path.join(srcDir, "brain");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({
        name: "brain",
        scripts: {
          build:
            "mkdir -p dist && cp index.html dist/index.html && node -e \"require('fs').writeFileSync('dist/env.json', JSON.stringify({HOME: process.env.HOME, PARACHUTE_HOME: process.env.PARACHUTE_HOME, HUB: process.env.PARACHUTE_HUB_ORIGIN ?? null, SECRET: process.env.SUPER_SECRET ?? null}))\"",
        },
      }),
    );
    fs.writeFileSync(path.join(src, "index.html"), "<h1>real build</h1>");

    // A secret in the daemon's OWN env must NOT reach the build child.
    process.env.SUPER_SECRET = "do-not-leak";
    process.env.PARACHUTE_HUB_ORIGIN = "http://hub.example";
    const buildHomeParent = path.join(tmpDir, "buildhome");
    try {
      const out = await buildSurface({
        sourceDir: src,
        name: "brain",
        // Option A explicitly — the DEFAULT is now the kernel sandbox (Option B,
        // build-sandbox.ts); this test asserts the constrained-subprocess runner's
        // env scrub, which is the shared baseline both runners provide.
        runner: constrainedSubprocessRunner,
        buildHomeParent,
        logger: silent,
      });
      expect(out.built).toBe(true);
      expect(fs.readFileSync(path.join(out.distDir, "index.html"), "utf8")).toContain("real build");
      const env = JSON.parse(fs.readFileSync(path.join(out.distDir, "env.json"), "utf8")) as {
        HOME: string;
        PARACHUTE_HOME: string;
        HUB: string | null;
        SECRET: string | null;
      };
      // HOME + PARACHUTE_HOME were redirected into the build sandbox...
      expect(env.HOME.startsWith(buildHomeParent)).toBe(true);
      expect(env.PARACHUTE_HOME.startsWith(buildHomeParent)).toBe(true);
      // ...and the daemon's hub origin + secret never reached the child.
      expect(env.HUB).toBeNull();
      expect(env.SECRET).toBeNull();
    } finally {
      delete process.env.SUPER_SECRET;
      delete process.env.PARACHUTE_HUB_ORIGIN;
    }
  });

  test("constrainedSubprocessRunner: an over-budget build times out (killed) and returns promptly", async () => {
    const started = Date.now();
    const res = await constrainedSubprocessRunner({
      argv: ["sleep", "30"],
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 300,
    });
    // Killed on the timeout — returns fast, flagged, non-zero. (Process-GROUP
    // reaping of build-spawned grandchildren is verified out-of-band — a
    // `process.kill(-pid)` assertion destabilizes the shared bun-test runner.)
    expect(Date.now() - started).toBeLessThan(8000);
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  test("a failing build → build_failed, no dist required", async () => {
    const src = path.join(srcDir, "brain");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "brain", scripts: { build: "exit 1" } }),
    );
    const runner: BuildRunner = async ({ argv }) => ({
      exitCode: argv.join(" ") === "bun run build" ? 1 : 0,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    });
    await expect(
      buildSurface({ sourceDir: src, name: "brain", runner, logger: silent }),
    ).rejects.toMatchObject({ code: "build_failed" });
  });

  test("source meta.json identity is PINNED to the pushed name (no mount hijack)", async () => {
    const src = path.join(srcDir, "brain");
    fs.mkdirSync(path.join(src, "dist"), { recursive: true });
    fs.writeFileSync(path.join(src, "dist", "index.html"), "<h1>brain</h1>");
    // Malicious meta tries to mount at another surface's path + name.
    fs.writeFileSync(
      path.join(src, "meta.json"),
      JSON.stringify({ name: "victim", displayName: "Brain", path: "/surface/victim" }),
    );
    const out = await buildSurface({ sourceDir: src, name: "brain", logger: silent });
    expect(out.meta.name).toBe("brain");
    expect(out.meta.path).toBe("/surface/brain");
    expect(out.meta.displayName).toBe("Brain"); // non-identity fields honored
  });
});

// ─── POST /surface/api/git-pushed ─────────────────────────────────────────────

describe("POST /surface/api/git-pushed", () => {
  test("401 without a bearer (real auth path)", async () => {
    const state = makeState();
    const res = await dispatch(
      pushReq({ surface: "brain", clone_url: "http://127.0.0.1:1939/git/brain", pull_token: "t" }),
      state,
    );
    expect(res.status).toBe(401);
  });

  test("happy path: pull → build → serve", async () => {
    const state = makeState();
    const { fn } = fakeClone({ "dist/index.html": "<h1>brain surface</h1>" });
    const res = await dispatch(
      pushReq({ surface: "brain", clone_url: "http://127.0.0.1:1939/git/brain", pull_token: "t" }),
      state,
      { enforceScopeFn: allowAdmin, gitSpawnFn: fn },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; served: boolean; path: string };
    expect(json.ok).toBe(true);
    expect(json.served).toBe(true);
    expect(json.path).toBe("/surface/brain");
    // Served bundle is on disk + in state.
    expect(fs.readFileSync(path.join(uisDir, "brain", "dist", "index.html"), "utf8")).toContain(
      "brain surface",
    );
    expect(state.registeredUis.some((u) => u.meta.name === "brain")).toBe(true);
  });

  test("fail-closed: a failed build keeps the last-good served", async () => {
    const state = makeState();
    seedServed("brain", "/surface/brain", "<h1>LAST GOOD</h1>");
    // Re-scan state so it reflects the seeded surface.
    const rescan = scanUis({ uisDir, logger: silent });
    state.registeredUis = rescan.registered;
    expect(state.registeredUis.some((u) => u.meta.name === "brain")).toBe(true);

    // New push clones a source with a build script whose build FAILS.
    const { fn } = fakeClone({
      "package.json": JSON.stringify({ name: "brain", scripts: { build: "exit 1" } }),
    });
    const failingRunner: BuildRunner = async ({ argv }) => ({
      exitCode: argv.join(" ") === "bun run build" ? 1 : 0,
      stdout: "",
      stderr: "compile error",
      timedOut: false,
    });
    const res = await dispatch(
      pushReq({ surface: "brain", clone_url: "http://127.0.0.1:1939/git/brain", pull_token: "t" }),
      state,
      { enforceScopeFn: allowAdmin, gitSpawnFn: fn, buildRunner: failingRunner },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.error).toBe("deploy_failed");
    expect(json.code).toBe("build_failed");
    // The last-good bundle is UNTOUCHED and still served.
    expect(fs.readFileSync(path.join(uisDir, "brain", "dist", "index.html"), "utf8")).toContain(
      "LAST GOOD",
    );
    expect(state.registeredUis.some((u) => u.meta.name === "brain")).toBe(true);
  });

  test("fail-closed: a clone failure never touches uis/", async () => {
    const state = makeState();
    const { fn } = fakeClone({}, 128);
    const res = await dispatch(
      pushReq({ surface: "brain", clone_url: "http://127.0.0.1:1939/git/brain", pull_token: "t" }),
      state,
      { enforceScopeFn: allowAdmin, gitSpawnFn: fn },
    );
    expect(res.status).toBe(502);
    expect(fs.existsSync(path.join(uisDir, "brain"))).toBe(false);
  });

  test("invalid payloads → 400", async () => {
    const state = makeState();
    for (const body of [
      { surface: "Bad Name", clone_url: "http://x/git/x", pull_token: "t" },
      { surface: "api", clone_url: "http://x/git/api", pull_token: "t" }, // reserved mount
      { surface: "brain", pull_token: "t" },
      { surface: "brain", clone_url: "http://x/git/x" },
    ]) {
      const res = await dispatch(pushReq(body), state, { enforceScopeFn: allowAdmin });
      expect(res.status).toBe(400);
    }
  });

  test("a backed-surface (server block) is refused (static-only in Phase 0b)", async () => {
    const state = makeState();
    const { fn } = fakeClone({
      "dist/index.html": "<h1>x</h1>",
      "meta.json": JSON.stringify({
        name: "brain",
        displayName: "Brain",
        path: "/surface/brain",
        server: { entry: "server/index.js" },
      }),
    });
    const res = await dispatch(
      pushReq({ surface: "brain", clone_url: "http://127.0.0.1:1939/git/brain", pull_token: "t" }),
      state,
      { enforceScopeFn: allowAdmin, gitSpawnFn: fn },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unsupported");
    // Not served.
    expect(state.registeredUis.some((u) => u.meta.name === "brain")).toBe(false);
  });

  // REGRESSION (the production shape that shipped the bug): the REAL notify path
  // — no injected srcDir (so the route picks its own build-src dir via
  // makeBuildSrcDir) and no injected buildRunner (so the DEFAULT Option-B kernel
  // sandbox actually runs) — must BUILD a build-script source + serve it. Before
  // the fix the route cloned under `$PARACHUTE_HOME/surface/src/<name>` (the home
  // tree, which the sandbox denies), so `bun run build` died with
  // `CouldntReadCurrentDirectory` → build_failed → 422. Skips on a host that
  // can't sandbox (green CI on an incapable runner). Gated because it drives the
  // real Seatbelt/bubblewrap engine.
  (CAN_SANDBOX ? test : test.skip)(
    "REAL Option-B runner builds a pushed build-script source (regression: build cwd readable)",
    async () => {
      const state = makeState();
      // A dep-less package.json (offline `bun install --ignore-scripts` no-op) +
      // a pure-shell build that emits dist/index.html — same shape as the live
      // happy-path, but driven through the whole git-pushed route.
      const { fn } = fakeClone({
        "package.json": JSON.stringify({
          name: "brain",
          scripts: { build: "mkdir -p dist && cp index.html dist/index.html" },
        }),
        "index.html": "<h1>built through the route</h1>",
      });
      // NOTE: deliberately NO srcDir and NO buildRunner override — this is the
      // whole point (exercise the production location selection + real sandbox).
      const result = routeAdmin(
        pushReq({
          surface: "brain",
          clone_url: "http://127.0.0.1:1939/git/brain",
          pull_token: "t",
        }),
        {
          state,
          uisDir,
          manifestPath,
          logger: silent,
          skipSelfRegisterRefresh: true,
          enforceScopeFn: allowAdmin,
          gitSpawnFn: fn,
        },
      );
      if (!result.handled) throw new Error("routeAdmin did not handle git-pushed");
      const res = await result.response;
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; served: boolean; path: string };
      expect(json.ok).toBe(true);
      expect(json.served).toBe(true);
      expect(fs.readFileSync(path.join(uisDir, "brain", "dist", "index.html"), "utf8")).toContain(
        "built through the route",
      );
      expect(state.registeredUis.some((u) => u.meta.name === "brain")).toBe(true);
    },
    120_000,
  );
});
