/**
 * Dev-mode HTTP routes — Phase 1.3.
 *
 * Two surfaces:
 *
 *   GET  /surface/<name>/_dev/reload      — SSE stream (unauthenticated; the
 *                                       UI's injected reload script reads
 *                                       it at page load before any token
 *                                       exists, same affordance as the
 *                                       OAuth-client discovery endpoint).
 *                                       404 when the UI isn't in dev mode.
 *   POST /surface/<name>/dev/enable       — flip dev mode on (surface:admin)
 *   POST /surface/<name>/dev/disable      — flip dev mode off (surface:admin)
 *   POST /surface/<name>/dev/trigger      — broadcast a reload event (surface:admin)
 *   GET  /surface/dev/list                — UIs in dev mode (surface:read)
 *
 * The SSE endpoint stays open as long as the client is connected; we hold
 * a per-stream subscriber in `dev-mode.ts`'s registry and broadcast to
 * every subscriber when `/dev/trigger` fires. Disconnects clean up via
 * the stream's `cancel` hook.
 *
 * Why a separate dispatcher (mirrors `routeAdmin`):
 *
 *   Keeping dev routes out of admin-routes.ts means Phase 2's auto-reload
 *   (file watcher driving `broadcastReload`) doesn't have to thread state
 *   through the admin handlers. The dispatcher shape is the same — fall
 *   through to `{ handled: false }` so the caller's per-UI matcher fires.
 */

import { SCOPE_ADMIN, SCOPE_READ, enforceScope as defaultEnforceScope } from "./auth.ts";
import {
  type DevReloadSubscriber,
  addSubscriber,
  broadcastReload,
  disableDevMode,
  enableDevMode,
  getDevMode,
  isDevMode,
  listDevMode,
  removeSubscriber,
  subscriberCount,
} from "./dev-mode.ts";
import {
  type DevSpawnFn,
  DevWatcherError,
  startWatcher as defaultStartWatcher,
  stopWatcher as defaultStopWatcher,
  watcherStatus as defaultWatcherStatus,
  isWatching,
} from "./dev-watcher.ts";

import type { AppState } from "./http-server.ts";

/**
 * Pluggable façade over the dev-watcher module so tests can swap in
 * fakes without forking shells or arming real FSWatchers. Production
 * code uses the defaults from `./dev-watcher.ts` directly.
 */
export type DevWatcherFns = {
  startWatcher: (opts: Parameters<typeof defaultStartWatcher>[0]) => {
    watchedAbsDir: string;
    debounceMs: number;
  };
  stopWatcher: (name: string) => void;
  isWatching: (name: string) => boolean;
  watcherStatus: (name: string) => ReturnType<typeof defaultWatcherStatus>;
};

const DEFAULT_WATCHER_FNS: DevWatcherFns = {
  startWatcher: defaultStartWatcher,
  stopWatcher: defaultStopWatcher,
  isWatching,
  watcherStatus: defaultWatcherStatus,
};

export type DevRoutesOpts = {
  state: Pick<AppState, "config" | "registeredUis">;
  /** Test-only seam: replace `enforceScope` with a stub. */
  enforceScopeFn?: (
    req: Request,
    requiredScope: typeof SCOPE_ADMIN | typeof SCOPE_READ,
  ) => Promise<Response | { scopes: readonly string[] }>;
  /**
   * Test-only seam: replace the dev-watcher module functions. When
   * omitted, the real `./dev-watcher.ts` exports are used so the
   * production daemon arms a real FSWatcher on enable.
   */
  watcherFns?: DevWatcherFns;
  /**
   * Phase 3.0 — override the build-command spawner (tests). Forwarded
   * to `startWatcher` so a test can assert on the spawn argv without
   * actually shelling out.
   */
  watcherSpawnFn?: DevSpawnFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

type RouteOutcome = { handled: false } | { handled: true; response: Promise<Response> | Response };

const RELOAD_STREAM_RE = /^\/surface\/([a-z][a-z0-9-]*)\/_dev\/reload$/;
const DEV_ENABLE_RE = /^\/surface\/([a-z][a-z0-9-]*)\/dev\/enable$/;
const DEV_DISABLE_RE = /^\/surface\/([a-z][a-z0-9-]*)\/dev\/disable$/;
const DEV_TRIGGER_RE = /^\/surface\/([a-z][a-z0-9-]*)\/dev\/trigger$/;
const DEV_STATUS_RE = /^\/surface\/([a-z][a-z0-9-]*)\/dev$/;

export function routeDev(req: Request, opts: DevRoutesOpts): RouteOutcome {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /surface/dev/list — admin SPA + CLI's `dev list` reads this.
  if (pathname === "/surface/dev/list" && method === "GET") {
    return { handled: true, response: handleList(req, opts) };
  }

  // GET /surface/<name>/_dev/reload — UNAUTHENTICATED SSE stream.
  const streamMatch = pathname.match(RELOAD_STREAM_RE);
  if (streamMatch && method === "GET") {
    return { handled: true, response: handleReloadStream(streamMatch[1]!, opts) };
  }

  // GET /surface/<name>/dev — dev-mode status for one UI (app:read).
  const statusMatch = pathname.match(DEV_STATUS_RE);
  if (statusMatch && method === "GET") {
    return { handled: true, response: handleStatus(req, statusMatch[1]!, opts) };
  }

  // POST /surface/<name>/dev/enable
  const enableMatch = pathname.match(DEV_ENABLE_RE);
  if (enableMatch && method === "POST") {
    return { handled: true, response: handleEnable(req, enableMatch[1]!, opts) };
  }

  // POST /surface/<name>/dev/disable
  const disableMatch = pathname.match(DEV_DISABLE_RE);
  if (disableMatch && method === "POST") {
    return { handled: true, response: handleDisable(req, disableMatch[1]!, opts) };
  }

  // POST /surface/<name>/dev/trigger
  const triggerMatch = pathname.match(DEV_TRIGGER_RE);
  if (triggerMatch && method === "POST") {
    return { handled: true, response: handleTrigger(req, triggerMatch[1]!, opts) };
  }

  return { handled: false };
}

function runEnforce(
  req: Request,
  scope: typeof SCOPE_ADMIN | typeof SCOPE_READ,
  opts: DevRoutesOpts,
): Promise<Response | { scopes: readonly string[] }> {
  if (opts.enforceScopeFn) return opts.enforceScopeFn(req, scope);
  return defaultEnforceScope(req, scope, { hubUrl: opts.state.config.hub_url });
}

function findUi(name: string, opts: DevRoutesOpts) {
  return opts.state.registeredUis.find((u) => u.meta.name === name);
}

function notFoundJson(name: string): Response {
  return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
}

// --- GET /surface/dev/list ---------------------------------------------------

async function handleList(req: Request, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  const watcherFns = opts.watcherFns ?? DEFAULT_WATCHER_FNS;
  const active = listDevMode().map(({ name, state }) => {
    const ws = watcherFns.watcherStatus(name);
    return {
      name,
      enabled: state.enabled,
      enabledAt: state.enabledAt,
      subscribers: subscriberCount(name),
      watcher: ws
        ? {
            watching: true,
            watchDir: ws.watchedAbsDir,
            debounceMs: ws.debounceMs,
            buildCmd: ws.buildCmd ?? null,
            building: ws.building,
          }
        : { watching: false },
    };
  });
  return Response.json({ uis: active });
}

// --- GET /surface/<name>/dev -------------------------------------------------

async function handleStatus(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  const ui = findUi(name, opts);
  if (!ui) return notFoundJson(name);
  const state = getDevMode(name);
  const watcherFns = opts.watcherFns ?? DEFAULT_WATCHER_FNS;
  const ws = watcherFns.watcherStatus(name);
  return Response.json({
    name,
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    subscribers: subscriberCount(name),
    watcher: ws
      ? {
          watching: true,
          watchDir: ws.watchedAbsDir,
          debounceMs: ws.debounceMs,
          buildCmd: ws.buildCmd ?? null,
          building: ws.building,
        }
      : { watching: false },
  });
}

// --- POST /surface/<name>/dev/enable ----------------------------------------

async function handleEnable(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  // Honor `config.dev_mode_allowed` so an operator who wants dev mode off
  // for a deploy can lock it down via config.
  if (opts.state.config.dev_mode_allowed === false) {
    return Response.json(
      {
        error: "dev_mode_disabled",
        message: "dev mode is disabled in config (`dev_mode_allowed: false`)",
      },
      { status: 409 },
    );
  }

  const ui = findUi(name, opts);
  if (!ui) return notFoundJson(name);

  const state = enableDevMode(name);

  // Phase 3.0 — arm the file watcher. Best-effort: a watcher failure
  // doesn't unwind dev mode (the operator can still use `--trigger`),
  // but we surface the reason in the response so the admin SPA / CLI
  // can show it. `meta.dev_watch_dir` is the operator override; absent,
  // we default to the UI's root dir (the watcher filters dist/ +
  // node_modules/ to avoid the build-output loop).
  const watcherFns = opts.watcherFns ?? DEFAULT_WATCHER_FNS;
  let watcher: { watchedAbsDir: string; debounceMs: number } | undefined;
  let watcherWarning: string | undefined;
  try {
    watcher = watcherFns.startWatcher({
      name,
      uiRootDir: ui.uiDir,
      watchDir: ui.meta.dev_watch_dir,
      buildCmd: ui.meta.dev_build_cmd,
      debounceMs: ui.meta.dev_debounce_ms,
      spawnFn: opts.watcherSpawnFn,
      logger: opts.logger,
    });
  } catch (e) {
    if (e instanceof DevWatcherError) {
      watcherWarning = e.message;
      opts.logger?.warn(`[app] dev-watcher: failed to start for ${name}: ${e.message}`);
    } else {
      watcherWarning = `unexpected error starting watcher: ${(e as Error).message}`;
      opts.logger?.warn(`[app] dev-watcher: ${watcherWarning}`);
    }
  }

  opts.logger?.log(
    `[app] dev mode ON for ${name}${watcher ? ` (watching ${watcher.watchedAbsDir})` : ""}`,
  );
  return Response.json({
    ok: true,
    name,
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    subscribers: subscriberCount(name),
    watcher: watcher
      ? {
          watching: true,
          watchDir: watcher.watchedAbsDir,
          debounceMs: watcher.debounceMs,
          buildCmd: ui.meta.dev_build_cmd ?? null,
        }
      : { watching: false, warning: watcherWarning ?? "watcher_unavailable" },
  });
}

// --- POST /surface/<name>/dev/disable ---------------------------------------

async function handleDisable(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;
  // We tolerate disabling a UI that's missing — the operator wants the
  // state cleaned up, and the in-memory map may have a stale entry.
  const before = isDevMode(name);
  disableDevMode(name);
  // Phase 3.0 — tear down the file watcher (idempotent; no-op if absent).
  const watcherFns = opts.watcherFns ?? DEFAULT_WATCHER_FNS;
  watcherFns.stopWatcher(name);
  opts.logger?.log(`[app] dev mode OFF for ${name}${before ? "" : " (was already off)"}`);
  return Response.json({ ok: true, name, enabled: false, was_on: before });
}

// --- POST /surface/<name>/dev/trigger ---------------------------------------

async function handleTrigger(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;
  if (!isDevMode(name)) {
    return Response.json(
      {
        error: "dev_mode_off",
        message: `UI "${name}" is not in dev mode; run \`parachute-surface dev ${name}\` first`,
      },
      { status: 409 },
    );
  }
  const notified = broadcastReload(name);
  opts.logger?.log(`[app] dev reload broadcast for ${name}: notified=${notified}`);
  return Response.json({ ok: true, name, notified });
}

// --- GET /surface/<name>/_dev/reload (SSE, unauthenticated) -----------------

function handleReloadStream(name: string, opts: DevRoutesOpts): Response {
  // 404 when dev mode is off — the injected script auto-reconnects via
  // EventSource defaults; once the operator flips dev mode on, the next
  // attempt will succeed.
  if (!isDevMode(name)) {
    return Response.json(
      { error: "dev_mode_off", message: `UI "${name}" is not in dev mode` },
      { status: 404 },
    );
  }

  let subscriber: DevReloadSubscriber | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = { controller, closed: false };
      addSubscriber(name, subscriber);
      // Emit a comment immediately. SSE clients dispatch on `:` lines as
      // no-op keepalives; this both flushes the response start and tells
      // the client the stream is alive.
      try {
        controller.enqueue(new TextEncoder().encode(`: connected ${Date.now()}\n\n`));
      } catch {
        // controller might already be closed in unit-test fakes.
      }
      opts.logger?.log(
        `[app] dev SSE subscriber connected for ${name} (count=${subscriberCount(name)})`,
      );
    },
    cancel() {
      if (subscriber) {
        subscriber.closed = true;
        removeSubscriber(name, subscriber);
        opts.logger?.log(
          `[app] dev SSE subscriber disconnected for ${name} (count=${subscriberCount(name)})`,
        );
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store, must-revalidate",
      connection: "keep-alive",
      // Disable response buffering for proxies that respect this header
      // (nginx / hub's reverse proxy in particular).
      "x-accel-buffering": "no",
    },
  });
}
