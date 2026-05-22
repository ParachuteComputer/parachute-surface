/**
 * Tests for `src/npm-fetch.ts`.
 *
 * Coverage:
 *   - parseNpmSpec recognizes scoped + plain + versioned + invalid forms
 *   - parseNpmSpec rejects local-path-shaped strings
 *   - fetchNpmPackage seeds staging, runs `bun add`, returns dist path
 *   - fetchNpmPackage cleanup() removes staging dir
 *   - fetchNpmPackage bun add exit-non-zero → NpmFetchError fetch_failed
 *   - fetchNpmPackage 404-shaped stderr → code:'not_found'
 *   - fetchNpmPackage network-shaped stderr → code:'network_error'
 *   - fetchNpmPackage missing dist/ → code:'no_dist'
 *   - fetchNpmPackage missing dist/index.html → code:'no_dist'
 *   - copyDir does a recursive copy + handles nested dirs
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NpmFetchError,
  type NpmSpawnFn,
  copyDir,
  fetchNpmPackage,
  parseNpmSpec,
} from "../npm-fetch.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let stagingParent: string;

beforeEach(() => {
  stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), "app-npm-parent-"));
});
afterEach(() => {
  fs.rmSync(stagingParent, { recursive: true, force: true });
});

describe("parseNpmSpec", () => {
  test("plain name", () => {
    expect(parseNpmSpec("notes-ui")).toEqual({ pkg: "notes-ui" });
  });
  test("scoped name", () => {
    expect(parseNpmSpec("@openparachute/notes-ui")).toEqual({ pkg: "@openparachute/notes-ui" });
  });
  test("with version", () => {
    expect(parseNpmSpec("@openparachute/notes-ui@0.1.2")).toEqual({
      pkg: "@openparachute/notes-ui",
      version: "0.1.2",
    });
  });
  test("with `latest` tag", () => {
    expect(parseNpmSpec("@openparachute/notes-ui@latest")).toEqual({
      pkg: "@openparachute/notes-ui",
      version: "latest",
    });
  });
  test("local path → undefined", () => {
    expect(parseNpmSpec("./foo")).toBeUndefined();
    expect(parseNpmSpec("/tmp/foo")).toBeUndefined();
  });
  test("empty / invalid → undefined", () => {
    expect(parseNpmSpec("")).toBeUndefined();
    expect(parseNpmSpec("@no-version-no-name@1.2.3")).toBeUndefined();
  });
});

/** Build a fake spawn that emulates bun-add by writing dist/ on success. */
function makeFakeSpawn(opts: {
  exitCode?: number;
  stderr?: string;
  writeDist?: { content: Record<string, string>; pkg: string };
}): NpmSpawnFn {
  return async (argv, cwd) => {
    expect(argv[0]).toBe("bun");
    expect(argv[1]).toBe("add");
    if (opts.writeDist) {
      const installRoot = path.join(cwd, "node_modules", opts.writeDist.pkg);
      const distDir = path.join(installRoot, "dist");
      fs.mkdirSync(distDir, { recursive: true });
      for (const [name, body] of Object.entries(opts.writeDist.content)) {
        fs.writeFileSync(path.join(distDir, name), body);
      }
    }
    return {
      exitCode: opts.exitCode ?? 0,
      stderr: opts.stderr ?? "",
      stdout: "",
    };
  };
}

describe("fetchNpmPackage", () => {
  test("happy path: returns dist + cleanup", async () => {
    const spawn = makeFakeSpawn({
      writeDist: {
        pkg: "@openparachute/notes-ui",
        content: { "index.html": "<!doctype html><body>notes</body>" },
      },
    });
    const r = await fetchNpmPackage({
      spec: "@openparachute/notes-ui",
      stagingParent,
      spawnFn: spawn,
      logger: silentLogger,
    });
    expect(r.pkg).toBe("@openparachute/notes-ui");
    expect(r.version).toBeUndefined();
    expect(fs.existsSync(r.distPath)).toBe(true);
    expect(fs.existsSync(path.join(r.distPath, "index.html"))).toBe(true);
    // cleanup
    r.cleanup();
    expect(fs.existsSync(r.stagingDir)).toBe(false);
  });

  test("version is preserved + forwarded to bun add", async () => {
    let capturedArgv: string[] | undefined;
    const spawn: NpmSpawnFn = async (argv, cwd) => {
      capturedArgv = [...argv];
      fs.mkdirSync(path.join(cwd, "node_modules", "@openparachute", "notes-ui", "dist"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "@openparachute", "notes-ui", "dist", "index.html"),
        "<html></html>",
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const r = await fetchNpmPackage({
      spec: "@openparachute/notes-ui@0.1.2",
      stagingParent,
      spawnFn: spawn,
      logger: silentLogger,
    });
    expect(capturedArgv).toEqual(["bun", "add", "@openparachute/notes-ui@0.1.2"]);
    expect(r.version).toBe("0.1.2");
    r.cleanup();
  });

  test("bad spec → NpmFetchError code:'bad_spec'", async () => {
    const spawn = makeFakeSpawn({});
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "/local/path",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) expect(caught.code).toBe("bad_spec");
  });

  test("bun add exits non-zero generically → fetch_failed", async () => {
    const spawn = makeFakeSpawn({
      exitCode: 1,
      stderr: "error: install failed mysteriously",
    });
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "@openparachute/notes-ui",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) {
      expect(caught.code).toBe("fetch_failed");
      expect(caught.stderr).toContain("install failed");
    }
  });

  test("404-shaped stderr → code:'not_found'", async () => {
    const spawn = makeFakeSpawn({
      exitCode: 1,
      stderr: "error: 404 Not Found - @doesnt/exist",
    });
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "@doesnt/exist",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) expect(caught.code).toBe("not_found");
  });

  test("network-shaped stderr → code:'network_error'", async () => {
    const spawn = makeFakeSpawn({
      exitCode: 1,
      stderr: "error: getaddrinfo ENOTFOUND registry.npmjs.org",
    });
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "@foo/bar",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) expect(caught.code).toBe("network_error");
  });

  test("package missing dist/ → code:'no_dist'", async () => {
    const spawn: NpmSpawnFn = async (_argv, cwd) => {
      // Install the package but without a dist/ dir.
      fs.mkdirSync(path.join(cwd, "node_modules", "@foo", "bar"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, "node_modules", "@foo", "bar", "package.json"),
        JSON.stringify({ name: "@foo/bar" }),
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "@foo/bar",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) expect(caught.code).toBe("no_dist");
  });

  test("dist/ exists but no index.html → code:'no_dist'", async () => {
    const spawn: NpmSpawnFn = async (_argv, cwd) => {
      fs.mkdirSync(path.join(cwd, "node_modules", "@foo", "bar", "dist"), { recursive: true });
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    let caught: unknown;
    try {
      await fetchNpmPackage({
        spec: "@foo/bar",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NpmFetchError);
    if (caught instanceof NpmFetchError) expect(caught.code).toBe("no_dist");
  });

  test("staging dir is cleaned up after failure", async () => {
    let observedStagingDir: string | undefined;
    const spawn: NpmSpawnFn = async (_argv, cwd) => {
      observedStagingDir = cwd;
      return { exitCode: 1, stderr: "error: nope", stdout: "" };
    };
    try {
      await fetchNpmPackage({
        spec: "@foo/bar",
        stagingParent,
        spawnFn: spawn,
        logger: silentLogger,
      });
    } catch {}
    expect(observedStagingDir).toBeDefined();
    expect(fs.existsSync(observedStagingDir!)).toBe(false);
  });

  test("meta.json sibling is detected when present", async () => {
    const spawn: NpmSpawnFn = async (_argv, cwd) => {
      const root = path.join(cwd, "node_modules", "@foo", "bar");
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "dist", "index.html"), "<html></html>");
      fs.writeFileSync(
        path.join(root, "meta.json"),
        JSON.stringify({ name: "bar", displayName: "Bar", path: "/app/bar" }),
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const r = await fetchNpmPackage({
      spec: "@foo/bar",
      stagingParent,
      spawnFn: spawn,
      logger: silentLogger,
    });
    expect(r.metaJsonPath).toBeDefined();
    expect(fs.existsSync(r.metaJsonPath!)).toBe(true);
    r.cleanup();
  });
});

describe("copyDir", () => {
  test("copies files + nested dirs recursively", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "app-copy-src-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "app-copy-dest-"));
    try {
      fs.mkdirSync(path.join(src, "nested"), { recursive: true });
      fs.writeFileSync(path.join(src, "index.html"), "<html></html>");
      fs.writeFileSync(path.join(src, "nested", "main.js"), "console.log('hi')");
      fs.mkdirSync(path.join(src, "nested", "deep"), { recursive: true });
      fs.writeFileSync(path.join(src, "nested", "deep", "style.css"), "body{}");

      copyDir(src, path.join(dest, "out"));

      expect(fs.existsSync(path.join(dest, "out", "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "out", "nested", "main.js"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "out", "nested", "deep", "style.css"))).toBe(true);
      expect(fs.readFileSync(path.join(dest, "out", "index.html"), "utf8")).toBe("<html></html>");
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  test("replaces existing destination", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "app-copy-src-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "app-copy-dest-"));
    try {
      fs.writeFileSync(path.join(src, "new.js"), "new");
      const destOut = path.join(dest, "out");
      fs.mkdirSync(destOut, { recursive: true });
      fs.writeFileSync(path.join(destOut, "stale.js"), "stale");

      copyDir(src, destOut);

      expect(fs.existsSync(path.join(destOut, "new.js"))).toBe(true);
      expect(fs.existsSync(path.join(destOut, "stale.js"))).toBe(false);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
