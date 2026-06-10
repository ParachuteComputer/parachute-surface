/**
 * URL-tarball source support for `POST /surface/add` + `POST /surface/inspect`
 * (R3b — the third source kind, alongside local paths and npm specs).
 *
 * The operator points at a `.tgz`/`.tar.gz` (an `npm pack` artifact, a GitHub
 * release asset, a CI build output). The flow is deliberately simple:
 *
 *   1. Download to a staging temp dir with a STREAMING SIZE CAP (default
 *      64 MiB) — the body is read incrementally and aborted the moment the
 *      cap is crossed, so a hostile/looping endpoint can't fill the disk.
 *   2. Content-type sanity: reject `text/html` and `text/plain` outright
 *      (the "you downloaded an error page / a login redirect" footgun) —
 *      anything else (gzip, x-tar, octet-stream, missing header) proceeds;
 *      the tar extraction is the real arbiter.
 *   3. Extract with the system `tar` (`tar -xzf`) into `staging/extract/`,
 *      through the same injectable spawn seam npm-fetch uses.
 *   4. Locate the package root: the extract dir itself when it holds
 *      `dist/index.html`, else a SINGLE top-level directory (npm tarballs
 *      nest everything under `package/`).
 *   5. Validate `dist/index.html`; surface the sibling `meta.json` when present.
 *
 * Transport rule: `https://` always; `http://` only for loopback hosts
 * (127.0.0.1 / localhost / [::1]) — a dev convenience that never sends a
 * bundle-fetch over plaintext to a remote host.
 *
 * Same contract as `fetchNpmPackage`: errors clean up their own staging dir;
 * the success path returns a `cleanup()` the caller runs in a `finally`.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { NpmSpawnFn } from "./npm-fetch.ts";

/** Default streaming download cap — generous for an SPA bundle. */
export const DEFAULT_URL_MAX_BYTES = 64 * 1024 * 1024;

/** Content types that are definitely NOT a tarball — fail fast with a clear message. */
const REJECTED_CONTENT_TYPES = ["text/html", "text/plain", "application/json", "text/css"];

export class UrlFetchError extends Error {
  override name = "UrlFetchError" as const;
  readonly code:
    | "bad_url"
    | "insecure_url"
    | "http_error"
    | "bad_content_type"
    | "too_large"
    | "network_error"
    | "extract_failed"
    | "no_dist"
    | "staging_failed";
  readonly httpStatus?: number;
  readonly retryHint?: string;
  constructor(
    message: string,
    code: UrlFetchError["code"],
    extra: { httpStatus?: number; retryHint?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = extra.httpStatus;
    this.retryHint = extra.retryHint;
  }
}

/**
 * Is this `source` string a URL source? (Routing predicate for the add /
 * inspect flows — anything `http(s)://` goes through `fetchUrlTarball`,
 * never the path/npm branches.)
 */
export function looksLikeUrlSource(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** Loopback hosts where plain `http://` is acceptable (dev convenience). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export type UrlFetchOpts = {
  /** The `http(s)://...` source URL. */
  url: string;
  /** Streaming download cap in bytes. Default {@link DEFAULT_URL_MAX_BYTES}. */
  maxBytes?: number;
  /** Override the staging-dir parent (tests). Defaults to `os.tmpdir()`. */
  stagingParent?: string;
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injected spawner for `tar` (tests). Same seam shape as npm-fetch. */
  spawnFn?: NpmSpawnFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type UrlFetchResult = {
  /** Absolute path to the staging dir (caller is responsible for cleanup). */
  stagingDir: string;
  /** Absolute path to the extracted package root. */
  packageRoot: string;
  /** Absolute path to `dist/` within the package root. */
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
 * Download + extract a URL tarball. On error the staging dir is cleaned up
 * before the throw; on success the caller runs `result.cleanup()` in a
 * `finally` — exactly `fetchNpmPackage`'s contract.
 */
export async function fetchUrlTarball(opts: UrlFetchOpts): Promise<UrlFetchResult> {
  const logger = opts.logger ?? console;
  const fetchFn = opts.fetchFn ?? fetch;
  const spawn = opts.spawnFn ?? DEFAULT_SPAWN;
  const maxBytes = opts.maxBytes ?? DEFAULT_URL_MAX_BYTES;
  const stagingParent = opts.stagingParent ?? os.tmpdir();

  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new UrlFetchError(`"${opts.url}" is not a valid URL`, "bad_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UrlFetchError(`URL scheme must be http(s), got "${parsed.protocol}"`, "bad_url");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new UrlFetchError(
      `plain http:// is only allowed for loopback hosts — use https:// for ${parsed.hostname}`,
      "insecure_url",
    );
  }

  let stagingDir: string;
  try {
    stagingDir = mkdtempSync(path.join(stagingParent, "parachute-surface-url-"));
  } catch (e) {
    throw new UrlFetchError(
      `failed to create staging directory: ${(e as Error).message}`,
      "staging_failed",
    );
  }
  const cleanup = (): void => {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`[surface-url] failed to clean up ${stagingDir}: ${(e as Error).message}`);
    }
  };

  // --- Download (streaming, capped). ---------------------------------------
  let res: Response;
  try {
    res = await fetchFn(opts.url, { redirect: "follow" });
  } catch (e) {
    cleanup();
    throw new UrlFetchError(`download failed: ${(e as Error).message}`, "network_error", {
      retryHint: "check the URL is reachable from this host and retry",
    });
  }
  if (!res.ok) {
    cleanup();
    throw new UrlFetchError(
      `the server returned HTTP ${res.status} for ${opts.url}`,
      "http_error",
      {
        httpStatus: res.status,
      },
    );
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "" && REJECTED_CONTENT_TYPES.includes(contentType)) {
    cleanup();
    throw new UrlFetchError(
      `the URL returned content-type "${contentType}" — that's a document, not a tarball (expected gzip/tar/octet-stream)`,
      "bad_content_type",
      { retryHint: "point at the .tgz asset itself, not a download page" },
    );
  }
  // Early reject on a declared oversize body (still re-checked while streaming).
  const declaredLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cleanup();
    throw new UrlFetchError(
      `tarball is ${declaredLength} bytes — over the ${maxBytes}-byte cap`,
      "too_large",
    );
  }

  const tarballPath = path.join(stagingDir, "bundle.tgz");
  try {
    const body = res.body;
    if (!body) {
      cleanup();
      throw new UrlFetchError("the response carried no body", "network_error");
    }
    const out = createWriteStream(tarballPath);
    let written = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The download is being abandoned either way.
          }
          throw new UrlFetchError(
            `download exceeded the ${maxBytes}-byte cap (aborted at ${written} bytes)`,
            "too_large",
          );
        }
        await new Promise<void>((resolve, reject) => {
          out.write(value, (err) => (err ? reject(err) : resolve()));
        });
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
  } catch (e) {
    cleanup();
    if (e instanceof UrlFetchError) throw e;
    throw new UrlFetchError(`download failed mid-stream: ${(e as Error).message}`, "network_error");
  }

  // --- Extract. -------------------------------------------------------------
  const extractDir = path.join(stagingDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  let tarResult: Awaited<ReturnType<NpmSpawnFn>>;
  try {
    tarResult = await spawn(["tar", "-xzf", tarballPath, "-C", extractDir], stagingDir);
  } catch (e) {
    cleanup();
    throw new UrlFetchError(`failed to spawn tar: ${(e as Error).message}`, "extract_failed", {
      retryHint: "ensure `tar` is on PATH",
    });
  }
  if (tarResult.exitCode !== 0) {
    cleanup();
    throw new UrlFetchError(
      `tar extraction failed (exit ${tarResult.exitCode}): ${tarResult.stderr.slice(0, 300)}`,
      "extract_failed",
      { retryHint: "the URL must point at a gzipped tarball (.tgz / .tar.gz)" },
    );
  }

  // --- Locate the package root + dist/. --------------------------------------
  const packageRoot = locatePackageRoot(extractDir);
  const distPath = path.join(packageRoot, "dist");
  if (!existsSync(path.join(distPath, "index.html"))) {
    cleanup();
    throw new UrlFetchError(
      "the tarball doesn't contain dist/index.html (looked at the archive root and a single top-level directory)",
      "no_dist",
      {
        retryHint:
          "the archive should hold a package with a `dist/` directory containing index.html — an `npm pack` artifact has this shape",
      },
    );
  }

  const metaJsonPath = path.join(packageRoot, "meta.json");
  return {
    stagingDir,
    packageRoot,
    distPath,
    metaJsonPath: existsSync(metaJsonPath) ? metaJsonPath : undefined,
    cleanup,
  };
}

/**
 * The extract dir itself when it holds `dist/index.html`; otherwise a single
 * top-level directory (npm tarballs nest under `package/`). Falls back to the
 * extract dir — the caller's `dist/index.html` check produces the error.
 */
function locatePackageRoot(extractDir: string): string {
  if (existsSync(path.join(extractDir, "dist", "index.html"))) return extractDir;
  const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && !e.name.startsWith("."),
  );
  if (entries.length === 1) return path.join(extractDir, entries[0]!.name);
  return extractDir;
}
