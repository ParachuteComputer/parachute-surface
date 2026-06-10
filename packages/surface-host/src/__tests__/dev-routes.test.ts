/**
 * Tests for `src/dev-routes.ts` — Phase 1.3 admin + SSE endpoints.
 *
 * Coverage:
 *   - enable / disable / status / list happy paths via `routeDev`
 *   - 404 when UI doesn't exist
 *   - 409 when trigger fires against a UI that's not in dev mode
 *   - 409 when enable fires while `config.dev_mode_allowed: false`
 *   - SSE stream returns 200 + text/event-stream when dev mode is on
 *   - SSE stream returns 404 when dev mode is off
 *   - SSE stream broadcasts a reload event to a connected subscriber
 *   - SSE stream cancel removes the subscriber
 *   - Disable closes any active SSE streams
 *   - Auth gate: 401 / 403 forwarded verbatim from `enforceScopeFn`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { AppConfig } from "../config.ts";
import { isDevMode, resetDevMode, subscriberCount } from "../dev-mode.ts";
import { type DevRoutesOpts, type DevWatcherFns, routeDev } from "../dev-routes.ts";
import { DevWatcherError } from "../dev-watcher.ts";
import type { RegisteredUi } from "../ui-registry.ts";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    hub_url: "http://127.0.0.1:1939",
    auto_register_oauth_clients: true,
    disabled: false,
    default_scope_required: ["vault:*:read"],
    dev_mode_allowed: true,
    bootstrap_default_apps: { enabled: false, apps: [] },
    auto_provision_required_schema: false,
    ...overrides,
  };
}

function makeUi(name: string, mountPath = `/surface/${name}`): RegisteredUi {
  return {
    dirName: name,
    uiDir: `/tmp/${name}`,
    distDir: `/tmp/${name}/dist`,
    meta: {
      name,
      displayName: name,
      path: mountPath,
      scopes_required: ["vault:*:read"],
      pwa: false,
      audience: "hub-users" as const,
      public: false,
    },
  };
}

/** All-allow enforceScopeFn — returns "ok" with the requested scope granted. */
const allowAll: DevRoutesOpts["enforceScopeFn"] = async (_req, scope) => ({
  scopes: [scope],
});
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Fake watcherFns recording calls — keeps dev-routes tests from arming a
 * real FSWatcher (and the per-platform flakiness that would imply).
 */
function makeFakeWatcherFns(overrides: Partial<DevWatcherFns> = {}): DevWatcherFns & {
  startCalls: Array<{ name: string; uiRootDir: string; buildCmd?: string; watchDir?: string }>;
  stopCalls: string[];
  watching: Set<string>;
} {
  const startCalls: Array<{
    name: string;
    uiRootDir: string;
    buildCmd?: string;
    watchDir?: string;
  }> = [];
  const stopCalls: string[] = [];
  const watching = new Set<string>();
  const fns: DevWatcherFns = {
    startWatcher: (o) => {
      startCalls.push({
        name: o.name,
        uiRootDir: o.uiRootDir,
        buildCmd: o.buildCmd,
        watchDir: o.watchDir,
      });
      watching.add(o.name);
      return { watchedAbsDir: o.uiRootDir, debounceMs: 250 };
    },
    stopWatcher: (name) => {
      stopCalls.push(name);
      watching.delete(name);
    },
    isWatching: (name) => watching.has(name),
    watcherStatus: (name) =>
      watching.has(name)
        ? {
            name,
            watchedAbsDir: `/tmp/${name}`,
            debounceMs: 250,
            building: false,
          }
        : undefined,
    ...overrides,
  };
  return Object.assign(fns, { startCalls, stopCalls, watching });
}

function makeOpts(overrides: Partial<DevRoutesOpts> = {}): DevRoutesOpts {
  return {
    state: {
      config: makeConfig(),
      registeredUis: [makeUi("notes"), makeUi("gitcoin-brain")],
    },
    enforceScopeFn: allowAll,
    logger: silentLogger,
    watcherFns: makeFakeWatcherFns(),
    ...overrides,
  };
}

/**
 * Helper: dispatch a request through `routeDev`, assert the route handled
 * it, and return the resolved Response. Centralizes the
 * `if (!out.handled) throw` boilerplate so the test bodies stay short.
 */
async function dispatch(req: Request, opts: DevRoutesOpts): Promise<Response> {
  const out = routeDev(req, opts);
  if (!out.handled) throw new Error(`route did not handle ${req.method} ${req.url}`);
  return out.response;
}

beforeEach(() => {
  resetDevMode();
});

afterEach(() => {
  resetDevMode();
});

describe("dev-routes — enable / disable / status / list", () => {
  test("POST /surface/<name>/dev/enable flips state on", async () => {
    const req = new Request("http://x/surface/notes/dev/enable", { method: "POST" });
    const res = await dispatch(req, makeOpts());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; enabled: boolean; enabledAt: number };
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);
    expect(body.enabledAt).toBeGreaterThan(0);
    expect(isDevMode("notes")).toBe(true);
  });

  test("POST /surface/<name>/dev/enable on missing UI → 404", async () => {
    const req = new Request("http://x/surface/nope/dev/enable", { method: "POST" });
    const res = await dispatch(req, makeOpts());
    expect(res.status).toBe(404);
  });

  test("POST /surface/<name>/dev/enable when dev_mode_allowed=false → 409", async () => {
    const opts = makeOpts({
      state: {
        config: makeConfig({ dev_mode_allowed: false }),
        registeredUis: [makeUi("notes")],
      },
    });
    const req = new Request("http://x/surface/notes/dev/enable", { method: "POST" });
    const res = await dispatch(req, opts);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("dev_mode_disabled");
  });

  test("POST /surface/<name>/dev/disable flips state off + reports was_on", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    expect(isDevMode("notes")).toBe(true);

    const res = await dispatch(
      new Request("http://x/surface/notes/dev/disable", { method: "POST" }),
      makeOpts(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; was_on: boolean };
    expect(body.ok).toBe(true);
    expect(body.was_on).toBe(true);
    expect(isDevMode("notes")).toBe(false);
  });

  test("POST /surface/<name>/dev/disable when already off → was_on=false", async () => {
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/disable", { method: "POST" }),
      makeOpts(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { was_on: boolean };
    expect(body.was_on).toBe(false);
  });

  test("GET /surface/<name>/dev returns status", async () => {
    const res = await dispatch(new Request("http://x/surface/notes/dev"), makeOpts());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  test("GET /surface/dev/list reports enabled UIs", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    await dispatch(
      new Request("http://x/surface/gitcoin-brain/dev/enable", { method: "POST" }),
      makeOpts(),
    );

    const res = await dispatch(new Request("http://x/surface/dev/list"), makeOpts());
    const body = (await res.json()) as {
      uis: Array<{ name: string; enabled: boolean }>;
    };
    expect(body.uis.length).toBe(2);
    expect(body.uis.map((u) => u.name).sort()).toEqual(["gitcoin-brain", "notes"]);
  });
});

describe("dev-routes — trigger", () => {
  test("POST /surface/<name>/dev/trigger 409s when dev mode is off", async () => {
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/trigger", { method: "POST" }),
      makeOpts(),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("dev_mode_off");
  });

  test("POST /surface/<name>/dev/trigger broadcasts when dev mode is on", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    const sseRes = await dispatch(new Request("http://x/surface/notes/_dev/reload"), makeOpts());
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    // Consume the initial keepalive comment.
    const first = await reader.read();
    expect(first.value).toBeTruthy();
    expect(subscriberCount("notes")).toBe(1);

    const res = await dispatch(
      new Request("http://x/surface/notes/dev/trigger", { method: "POST" }),
      makeOpts(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notified: number };
    expect(body.notified).toBe(1);

    const next = await reader.read();
    const frame = new TextDecoder().decode(next.value);
    expect(frame).toContain("event: reload");
    expect(frame).toMatch(/data: \{"timestamp":\d+\}/);

    await reader.cancel();
  });
});

describe("dev-routes — SSE stream", () => {
  test("GET /surface/<name>/_dev/reload 404s when dev mode is off", async () => {
    const res = await dispatch(new Request("http://x/surface/notes/_dev/reload"), makeOpts());
    expect(res.status).toBe(404);
  });

  test("GET /surface/<name>/_dev/reload returns text/event-stream when on", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    const res = await dispatch(new Request("http://x/surface/notes/_dev/reload"), makeOpts());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(subscriberCount("notes")).toBe(1);

    await res.body!.cancel();
    // Bun pumps the cancel callback async — give it a tick to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(subscriberCount("notes")).toBe(0);
  });

  test("disable closes active SSE streams", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    const res = await dispatch(new Request("http://x/surface/notes/_dev/reload"), makeOpts());
    expect(subscriberCount("notes")).toBe(1);

    await dispatch(new Request("http://x/surface/notes/dev/disable", { method: "POST" }), makeOpts());
    expect(subscriberCount("notes")).toBe(0);
    await res.body!.cancel();
  });
});

describe("dev-routes — Phase 3.0 watcher wiring", () => {
  test("enable starts the watcher with the UI's root + meta dev_* fields", async () => {
    const watcherFns = makeFakeWatcherFns();
    const ui = makeUi("notes");
    ui.meta.dev_watch_dir = "src";
    ui.meta.dev_build_cmd = "bun run build";
    const opts = makeOpts({
      state: { config: makeConfig(), registeredUis: [ui] },
      watcherFns,
    });
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/enable", { method: "POST" }),
      opts,
    );
    expect(res.status).toBe(200);
    expect(watcherFns.startCalls.length).toBe(1);
    expect(watcherFns.startCalls[0]).toMatchObject({
      name: "notes",
      uiRootDir: "/tmp/notes",
      watchDir: "src",
      buildCmd: "bun run build",
    });
    const body = (await res.json()) as {
      watcher: { watching: boolean; watchDir: string; debounceMs: number; buildCmd: string | null };
    };
    expect(body.watcher.watching).toBe(true);
    expect(body.watcher.buildCmd).toBe("bun run build");
  });

  test("enable surfaces a watcher warning when startWatcher throws DevWatcherError", async () => {
    const watcherFns = makeFakeWatcherFns({
      startWatcher: () => {
        throw new DevWatcherError("watch dir does not exist: /tmp/foo", "watch_dir_missing");
      },
    });
    const opts = makeOpts({ watcherFns });
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/enable", { method: "POST" }),
      opts,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      watcher: { watching: boolean; warning?: string };
    };
    // Dev mode still flipped on — the watcher is best-effort.
    expect(body.enabled).toBe(true);
    expect(body.watcher.watching).toBe(false);
    expect(body.watcher.warning).toContain("watch dir does not exist");
  });

  test("disable stops the watcher", async () => {
    const watcherFns = makeFakeWatcherFns();
    const opts = makeOpts({ watcherFns });
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), opts);
    expect(watcherFns.watching.has("notes")).toBe(true);
    await dispatch(new Request("http://x/surface/notes/dev/disable", { method: "POST" }), opts);
    expect(watcherFns.stopCalls).toContain("notes");
    expect(watcherFns.watching.has("notes")).toBe(false);
  });

  test("status endpoint surfaces watcher info", async () => {
    const watcherFns = makeFakeWatcherFns();
    const opts = makeOpts({ watcherFns });
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), opts);
    const res = await dispatch(new Request("http://x/surface/notes/dev"), opts);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      watcher: { watching: boolean; watchDir?: string };
    };
    expect(body.watcher.watching).toBe(true);
    expect(body.watcher.watchDir).toBe("/tmp/notes");
  });

  test("list endpoint reports watcher info per UI", async () => {
    const watcherFns = makeFakeWatcherFns();
    const opts = makeOpts({ watcherFns });
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), opts);
    const res = await dispatch(new Request("http://x/surface/dev/list"), opts);
    const body = (await res.json()) as {
      uis: Array<{ name: string; watcher?: { watching: boolean } }>;
    };
    expect(body.uis.length).toBe(1);
    expect(body.uis[0]?.watcher?.watching).toBe(true);
  });
});

describe("dev-routes — auth gates", () => {
  test("enable returns the forwarded 401 from enforceScopeFn", async () => {
    const opts = makeOpts({
      enforceScopeFn: async () => Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/enable", { method: "POST" }),
      opts,
    );
    expect(res.status).toBe(401);
  });

  test("trigger returns the forwarded 403 when scope is insufficient", async () => {
    const opts = makeOpts({
      enforceScopeFn: async () => Response.json({ error: "Forbidden" }, { status: 403 }),
    });
    const res = await dispatch(
      new Request("http://x/surface/notes/dev/trigger", { method: "POST" }),
      opts,
    );
    expect(res.status).toBe(403);
  });

  test("SSE stream is unauthenticated — UI's JS reads it pre-token", async () => {
    await dispatch(new Request("http://x/surface/notes/dev/enable", { method: "POST" }), makeOpts());
    const res = await dispatch(new Request("http://x/surface/notes/_dev/reload"), makeOpts());
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });
});
