/**
 * @openparachute/app — library entry.
 *
 * Phase 1.1 wires the public surface: `serve` starts the long-running daemon
 * that scans `$PARACHUTE_HOME/app/uis/`, mounts each declared UI at its
 * declared path, serves the bundle with smart cache headers + SPA-routing
 * fallback, and self-registers into `~/.parachute/services.json`. Admin
 * verbs (`addUi`, `removeUi`, `listUis`, `reloadUi`) and dev mode
 * (`setDevMode`) land in Phase 1.2 / 1.3.
 *
 * See the design doc:
 *   https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md
 */

import pkg from "../package.json" with { type: "json" };

import { type AppConfig, loadConfig, resolveConfigPath, resolveUisDir } from "./config.ts";
import { type AppState, startHttpServer } from "./http-server.ts";
import { resolveProjectRoot, selfRegister } from "./self-register.ts";
import { scanUis } from "./ui-registry.ts";

// Re-export everything so callers can drop down to a specific layer
// without an import-path puzzle.
export * from "./config.ts";
export * from "./meta-schema.ts";
export * from "./cache-headers.ts";
export * from "./ui-registry.ts";
export * from "./services-manifest.ts";
export { resolveProjectRoot, selfRegister } from "./self-register.ts";
export type { SelfRegisterOpts, SelfRegisterResult } from "./self-register.ts";
export { startHttpServer } from "./http-server.ts";
export type { AppState, HttpServerOpts } from "./http-server.ts";

/** Package semver. */
export const VERSION: string = pkg.version;

/** Default healthz port (per design doc + canonical-ports pattern, app claims 1946). */
export const DEFAULT_PORT = 1946;

/** Default mount path for app under hub's reverse proxy. */
export const DEFAULT_MOUNT = "/app";

export type ServeOptions = {
  /** Override the healthz port. Defaults to `DEFAULT_PORT` (1946). */
  port?: number;
  /** Override the config path (tests). Defaults to `resolveConfigPath()`. */
  configPath?: string;
  /** Override the uis-dir location (tests). Defaults to `resolveUisDir()`. */
  uisDir?: string;
  /** Override the bind hostname (tests). Defaults to `127.0.0.1`. */
  hostname?: string;
  /** Override the services.json path (tests). */
  manifestPath?: string;
  /** Skip self-registration (tests don't want to touch `~/.parachute/`). */
  skipSelfRegister?: boolean;
  /** Override `.parachute/` location (tests). */
  parachuteDir?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Override `Bun.serve` (tests). Lets us assert on the dispatched config
   * without binding a real port.
   */
  serveFn?: typeof Bun.serve;
};

export type ServeHandle = {
  /** The currently-resolved app config. */
  config: AppConfig;
  /** The running HTTP server — `server.stop()` for graceful shutdown. */
  server: ReturnType<typeof Bun.serve>;
  /** The mutable state object. */
  state: AppState;
  /** Stop the daemon. */
  stop: () => Promise<void>;
};

/**
 * Long-running daemon: scan `$PARACHUTE_HOME/app/uis/`, mount each UI at its
 * declared path, serve the bundle with smart cache headers + SPA fallback.
 *
 * Phase 1.1: discovery is one-shot at startup. Phase 1.2 adds reload + watch.
 *
 * Returns a handle the CLI uses to wire SIGINT/SIGTERM into graceful
 * shutdown.
 */
export function serve(opts: ServeOptions = {}): ServeHandle {
  const logger = opts.logger ?? console;
  const port = opts.port ?? DEFAULT_PORT;
  const hostname = opts.hostname ?? "127.0.0.1";

  const config = loadConfig({ configPath: opts.configPath, logger });

  // Kill-switch: when `config.disabled` is true, skip the UI scan entirely
  // so no bundles are mounted. The HTTP server still binds (healthz + the
  // `.parachute/*` admin surface keep working) so an operator can flip the
  // flag back via the admin SPA (Phase 1.2) without restarting the daemon.
  // Per design doc + reviewer nit 3 — `disabled` was loaded but not honored.
  const scan = config.disabled
    ? { registered: [], skipped: [] as Array<{ dirName: string; status: string; reason: string }> }
    : scanUis({ uisDir: opts.uisDir, logger });

  if (config.disabled) {
    logger.log("[app] disabled (config.disabled=true) — no UIs mounted");
  }

  const state: AppState = {
    config,
    registeredUis: scan.registered,
    skippedUis: scan.skipped.map((s) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    })),
  };

  const startedAt = new Date();
  const server = startHttpServer({
    state,
    port,
    hostname,
    startedAt,
    logger,
    parachuteDir: opts.parachuteDir,
    serveFn: opts.serveFn,
  });

  logger.log(
    `[app] Listening on http://${hostname}:${server.port} — ${state.registeredUis.length} UI${
      state.registeredUis.length === 1 ? "" : "s"
    } hosted${state.skippedUis.length > 0 ? ` (${state.skippedUis.length} skipped)` : ""}`,
  );
  for (const ui of state.registeredUis) {
    logger.log(`[app]   ${ui.meta.path} → ${ui.meta.displayName} (${ui.meta.name})`);
  }

  if (!opts.skipSelfRegister) {
    // `server.port` is `number | undefined` per Bun's types (it's undefined
    // when the server uses unix sockets, which we don't here) — fall back to
    // the operator's requested port. Both paths produce a `number`.
    const portWritten = server.port ?? port;
    selfRegister({
      boundPort: portWritten,
      installDir: resolveProjectRoot(),
      manifestPath: opts.manifestPath,
      logger,
    });
  }

  const stop = async () => {
    logger.log("[app] shutting down");
    server.stop();
    logger.log("[app] stopped");
  };

  return { config, server, state, stop };
}

/**
 * One-shot: scan UIs + report status, exit. Non-daemon counterpart to
 * `serve` — useful for `parachute-app list` (Phase 1.2) and config
 * validation in CI.
 */
export function runOnce(opts: ServeOptions = {}): {
  config: AppConfig;
  state: AppState;
} {
  const logger = opts.logger ?? console;
  const config = loadConfig({ configPath: opts.configPath, logger });
  const scan = scanUis({ uisDir: opts.uisDir, logger });
  const state: AppState = {
    config,
    registeredUis: scan.registered,
    skippedUis: scan.skipped.map((s) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    })),
  };
  logger.log(
    `[app] scan: ${state.registeredUis.length} active, ${state.skippedUis.length} skipped`,
  );
  for (const ui of state.registeredUis) {
    logger.log(`[app]   active  ${ui.meta.path} (${ui.meta.name})`);
  }
  for (const s of state.skippedUis) {
    logger.log(`[app]   skip    ${s.dirName} — ${s.status}: ${s.reason}`);
  }
  return { config, state };
}

/** Phase 1.2 surface — register a new UI under `$PARACHUTE_HOME/app/uis/<name>/`. */
export function addUi(): Promise<never> {
  throw new Error("addUi: not yet implemented (Phase 1.2)");
}

/** Phase 1.2 surface — remove a UI + revoke its OAuth client_id with hub. */
export function removeUi(): Promise<never> {
  throw new Error("removeUi: not yet implemented (Phase 1.2)");
}

/** Phase 1.2 surface — list installed UIs with status, mount path, OAuth client_id. */
export function listUis(): Promise<never> {
  throw new Error("listUis: not yet implemented (Phase 1.2)");
}

/** Phase 1.2 surface — refresh a UI's bundle in-place, no daemon restart. */
export function reloadUi(): Promise<never> {
  throw new Error("reloadUi: not yet implemented (Phase 1.2)");
}

/** Phase 1.3 surface — toggle dev mode for a UI with live reload. */
export function setDevMode(): Promise<never> {
  throw new Error("setDevMode: not yet implemented (Phase 1.3)");
}

/** Expose canonical resolvers for the bin. */
export { resolveConfigPath, resolveUisDir };
