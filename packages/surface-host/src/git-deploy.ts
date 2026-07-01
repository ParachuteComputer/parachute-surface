/**
 * Surface Git Transport — the pull + sandboxed build half (Phase 0b, design
 * doc 2026-06-30-surface-git-transport.md §5 step 5, §7, "Decisions locked" #4).
 *
 * When the hub notifies surface-host that a surface was pushed
 * (`POST /surface/api/git-pushed` → admin-routes `handleGitPushed`), this
 * module does the two attacker-adjacent jobs the substrate deliberately does
 * NOT do:
 *
 *   1. `pullSurfaceSource` — `git clone` the freshly-pushed SOURCE from the hub
 *      git endpoint over the network (modular: no shared disk with the hub —
 *      works when hub + surface-host are separate containers), authed by the
 *      short-lived `surface:<name>:read` token the hub minted into the notify.
 *
 *   2. `buildSurface` — COMPILE that source into a servable `dist/` bundle. The
 *      pusher is operator-authorized (`surface:<name>:write`), so this is the
 *      CI trust model: authorized-but-attacker-influenceable code. It runs
 *      behind a swappable `BuildRunner` seam.
 *
 * ── BUILD TRUST BOUNDARY (read this before touching the runner) ──────────────
 * As of Phase 0c the DEFAULT runner is Option B — kernel confinement via
 * `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux),
 * implemented in `build-sandbox.ts` and resolved lazily as `defaultBuildRunner`.
 * Both runners share these baseline protections:
 *   • NO hub secrets in the env — only PATH + a build-scoped HOME/TMPDIR/
 *     PARACHUTE_HOME (the daemon's real env, incl. any operator/hub token, is
 *     never inherited);
 *   • cwd pinned to the throwaway source checkout;
 *   • a wall-clock timeout that kills the whole process GROUP (a build-spawned
 *     grandchild can't be orphaned — see `spawnBoundedProcess`);
 *   • bounded captured output;
 *   • never elevated (runs as whatever user surface-host runs as).
 *
 * Option A (`constrainedSubprocessRunner`, the pre-0c default, now an opt-in
 * fallback) stops there — no kernel FS/network confinement. Its residuals, all
 * bounded by "the pusher is operator-authorized" and all CLOSED by Option B:
 *   • CONFIDENTIALITY — a hostile build can READ files this user can read via
 *     ABSOLUTE paths (env redirection doesn't stop a hardcoded path), incl.
 *     on-disk credentials (the vault read cred under `~/.parachute/**`);
 *   • INTEGRITY — it can likewise WRITE via absolute paths, e.g. clobber a
 *     sibling served bundle under the real `uis/` (persistence);
 *   • RESOURCES — egress is open (arbitrary exfil).
 *
 * Option B closes all three: reads are confined (the home tree + the real
 * `$PARACHUTE_HOME` are denied, only the build dir + build-HOME + the toolchain
 * are re-allowed → the vault cred / operator token / sibling surfaces are
 * unreadable), writes are confined to the throwaway build dir (no clobbering a
 * sibling bundle), and egress is restricted to the npm registry (no arbitrary
 * exfil). This is the HARD GATE before Phase 2 (non-operator writers), design
 * 2026-06-30-surface-git-transport.md §7 + "Decisions locked" #4. The
 * `BuildRunner` seam is what made the swap a contained change — A is still
 * reachable (tests inject it; operators opt in when the kernel sandbox is
 * unavailable — see build-sandbox.ts).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_AUDIENCE,
  DEFAULT_SCOPES_REQUIRED,
  type UiMeta,
  parseMeta,
} from "./meta-schema.ts";

/** Surface-name charset (matches meta-schema NAME_PATTERN — servable names). */
const SURFACE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export class GitDeployError extends Error {
  override name = "GitDeployError" as const;
  readonly code:
    | "bad_name"
    | "bad_clone_url"
    | "pull_failed"
    | "no_build_output"
    | "build_failed"
    | "build_timeout"
    | "sandbox_unavailable"
    | "bad_build_workspace"
    | "bad_meta";
  readonly detail?: string;
  constructor(message: string, code: GitDeployError["code"], detail?: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// ─── where the pushed source lands ───────────────────────────────────────────

export type BuildSrcDir = {
  /** The private throwaway PARENT — what the caller removes after the build. */
  parentDir: string;
  /** `<parent>/<name>` — the clone destination AND the build cwd. */
  sourceDir: string;
};

/**
 * Resolve the directory a pushed surface's SOURCE is cloned into before the
 * sandboxed build — a PRIVATE, per-push throwaway OUTSIDE the operator's home tree.
 *
 * WHY NOT under `$PARACHUTE_HOME/surface/src/<name>` (the obvious spot, and where
 * this used to clone): the Option-B build sandbox (build-sandbox.ts) DENIES reads
 * on the whole home tree (`/Users` on macOS, `/home` on Linux) plus the real
 * `$PARACHUTE_HOME`, re-allowing only the leaf build dir. But `bun run <script>`
 * reads the build dir's ANCESTORS (package.json / workspace-root / bunfig discovery
 * walks UP from cwd), and under `$PARACHUTE_HOME/surface/src/<name>` those ancestors
 * sat under the deny with no re-allow — so bun could not read its own cwd and every
 * build-script push died with `CouldntReadCurrentDirectory` (`bun install` / `pwd` /
 * `ls` touch only the re-allowed leaf, so they passed; only the ancestor-walking
 * `bun run` failed). Cloning under `os.tmpdir()` keeps the ancestors readable
 * (system temp is outside the deny) while the crown-jewel deny stays FULLY intact:
 * `~/.parachute/**` (the vault read cred, the operator token) and every sibling
 * surface are still unreadable — the source is simply no longer under the denied
 * tree, so nothing else moved out from behind the boundary.
 *
 * The parent is a `mkdtemp` (mode 0700) so a world-writable `/tmp` can't be
 * pre-created as a symlink under us; a per-push fresh dir means no shared,
 * predictable path. The caller removes {@link BuildSrcDir.parentDir} after each
 * build (success AND failure). `parent` overrides the temp base (tests).
 *
 * FAIL-LOUD GUARD: `os.tmpdir()` honors `$TMPDIR`, so on a (pathological but
 * possible) box where `$TMPDIR` points inside the home tree the workspace would
 * land back UNDER the sandbox deny → silent regression to the
 * `CouldntReadCurrentDirectory` bug, or worse, attacker-influenceable source
 * sitting under the denied tree. So after `mkdtemp` we canonicalize the resolved
 * parent and THROW (`bad_build_workspace`) if it's under the home-tree deny root
 * or the real `$PARACHUTE_HOME` — fail-closed, with an actionable message.
 */
export function makeBuildSrcDir(name: string, parent?: string): BuildSrcDir {
  const parentDir = mkTempDir(parent, `parachute-surface-src-${name}-`);
  // Canonicalize (resolve symlinks — e.g. macOS `/tmp` → `/private/tmp`) and check
  // against the SAME roots build-sandbox.ts denies, so a workspace can never land
  // inside the deny. Both roots computed locally to avoid an import cycle
  // (build-sandbox.ts imports this module).
  const canonicalParent = canonicalizePath(parentDir);
  const homeRoot = buildDenyHomeRoot();
  const paraHome = canonicalizePath(
    process.env.PARACHUTE_HOME ?? path.join(os.homedir(), ".parachute"),
  );
  if (isUnderRoot(canonicalParent, homeRoot) || isUnderRoot(canonicalParent, paraHome)) {
    rmSync(parentDir, { recursive: true, force: true });
    throw new GitDeployError(
      `build workspace resolved under the sandbox deny root (${canonicalParent}) — set TMPDIR to a directory outside the home tree (${homeRoot}) and outside $PARACHUTE_HOME so the confined build can read its own cwd`,
      "bad_build_workspace",
    );
  }
  return { parentDir, sourceDir: path.join(parentDir, name) };
}

/** The home-tree deny root, per platform. MUST stay in lockstep with
 * build-sandbox.ts `homeTreeDenyRoot` — duplicated inline (not imported) because
 * build-sandbox.ts imports THIS module, and an import back would cycle. */
function buildDenyHomeRoot(): string {
  return process.platform === "darwin" ? "/Users" : "/home";
}

/** Is `p` at or under `root`? Path-boundary aware (`/home` matches `/home/x` but
 * not `/homework`). Mirrors build-sandbox.ts `isUnder`. */
function isUnderRoot(p: string, root: string): boolean {
  if (p === root) return true;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(withSep);
}

/** realpath a path if it exists; else pass it through unchanged. */
function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ─── git pull ────────────────────────────────────────────────────────────────

/**
 * Spawn seam for git commands — argv + cwd + a scrubbed env, returns exit code
 * + captured streams. Mirrors npm-fetch's `NpmSpawnFn`; tests inject a stub
 * that fabricates a source checkout without a live hub.
 */
export type GitSpawnFn = (
  argv: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const DEFAULT_GIT_SPAWN: GitSpawnFn = async (argv, cwd, env) => {
  const proc = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export type PullSourceOpts = {
  /** The `<hub>/git/<name>` URL to clone (from the hub notify payload). */
  cloneUrl: string;
  /** The short-lived `surface:<name>:read` bearer the hub minted into the notify. */
  token: string;
  /** Absolute path the source is cloned into (replaced if it exists). */
  destDir: string;
  /** Override the git spawner (tests). */
  spawnFn?: GitSpawnFn;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Fresh shallow clone of the pushed source into `destDir`. Fresh (not pull) so
 * there's no stale-checkout state to reason about; `--depth 1` bounds the
 * transfer to the tip tree.
 *
 * The bearer rides in the git child's ENV (`GIT_CONFIG_*` → `http.extraHeader`),
 * never in argv (so it can't leak via `ps`) and never in persisted repo config.
 * `GIT_TERMINAL_PROMPT=0` fails closed instead of hanging on an auth prompt.
 */
export async function pullSurfaceSource(opts: PullSourceOpts): Promise<{ sourceDir: string }> {
  const logger = opts.logger ?? console;
  const spawn = opts.spawnFn ?? DEFAULT_GIT_SPAWN;

  // clone_url must be a real http(s) URL (the hub supplies its own origin). This
  // also rejects `file://`, `ssh://`, and shell-y strings.
  let parsed: URL;
  try {
    parsed = new URL(opts.cloneUrl);
  } catch {
    throw new GitDeployError(`clone_url is not a valid URL: ${opts.cloneUrl}`, "bad_clone_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GitDeployError(`clone_url must be http(s), got ${parsed.protocol}`, "bad_clone_url");
  }

  // Replace any prior checkout — fresh clone each push.
  rmSync(opts.destDir, { recursive: true, force: true });
  mkdirSync(path.dirname(opts.destDir), { recursive: true });

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    // The Authorization header rides in env, not argv (avoids `ps` leak) and is
    // not written to any repo config. SCOPED to the clone origin
    // (`http.<origin>/.extraHeader`) so the bearer never rides a cross-host
    // redirect — only requests to the hub carry it.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${parsed.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${opts.token}`,
  };

  const res = await spawn(
    ["git", "clone", "--depth", "1", "--no-tags", opts.cloneUrl, opts.destDir],
    path.dirname(opts.destDir),
    env,
  );
  if (res.exitCode !== 0) {
    // Never echo the env (it holds the bearer) — only git's stderr, with the
    // token pattern defensively scrubbed in case a future git echoes config.
    const stderr = scrubToken(res.stderr, opts.token);
    logger.warn(`[surface-git] clone failed for ${opts.destDir}: ${stderr.trim()}`);
    throw new GitDeployError("git clone of the pushed source failed", "pull_failed", stderr.trim());
  }
  return { sourceDir: opts.destDir };
}

function scrubToken(s: string, token: string): string {
  return token ? s.split(token).join("<redacted>") : s;
}

// ─── build ───────────────────────────────────────────────────────────────────

export type BuildRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * The swappable build-execution seam (see the file header's TRUST BOUNDARY
 * note). Given an argv + cwd + scrubbed env + timeout, run it and return the
 * result. The default is the constrained subprocess (Option A); a kernel
 * sandbox (Option B) slots in here without touching any caller.
 */
export type BuildRunner = (opts: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => Promise<BuildRunResult>;

/** Cap on captured build output kept in memory / echoed (per stream). */
const MAX_BUILD_OUTPUT_BYTES = 64 * 1024;
/** Default wall-clock build budget. */
export const DEFAULT_BUILD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The shared launch primitive — a bounded, process-group-killed subprocess.
 * Non-privileged, cwd-pinned, PROCESS-GROUP timeout-killed, bounded output. Does
 * NOT itself provide kernel FS/network confinement — it is the raw spawn both
 * runners build on: Option A (`constrainedSubprocessRunner`) IS this primitive;
 * Option B (`build-sandbox.ts`) wraps the argv in a Seatbelt/bubblewrap prefix,
 * then hands the wrapped argv here so the kill/timeout/output-bounding is
 * identical across both.
 *
 * `detached: true` makes the child a new process-group leader (pgid = its pid),
 * so the wall-clock timeout `SIGKILL`s the WHOLE group (`process.kill(-pid)`) —
 * a grandchild the build spawned (a shell, a watcher, the sandbox wrapper's
 * child) is killed too, not orphaned. Termination is bounded on `proc.exited`,
 * NOT on stream EOF: after the kill the stream drains get a short grace and are
 * abandoned, so a lingering pipe holder can never hang the runner past
 * `timeoutMs + grace`.
 */
const POST_KILL_DRAIN_GRACE_MS = 2000;
export const spawnBoundedProcess: BuildRunner = async ({ argv, cwd, env, timeoutMs }) => {
  // `detached` isn't in Bun's SpawnOptions type yet but is honored at runtime
  // (new session/process group) — verified against bun 1.3.x.
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    ...({ detached: true } as object),
  });
  const killGroup = () => {
    try {
      // Negative pid → the whole process group (child is the leader).
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // Group gone or platform didn't honor detached — fall back to the child.
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);
  try {
    const stdoutP = readBounded(proc.stdout as ReadableStream<Uint8Array>);
    const stderrP = readBounded(proc.stderr as ReadableStream<Uint8Array>);
    // SIGKILL guarantees the direct child exits, so this resolves within the
    // budget regardless of whether the pipes ever EOF.
    const exitCode = await proc.exited;
    const grace = new Promise<string>((r) => setTimeout(() => r(""), POST_KILL_DRAIN_GRACE_MS));
    const [stdout, stderr] = await Promise.all([
      Promise.race([stdoutP, grace]),
      Promise.race([stderrP, grace]),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Option A — the constrained subprocess runner (the pre-0c default; now the
 * opt-in fallback the kernel sandbox degrades to when the operator explicitly
 * allows an unsandboxed build). Behaviourally identical to
 * {@link spawnBoundedProcess}: it runs the argv directly with no Seatbelt/
 * bubblewrap wrapper, so it provides NO kernel FS/network confinement — see the
 * file-header TRUST BOUNDARY for the residuals Option B closes.
 */
export const constrainedSubprocessRunner: BuildRunner = spawnBoundedProcess;

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0 && total < MAX_BUILD_OUTPUT_BYTES) {
        chunks.push(value);
        total += value.length;
      }
      // Keep draining past the cap so the child never blocks on a full pipe;
      // we just stop retaining bytes.
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks)).slice(0, MAX_BUILD_OUTPUT_BYTES);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export type BuildSurfaceOpts = {
  /** The cloned source tree. */
  sourceDir: string;
  /** The pushed surface name — pins the served identity (name + mount). */
  name: string;
  /** Fallback scopes when the source ships no meta.json (daemon config). */
  defaultScopes?: readonly string[];
  /**
   * Override the build executor (the sandbox seam). Defaults to Option B — the
   * kernel sandbox runner (`defaultBuildRunner` in build-sandbox.ts), resolved
   * lazily so this module carries no static dependency on the sandbox engine
   * (and the prebuilt-dist path never loads it). Tests inject a stub; an
   * operator who has opted into unsandboxed builds gets Option A via that path.
   */
  runner?: BuildRunner;
  /** Override the build timeout. */
  timeoutMs?: number;
  /**
   * Parent dir for the build-scoped HOME/TMPDIR (isolates bun/npm caches +
   * blunts `$HOME`/`$PARACHUTE_HOME`-relative reads). Defaults under os.tmpdir().
   */
  buildHomeParent?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type BuildSurfaceResult = {
  /** Absolute path to the produced (or prebuilt) dist/ dir. */
  distDir: string;
  /** The finalized meta to write — name/path PINNED to the pushed surface. */
  meta: UiMeta;
  /** Whether a build step actually ran (false = source shipped a prebuilt dist/). */
  built: boolean;
};

/**
 * Build the pulled source into a servable `dist/`, then resolve its `meta.json`.
 *
 * Strategy:
 *   • `package.json` with a `build` script → `bun install --ignore-scripts`
 *     (dependency lifecycle scripts can't run arbitrary code — only the
 *     surface's own build does) then `bun run build`. Output: `<source>/dist`.
 *   • else a prebuilt `dist/index.html` present → serve as-is (no build).
 *   • else → error (nothing to serve).
 *
 * Identity is PINNED to the pushed name: whatever the source's meta.json claims
 * for `name`/`path`, the served surface is `name` at `/surface/<name>` (the
 * push target = `surface:<name>:write`). This prevents a push to surface "foo"
 * from mounting itself at another surface's path.
 */
export async function buildSurface(opts: BuildSurfaceOpts): Promise<BuildSurfaceResult> {
  const logger = opts.logger ?? console;
  if (!SURFACE_NAME_RE.test(opts.name)) {
    throw new GitDeployError(`surface name "${opts.name}" is not servable`, "bad_name");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const src = opts.sourceDir;

  const pkgPath = path.join(src, "package.json");
  const hasBuildScript = readBuildScript(pkgPath) !== undefined;

  let built = false;
  if (hasBuildScript) {
    // Resolve the runner ONLY when a build actually runs. Default = Option B (the
    // kernel sandbox), dynamically imported so git-deploy.ts stays free of a
    // static import cycle with build-sandbox.ts (which imports this module's
    // BuildRunner type + spawn primitive) and so a prebuilt-dist push never even
    // loads the sandbox engine.
    const runner = opts.runner ?? (await import("./build-sandbox.ts")).defaultBuildRunner;
    // Build-scoped HOME/TMPDIR: contains bun/npm caches AND blunts any
    // $HOME/$PARACHUTE_HOME-relative read from the build (an absolute-path read
    // still escapes — see the file header TRUST BOUNDARY).
    const buildHome = mkTempDir(opts.buildHomeParent, `surface-build-${opts.name}-`);
    try {
      const env = scrubbedBuildEnv(buildHome);
      // 1) install deps, dependency lifecycle scripts disabled.
      const install = await runner({
        argv: ["bun", "install", "--ignore-scripts"],
        cwd: src,
        env,
        timeoutMs,
      });
      assertRunOk(install, "bun install", opts.name, logger);
      // 2) the surface's own build (attacker-influenceable — sandboxed by the runner).
      const build = await runner({ argv: ["bun", "run", "build"], cwd: src, env, timeoutMs });
      assertRunOk(build, "bun run build", opts.name, logger);
      built = true;
    } finally {
      rmSync(buildHome, { recursive: true, force: true });
    }
  }

  const distDir = path.join(src, "dist");
  if (!existsSync(path.join(distDir, "index.html"))) {
    throw new GitDeployError(
      built
        ? `build produced no dist/index.html for "${opts.name}"`
        : `source for "${opts.name}" has no build script and no prebuilt dist/index.html`,
      "no_build_output",
    );
  }

  const meta = resolveMeta(src, opts.name, opts.defaultScopes ?? DEFAULT_SCOPES_REQUIRED);
  return { distDir, meta, built };
}

function assertRunOk(
  r: BuildRunResult,
  label: string,
  name: string,
  logger: Pick<Console, "log" | "warn" | "error">,
): void {
  if (r.timedOut) {
    logger.warn(`[surface-git] ${label} timed out for "${name}"`);
    throw new GitDeployError(`${label} timed out`, "build_timeout", r.stderr.trim().slice(-1000));
  }
  if (r.exitCode !== 0) {
    logger.warn(`[surface-git] ${label} failed for "${name}" (exit ${r.exitCode})`);
    throw new GitDeployError(
      `${label} failed (exit ${r.exitCode})`,
      "build_failed",
      r.stderr.trim().slice(-1000),
    );
  }
}

/**
 * Read the `build` script from a package.json, or undefined when there's no
 * package.json / no scripts.build. Malformed package.json → undefined (treated
 * as "no build," which then requires a prebuilt dist/ or errors cleanly).
 */
function readBuildScript(pkgPath: string): string | undefined {
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const b = pkg.scripts?.build;
    return typeof b === "string" && b.length > 0 ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Minimal, hub-secret-free env for the build child. */
function scrubbedBuildEnv(buildHome: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: buildHome,
    TMPDIR: buildHome,
    // Redirect PARACHUTE_HOME so a $PARACHUTE_HOME-relative read finds an empty
    // sandbox instead of the operator's real config (absolute paths still
    // escape — file header TRUST BOUNDARY).
    PARACHUTE_HOME: buildHome,
  };
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

/**
 * Resolve the served meta: parse a source `meta.json` when present (for
 * displayName/tagline/scopes/etc.), else synthesize a minimal one — then PIN
 * `name` + `path` to the pushed surface (identity is the push target, never the
 * source's claim).
 */
function resolveMeta(src: string, name: string, defaultScopes: readonly string[]): UiMeta {
  const pinnedPath = `/surface/${name}`;
  const metaPath = path.join(src, "meta.json");
  if (existsSync(metaPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (e) {
      throw new GitDeployError(
        `source meta.json is not valid JSON: ${(e as Error).message}`,
        "bad_meta",
      );
    }
    // Force identity to the pushed surface BEFORE validation so path/name always
    // pass the pattern checks (and can't hijack another mount).
    const merged =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>), name, path: pinnedPath }
        : { name, path: pinnedPath };
    try {
      return parseMeta(merged);
    } catch (e) {
      throw new GitDeployError(`source meta.json is invalid: ${(e as Error).message}`, "bad_meta");
    }
  }
  // No meta.json — synthesize the minimum a served surface needs.
  return parseMeta({
    name,
    displayName: name,
    path: pinnedPath,
    scopes_required: [...defaultScopes],
    audience: DEFAULT_AUDIENCE,
  });
}

function mkTempDir(parent: string | undefined, prefix: string): string {
  const base = parent ?? os.tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, prefix));
}
