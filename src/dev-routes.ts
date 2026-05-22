/**
 * Dev-mode HTTP routes — Phase 1.3.
 *
 * Two surfaces:
 *
 *   GET  /app/<name>/_dev/reload      — SSE stream (unauthenticated; the
 *                                       UI's injected reload script reads
 *                                       it at page load before any token
 *                                       exists, same affordance as the
 *                                       OAuth-client discovery endpoint).
 *                                       404 when the UI isn't in dev mode.
 *   POST /app/<name>/dev/enable       — flip dev mode on (app:admin)
 *   POST /app/<name>/dev/disable      — flip dev mode off (app:admin)
 *   POST /app/<name>/dev/trigger      — broadcast a reload event (app:admin)
 *   GET  /app/dev/list                — UIs in dev mode (app:read)
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

import type { AppState } from "./http-server.ts";

export type DevRoutesOpts = {
  state: Pick<AppState, "config" | "registeredUis">;
  /** Test-only seam: replace `enforceScope` with a stub. */
  enforceScopeFn?: (
    req: Request,
    requiredScope: typeof SCOPE_ADMIN | typeof SCOPE_READ,
  ) => Promise<Response | { scopes: readonly string[] }>;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

type RouteOutcome = { handled: false } | { handled: true; response: Promise<Response> | Response };

const RELOAD_STREAM_RE = /^\/app\/([a-z][a-z0-9-]*)\/_dev\/reload$/;
const DEV_ENABLE_RE = /^\/app\/([a-z][a-z0-9-]*)\/dev\/enable$/;
const DEV_DISABLE_RE = /^\/app\/([a-z][a-z0-9-]*)\/dev\/disable$/;
const DEV_TRIGGER_RE = /^\/app\/([a-z][a-z0-9-]*)\/dev\/trigger$/;
const DEV_STATUS_RE = /^\/app\/([a-z][a-z0-9-]*)\/dev$/;

export function routeDev(req: Request, opts: DevRoutesOpts): RouteOutcome {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /app/dev/list — admin SPA + CLI's `dev list` reads this.
  if (pathname === "/app/dev/list" && method === "GET") {
    return { handled: true, response: handleList(req, opts) };
  }

  // GET /app/<name>/_dev/reload — UNAUTHENTICATED SSE stream.
  const streamMatch = pathname.match(RELOAD_STREAM_RE);
  if (streamMatch && method === "GET") {
    return { handled: true, response: handleReloadStream(streamMatch[1]!, opts) };
  }

  // GET /app/<name>/dev — dev-mode status for one UI (app:read).
  const statusMatch = pathname.match(DEV_STATUS_RE);
  if (statusMatch && method === "GET") {
    return { handled: true, response: handleStatus(req, statusMatch[1]!, opts) };
  }

  // POST /app/<name>/dev/enable
  const enableMatch = pathname.match(DEV_ENABLE_RE);
  if (enableMatch && method === "POST") {
    return { handled: true, response: handleEnable(req, enableMatch[1]!, opts) };
  }

  // POST /app/<name>/dev/disable
  const disableMatch = pathname.match(DEV_DISABLE_RE);
  if (disableMatch && method === "POST") {
    return { handled: true, response: handleDisable(req, disableMatch[1]!, opts) };
  }

  // POST /app/<name>/dev/trigger
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

// --- GET /app/dev/list ---------------------------------------------------

async function handleList(req: Request, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  const active = listDevMode().map(({ name, state }) => ({
    name,
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    subscribers: subscriberCount(name),
  }));
  return Response.json({ uis: active });
}

// --- GET /app/<name>/dev -------------------------------------------------

async function handleStatus(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  const ui = findUi(name, opts);
  if (!ui) return notFoundJson(name);
  const state = getDevMode(name);
  return Response.json({
    name,
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    subscribers: subscriberCount(name),
  });
}

// --- POST /app/<name>/dev/enable ----------------------------------------

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
  opts.logger?.log(`[app] dev mode ON for ${name}`);
  return Response.json({
    ok: true,
    name,
    enabled: state.enabled,
    enabledAt: state.enabledAt,
    subscribers: subscriberCount(name),
  });
}

// --- POST /app/<name>/dev/disable ---------------------------------------

async function handleDisable(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;
  // We tolerate disabling a UI that's missing — the operator wants the
  // state cleaned up, and the in-memory map may have a stale entry.
  const before = isDevMode(name);
  disableDevMode(name);
  opts.logger?.log(`[app] dev mode OFF for ${name}${before ? "" : " (was already off)"}`);
  return Response.json({ ok: true, name, enabled: false, was_on: before });
}

// --- POST /app/<name>/dev/trigger ---------------------------------------

async function handleTrigger(req: Request, name: string, opts: DevRoutesOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;
  if (!isDevMode(name)) {
    return Response.json(
      {
        error: "dev_mode_off",
        message: `UI "${name}" is not in dev mode; run \`parachute-app dev ${name}\` first`,
      },
      { status: 409 },
    );
  }
  const notified = broadcastReload(name);
  opts.logger?.log(`[app] dev reload broadcast for ${name}: notified=${notified}`);
  return Response.json({ ok: true, name, notified });
}

// --- GET /app/<name>/_dev/reload (SSE, unauthenticated) -----------------

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
