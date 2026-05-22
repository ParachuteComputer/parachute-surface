/**
 * HTTP surface for `parachute-app serve` — Phase 1.1.
 *
 * Phase 1.1 ships core UI hosting: discovery + mount + SPA fallback + smart
 * cache headers + PWA opt-in. Admin endpoints (`POST /app/add`,
 * `DELETE /app/<name>`, OAuth DCR, the admin SPA) land in Phase 1.2; the
 * routing shape below leaves a clean seam to drop them in.
 *
 * Endpoints (Phase 1.1):
 *   - GET /healthz, GET /app/healthz                  — liveness, open
 *   - GET /.parachute/info                            — module identity (open)
 *   - GET /.parachute/config/schema                   — Draft-07 schema (open)
 *   - GET /.parachute/config                          — current config (open;
 *                                                       no secrets in app config)
 *   - GET /<meta.path>/[anything]                     — per-UI bundle serving
 *
 * Per-UI routing:
 *   - GET /<meta.path>/                               — serves `dist/index.html`
 *   - GET /<meta.path>                                — same (no-trailing-slash variant)
 *   - GET /<meta.path>/<asset>                        — serves `dist/<asset>` if it exists
 *   - GET /<meta.path>/<anything-else>                — SPA fallback: serves `dist/index.html`
 *
 * SPA fallback discipline: any URL under `<meta.path>` that doesn't resolve
 * to a file in `dist/` serves `index.html` with the no-cache headers.
 * Client-side routers (React Router, hash routing, BrowserRouter) all
 * benefit. Asset extensions that would normally 404 (a missing `.png`)
 * still serve index.html — the bundle decides whether to render a 404 page
 * or fall through to the router. That tradeoff matches design doc section 9.
 *
 * Hostname defaults to `127.0.0.1` (loopback-only) — same security posture
 * as runner. Hub forwards `/app/*` traffic from the public origin.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { cacheHeadersFor } from "./cache-headers.ts";
import { type AppConfig, loadConfig } from "./config.ts";
import type { UiMeta } from "./meta-schema.ts";
import { type RegisteredUi, scanUis } from "./ui-registry.ts";

export type AppState = {
  /** Currently-resolved config. Phase 1.2 PUTs will mutate this in place. */
  config: AppConfig;
  /** Mounted UIs. Phase 1.2's `reload` will swap this list. */
  registeredUis: RegisteredUi[];
  /**
   * Skipped UIs from the last scan — surfaced in `/app/healthz`'s diagnostic
   * payload so operators can spot broken UIs without leaving the daemon.
   */
  skippedUis: Array<{ dirName: string; status: string; reason: string }>;
};

export type HttpServerOpts = {
  /** Mutable state. */
  state: AppState;
  /** Bind port. Use 0 in tests to let the OS pick. */
  port: number;
  /** Process start time, for `/healthz` uptime. */
  startedAt: Date;
  /**
   * Bind address. Defaults to `127.0.0.1` — loopback-only because the admin
   * endpoints (Phase 1.2) leak state. Hub forwards `/app/*` over loopback.
   */
  hostname?: string;
  /** Override for tests — defaults to `Bun.serve`. */
  serveFn?: typeof Bun.serve;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Override the `.parachute/` manifest dir. Defaults to the repo's
   * `.parachute/` next to `package.json`. Tests inject a tmpdir.
   */
  parachuteDir?: string;
};

/**
 * Spin up the app HTTP server. Returns the running Bun.Server so the CLI
 * can `server.stop()` during graceful shutdown.
 */
export function startHttpServer(opts: HttpServerOpts): ReturnType<typeof Bun.serve> {
  const { port, startedAt } = opts;
  const hostname = opts.hostname ?? "127.0.0.1";
  const serve = opts.serveFn ?? Bun.serve;
  const parachuteDir = opts.parachuteDir ?? defaultParachuteDir();
  const logger = opts.logger ?? console;

  return serve({
    port,
    hostname,
    fetch: (req) => handle(req, opts.state, { startedAt, parachuteDir, logger }),
  });
}

type HandleCtx = {
  startedAt: Date;
  parachuteDir: string;
  logger: Pick<Console, "log" | "warn" | "error">;
};

function handle(req: Request, state: AppState, ctx: HandleCtx): Response {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // Only GETs (and HEADs for static asset probes) for Phase 1.1. Phase 1.2
  // adds POST/PUT/DELETE for admin endpoints.
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // /healthz: open, both with and without /app prefix so hub-as-supervisor
  // (forwards via /app) and direct localhost probes both work.
  if (pathname === "/healthz" || pathname === "/app/healthz") {
    return Response.json({
      status: "ok",
      uis: state.registeredUis.length,
      skipped: state.skippedUis.length,
      uptime_seconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    });
  }

  // .parachute/* — module-protocol surface, open (no secrets in app config).
  if (pathname === "/.parachute/info") {
    return serveStaticFile(path.join(ctx.parachuteDir, "info"), "application/json");
  }
  if (pathname === "/.parachute/config/schema") {
    return serveStaticFile(path.join(ctx.parachuteDir, "config", "schema"), "application/json");
  }
  if (pathname === "/.parachute/config") {
    return Response.json(state.config);
  }

  // Per-UI mount paths. Find the matching UI (longest mount-path wins,
  // though Phase 1.1's PATH_PATTERN constrains mounts to single-segment
  // so there's no overlap in practice — the longest-prefix loop is
  // forward-defensive for Phase 2's multi-segment relaxation).
  const ui = matchUi(pathname, state.registeredUis);
  if (ui) {
    return serveUiAsset(req, ui, pathname);
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Find the UI whose mount path is a prefix of `pathname`. Longest-prefix
 * wins so a UI at `/app/foo-bar` doesn't shadow `/app/foo` — though the
 * current PATH_PATTERN forbids that exact case, the search shape is
 * forward-defensive.
 */
function matchUi(pathname: string, uis: ReadonlyArray<RegisteredUi>): RegisteredUi | undefined {
  let best: RegisteredUi | undefined;
  for (const ui of uis) {
    const mount = ui.meta.path;
    if (pathname === mount || pathname.startsWith(`${mount}/`)) {
      if (!best || ui.meta.path.length > best.meta.path.length) best = ui;
    }
  }
  return best;
}

/**
 * Serve an asset for a registered UI. The flow:
 *
 *   1. If `pathname === meta.path` or `pathname === meta.path + "/"`, serve
 *      `dist/index.html` (the root document).
 *   2. Otherwise compute the relative path after `meta.path/`. If the file
 *      exists under `dist/`, serve it with content-type + cache headers.
 *   3. If it doesn't exist (SPA-routing case), serve `dist/index.html` with
 *      the no-cache headers — the client-side router decides what to render.
 *
 * Path traversal: `path.resolve(distDir, rel)` is checked against `distDir`
 * via a containment test (`resolved.startsWith(distDir + path.sep)`). Any
 * attempt to escape (`../etc/passwd`) gets a 404. Bun's URL parser
 * already collapses `..` segments but the explicit check is the load-bearing
 * line — defense in depth.
 */
function serveUiAsset(req: Request, ui: RegisteredUi, pathname: string): Response {
  const mount = ui.meta.path;
  const distDir = ui.distDir;
  const indexHtmlPath = path.join(distDir, "index.html");

  // Root document: /app/foo or /app/foo/
  if (pathname === mount || pathname === `${mount}/`) {
    return serveFileWithHeaders(req, indexHtmlPath, "index.html", ui.meta);
  }

  // Strip the mount prefix; rel is the path within dist/.
  const rel = pathname.slice(mount.length + 1); // +1 to drop the leading '/'
  // Defense in depth: reject any explicit traversal segments before resolve.
  if (rel.includes("\0") || rel.split("/").some((seg) => seg === "..")) {
    // Fall through to SPA fallback — the bundle's router handles unknown routes.
    return serveFileWithHeaders(req, indexHtmlPath, "index.html", ui.meta);
  }

  const resolved = path.resolve(distDir, rel);
  // Containment check — the resolved path must live under distDir.
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) {
    return serveFileWithHeaders(req, indexHtmlPath, "index.html", ui.meta);
  }

  if (existsSync(resolved)) {
    try {
      const st = statSync(resolved);
      if (st.isFile()) {
        const basename = path.basename(resolved);
        return serveFileWithHeaders(req, resolved, basename, ui.meta);
      }
    } catch {
      // Race with file deletion — fall through to SPA fallback.
    }
  }

  // SPA fallback: serve index.html with no-cache headers so the router runs
  // on a fresh document.
  return serveFileWithHeaders(req, indexHtmlPath, "index.html", ui.meta);
}

/**
 * Read a file from disk and wrap it with content-type + cache headers.
 * Returns 404 if the file is unreadable — caller passes a path it already
 * stat'd, so the only realistic 404 is a race with deletion mid-request.
 */
function serveFileWithHeaders(
  req: Request,
  filePath: string,
  filenameForHeaders: string,
  meta: UiMeta,
): Response {
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (e) {
    return new Response(`Not Found: ${(e as Error).message}`, { status: 404 });
  }
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(filenameForHeaders),
    ...cacheHeadersFor(filenameForHeaders, meta),
  };
  if (req.method === "HEAD") {
    // HEAD: include Content-Length but no body.
    headers["content-length"] = String(body.length);
    return new Response(null, { status: 200, headers });
  }
  // Bun's Response accepts Buffer / Uint8Array / ArrayBuffer interchangeably;
  // pass the Buffer directly.
  return new Response(body, { status: 200, headers });
}

/**
 * Minimal content-type table — the common SPA bundle assets. Falls through
 * to application/octet-stream for anything not listed. Operators can override
 * via meta.json `cache_headers` extension in Phase 2 (designed-but-not-shipped);
 * for MVP this table covers Vite's default output.
 */
function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".map":
      return "application/json; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".webmanifest":
      return "application/manifest+json";
    default:
      return "application/octet-stream";
  }
}

function serveStaticFile(filePath: string, contentType: string): Response {
  try {
    const body = readFileSync(filePath, "utf8");
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "not_found", message: `${filePath}: ${(e as Error).message}` }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
}

/**
 * Default location of `.parachute/` relative to the installed package.
 * The files we serve (info, config/schema) are checked into the npm
 * package via `package.json#files`.
 */
function defaultParachuteDir(): string {
  return path.resolve(import.meta.dir, "..", ".parachute");
}

/**
 * Force-load the app config — used by callers that want defaults applied
 * without going through the full daemon boot path (e.g. CI healthchecks).
 */
export function loadOrDefaultConfig(opts: Parameters<typeof loadConfig>[0] = {}): AppConfig {
  return loadConfig(opts);
}
