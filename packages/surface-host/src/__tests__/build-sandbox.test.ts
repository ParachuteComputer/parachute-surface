/**
 * Unit tests for the Option-B kernel build sandbox (build-sandbox.ts) that do NOT
 * need a real Seatbelt/bubblewrap host — they exercise the confinement POLICY
 * (config shape), the env-allowlist merge, the availability check, and the
 * fail-closed / opt-in behaviour with an INJECTED fake engine. The LIVE boundary
 * proof (a real sandboxed process is genuinely confined) is in
 * build-sandbox.live.test.ts, gated on host capability.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  NPM_EGRESS_HOSTS,
  type SandboxEngine,
  UNSANDBOXED_OPT_IN_ENV,
  buildSandboxConfig,
  checkSandboxAvailable,
  homeTreeDenyRoot,
  makeKernelSandboxRunner,
  mergeSandboxBuildEnv,
  resolveBunReadBinds,
  resolveSeccompReadBinds,
  shellJoin,
} from "../build-sandbox.ts";
import { type BuildRunner, GitDeployError } from "../git-deploy.ts";

const silent = { log() {}, warn() {}, error() {} };

/**
 * A fake sandbox engine that records what it was initialized with and returns a
 * canned wrapped command — so we can assert the config + env merge + the whole
 * runner control-flow WITHOUT a real kernel sandbox. `available` toggles the
 * availability gate; `wrapArgv`/`wrapEnv` are the canned wrap result.
 */
function fakeEngine(opts: {
  available?: boolean;
  depErrors?: string[];
  wrapArgv?: string[];
  wrapEnv?: Record<string, string | undefined>;
}): SandboxEngine & { lastConfig?: SandboxRuntimeConfig; calls: string[] } {
  const calls: string[] = [];
  const eng: SandboxEngine & { lastConfig?: SandboxRuntimeConfig; calls: string[] } = {
    calls,
    isSupportedPlatform: () => opts.available !== false,
    checkDependencies: () => ({ errors: opts.depErrors ?? [], warnings: [] }),
    async initialize(config) {
      calls.push("initialize");
      eng.lastConfig = config;
    },
    async wrapWithSandboxArgv(command) {
      calls.push(`wrap:${command}`);
      return {
        argv: opts.wrapArgv ?? ["/bin/sh", "-c", command],
        env: opts.wrapEnv ?? {},
      };
    },
    async waitForNetworkInitialization() {
      calls.push("waitForNetwork");
      return true;
    },
    async reset() {
      calls.push("reset");
    },
  };
  return eng;
}

describe("buildSandboxConfig — confinement policy", () => {
  test("writes are confined to the build dir + build HOME (allow-only)", () => {
    const cfg = buildSandboxConfig({
      buildDir: "/srv/surface/src/brain",
      buildHome: "/tmp/build-home",
      egressHosts: NPM_EGRESS_HOSTS,
      platform: "linux",
      parachuteHome: "/srv/surface", // outside the home tree
    });
    expect(cfg.filesystem.allowWrite).toEqual(["/srv/surface/src/brain", "/tmp/build-home"]);
    expect(cfg.filesystem.denyWrite).toEqual([]);
  });

  test("reads deny the home tree; a parachute-home OUTSIDE it is denied too", () => {
    const cfg = buildSandboxConfig({
      buildDir: "/opt/pc/surface/src/brain",
      buildHome: "/tmp/bh",
      egressHosts: NPM_EGRESS_HOSTS,
      platform: "linux",
      parachuteHome: "/opt/pc", // NOT under /home
    });
    // Both the home tree AND the (outside) real parachute-home are denied.
    expect(cfg.filesystem.denyRead).toContain("/home");
    expect(cfg.filesystem.denyRead).toContain("/opt/pc");
    // The build's own checkout is re-allowed (allow-over-deny wins).
    expect(cfg.filesystem.allowRead).toContain("/opt/pc/surface/src/brain");
    expect(cfg.filesystem.allowRead).toContain("/tmp/bh");
  });

  test("a parachute-home UNDER the home tree is NOT double-denied (single-level deny)", () => {
    // When PARACHUTE_HOME is the default ~/.parachute (under /Users), the home-tree
    // deny already covers it — we don't add a nested second deny (so the build-dir
    // re-allow beats a SINGLE deny, the exact relationship the live tests prove).
    const cfg = buildSandboxConfig({
      buildDir: "/tmp/build/brain",
      buildHome: "/tmp/bh",
      egressHosts: NPM_EGRESS_HOSTS,
      platform: "darwin",
      parachuteHome: "/Users/op/.parachute",
    });
    expect(cfg.filesystem.denyRead).toEqual(["/Users"]);
  });

  test("network is restricted to the given egress hosts; no pty", () => {
    const cfg = buildSandboxConfig({
      buildDir: "/tmp/b",
      buildHome: "/tmp/bh",
      egressHosts: ["registry.npmjs.org", "example.com"],
      platform: "linux",
      parachuteHome: "/opt/pc",
    });
    expect(cfg.network.allowedDomains).toEqual(["registry.npmjs.org", "example.com"]);
    expect(cfg.network.deniedDomains).toEqual([]);
    expect(cfg.allowPty).toBe(false);
  });

  test("homeTreeDenyRoot is /Users on darwin, /home on linux", () => {
    expect(homeTreeDenyRoot("darwin")).toBe("/Users");
    expect(homeTreeDenyRoot("linux")).toBe("/home");
  });
});

describe("mergeSandboxBuildEnv — only allowlisted engine keys; scrub wins", () => {
  test("drops non-allowlisted wrapper keys; scrubbed fundamentals win", () => {
    const scrubbed = { PATH: "/usr/bin", HOME: "/tmp/bh", TMPDIR: "/tmp/bh" };
    const wrapped = {
      HTTPS_PROXY: "http://127.0.0.1:9",
      SANDBOX_RUNTIME: "1",
      SECRET_LEAK: "do-not-pass", // NOT allowlisted → dropped
      ANTHROPIC_API_KEY: "sk-leak", // NOT allowlisted → dropped
      HOME: "/root", // allowlist doesn't include HOME → scrubbed HOME survives
      TMPDIR: "/var/other", // TMPDIR is allowlisted, but scrubbed wins (layered last)
    };
    const out = mergeSandboxBuildEnv(scrubbed, wrapped);
    expect(out.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(out.SANDBOX_RUNTIME).toBe("1");
    expect(out.SECRET_LEAK).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    // scrubbed HOME + TMPDIR win so writes stay confined to the build HOME.
    expect(out.HOME).toBe("/tmp/bh");
    expect(out.TMPDIR).toBe("/tmp/bh");
    expect(out.PATH).toBe("/usr/bin");
  });
});

describe("checkSandboxAvailable", () => {
  test("unsupported platform → not ok", () => {
    const r = checkSandboxAvailable(fakeEngine({ available: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not supported");
  });
  test("dependency errors → not ok, reason carries them", () => {
    const r = checkSandboxAvailable(
      fakeEngine({ available: true, depErrors: ["bwrap not found"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("bwrap not found");
  });
  test("supported + no dep errors → ok", () => {
    expect(checkSandboxAvailable(fakeEngine({ available: true })).ok).toBe(true);
  });
});

describe("makeKernelSandboxRunner — fail-closed / opt-in", () => {
  const runnerOpts = { PATH: "/usr/bin", HOME: "/tmp/bh", TMPDIR: "/tmp/bh" };

  test("FAIL-CLOSED: sandbox unavailable + no opt-in → throws sandbox_unavailable", async () => {
    const runner = makeKernelSandboxRunner({
      engine: fakeEngine({ available: false }),
      env: {}, // opt-in NOT set
      logger: silent,
    });
    await expect(
      runner({ argv: ["bun", "install"], cwd: "/tmp/b", env: runnerOpts, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });

  test("OPT-IN: sandbox unavailable + env=1 → degrades to the fallback runner", async () => {
    let fellBack = false;
    const fallbackRunner: BuildRunner = async () => {
      fellBack = true;
      return { exitCode: 0, stdout: "fallback", stderr: "", timedOut: false };
    };
    const runner = makeKernelSandboxRunner({
      engine: fakeEngine({ available: false }),
      env: { [UNSANDBOXED_OPT_IN_ENV]: "1" },
      fallbackRunner,
      logger: silent,
    });
    const res = await runner({
      argv: ["bun", "install"],
      cwd: "/tmp/b",
      env: runnerOpts,
      timeoutMs: 1000,
    });
    expect(fellBack).toBe(true);
    expect(res.stdout).toBe("fallback");
  });

  test("opt-in value other than '1' does NOT open the escape hatch (fail-closed)", async () => {
    const runner = makeKernelSandboxRunner({
      engine: fakeEngine({ available: false }),
      env: { [UNSANDBOXED_OPT_IN_ENV]: "true" }, // must be exactly "1"
      logger: silent,
    });
    await expect(
      runner({ argv: ["bun", "install"], cwd: "/tmp/b", env: runnerOpts, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "sandbox_unavailable" });
  });
});

describe("makeKernelSandboxRunner — control flow (fake engine + REAL spawn primitive)", () => {
  test("reset→initialize→wait→wrap→spawn, config confines, env merge holds", async () => {
    const buildDir = mkdtempSync(join(tmpdir(), "sbx-unit-build-"));
    const buildHome = mkdtempSync(join(tmpdir(), "sbx-unit-home-"));
    try {
      // The wrapped command echoes HOME + whether a non-allowlisted wrapper key
      // leaked — run for real through spawnBoundedProcess.
      const eng = fakeEngine({
        available: true,
        wrapArgv: ["/bin/sh", "-c", 'echo "HOME=$HOME LEAK=${SECRET_LEAK:-none}"'],
        wrapEnv: { SANDBOX_RUNTIME: "1", SECRET_LEAK: "leaked", HTTPS_PROXY: "http://p" },
      });
      const runner = makeKernelSandboxRunner({
        engine: eng,
        platform: "linux",
        parachuteHome: "/opt/pc",
        egress: ["example.com"],
        logger: silent,
      });
      const res = await runner({
        argv: ["bun", "run", "build"],
        cwd: buildDir,
        env: { PATH: process.env.PATH ?? "/usr/bin", HOME: buildHome, TMPDIR: buildHome },
        timeoutMs: 30_000,
      });

      // The singleton lifecycle ran in order.
      expect(eng.calls[0]).toBe("reset");
      expect(eng.calls[1]).toBe("initialize");
      expect(eng.calls).toContain("waitForNetwork");
      expect(eng.calls.some((c) => c.startsWith("wrap:"))).toBe(true);
      // The command string was shell-joined (argv → "bun run build").
      expect(eng.calls.find((c) => c.startsWith("wrap:"))).toBe("wrap:bun run build");

      // The config confined writes + restricted egress (npm base + the addition).
      // (Binds are canonicalized — realpath — so /var/… becomes /private/var/… on macOS.)
      expect(eng.lastConfig?.filesystem.allowWrite).toContain(realpathSync(buildDir));
      expect(eng.lastConfig?.filesystem.allowWrite).toContain(realpathSync(buildHome));
      expect(eng.lastConfig?.network.allowedDomains).toContain("registry.npmjs.org");
      expect(eng.lastConfig?.network.allowedDomains).toContain("example.com");

      // The child ran with the SCRUBBED HOME and WITHOUT the non-allowlisted key.
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`HOME=${buildHome}`);
      expect(res.stdout).toContain("LEAK=none");
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
      rmSync(buildHome, { recursive: true, force: true });
    }
  });
});

describe("toolchain read-bind resolution", () => {
  test("resolveBunReadBinds finds the bun binary + install dir (bun is present here)", () => {
    const binds = resolveBunReadBinds(process.env.PATH);
    expect(binds.length).toBeGreaterThan(0);
    expect(binds.some((b) => b.endsWith("/bun") || b.includes("bun"))).toBe(true);
  });

  test("resolveSeccompReadBinds returns the vendored helper binds on x64/arm64", () => {
    const binds = resolveSeccompReadBinds();
    // The pinned engine ships vendor/seccomp/{x64,arm64}/apply-seccomp; on those
    // arches we get binds, else [] (a no-op — the engine self-resolves).
    if (process.arch === "x64" || process.arch === "arm64") {
      expect(binds.length).toBeGreaterThan(0);
      expect(binds.some((b) => b.includes("seccomp"))).toBe(true);
    } else {
      expect(binds).toEqual([]);
    }
  });
});

describe("shellJoin", () => {
  test("joins simple argv unquoted, quotes shell-significant args", () => {
    expect(shellJoin(["bun", "run", "build"])).toBe("bun run build");
    expect(shellJoin(["echo", "a b"])).toBe("echo 'a b'");
    expect(shellJoin(["cat", "/x/'y"])).toBe(`cat '/x/'\\''y'`);
  });
});

describe("GitDeployError sandbox_unavailable code exists", () => {
  test("the code is part of the union (constructs cleanly)", () => {
    const e = new GitDeployError("x", "sandbox_unavailable", "why");
    expect(e.code).toBe("sandbox_unavailable");
    expect(e.detail).toBe("why");
  });
});
