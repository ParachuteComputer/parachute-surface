/**
 * Option B — KERNEL build confinement for the Surface Git Transport (Phase 0c,
 * design 2026-06-30-surface-git-transport.md §7 + "Decisions locked" #4).
 *
 * This is the default {@link BuildRunner}: it runs a pushed surface's
 * `bun install` + `bun run build` inside a kernel sandbox — Seatbelt on macOS,
 * bubblewrap on Linux, via `@anthropic-ai/sandbox-runtime` (the SAME engine the
 * agent uses). It closes the Option-A residual (`git-deploy.ts` file header): a
 * malicious-but-authorized build reading absolute-path secrets (the vault read
 * cred under `~/.parachute/**`, the operator token, other surfaces' source) or
 * writing outside its throwaway build dir (clobbering a sibling served bundle).
 * It is the HARD GATE before Phase 2 (when non-operator agents/clients can push,
 * which is when that residual would matter).
 *
 * ── WHAT A `surface:<name>:write` HOLDER CAN vs CANNOT DO under Option B ──────
 *   CAN:  build from the pushed source (read/write its OWN throwaway checkout +
 *         a throwaway build HOME for caches); reach the npm registry to install
 *         deps.
 *   CANNOT: read `~/.parachute/**` (the vault read cred / operator token), read
 *         another surface's source or served bundle, read the operator's home
 *         (SSH keys, other projects); write ANYWHERE outside the throwaway build
 *         dir + build HOME (no clobbering `uis/<other>`); reach any host beyond
 *         the npm registry (no arbitrary exfil). Plus every Option-A protection
 *         (scrubbed env, wall-clock timeout, bounded output, non-root, fail-
 *         closed) still holds — see `git-deploy.ts`.
 *
 * ── REUSED, DELIBERATELY, from the agent's hard-won integration ──────────────
 * (parachute-agent/src/sandbox/* + spawn-{agent,deps}.ts — do NOT re-discover
 * these; they were paid for once already):
 *   • the home-tree deny + scoped re-allow read model (agent `sandbox/mounts.ts`
 *     §4.5): the runtime reads deny-then-allow, so we DENY the home tree and
 *     re-allow only the build dir + toolchain, and `allowRead` wins over
 *     `denyRead` for a nested path;
 *   • {@link resolveSeccompReadBinds} — the Linux `apply-seccomp` ENOENT fix
 *     (agent `spawn-deps.ts`): the engine execs its vendored helper INSIDE the
 *     bwrap namespace, but bun/npm install it under the home tree the deny masks,
 *     so it must be re-bound or every Linux build dies with ENOENT;
 *   • {@link resolveBunReadBinds} — the bun-binary analogue of the agent's
 *     `resolveClaudeBin`: bun commonly lives under `~/.bun`, which the deny masks,
 *     so the binary + its install dir must be re-bound to exec at all;
 *   • {@link SANDBOX_ENV_ALLOWLIST} — the ONLY engine env keys admitted onto the
 *     scrubbed build env (agent `spawn-agent.ts`), so the daemon's ambient env
 *     (incl. any secret) never rides back in via the wrapper's returned env;
 *   • the reset→initialize→wrap serialization on the process-global singleton
 *     (agent `sandbox/index.ts`) — here widened to cover the whole build (see
 *     {@link withBuildLock}).
 */

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// `@anthropic-ai/sandbox-runtime` is pinned EXACT (not `^`) in package.json — it's
// an anthropic-experimental research preview whose config/API may evolve between
// patch releases, and it is the load-bearing isolation engine. Treat a version
// bump as an upgrade-gate: only raise the pin behind a green run of the sandbox
// tests (esp. the LIVE assertions in `build-sandbox.live.test.ts`, which prove the
// real boundary still holds). On a bump, also re-check SANDBOX_ENV_ALLOWLIST below
// against the runtime's `generateProxyEnvVars` — a new proxy/launch var the engine
// emits must be added there or egress silently breaks (on Windows the vars ride in
// the returned env dict). We keep the pin EQUAL to the agent's (0.0.54) so both
// modules exercise one audited engine version.
import { SandboxManager as RealSandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import {
  type BuildRunResult,
  type BuildRunner,
  GitDeployError,
  constrainedSubprocessRunner,
  spawnBoundedProcess,
} from "./git-deploy.ts";

/** The two platforms we confine on. */
export type SandboxPlatform = "darwin" | "linux";

/** Resolve the running platform to the two we handle (anything non-darwin → linux). */
export function currentSandboxPlatform(): SandboxPlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/**
 * Env var an operator sets to DELIBERATELY allow an UNSANDBOXED build when the
 * kernel sandbox is unavailable on the host (e.g. a Linux box missing bubblewrap,
 * or a platform the engine doesn't support). Absent/not-"1" → fail-closed (the
 * secure default): the build is REFUSED rather than run without confinement.
 * Set to `"1"` → the runner degrades to Option A ({@link constrainedSubprocessRunner})
 * with a LOUD warning on every build. Documented in the README + the design doc.
 */
export const UNSANDBOXED_OPT_IN_ENV = "PARACHUTE_SURFACE_BUILD_ALLOW_UNSANDBOXED";

/**
 * The non-removable egress base for a build: the npm registry. A `bun install`
 * fetches packages + tarballs from here (bun's default registry is npmjs; both
 * the metadata and the `-/…` tarball path are on `registry.npmjs.org`). The
 * CLONE of the pushed source is NOT in this sandbox — it's the trusted substrate
 * fetch (`pullSurfaceSource`, authed by the hub read token), so the build itself
 * needs only npm, never the hub. A factory caller can WIDEN this (private
 * registry, git deps) via `makeKernelSandboxRunner({ egress })`; the base is
 * always present so a widening can only add, never strip.
 */
export const NPM_EGRESS_HOSTS: readonly string[] = ["registry.npmjs.org", "*.npmjs.org"] as const;

// ─── engine adapter ────────────────────────────────────────────────────────────

/**
 * The minimal slice of the sandbox-runtime singleton this runner uses. Pinned
 * here so a test can inject a fake without depending on the full runtime API,
 * and so drift in the runtime's surface fails the typecheck loudly. Mirrors the
 * agent's `SandboxEngine` (kept intentionally narrow).
 */
export interface SandboxEngine {
  isSupportedPlatform(): boolean;
  checkDependencies(ripgrep?: { command: string; args?: string[] }): {
    errors: string[];
    warnings: string[];
  };
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  /** Wrap a shell command string; returns the argv + env to spawn. */
  wrapWithSandboxArgv(
    command: string,
  ): Promise<{ argv: string[]; env: Record<string, string | undefined> }>;
  /** Block until the egress proxy is ready (restricted network). Optional. */
  waitForNetworkInitialization?(): Promise<boolean>;
  reset(): Promise<void>;
}

/** The real engine, library-linked (never via PATH — a poisoned PATH entry would
 * execute BEFORE the sandbox is established; the import anchors the trust boundary
 * to the pinned, library-resolved artifact — agent `sandbox/index.ts` Q4). */
export const defaultSandboxEngine: SandboxEngine = RealSandboxManager as unknown as SandboxEngine;

/**
 * Is the kernel sandbox usable on this host RIGHT NOW? `isSupportedPlatform`
 * rejects an unsupported OS; `checkDependencies().errors` catches a Linux box
 * missing bubblewrap / ripgrep / the seccomp helper (errors = "cannot run",
 * warnings = degraded — we only fail on errors). We do NOT gate on
 * `isSandboxingEnabled()`: in this runtime that merely reports "initialize() was
 * called," so it's useless as a pre-check and would fail-open.
 */
export function checkSandboxAvailable(
  engine: SandboxEngine,
  ripgrep?: { command: string; args?: string[] },
): { ok: boolean; reason?: string } {
  if (!engine.isSupportedPlatform()) {
    return { ok: false, reason: "platform not supported by @anthropic-ai/sandbox-runtime" };
  }
  const dep = engine.checkDependencies(ripgrep);
  if (dep.errors.length > 0) return { ok: false, reason: dep.errors.join("; ") };
  return { ok: true };
}

// ─── read binds the confined build needs ────────────────────────────────────────

/** Map `process.arch` → the sandbox-runtime vendor dir name, or null. Mirrors the
 * runtime's own `getVendorArchitecture` (incl. its `x86_64`/`aarch64` aliases). */
function seccompVendorArch(): "x64" | "arm64" | null {
  const arch: string = process.arch;
  if (arch === "x64" || arch === "x86_64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return null;
}

/**
 * Read binds the sandbox needs to exec the engine's OWN vendored `apply-seccomp`
 * helper (Linux). VERBATIM in spirit from the agent's `spawn-deps.ts`:
 *
 * On Linux the engine enforces its unix-socket block by exec'ing
 * `<pkgRoot>/vendor/seccomp/<arch>/apply-seccomp` (an absolute host path) INSIDE
 * the bwrap mount namespace. Our scoped-read policy denies the whole home tree by
 * mounting a tmpfs over it; bun/npm install the package UNDER the home tree
 * (`~/.bun/...`), so the deny tmpfs MASKS the engine's own helper inside the
 * namespace and the build dies with `apply-seccomp: No such file or directory`
 * (an ENOENT for a file that exists on the host but is hidden in the sandbox). So
 * we resolve the helper exactly as the runtime does and re-bind it + its dir +
 * the vendor tree over the deny. READ-ONLY bind of the engine's own static helper
 * — zero weakening (it IS the boundary). No-op on macOS / outside the home tree.
 * `[]` when it can't be located (the engine degrades to its own resolution).
 */
export function resolveSeccompReadBinds(): string[] {
  const arch = seccompVendorArch();
  if (!arch) return [];
  try {
    // Resolve the package ROOT via the module graph (library-resolved, never PATH)
    // so we bind the same physical install the engine was imported from.
    const req = createRequire(import.meta.url);
    const pkgRoot = dirname(dirname(req.resolve("@anthropic-ai/sandbox-runtime")));
    const bin = join(pkgRoot, "vendor", "seccomp", arch, "apply-seccomp");
    if (!existsSync(bin)) return [];
    const reads = new Set<string>([bin]);
    try {
      const real = realpathSync(bin);
      reads.add(real);
      reads.add(dirname(real)); // .../vendor/seccomp/<arch>
      reads.add(dirname(dirname(dirname(real)))); // .../vendor
    } catch {
      // Broken symlink — bind the path we built; the dir bind below still applies.
    }
    reads.add(dirname(bin));
    return [...reads];
  } catch {
    return [];
  }
}

/**
 * Read binds the sandbox needs to actually EXEC `bun` inside the confinement —
 * the bun analogue of the agent's `resolveClaudeBin`. The scoped-read policy
 * denies the whole home tree; bun commonly installs under it
 * (`~/.bun/bin/bun` → `~/.bun/install/global/...`), so without re-binding the
 * binary + its realpath + its install dir the confined `bun install` fails with
 * `bun: command not found`. Outside the home tree (`/opt/homebrew/bin`, `/usr/…`)
 * these are no-ops (already readable). `[]` when bun can't be located — the
 * caller falls back to PATH resolution at run (correct when bun is outside the
 * home tree). `pathEnv` is the build child's PATH (so we resolve the same bun the
 * child will).
 */
export function resolveBunReadBinds(pathEnv?: string): string[] {
  const sym = Bun.which("bun", pathEnv ? { PATH: pathEnv } : undefined);
  if (!sym) return [];
  const reads = new Set<string>([sym]);
  try {
    const real = realpathSync(sym);
    reads.add(real);
    reads.add(dirname(real)); // .../bin
    reads.add(dirname(dirname(real))); // the install root
  } catch {
    // Broken symlink — bind just the symlink we found.
  }
  return [...reads];
}

// ─── env allowlist ───────────────────────────────────────────────────────────

/**
 * The ONLY env keys admitted FROM the sandbox engine's returned wrapper env.
 *
 * CRITICAL ISOLATION CONTRACT (agent `spawn-agent.ts`). On macOS/Linux
 * `wrapWithSandboxArgv` returns essentially the WHOLE daemon `process.env` (the
 * proxy/sandbox vars are baked into the wrapped COMMAND, not the returned env); on
 * Windows the proxy vars DO ride in the returned env. If we spread that env onto
 * the scrubbed build env, the daemon's ambient secrets would re-enter and defeat
 * the scrub. So we ALLOWLIST: from the wrapper env we keep ONLY these known
 * sandbox/proxy/CA keys (the exact set the runtime's `generateProxyEnvVars` +
 * Linux bwrap markers emit — needed so restricted egress works, esp. on Windows),
 * and the scrubbed build env is layered ON TOP so the fundamentals it sets
 * (PATH/HOME/TMPDIR/PARACHUTE_HOME) always win.
 */
export const SANDBOX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Sandbox markers + per-session temp dir. (Our scrubbed env's TMPDIR wins in
  // the merge — writes stay confined to the build HOME — so this is only for the
  // Windows path where it rides in the returned env.)
  "SANDBOX_RUNTIME",
  "TMPDIR",
  // CA trust stores — when the egress proxy terminates TLS the child must trust
  // the proxy-minted certs.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  // Proxy routing (upper + lower case) — the egress floor. Without these the
  // sandboxed build loses network on platforms that carry them in the returned env.
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "FTP_PROXY",
  "ftp_proxy",
  "RSYNC_PROXY",
  "GRPC_PROXY",
  "grpc_proxy",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "GIT_SSH_COMMAND",
  // Linux bwrap host-proxy-port markers (debug/transparency).
  "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
]);

/**
 * Compose the launch env so the SCRUB WINS: keep only the allowlisted sandbox/
 * proxy/CA keys from the wrapper's returned env, then layer the scrubbed build
 * env ON TOP (its PATH/HOME/TMPDIR/PARACHUTE_HOME override any wrapper value, so
 * writes stay confined to the build HOME and the daemon's ambient env never
 * re-enters).
 */
export function mergeSandboxBuildEnv(
  scrubbed: Record<string, string>,
  wrappedEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(wrappedEnv)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (!SANDBOX_ENV_ALLOWLIST.has(k)) continue;
    out[k] = v;
  }
  return { ...out, ...scrubbed };
}

// ─── filesystem + network config ─────────────────────────────────────────────

/** The home-tree root denied for scoped reads, per platform. */
export function homeTreeDenyRoot(platform: SandboxPlatform): string {
  return platform === "darwin" ? "/Users" : "/home";
}

/** Base for the operator's real parachute home — `$PARACHUTE_HOME` else
 * `~/.parachute`. This is the REAL one (holding the vault read cred + operator
 * token) we DENY — NOT the build child's redirected `PARACHUTE_HOME` (which points
 * at the throwaway build HOME). */
function realParachuteHome(): string {
  return process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
}

/** realpath a path if it exists (Seatbelt/bwrap bind on canonical paths); else
 * pass through unchanged. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface BuildSandboxConfigInput {
  /** The source checkout being built (cwd) — read + write confined here. */
  buildDir: string;
  /** The throwaway build HOME (bun/npm caches, TMPDIR) — read + write confined. */
  buildHome: string;
  /** Egress hosts the build may reach (npm base + any factory additions). */
  egressHosts: readonly string[];
  /** Target platform. Defaults to the running platform. */
  platform?: SandboxPlatform;
  /** The build child's PATH (to resolve the same `bun` it will exec). */
  pathEnv?: string;
  /** Override the real parachute-home deny target (tests). */
  parachuteHome?: string;
}

/**
 * Build the `SandboxRuntimeConfig` for one build command. The single place the
 * confinement policy is expressed:
 *
 *   WRITES  — allow-only: confined to the build dir + build HOME. Everything else
 *             is unwritable (no clobbering `uis/<other>`, no absolute-path writes).
 *   READS   — deny-then-allow: DENY the home tree AND the real `$PARACHUTE_HOME`
 *             (when it sits outside the home tree — a cloud box), then RE-ALLOW
 *             only the build dir + build HOME + the toolchain (bun, the vendored
 *             seccomp helper). System paths (`/usr`, `/opt`, …) stay readable so
 *             `bun`/`node` run. Net effect: the vault read cred / operator token /
 *             sibling surfaces (all under `$PARACHUTE_HOME` or the home tree) are
 *             UNREADABLE, while the build's own checkout is readable.
 *   NETWORK — restricted to `egressHosts` (npm) — no arbitrary exfil.
 */
export function buildSandboxConfig(input: BuildSandboxConfigInput): SandboxRuntimeConfig {
  const platform = input.platform ?? currentSandboxPlatform();
  const homeRoot = homeTreeDenyRoot(platform);
  const paraHome = canonical(input.parachuteHome ?? realParachuteHome());

  const buildDir = canonical(input.buildDir);
  const buildHome = canonical(input.buildHome);

  // WRITES confined to the two throwaway dirs.
  const allowWrite = dedupe([buildDir, buildHome]);

  // READS: re-allow the build dir + build HOME + the toolchain over the deny.
  const allowRead = dedupe([
    buildDir,
    buildHome,
    ...resolveBunReadBinds(input.pathEnv),
    ...resolveSeccompReadBinds(),
  ]);

  // DENY the home tree; ALSO deny the real parachute-home ONLY when it's OUTSIDE
  // the home tree (else the home-tree deny already covers it). Keeping the two
  // deny entries non-nested means the re-allow of a sub-path (the build dir under
  // `$PARACHUTE_HOME/surface/src/<name>`) beats a SINGLE deny — the exact
  // allow-over-deny relationship the agent's live tests prove — never a two-level
  // nested deny whose precedence we'd be guessing at.
  const denyRead = isUnder(paraHome, homeRoot) ? [homeRoot] : [homeRoot, paraHome];

  return {
    network: { allowedDomains: [...input.egressHosts], deniedDomains: [] },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite: [],
    },
    // A build needs no controlling terminal.
    allowPty: false,
  };
}

/** Is `p` at or under `root`? (path-boundary aware — `/home` matches `/home/x`
 * but not `/homework`). */
function isUnder(p: string, root: string): boolean {
  if (p === root) return true;
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(withSep);
}

function dedupe(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (x.length > 0 && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ─── the runner ────────────────────────────────────────────────────────────────

/**
 * Process-wide serialization for the sandbox-runtime singleton. `SandboxManager`
 * is a process-global — `initialize` starts host egress proxies and `reset` tears
 * them DOWN. We hold the lock across the WHOLE build command (reset → initialize →
 * wrap → spawn → await), not just the wrap window the agent locks: a build runs
 * for minutes with a LIVE egress proxy, and a concurrent build's `reset` would
 * tear that proxy down mid-flight (the documented v1 singleton limitation). So
 * surface builds serialize process-wide — acceptable for operator-driven deploys;
 * the escalation rung (a per-session backend) removes it later. A minimal FIFO
 * async mutex: each acquirer chains onto the prior one's release.
 */
let buildLock: Promise<void> = Promise.resolve();
async function withBuildLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = buildLock;
  let release!: () => void;
  buildLock = new Promise<void>((r) => {
    release = r;
  });
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Minimal POSIX shell-quote for joining the (controlled, literal) build argv
 * into the single command string the engine wraps. Mirrors the agent's shellJoin. */
export function shellJoin(argv: string[]): string {
  return argv
    .map((a) =>
      a.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`,
    )
    .join(" ");
}

export interface KernelSandboxRunnerOpts {
  /** Egress hosts the build may reach, ADDED to the npm base. */
  egress?: readonly string[];
  /** Engine override (tests inject a fake). Defaults to the real singleton. */
  engine?: SandboxEngine;
  /** Platform override (tests). Defaults to the running platform. */
  platform?: SandboxPlatform;
  /** Override the real parachute-home deny target (tests). */
  parachuteHome?: string;
  /**
   * Fallback runner when the operator has opted into unsandboxed builds and the
   * sandbox is unavailable. Defaults to Option A ({@link constrainedSubprocessRunner}).
   */
  fallbackRunner?: BuildRunner;
  /** Read the opt-in env (tests). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Build the Option-B {@link BuildRunner} — the kernel-sandboxed build executor.
 *
 * Per call it: (1) checks the sandbox is usable — FAIL-CLOSED if not (throw
 * `sandbox_unavailable`), UNLESS {@link UNSANDBOXED_OPT_IN_ENV}=1, in which case
 * it degrades to the fallback (Option A) with a loud warning; (2) derives the
 * confinement from the caller's `cwd` + build env (HOME/TMPDIR/PARACHUTE_HOME =
 * the throwaway build HOME); (3) reset→initialize→wrap the command; (4) hands the
 * WRAPPED argv to the shared {@link spawnBoundedProcess} primitive so the kill/
 * timeout/output-bounding is identical to Option A. Steps 3–4 hold the build lock.
 */
export function makeKernelSandboxRunner(opts: KernelSandboxRunnerOpts = {}): BuildRunner {
  const engine = opts.engine ?? defaultSandboxEngine;
  const fallback = opts.fallbackRunner ?? constrainedSubprocessRunner;
  const egressHosts = dedupe([...NPM_EGRESS_HOSTS, ...(opts.egress ?? [])]);

  return async ({ argv, cwd, env, timeoutMs }): Promise<BuildRunResult> => {
    const logger = opts.logger ?? console;
    const optInEnv = opts.env ?? process.env;

    const availability = checkSandboxAvailable(engine);
    if (!availability.ok) {
      const optedIn = (optInEnv[UNSANDBOXED_OPT_IN_ENV] ?? "") === "1";
      if (!optedIn) {
        // FAIL CLOSED — refuse to build rather than build without confinement.
        throw new GitDeployError(
          `kernel build sandbox is unavailable on this host — refusing to build unsandboxed. Install the sandbox deps, or set ${UNSANDBOXED_OPT_IN_ENV}=1 to allow an UNSANDBOXED build (only on a trusted, operator-only box).`,
          "sandbox_unavailable",
          availability.reason,
        );
      }
      logger.warn(
        `[surface-build] SANDBOX UNAVAILABLE (${availability.reason}) and ${UNSANDBOXED_OPT_IN_ENV}=1 — running this build UNSANDBOXED (Option A). The build can read absolute-path files this user can read (incl. credentials) and reach any host. Only safe on a trusted, operator-only box.`,
      );
      return fallback({ argv, cwd, env, timeoutMs });
    }

    // Derive the write/read confinement from what the caller already passes: cwd
    // is the source checkout; HOME/TMPDIR/PARACHUTE_HOME are the throwaway build
    // HOME (git-deploy.ts `scrubbedBuildEnv`). We confine to exactly those.
    const buildHome = env.HOME ?? env.TMPDIR ?? env.PARACHUTE_HOME ?? cwd;
    const config = buildSandboxConfig({
      buildDir: cwd,
      buildHome,
      egressHosts,
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(env.PATH ? { pathEnv: env.PATH } : {}),
      ...(opts.parachuteHome ? { parachuteHome: opts.parachuteHome } : {}),
    });

    return withBuildLock(async () => {
      // Reset the process-global singleton BEFORE re-initializing, so a prior
      // build's network/fs config can't leak into this one.
      try {
        await engine.reset();
      } catch {
        // First-ever build has nothing to tear down; a teardown fault must not
        // block the initialize that re-establishes clean state below.
      }
      await engine.initialize(config);
      // Restricted network → wait for the egress proxy to come up before the build
      // reaches for npm (else the first fetch races a not-yet-ready proxy).
      if (engine.waitForNetworkInitialization) {
        try {
          await engine.waitForNetworkInitialization();
        } catch {
          // Non-fatal: the build will surface a network error itself if the proxy
          // genuinely failed; we don't want a probe fault to abort a valid build.
        }
      }
      const wrapped = await engine.wrapWithSandboxArgv(shellJoin(argv));
      const launchEnv = mergeSandboxBuildEnv(env, wrapped.env);
      return spawnBoundedProcess({ argv: wrapped.argv, cwd, env: launchEnv, timeoutMs });
    });
  };
}

/**
 * The DEFAULT build runner — Option B with the npm egress base, the real engine,
 * the current platform, and fail-closed-unless-opted-in. Resolved lazily by
 * `git-deploy.ts` `buildSurface` (dynamic import) so this module — and the
 * sandbox engine it links — loads only when a build actually runs.
 */
export const defaultBuildRunner: BuildRunner = makeKernelSandboxRunner();
