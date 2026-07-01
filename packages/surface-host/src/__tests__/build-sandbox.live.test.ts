/**
 * LIVE kernel-sandbox assertions on this host (Seatbelt on macOS, bubblewrap on
 * Linux) — the SECURITY PROOF that a surface build is genuinely confined, run
 * through the PRODUCTION runner (`makeKernelSandboxRunner` / `buildSurface`), not
 * a hand-patched config:
 *
 *   - a build reading an absolute-path SECRET (a decoy in the real ~/.parachute,
 *     exactly where the vault read cred lives) is DENIED;
 *   - a build reading a secret under a PARACHUTE_HOME OUTSIDE the home tree
 *     (the cloud-box shape) is DENIED;
 *   - a build WRITING outside its build dir is DENIED;
 *   - egress to a non-npm host is DENIED;
 *   - positive controls: the build dir IS readable + writable, a trivial command
 *     runs — so a denial can't be vacuously passing (negative scans need positive
 *     controls);
 *   - the happy path: a real source builds into a servable dist/ THROUGH the
 *     default (Option B) runner.
 *
 * The sandbox-runtime singleton starts host proxies on initialize and tears them
 * down on reset; it's process-global, so these serialize — the production runner's
 * build lock enforces that, and this file runs them sequentially. Sandboxed in
 * fresh temp dirs; the ~/.parachute decoy is a unique-named file cleaned up after.
 *
 * Skipped automatically when the host can't sandbox (unsupported platform / missing
 * bubblewrap deps) so CI on an incapable runner stays green while a capable host
 * (this Mac) exercises the real boundary. The POLICY tests (build-sandbox.test.ts)
 * always run regardless.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { makeKernelSandboxRunner } from "../build-sandbox.ts";
import { buildSurface } from "../git-deploy.ts";

const CAN_SANDBOX =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

// Positive control at the SUITE level: only run when the host can genuinely
// sandbox — else skip (green on an incapable CI runner).
const d = CAN_SANDBOX ? describe : describe.skip;

/** Run a command through the REAL production runner, confined to `buildDir` with a
 * throwaway build HOME. `parachuteHome` overrides the cred-dir deny target. */
async function runConfined(opts: {
  argv: string[];
  buildDir: string;
  buildHome: string;
  parachuteHome?: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const runner = makeKernelSandboxRunner({
    ...(opts.parachuteHome ? { parachuteHome: opts.parachuteHome } : {}),
    logger: { log() {}, warn() {}, error() {} },
  });
  return runner({
    argv: opts.argv,
    cwd: opts.buildDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: opts.buildHome,
      TMPDIR: opts.buildHome,
      PARACHUTE_HOME: opts.buildHome,
    },
    timeoutMs: 60_000,
  });
}

let buildDir: string;
let buildHome: string;

afterEach(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  if (buildHome) rmSync(buildHome, { recursive: true, force: true });
});

d("LIVE kernel sandbox — filesystem read confinement", () => {
  test("positive control: a trivial command runs sandboxed", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-pos-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-pos-"));
    const r = await runConfined({ argv: ["/bin/echo", "sandbox-alive"], buildDir, buildHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("sandbox-alive");
  }, 90_000);

  test("DENIED: a build cannot read a secret in the real ~/.parachute (the vault-cred dir)", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-cred-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-cred-"));
    // Decoy exactly where the vault read cred lives — proves the PRODUCTION deny.
    const paraDir = join(homedir(), ".parachute");
    mkdirSync(paraDir, { recursive: true });
    const decoy = join(paraDir, `.surface-build-decoy-${process.pid}.txt`);
    writeFileSync(decoy, "VAULT-READ-CRED-DECOY-do-not-read");
    try {
      const r = await runConfined({ argv: ["cat", decoy], buildDir, buildHome });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("VAULT-READ-CRED-DECOY");
    } finally {
      rmSync(decoy, { force: true });
    }
  }, 90_000);

  test("DENIED: a build cannot read a secret under a PARACHUTE_HOME OUTSIDE the home tree (cloud box)", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-cloud-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-cloud-"));
    // A parachute-home OUTSIDE /Users — modelled by a temp dir under /var/folders.
    const cloudPara = mkdtempSync(join(tmpdir(), "sbx-parahome-"));
    const cred = join(cloudPara, "surface", "credentials", "vault-read.token");
    mkdirSync(join(cloudPara, "surface", "credentials"), { recursive: true });
    writeFileSync(cred, "CLOUD-VAULT-CRED-do-not-read");
    try {
      const r = await runConfined({
        argv: ["cat", cred],
        buildDir,
        buildHome,
        parachuteHome: cloudPara,
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("CLOUD-VAULT-CRED");
    } finally {
      rmSync(cloudPara, { recursive: true, force: true });
    }
  }, 90_000);

  test("ALLOWED (positive control): a build CAN read a file inside its own build dir", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-read-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-read-"));
    const inside = join(buildDir, "source.txt");
    writeFileSync(inside, "OWN-SOURCE-readable");
    const r = await runConfined({ argv: ["cat", inside], buildDir, buildHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OWN-SOURCE-readable");
  }, 90_000);
});

d("LIVE kernel sandbox — filesystem write confinement", () => {
  test("DENIED: a build cannot write outside its build dir (no clobbering a sibling bundle)", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-write-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-write-"));
    // A sibling "served bundle" dir the build must NOT be able to clobber.
    const sibling = mkdtempSync(join(tmpdir(), "sbx-sibling-uis-"));
    const target = join(sibling, "index.html");
    writeFileSync(target, "LEGIT-BUNDLE");
    try {
      const r = await runConfined({
        argv: ["/bin/sh", "-c", `echo PWNED > ${target}`],
        buildDir,
        buildHome,
      });
      expect(r.exitCode).not.toBe(0);
      // The sibling bundle is UNTOUCHED.
      expect(await Bun.file(target).text()).toBe("LEGIT-BUNDLE");
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 90_000);

  test("ALLOWED (positive control): a build CAN write inside its build dir", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-writeok-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-writeok-"));
    const out = join(buildDir, "dist-out.txt");
    const r = await runConfined({
      argv: ["/bin/sh", "-c", `echo built > ${out}`],
      buildDir,
      buildHome,
    });
    expect(r.exitCode).toBe(0);
    expect(await Bun.file(out).text()).toContain("built");
  }, 90_000);
});

d("LIVE kernel sandbox — network egress confinement", () => {
  test("DENIED: egress to a non-npm host is blocked", async () => {
    buildDir = mkdtempSync(join(tmpdir(), "sbx-build-egress-"));
    buildHome = mkdtempSync(join(tmpdir(), "sbx-home-egress-"));
    const r = await runConfined({
      argv: [
        "curl",
        "-sS",
        "-m",
        "8",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://example.com",
      ],
      buildDir,
      buildHome,
    });
    // The egress proxy refuses a non-allowlisted host: curl exits non-zero and the
    // status is never a 2xx. (npm is the only allowed host — asserted in the config
    // unit tests; a live npm fetch would be a network-flaky external dependency.)
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toMatch(/^2\d\d$/);
  }, 90_000);
});

d("LIVE kernel sandbox — happy path through the DEFAULT (Option B) runner", () => {
  test("a real source builds into a servable dist/ (buildSurface, no injected runner)", async () => {
    const srcBase = mkdtempSync(join(tmpdir(), "sbx-happy-src-"));
    const src = join(srcBase, "brain");
    mkdirSync(src, { recursive: true });
    // Dep-less package.json (offline `bun install --ignore-scripts` no-op) + a
    // pure-shell build that emits dist/index.html.
    writeFileSync(
      join(src, "package.json"),
      JSON.stringify({
        name: "brain",
        scripts: { build: "mkdir -p dist && cp index.html dist/index.html" },
      }),
    );
    writeFileSync(join(src, "index.html"), "<h1>sandboxed build works</h1>");
    try {
      const out = await buildSurface({
        sourceDir: src,
        name: "brain",
        logger: { log() {}, warn() {}, error() {} },
      });
      expect(out.built).toBe(true);
      expect(existsSync(join(out.distDir, "index.html"))).toBe(true);
      expect(await Bun.file(join(out.distDir, "index.html")).text()).toContain(
        "sandboxed build works",
      );
      expect(out.meta.name).toBe("brain");
      expect(out.meta.path).toBe("/surface/brain");
    } finally {
      rmSync(srcBase, { recursive: true, force: true });
    }
  }, 120_000);
});
