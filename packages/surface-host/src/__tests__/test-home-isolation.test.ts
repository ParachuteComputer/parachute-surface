/** The suite must never resolve surface state or credentials in a live install. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveConfigPath, resolveUisDir } from "../config.ts";
import { resolveCredentialsDir } from "../credential-store.ts";
import { resolveSurfaceStateDir } from "../host-context.ts";
import { resolveOperatorTokenPath } from "../operator-token.ts";
import { resolveManifestPath } from "../services-manifest.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

describe("test-home isolation", () => {
  test("the preload redirects every default surface-host path", () => {
    const testHome = process.env.PARACHUTE_HOME;
    const realHome = join(homedir(), ".parachute");

    expect(testHome).toBeTruthy();
    expect(testHome).not.toBe(realHome);
    expect(testHome!.startsWith(`${realHome}/`)).toBe(false);
    expect(process.env.PARACHUTE_HUB_TOKEN).toBe("");

    for (const resolved of [
      resolveConfigPath(),
      resolveUisDir(),
      resolveCredentialsDir(),
      resolveSurfaceStateDir(),
      resolveOperatorTokenPath(),
      resolveManifestPath(),
    ]) {
      expect(resolved.startsWith(`${testHome}/`)).toBe(true);
      expect(resolved.startsWith(`${realHome}/`)).toBe(false);
    }
  });

  test("the preload overrides an inherited live-looking home in a child suite", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "surface-home-isolation-"));
    try {
      const inherited = join(sandbox, ".parachute");
      const probe = join(sandbox, "probe.test.ts");
      await Bun.write(
        probe,
        [
          `import { test } from "bun:test";`,
          `import { resolveCredentialsDir, writeCredential } from ${JSON.stringify(resolve(REPO_ROOT, "packages/surface-host/src/credential-store.ts"))};`,
          `test("default credential write", () => {`,
          `  console.log("RESOLVED=" + resolveCredentialsDir());`,
          `  console.log("HUB_TOKEN=" + process.env.PARACHUTE_HUB_TOKEN);`,
          `  writeCredential({ connection_id: "probe", key: "probe", vault: "probe", scope: "vault:probe:read", scoped_tags: [], token: "secret", jti: "probe", expires_at: "2099-01-01T00:00:00.000Z", renew_path: "/admin/connections/probe/renew", status: "ok", updated_at: "2026-08-24T00:00:00.000Z" });`,
          "});",
        ].join("\n"),
      );

      const proc = Bun.spawn(["bun", "test", probe], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: sandbox,
          PARACHUTE_HOME: inherited,
          PARACHUTE_HUB_TOKEN: "live-looking-token",
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = stdout + stderr;

      expect(exitCode).toBe(0);
      expect(output).toContain("RESOLVED=");
      expect(output).toContain("HUB_TOKEN=\n");
      expect(output).not.toContain("HUB_TOKEN=live-looking-token");
      expect(output).not.toContain(`RESOLVED=${join(inherited, "surface", "credentials")}`);
      expect(existsSync(inherited)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("a test process without the preload refuses the real fallback", async () => {
    const probe = [
      "delete process.env.PARACHUTE_HOME;",
      'process.env.NODE_ENV = "test";',
      `const { resolveCredentialsDir } = await import(${JSON.stringify(resolve(REPO_ROOT, "packages/surface-host/src/credential-store.ts"))});`,
      "console.log(resolveCredentialsDir());",
    ].join("\n");
    const proc = Bun.spawn(["bun", "-e", probe], {
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PARACHUTE_HOME: undefined, HOME: homedir(), NODE_ENV: "test" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toContain("refusing to resolve test state inside the live install");
  });
});
