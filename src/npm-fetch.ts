/**
 * npm-fetch shorthand for `POST /app/add`.
 *
 * When the operator passes `source: "@openparachute/notes-ui"` (or any npm
 * specifier matching `(@scope/)?name(@version)?`), apps runs `bun add <spec>`
 * into a staging temp dir, copies the package's `dist/` into the UI's home
 * under `~/.parachute/app/uis/<name>/dist/`, and copies `meta.json` if the
 * package ships one.
 *
 * The flow per design doc section 4:
 *   1. Make a fresh staging dir under `/tmp/parachute-app-staging-<random>`.
 *   2. Initialize a minimal `package.json` so `bun add` has somewhere to
 *      write. `bun add` requires a package.json in the cwd.
 *   3. `bun add <spec>` — this fetches + installs into `staging/node_modules/`.
 *   4. Locate the installed package: `staging/node_modules/<pkg-from-spec>`.
 *   5. Validate the package has `dist/index.html` (the bundle).
 *   6. Return path-pointers the caller copies + cleans up.
 *
 * Failure modes:
 *   - Spec doesn't match the npm naming pattern → `NpmFetchError` `code: "bad_spec"`.
 *   - `bun add` exits non-zero → `code: "fetch_failed"` carrying stderr.
 *   - Installed package has no `dist/` → `code: "no_dist"`.
 *
 * The caller (admin-routes `/app/add`) cleans up the staging dir in a
 * `finally` regardless of outcome.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Regex matching valid npm package specifiers, with optional `@version` tail. */
export const NPM_SPEC_PATTERN = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/;

export class NpmFetchError extends Error {
  override name = "NpmFetchError" as const;
  readonly code:
    | "bad_spec"
    | "fetch_failed"
    | "not_found"
    | "no_dist"
    | "network_error"
    | "staging_failed";
  readonly stderr?: string;
  readonly retryHint?: string;
  constructor(
    message: string,
    code: NpmFetchError["code"],
    extra: { stderr?: string; retryHint?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.stderr = extra.stderr;
    this.retryHint = extra.retryHint;
  }
}

/**
 * Parse an npm spec into its package name + optional version.
 *
 * Returns `undefined` if the spec doesn't look like an npm package (caller
 * should fall through to local-path handling). Examples that pass:
 *   - `notes-ui`
 *   - `@openparachute/notes-ui`
 *   - `@openparachute/notes-ui@0.1.2`
 *   - `@openparachute/notes-ui@latest`
 *
 * Examples that don't pass (caller treats as local path):
 *   - `./foo`        (relative path, has `/`)
 *   - `/tmp/foo`     (absolute path, leading `/`)
 *   - `foo/bar/baz`  (too many segments — not a scope)
 *
 * The pattern distinguishes spec-vs-path via "starts with `@` or contains no
 * `/`" — a single `/` after a `@scope` is part of an npm name, otherwise a
 * `/` means filesystem path.
 */
export function parseNpmSpec(spec: string): { pkg: string; version?: string } | undefined {
  if (spec.length === 0) return undefined;
  // Local-path heuristic: starts with `.` or `/`, or contains an internal
  // `/` without a leading `@`.
  if (spec.startsWith(".") || spec.startsWith("/")) return undefined;
  const m = NPM_SPEC_PATTERN.exec(spec);
  if (!m) return undefined;
  return { pkg: m[1]!, version: m[2] };
}

export type NpmFetchOpts = {
  /** The spec. `parseNpmSpec` is called internally; an invalid spec throws `NpmFetchError`. */
  spec: string;
  /** Override the staging-dir parent (tests). Defaults to `os.tmpdir()`. */
  stagingParent?: string;
  /**
   * Override the spawner (tests). Receives the full argv array and returns
   * `{exitCode, stderr}`. Defaults to `Bun.spawn`.
   */
  spawnFn?: NpmSpawnFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/** Shape `Bun.spawn`-equivalent test mocks need to fulfill. */
export type NpmSpawnFn = (
  argv: string[],
  cwd: string,
) => Promise<{ exitCode: number; stderr: string; stdout: string }>;

export type NpmFetchResult = {
  /** The parsed spec. */
  pkg: string;
  version?: string;
  /** Absolute path to the staging dir (caller is responsible for cleanup). */
  stagingDir: string;
  /** Absolute path to `staging/node_modules/<pkg>/`. */
  installedPath: string;
  /** Absolute path to `dist/` within the installed package. */
  distPath: string;
  /** Absolute path to `meta.json` if present (sibling of `dist/`); else undefined. */
  metaJsonPath?: string;
  /** Cleanup the staging dir. Safe to call multiple times. */
  cleanup: () => void;
};

const DEFAULT_SPAWN: NpmSpawnFn = async (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stderr, stdout };
};

/**
 * Fetch + extract an npm package. Returns paths the caller copies into the
 * UI's home; the caller MUST call `result.cleanup()` (typically in a
 * `finally`) regardless of outcome.
 *
 * On error: the staging dir is cleaned up before the throw, so callers don't
 * have to wrap every `try` with a `finally` of their own. (The returned
 * `result.cleanup` is for the success path.)
 */
export async function fetchNpmPackage(opts: NpmFetchOpts): Promise<NpmFetchResult> {
  const logger = opts.logger ?? console;
  const spawn = opts.spawnFn ?? DEFAULT_SPAWN;
  const stagingParent = opts.stagingParent ?? os.tmpdir();

  const parsed = parseNpmSpec(opts.spec);
  if (!parsed) {
    throw new NpmFetchError(
      `\"${opts.spec}\" is not a valid npm package specifier (expected name, @scope/name, or @scope/name@version)`,
      "bad_spec",
    );
  }
  const { pkg, version } = parsed;
  const specForBunAdd = version ? `${pkg}@${version}` : pkg;

  // Staging dir. mkdtempSync gives us a unique name; we own it for the
  // remainder of the operation.
  let stagingDir: string;
  try {
    stagingDir = mkdtempSync(path.join(stagingParent, "parachute-app-staging-"));
  } catch (e) {
    throw new NpmFetchError(
      `failed to create staging directory: ${(e as Error).message}`,
      "staging_failed",
    );
  }
  const cleanup = (): void => {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[app-npm] failed to clean up ${stagingDir}: ${(e as Error).message}`);
    }
  };

  // Seed a minimal package.json so `bun add` has something to write.
  try {
    writeFileSync(
      path.join(stagingDir, "package.json"),
      `${JSON.stringify({ name: "parachute-app-staging", version: "0.0.0", private: true }, null, 2)}\n`,
    );
  } catch (e) {
    cleanup();
    throw new NpmFetchError(
      `failed to seed staging package.json: ${(e as Error).message}`,
      "staging_failed",
    );
  }

  // `bun add <spec>` — install into the staging dir.
  // `--ignore-scripts` prevents malicious `postinstall` (et al.) hooks in the
  // fetched package or any of its deps from executing arbitrary code in the
  // daemon's process context. We only need the package's `dist/` output, not
  // any install-time codegen.
  let spawnResult: Awaited<ReturnType<NpmSpawnFn>>;
  try {
    spawnResult = await spawn(["bun", "add", "--ignore-scripts", specForBunAdd], stagingDir);
  } catch (e) {
    cleanup();
    throw new NpmFetchError(`failed to spawn bun: ${(e as Error).message}`, "network_error", {
      retryHint: "ensure `bun` is on PATH",
    });
  }

  if (spawnResult.exitCode !== 0) {
    const stderr = spawnResult.stderr;
    cleanup();

    // Distinguish 404 (package doesn't exist) from generic install failures
    // by sniffing stderr — bun's error messages are stable.
    const looks404 =
      /404\b/.test(stderr) ||
      /not found/i.test(stderr) ||
      /no matching version/i.test(stderr) ||
      /no versions available/i.test(stderr);
    const looksNetwork =
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|EAI_AGAIN/i.test(stderr) ||
      /network error/i.test(stderr) ||
      /failed to connect/i.test(stderr);
    const code: NpmFetchError["code"] = looks404
      ? "not_found"
      : looksNetwork
        ? "network_error"
        : "fetch_failed";
    const retryHint = looksNetwork
      ? "check your network connection or registry config and retry"
      : looks404
        ? `verify the package name + version exist on npm: \`npm view ${specForBunAdd}\``
        : undefined;
    throw new NpmFetchError(
      `\`bun add ${specForBunAdd}\` failed (exit ${spawnResult.exitCode})`,
      code,
      { stderr, retryHint },
    );
  }

  const installedPath = path.join(stagingDir, "node_modules", pkg);
  if (!existsSync(installedPath)) {
    cleanup();
    throw new NpmFetchError(
      `bun reported success but ${installedPath} doesn't exist — registry shape unexpected`,
      "fetch_failed",
    );
  }

  // Locate the dist/ inside the installed package. Per the convention
  // (Notes' published `@openparachute/notes-ui` will be the canonical
  // example), the bundle lives at `<pkg>/dist/`.
  const distPath = path.join(installedPath, "dist");
  if (!existsSync(distPath)) {
    cleanup();
    throw new NpmFetchError(
      `package ${specForBunAdd} doesn't contain a dist/ directory — not a parachute-app-shaped UI bundle`,
      "no_dist",
      {
        retryHint:
          "the package should publish a `dist/` directory containing `index.html`; ask the maintainer or build locally + `parachute-app add ./path/to/dist`",
      },
    );
  }
  if (!existsSync(path.join(distPath, "index.html"))) {
    cleanup();
    throw new NpmFetchError(
      `package ${specForBunAdd} has dist/ but no index.html — not a valid SPA bundle`,
      "no_dist",
    );
  }

  // Sibling meta.json is optional — the caller falls back to body-provided
  // values when missing.
  const metaJsonPath = path.join(installedPath, "meta.json");
  const metaJsonPathResolved = existsSync(metaJsonPath) ? metaJsonPath : undefined;

  return {
    pkg,
    version,
    stagingDir,
    installedPath,
    distPath,
    metaJsonPath: metaJsonPathResolved,
    cleanup,
  };
}

/**
 * Recursive copy of `srcDir` to `destDir`. Replaces destDir if it exists.
 * Mirror of `cp -r src/. dest/` semantics. Used by `POST /app/add` to copy
 * the staged dist into the UI's permanent home.
 */
export function copyDir(srcDir: string, destDir: string): void {
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });
  copyDirInner(srcDir, destDir);
}

function copyDirInner(src: string, dest: string): void {
  for (const entry of readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyDirInner(s, d);
    } else if (st.isFile()) {
      copyFileSync(s, d);
    }
    // Skip symlinks + other entries — keep the bundle to plain files.
  }
}
