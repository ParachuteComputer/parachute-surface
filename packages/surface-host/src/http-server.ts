/**
 * HTTP surface for `parachute-surface serve` — Phase 1.1.
 *
 * Phase 1.1 ships core UI hosting: discovery + mount + SPA fallback + smart
 * cache headers + PWA opt-in. Admin endpoints (`POST /surface/add`,
 * `DELETE /surface/<name>`, OAuth DCR, the admin SPA) land in Phase 1.2; the
 * routing shape below leaves a clean seam to drop them in.
 *
 * Endpoints (Phase 1.1):
 *   - GET /healthz, GET /surface/healthz                  — liveness, open
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
 * as runner. Hub forwards `/surface/*` traffic from the public origin.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { type AdminHandlerOpts, routeAdmin } from "./admin-routes.ts";
import { getHubOrigin } from "./auth.ts";
import { type SurfaceWsData, createSurfaceWsHandlers } from "./backend-ws.ts";
import { cacheHeadersFor } from "./cache-headers.ts";
import { type AppConfig, loadConfig } from "./config.ts";
import { injectDevReloadScript } from "./dev-injection.ts";
import { isDevMode } from "./dev-mode.ts";
import { type DevRoutesOpts, routeDev } from "./dev-routes.ts";
import { clientIpFromRequest, layerFromRequest } from "./host-context.ts";
import type { UiMeta } from "./meta-schema.ts";
import { applySecurityHeaders } from "./security-headers.ts";
import { injectTenancyContract } from "./tenancy-injection.ts";
import { type RegisteredUi, scanUis } from "./ui-registry.ts";

export type AppState = {
  /** Currently-resolved config. Phase 1.2 PUTs will mutate this in place. */
  config: AppConfig;
  /** Mounted UIs. Phase 1.2's `reload` will swap this list. */
  registeredUis: RegisteredUi[];
  /**
   * Skipped UIs from the last scan — surfaced in `/surface/healthz`'s diagnostic
   * payload so operators can spot broken UIs without leaving the daemon.
   */
  skippedUis: Array<{ dirName: string; status: string; reason: string }>;
  /**
   * Backend supervisor for BACKED surfaces (surface-runtime P5). Absent in
   * contexts that never mount backends (runOnce, most unit tests) — status
   * reads fall back to "backend-error" for declared-but-unmounted servers.
   */
  backends?: import("./backend-supervisor.ts").BackendSupervisor;
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
   * endpoints (Phase 1.2) leak state. Hub forwards `/surface/*` over loopback.
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
  /**
   * Override the absolute path to the `dist/admin/` directory that holds the
   * built admin SPA. Tests inject a tmpdir with a fake index.html. Production
   * resolves to `<package-root>/dist/admin/` via `defaultAdminDir()`.
   */
  adminDir?: string;
  /**
   * Phase 1.2 admin-route handlers need a couple of side-channel hooks
   * (tests inject the uis-dir, services.json path, npm-spawn, fetch). The
   * server exposes them so callers don't have to thread them in by hand.
   */
  adminOpts?: Omit<AdminHandlerOpts, "state">;
  /**
   * Phase 1.3 dev-route opts (test seam for enforceScope override).
   */
  devOpts?: Omit<DevRoutesOpts, "state">;
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

  const adminDir = opts.adminDir ?? defaultAdminDir();
  const adminOpts = opts.adminOpts ?? {};
  const devOpts = opts.devOpts ?? {};
  return serve({
    port,
    hostname,
    fetch: (req, server) =>
      handle(req, opts.state, {
        startedAt,
        parachuteDir,
        logger,
        adminDir,
        adminOpts,
        devOpts,
        server,
      }),
    // Backed-surface WebSocket multiplexing (P4): one handler set serves
    // every surface; per-connection data carries the owning surface +
    // trust signals captured at upgrade time. Dispatch (in `handle`) only
    // upgrades `${mount}/ws` for capability-declaring surfaces with a
    // mounted backend — deny-by-default, mirroring the hub bridge.
    websocket: createSurfaceWsHandlers({
      getSupervisor: () => opts.state.backends,
      logger,
    }),
  });
}

/** Narrow upgrade-capable server view (test seams stub Bun.serve). */
type UpgradableServer = {
  upgrade?: (req: Request, opts: { data: SurfaceWsData }) => boolean;
};

type HandleCtx = {
  startedAt: Date;
  parachuteDir: string;
  logger: Pick<Console, "log" | "warn" | "error">;
  adminDir: string;
  adminOpts: Omit<AdminHandlerOpts, "state">;
  devOpts: Omit<DevRoutesOpts, "state">;
  /** The Bun server (for WS upgrades). Absent in some unit tests. */
  server?: UpgradableServer;
};

/**
 * Returns `undefined` ONLY when a WebSocket upgrade succeeded (Bun's
 * contract: an upgraded request must not produce a Response).
 */
function handle(
  req: Request,
  state: AppState,
  ctx: HandleCtx,
): Response | undefined | Promise<Response | undefined> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // /healthz: open, both with and without /surface prefix so hub-as-supervisor
  // (forwards via /surface) and direct localhost probes both work.
  //
  // When `config.disabled` is true, surface `status: "disabled"` so probes
  // can distinguish "daemon's up but intentionally not hosting" from "ok".
  // The JSON key is `skippedUis` (matching the `AppState.skippedUis` field
  // name) per reviewer Open Q 2 — keeps the shape consistent across the
  // wire format and the internal state.
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/healthz" || pathname === "/surface/healthz")
  ) {
    return Response.json({
      status: state.config.disabled ? "disabled" : "ok",
      uis: state.registeredUis.length,
      skippedUis: state.skippedUis.length,
      uptime_seconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    });
  }

  // .parachute/* — module-protocol surface, open (no secrets in app config).
  if (method === "GET" && pathname === "/.parachute/info") {
    return serveStaticFile(path.join(ctx.parachuteDir, "info"), "application/json");
  }
  if (method === "GET" && pathname === "/.parachute/config/schema") {
    return serveStaticFile(path.join(ctx.parachuteDir, "config", "schema"), "application/json");
  }
  if (method === "GET" && pathname === "/.parachute/config") {
    return Response.json(state.config);
  }

  // Phase 1.2 admin SPA — mounted at /surface/admin/. Reserved namespace: hosted
  // UIs are rejected from claiming `/surface/admin` by `meta-schema` + admin
  // /surface/add. The bundle is `dist/admin/` shipped inside the npm package.
  // Bundle path serving deliberately runs BEFORE the per-UI matcher so
  // /surface/admin/* always resolves to admin assets, even if a malformed UI
  // somehow registers `/surface/admin` (path-pattern + reserved-path checks
  // prevent that, but defense-in-depth).
  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/surface/admin" ||
      pathname === "/surface/admin/" ||
      pathname.startsWith("/surface/admin/"))
  ) {
    return serveAdminAsset(req, ctx.adminDir, pathname);
  }

  // Phase 1.3 dev-mode routes: SSE reload stream + trigger endpoint.
  // Matched ahead of admin so the per-UI `/_dev/reload` SSE path doesn't
  // race with the admin regex (different prefix shapes — defense in depth).
  const dev = routeDev(req, { state, ...ctx.devOpts });
  if (dev.handled) {
    return dev.response;
  }

  // Phase 1.2 admin endpoints (POST /surface/add, DELETE /surface/<name>, etc.).
  const admin = routeAdmin(req, { state, ...ctx.adminOpts });
  if (admin.handled) {
    return admin.response;
  }

  // Backed-surface namespaces (P4 — STRUCTURAL containment). The host
  // forwards EXACTLY two namespaces to a surface's backend:
  // `${mount}/api/*` (any method) and `${mount}/ws` (the WebSocket
  // upgrade). Everything else — the static dist, /oauth-client, the meta
  // endpoints above, the admin SPA, sibling surfaces — is host-served and
  // unreachable from a backend's router BY CONSTRUCTION: this dispatch
  // runs AFTER every host route and only ever hands the backend its two
  // namespaces. Every response on these paths (and the backed surface's
  // static responses below) carries the P6 security headers.
  {
    const ui = matchUi(pathname, state.registeredUis);
    if (ui?.meta.server) {
      const mount = ui.meta.path;
      const isWs = pathname === `${mount}/ws`;
      const isApi = pathname === `${mount}/api` || pathname.startsWith(`${mount}/api/`);

      if (isWs) {
        return handleWsRoute(req, ui, state, ctx);
      }
      if (isApi) {
        const backends = state.backends;
        const dispatch = backends
          ? backends.handleRequest(ui, req)
          : Promise.resolve(
              new Response(
                JSON.stringify({
                  error: "backend_unavailable",
                  error_description: "no backend supervisor is running",
                }),
                { status: 503, headers: { "content-type": "application/json" } },
              ),
            );
        return dispatch.then((res) => applySecurityHeaders(res, ui.meta));
      }
    }
  }

  // Per-UI mount paths. Find the matching UI (longest mount-path wins,
  // though Phase 1.1's PATH_PATTERN constrains mounts to single-segment
  // so there's no overlap in practice — the longest-prefix loop is
  // forward-defensive for Phase 2's multi-segment relaxation).
  if (method === "GET" || method === "HEAD") {
    const ui = matchUi(pathname, state.registeredUis);
    if (ui) {
      // Resolve the hub origin per-request so a config flip
      // (admin-SPA-toggled `hub_url` or env override) takes effect on the
      // very next index.html serve. Read by `injectTenancyContract` below
      // via `serveFileWithHeaders`'s `hubOrigin` parameter.
      const hubOrigin = getHubOrigin(state.config.hub_url);
      const res = serveUiAsset(req, ui, pathname, hubOrigin, ctx.logger);
      // P6: a BACKED surface's static responses carry the security headers
      // too (the design's "every backed-surface response"); static-only
      // surfaces keep their current behavior.
      return ui.meta.server ? applySecurityHeaders(res, ui.meta) : res;
    }
  }

  // Fall-through: unknown route for an unsupported method → 405, otherwise 404.
  if (method !== "GET" && method !== "HEAD" && method !== "POST" && method !== "DELETE") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response("Not Found", { status: 404 });
}

/**
 * `${mount}/ws` (P4/P6): upgrade iff the surface DECLARED the websocket
 * capability AND its mounted backend exports websocket handlers; anything
 * else is 426 — deny-by-default, mirroring the hub bridge (which only
 * forwards upgrades here when our services.json row carries
 * `websocket: true`, itself derived from the installed surfaces'
 * declarations). Trust signals are captured from the hub stamps at upgrade
 * time and ride the connection (`SurfaceWsData`); refusals carry the P6
 * headers like every other backed-surface response.
 */
function handleWsRoute(
  req: Request,
  ui: RegisteredUi,
  state: AppState,
  ctx: HandleCtx,
): Response | undefined {
  const refuse = (status: number, error: string, description: string): Response =>
    applySecurityHeaders(
      new Response(JSON.stringify({ error, error_description: description }), {
        status,
        headers: {
          "content-type": "application/json",
          ...(status === 426 ? { upgrade: "websocket" } : {}),
        },
      }),
      ui.meta,
    );

  const declared = ui.meta.server?.capabilities.includes("websocket") === true;
  const handlers = state.backends?.websocketHandlersFor(ui.meta.name);
  if (!declared || !handlers) {
    return refuse(
      426,
      "websocket_not_supported",
      declared
        ? `surface "${ui.meta.name}" has no active websocket backend`
        : `surface "${ui.meta.name}" does not declare the websocket capability`,
    );
  }
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return refuse(426, "upgrade_required", "this endpoint only accepts WebSocket upgrades");
  }
  if (!ctx.server?.upgrade) {
    return refuse(503, "service_unavailable", "websocket upgrade unavailable on this server");
  }
  const upgraded = ctx.server.upgrade(req, {
    data: {
      surface: ui.meta.name,
      layer: layerFromRequest(req),
      clientIp: clientIpFromRequest(req),
    },
  });
  if (upgraded) return undefined; // Bun contract: no Response after upgrade
  return refuse(400, "upgrade_failed", "WebSocket handshake was malformed");
}

/**
 * Find the UI whose mount path is a prefix of `pathname`. Longest-prefix
 * wins so a UI at `/surface/foo-bar` doesn't shadow `/surface/foo` — though the
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
 * File extensions that identify a request as an asset (vs a client-side
 * navigation). Asset requests that miss return 404; navigation requests
 * (no extension, or `.html`) fall through to the SPA shell so the
 * client-side router can handle the path.
 *
 * Why this matters: if the SPA shell is served in response to an asset
 * miss (a missing JS chunk, a missing `manifest.webmanifest`), the
 * browser tries to parse HTML as JS / JSON / a PWA manifest and the
 * resulting error ("Expected JavaScript-or-Wasm module, got
 * 'text/html'", "Manifest: Line: 1, column: 1, Syntax error") masks
 * the real cause — a missing or misnamed asset.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".webmanifest",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".webm",
  ".wasm",
  ".txt",
  ".gz",
  ".br",
]);

function looksLikeAssetRequest(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

/**
 * Serve an asset for a registered UI. The flow:
 *
 *   1. If `pathname === meta.path` or `pathname === meta.path + "/"`, serve
 *      `dist/index.html` (the root document).
 *   2. Otherwise compute the relative path after `meta.path/`. If the file
 *      exists under `dist/`, serve it with content-type + cache headers.
 *   3. If it doesn't exist:
 *      - If the request looks like an asset (extension like `.js`, `.css`,
 *        `.webmanifest`), return 404 — never serve HTML in response to an
 *        asset request, or the browser parses the SPA shell as JS/JSON.
 *      - Otherwise (no extension / `.html` — a client-side route), serve
 *        `dist/index.html` with no-cache headers and let the bundle's
 *        router decide what to render.
 *
 * Path traversal: `path.resolve(distDir, rel)` is checked against `distDir`
 * via a containment test (`resolved.startsWith(distDir + path.sep)`). Any
 * attempt to escape (`../etc/passwd`) gets a 404. Bun's URL parser
 * already collapses `..` segments but the explicit check is the load-bearing
 * line — defense in depth. A traversal attempt with an asset-shaped suffix
 * (e.g. `../etc/passwd.js`) is 404'd too — defense in depth for the
 * "HTML returned for a JS request" foot-gun above.
 */
function serveUiAsset(
  req: Request,
  ui: RegisteredUi,
  pathname: string,
  hubOrigin: string,
  logger: Pick<Console, "log" | "warn" | "error">,
): Response {
  const mount = ui.meta.path;
  const distDir = ui.distDir;
  const indexHtmlPath = path.join(distDir, "index.html");
  // Per-request dev-mode check — flipping `parachute-surface dev <name>` takes
  // effect on the very next request without restarting the server.
  const devMode = isDevMode(ui.meta.name);

  // Root document: /surface/foo or /surface/foo/
  if (pathname === mount || pathname === `${mount}/`) {
    return serveFileWithHeaders(
      req,
      indexHtmlPath,
      "index.html",
      ui.meta,
      devMode,
      hubOrigin,
      logger,
    );
  }

  // Strip the mount prefix; rel is the path within dist/.
  const rel = pathname.slice(mount.length + 1); // +1 to drop the leading '/'
  // Defense in depth: reject any explicit traversal segments before resolve.
  if (rel.includes("\0") || rel.split("/").some((seg) => seg === "..")) {
    if (looksLikeAssetRequest(rel)) {
      return new Response("Not Found", { status: 404 });
    }
    // Fall through to SPA fallback — the bundle's router handles unknown routes.
    return serveFileWithHeaders(
      req,
      indexHtmlPath,
      "index.html",
      ui.meta,
      devMode,
      hubOrigin,
      logger,
    );
  }

  const resolved = path.resolve(distDir, rel);
  // Containment check — the resolved path must live under distDir.
  if (resolved !== distDir && !resolved.startsWith(`${distDir}${path.sep}`)) {
    if (looksLikeAssetRequest(rel)) {
      return new Response("Not Found", { status: 404 });
    }
    return serveFileWithHeaders(
      req,
      indexHtmlPath,
      "index.html",
      ui.meta,
      devMode,
      hubOrigin,
      logger,
    );
  }

  if (existsSync(resolved)) {
    try {
      const st = statSync(resolved);
      if (st.isFile()) {
        const basename = path.basename(resolved);
        return serveFileWithHeaders(req, resolved, basename, ui.meta, devMode, hubOrigin, logger);
      }
    } catch {
      // Race with file deletion — fall through to SPA-fallback-or-404 below.
    }
  }

  // Miss. Asset-shaped requests get 404; navigation requests get the SPA
  // shell so the client-side router runs.
  if (looksLikeAssetRequest(rel)) {
    return new Response("Not Found", { status: 404 });
  }
  return serveFileWithHeaders(
    req,
    indexHtmlPath,
    "index.html",
    ui.meta,
    devMode,
    hubOrigin,
    logger,
  );
}

/**
 * Read a file from disk and wrap it with content-type + cache headers.
 * Returns 404 if the file is unreadable — caller passes a path it already
 * stat'd, so the only realistic 404 is a race with deletion mid-request.
 *
 * Body is the literal string `"Not Found"` — we deliberately don't include
 * the underlying error message because ENOENT's `Error.message` leaks the
 * absolute filesystem path (e.g. `ENOENT: no such file or directory, open
 * '/Users/.../surface/uis/notes/dist/missing.js'`). That information is fine in
 * logs but not in a client-visible response. We log the path-loss event
 * server-side and return the generic body to the client.
 */
function serveFileWithHeaders(
  req: Request,
  filePath: string,
  filenameForHeaders: string,
  meta: UiMeta,
  devMode = false,
  hubOrigin?: string,
  logger: Pick<Console, "log" | "warn" | "error"> = console,
): Response {
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (e) {
    // Log the actual path server-side for debugging — never returns to the client.
    logger.warn(`[app] serve: file vanished mid-request: ${filePath} (${(e as Error).message})`);
    return new Response("Not Found", { status: 404 });
  }

  // When we're serving the index.html document, run two layered HTML
  // post-processors:
  //
  //   1. Runtime tenancy contract — inject `<base href>` + meta tags so the
  //      bundle (and `@openparachute/surface-client`) can resolve its mount,
  //      hub origin, etc. without baking them in at build time. Always-on:
  //      `injectTenancyContract` skips itself if the source already
  //      declared the tags (idempotent).
  //   2. Dev-mode reload script — when dev mode is enabled for this UI,
  //      inject the EventSource shim. Tenancy runs first so dev's
  //      `</head>` insertion never collides with our `<head>` insertion.
  //
  // Both passes are string-scan based; neither parses HTML. The contract
  // for both is the same: idempotent + non-destructive on malformed
  // documents (no `<head>` → warn + serve raw).
  let payload: Buffer | string = body;
  if (filenameForHeaders === "index.html") {
    let html = body.toString("utf8");

    // Pass 1: runtime tenancy contract (always-on when hubOrigin is supplied).
    if (hubOrigin) {
      try {
        const result = injectTenancyContract(html, meta.path, hubOrigin);
        if (result.skipped === "no-head") {
          logger.warn(
            `[app] inject-tenancy: no <head> in index.html for ${meta.name}; serving unmodified`,
          );
        }
        html = result.html;
      } catch (e) {
        // Should never throw — string ops only. Fall back to the raw bytes
        // (string-form, so the dev-mode pass below still runs).
        logger.warn(`[app] inject-tenancy: failed for ${meta.name}: ${(e as Error).message}`);
      }
    }

    // Pass 2: dev-mode reload script (only when dev mode is on).
    if (devMode) {
      const endpoint = `${meta.path}/_dev/reload`;
      try {
        const { html: injected, fallback } = injectDevReloadScript(html, endpoint);
        if (fallback) {
          logger.warn(
            `[app] dev: injected reload script via ${fallback} fallback for ${meta.name} (no </head> in index.html)`,
          );
        }
        html = injected;
      } catch (e) {
        logger.warn(`[app] dev: inject failed for ${meta.name}: ${(e as Error).message}`);
      }
    }

    payload = html;
  }

  const bodyLen = typeof payload === "string" ? Buffer.byteLength(payload) : payload.length;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(filenameForHeaders),
    ...cacheHeadersFor(filenameForHeaders, meta, devMode),
  };
  if (req.method === "HEAD") {
    // HEAD: include Content-Length but no body.
    headers["content-length"] = String(bodyLen);
    return new Response(null, { status: 200, headers });
  }
  // Bun's Response accepts string / Buffer / Uint8Array / ArrayBuffer
  // interchangeably; pass whichever shape we have.
  return new Response(payload, { status: 200, headers });
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
    // Same posture as serveFileWithHeaders: log the path server-side but
    // return a generic body so ENOENT's absolute filesystem path doesn't
    // leak to the client.
    console.warn(`[app] serve-static: ${filePath} unreadable (${(e as Error).message})`);
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
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
 * Default location of the built admin SPA. Shipped via `package.json#files`
 * (`dist/admin/**`) so `bunx @openparachute/surface` resolves it.
 */
function defaultAdminDir(): string {
  return path.resolve(import.meta.dir, "..", "dist", "admin");
}

/**
 * Serve a file from the admin SPA's dist directory. Same cache shape Phase 1.1
 * used for hosted UIs: `index.html` no-cache; hashed assets immutable;
 * everything else 1-hour. SPA-fallback: anything that doesn't resolve serves
 * index.html (react-router runs).
 *
 * If the admin SPA bundle isn't present (e.g. tests, fresh dev checkout
 * before `bun run build`), we return a friendly placeholder so operators
 * see "admin SPA not built" instead of a bare 404. Production npm installs
 * ship the bundle so this branch is the dev affordance.
 *
 * Note: this path intentionally does NOT inject the runtime tenancy
 * contract (`<base href>` + `<meta name="parachute-mount">` etc.). The
 * admin SPA is app's own surface — it's not a hosted tenant. Tenancy
 * injection runs only in `serveUiAsset` for the `/surface/<name>/*` mounts.
 */
function serveAdminAsset(req: Request, adminDir: string, pathname: string): Response {
  const indexHtmlPath = path.join(adminDir, "index.html");

  if (!existsSync(indexHtmlPath)) {
    // Dev / pre-build branch: return a static placeholder so the operator
    // sees the daemon is healthy but the bundle isn't shipped yet.
    return new Response(adminSpaPlaceholder(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  // Strip the `/surface/admin/` prefix, falling back to index.html on root.
  if (pathname === "/surface/admin" || pathname === "/surface/admin/") {
    return serveAdminFile(req, indexHtmlPath, "index.html");
  }
  const rel = pathname.slice("/surface/admin/".length);
  if (rel.includes("\0") || rel.split("/").some((seg) => seg === "..")) {
    return serveAdminFile(req, indexHtmlPath, "index.html");
  }
  const resolved = path.resolve(adminDir, rel);
  if (resolved !== adminDir && !resolved.startsWith(`${adminDir}${path.sep}`)) {
    return serveAdminFile(req, indexHtmlPath, "index.html");
  }
  if (existsSync(resolved)) {
    try {
      const st = statSync(resolved);
      if (st.isFile()) {
        return serveAdminFile(req, resolved, path.basename(resolved));
      }
    } catch {
      // race with deletion — SPA fallback
    }
  }
  return serveAdminFile(req, indexHtmlPath, "index.html");
}

function serveAdminFile(req: Request, filePath: string, filenameForHeaders: string): Response {
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (e) {
    console.warn(`[app] admin serve: ${filePath} unreadable (${(e as Error).message})`);
    return new Response("Not Found", { status: 404 });
  }
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(filenameForHeaders),
    // Mirror the hosted-UI policy: index.html → no-cache; everything else
    // → 1 year + immutable when content-hashed, 1h otherwise. The admin
    // SPA doesn't have meta.json so we use a `pwa: false`-equivalent shim.
    ...cacheHeadersFor(filenameForHeaders, {
      name: "admin",
      displayName: "Admin",
      path: "/surface/admin",
      scopes_required: [],
      pwa: false,
      audience: "hub-users",
      public: false,
    } as UiMeta),
  };
  if (req.method === "HEAD") {
    headers["content-length"] = String(body.length);
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}

/**
 * Placeholder served when the admin SPA bundle isn't built. The dev
 * affordance — production installs always ship `dist/admin/`. Keeps the
 * /surface/admin/ route from 404'ing in a fresh checkout.
 */
function adminSpaPlaceholder(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>parachute-surface admin</title></head>
<body style="font-family:system-ui;margin:2rem;color:#222;max-width:42rem;">
  <h1>parachute-surface admin</h1>
  <p>The admin SPA bundle isn't present. Run <code>bun run build</code> from this checkout to build it.</p>
  <p>API endpoints under <code>/surface/list</code>, <code>/surface/add</code>, etc. are live; CLI <code>parachute-surface list</code> works.</p>
</body></html>`;
}

/**
 * Force-load the app config — used by callers that want defaults applied
 * without going through the full daemon boot path (e.g. CI healthchecks).
 */
export function loadOrDefaultConfig(opts: Parameters<typeof loadConfig>[0] = {}): AppConfig {
  return loadConfig(opts);
}
