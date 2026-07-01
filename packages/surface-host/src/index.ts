/**
 * @openparachute/surface — library entry.
 *
 * Phase 1.1 wires the public surface: `serve` starts the long-running daemon
 * that scans `$PARACHUTE_HOME/surface/uis/`, mounts each declared UI at its
 * declared path, serves the bundle with smart cache headers + SPA-routing
 * fallback, and self-registers into `~/.parachute/services.json`. Admin
 * verbs (`addUi`, `removeUi`, `listUis`, `reloadUi`) and dev mode
 * (`setDevMode`) land in Phase 1.2 / 1.3.
 *
 * See the design doc:
 *   https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md
 */

import { VaultClient } from "@openparachute/surface-client/vault-client";

import pkg from "../package.json" with { type: "json" };

import { addUiInternal, buildSelfRegisterExtraFields } from "./admin-routes.ts";
import { getHubOrigin } from "./auth.ts";
import { BackendSupervisor } from "./backend-supervisor.ts";
import { maybeBootstrapDefaultApps } from "./bootstrap.ts";
import { type AppConfig, loadConfig, resolveConfigPath, resolveUisDir } from "./config.ts";
import { startCredentialRenewal } from "./credential-renewal.ts";
import {
  createCredentialTokenProvider,
  createPendingCredentialGate,
  resolveDiscoveryCredential,
} from "./credential-store.ts";
import { selfHealRedirectUris } from "./dcr.ts";
import { disableDevMode, enableDevMode } from "./dev-mode.ts";
import { stopAllWatchers } from "./dev-watcher.ts";
import { createHostContextBuilder } from "./host-context.ts";
import { type AppState, startHttpServer } from "./http-server.ts";
import { readOperatorToken } from "./operator-token.ts";
import { resolveProjectRoot, selfRegister } from "./self-register.ts";
import { type SurfaceDiscoveryResult, runSurfaceDiscovery } from "./surface-discovery.ts";
import { scanUis } from "./ui-registry.ts";

// Re-export everything so callers can drop down to a specific layer
// without an import-path puzzle.
export * from "./config.ts";
export * from "./meta-schema.ts";
export * from "./cache-headers.ts";
export * from "./ui-registry.ts";
export * from "./services-manifest.ts";
export * from "./auth.ts";
export * from "./operator-token.ts";
export * from "./dcr.ts";
export * from "./npm-fetch.ts";
export {
  pullSurfaceSource,
  buildSurface,
  constrainedSubprocessRunner,
  GitDeployError,
  DEFAULT_BUILD_TIMEOUT_MS,
  type GitSpawnFn,
  type BuildRunner,
  type BuildRunResult,
  type PullSourceOpts,
  type BuildSurfaceOpts,
  type BuildSurfaceResult,
} from "./git-deploy.ts";
export * from "./dev-mode.ts";
export * from "./dev-injection.ts";
export * from "./dev-watcher.ts";
export {
  routeAdmin,
  buildUisExtraFieldForBoot,
  buildSelfRegisterExtraFields,
  addUiInternal,
  type AdminHandlerOpts,
  type AdminMutableState,
  type AddRequestBody,
  type AddUiInternalResult,
  type SerializedUi,
} from "./admin-routes.ts";
export {
  maybeBootstrapDefaultApps,
  type BootstrapOpts,
  type BootstrapResult,
  type BootstrapAddFn,
} from "./bootstrap.ts";
export {
  provisionSchemaForUi,
  type ProvisionSchemaOpts,
  type ProvisionSchemaResult,
} from "./provision-schema.ts";
export { routeDev, type DevRoutesOpts } from "./dev-routes.ts";
export * from "./backend-types.ts";
export {
  BackendSupervisor,
  mountSpecFor,
  DEFAULT_CRASH_LOOP_MAX,
  DEFAULT_CRASH_LOOP_WINDOW_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type BackendSupervisorOpts,
} from "./backend-supervisor.ts";
export * from "./host-context.ts";
export * from "./credential-store.ts";
export * from "./credential-renewal.ts";
export * from "./security-headers.ts";
export { createSurfaceWsHandlers, type SurfaceWsData, type SurfaceWsDeps } from "./backend-ws.ts";
export { ScopedVaultClient, type ScopedVaultClientOptions } from "./scoped-vault-client.ts";
export {
  SurfaceStateStore,
  type SurfaceStateEntry,
  type SurfaceStateEntryMeta,
} from "./surface-state-store.ts";
export { resolveProjectRoot, selfRegister } from "./self-register.ts";
export type { SelfRegisterOpts, SelfRegisterResult } from "./self-register.ts";
export {
  runSurfaceDiscovery,
  discoverDeclaredSurfaces,
  registerDeclaredSurfaces,
  parseSurfaceNote,
  SURFACE_TAG,
  type DeclaredSurface,
  type SkippedSurface,
  type SurfaceDiscoveryResult,
} from "./surface-discovery.ts";
export { startHttpServer } from "./http-server.ts";
export type { AppState, HttpServerOpts } from "./http-server.ts";

/** Package semver. */
export const VERSION: string = pkg.version;

/** Default healthz port (per design doc + canonical-ports pattern, app claims 1946). */
export const DEFAULT_PORT = 1946;

/** Default mount path for app under hub's reverse proxy. */
export const DEFAULT_MOUNT = "/surface";

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
  /**
   * Override the absolute path to the built admin SPA bundle (tests). Defaults
   * to `<package-root>/dist/admin/`.
   */
  adminDir?: string;
  /** Inject fetch for DCR calls (tests). */
  fetchFn?: import("./dcr.ts").FetchFn;
  /** Override the operator-token resolver (tests). */
  operatorTokenOverride?: () => string | undefined;
  /** Override the npm-fetch spawner (tests). */
  npmSpawnFn?: import("./npm-fetch.ts").NpmSpawnFn;
  /**
   * Skip the first-boot default-app bootstrap (tests + CI). When omitted,
   * bootstrap runs iff `state.registeredUis.length === 0` AND
   * `config.bootstrap_default_apps.enabled === true`.
   */
  skipBootstrap?: boolean;
  /**
   * Return a promise from `serve()` that callers can await to know when
   * bootstrap is complete (tests). Production `serve()` callers don't
   * need this; bootstrap is fire-and-forget for the daemon.
   */
  awaitBootstrap?: boolean;
  /**
   * Override the credentials dir (tests). Defaults to
   * `resolveCredentialsDir()` — `$PARACHUTE_HOME/surface/credentials/`.
   */
  credentialsDir?: string;
  /** Skip the boot-time credential renewal sweep + loop (tests). */
  skipCredentialRenewal?: boolean;
  /**
   * Skip the boot-time OAuth-redirect-uri self-heal sweep (tests). When
   * omitted, the sweep runs once on boot: any UI whose stored
   * `.oauth-client.json` is missing a currently-known hub origin's
   * redirect_uris (the surface#118 loopback-then-expose case) is
   * re-registered. Best-effort; never blocks startup.
   */
  skipRedirectSelfHeal?: boolean;
  /**
   * Skip the boot-time `#surface` discovery sweep (tests + CI). When omitted, the
   * sweep runs once on boot: query the vault for `tag:surface` (with a custodied
   * read credential), then register each declared surface with the hub
   * (`POST /admin/surfaces`) so its bare repo is provisioned + gated. Best-effort;
   * never blocks startup. Skips cleanly when no read credential / operator token
   * is available.
   */
  skipSurfaceDiscovery?: boolean;
  /** Vault the discovery sweep queries for `#surface` notes. Defaults to `"default"`. */
  discoveryVault?: string;
  /**
   * Inject the vault query fn for the discovery sweep (tests). When omitted,
   * serve() builds one over a custodied read credential (or skips if none).
   */
  discoveryQueryNotes?: (
    q: import("@openparachute/surface-client").NotesQueryInput,
  ) => Promise<import("@openparachute/surface-client").Note[]>;
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
  /**
   * Resolves once first-boot bootstrap completes. `undefined` when
   * bootstrap was skipped (state non-empty or `skipBootstrap: true`).
   * Tests `await handle.bootstrap` to assert post-bootstrap state.
   */
  bootstrap?: Promise<import("./bootstrap.ts").BootstrapResult>;
  /**
   * Resolves once the boot-time backend mount pass (P5) completes.
   * Mounting is fire-and-forget for the daemon (the HTTP server is up
   * first; a backed surface 503s its api namespace until mounted); tests
   * await this to assert post-mount state.
   */
  backendsReady?: Promise<void>;
  /**
   * Resolves once the boot-time OAuth-redirect-uri self-heal sweep
   * completes (surface#118). `undefined` when skipped. Fire-and-forget for
   * the daemon; tests await it to assert re-registration happened.
   */
  redirectSelfHeal?: Promise<import("./dcr.ts").RedirectSelfHealOutcome>;
  /**
   * Resolves once the boot-time `#surface` discovery sweep completes.
   * `undefined` when skipped. Fire-and-forget for the daemon; tests await it to
   * assert which surfaces were discovered + registered.
   */
  surfaceDiscovery?: Promise<SurfaceDiscoveryResult>;
};

/**
 * Long-running daemon: scan `$PARACHUTE_HOME/surface/uis/`, mount each UI at its
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

  // Backend supervisor (P5) — mounts every backed surface's server entry
  // with the full host context (P2): ScopedVaultClient + SurfaceStateStore
  // + hub-stamped trust readers. The vault token provider reads the
  // HOST-custodied credential store fresh per request (P3) — deliveries +
  // renewals take effect without a remount. A surface that declares
  // scopes_required with NO stored credential yet parks in
  // "pending-credential" (#101) — the factory runs when the credential
  // lands (delivery endpoint / binding change / reload) instead of
  // blocking the add/boot path awaiting a token that can't exist yet.
  const backends = new BackendSupervisor({
    buildContext: createHostContextBuilder({
      config,
      logger,
      tokenProviderFor: (ui) =>
        createCredentialTokenProvider(ui, {
          ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
          getConfig: () => state.config,
        }),
    }),
    pendingCredentialReason: createPendingCredentialGate({
      ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
      getConfig: () => state.config,
    }),
    logger,
  });
  state.backends = backends;

  const startedAt = new Date();
  const server = startHttpServer({
    state,
    port,
    hostname,
    startedAt,
    logger,
    parachuteDir: opts.parachuteDir,
    serveFn: opts.serveFn,
    adminDir: opts.adminDir,
    adminOpts: {
      uisDir: opts.uisDir,
      manifestPath: opts.manifestPath,
      fetchFn: opts.fetchFn,
      operatorTokenOverride: opts.operatorTokenOverride,
      npmSpawnFn: opts.npmSpawnFn,
      logger,
      skipSelfRegisterRefresh: opts.skipSelfRegister,
      ...(opts.credentialsDir !== undefined ? { credentialsDir: opts.credentialsDir } : {}),
      // PATCH /surface/api/config persists to the same file serve() loaded.
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    },
  });

  logger.log(
    `[app] Listening on http://${hostname}:${server.port} — ${state.registeredUis.length} UI${
      state.registeredUis.length === 1 ? "" : "s"
    } hosted${state.skippedUis.length > 0 ? ` (${state.skippedUis.length} skipped)` : ""}`,
  );
  for (const ui of state.registeredUis) {
    logger.log(`[app]   ${ui.meta.path} → ${ui.meta.displayName} (${ui.meta.name})`);
  }

  // Phase 2.1 — first-boot default-app bootstrap. Runs only when no UIs
  // are mounted (fresh install). Best-effort; failures log + continue so
  // a network blip or unpublished package doesn't prevent daemon
  // startup.
  // `server.port` is `number | undefined` per Bun's types (it's undefined
  // when the server uses unix sockets, which we don't here) — fall back to
  // the operator's requested port. Both paths produce a `number`.
  const portWritten = server.port ?? port;

  // Boot-time backend mount pass (P5). Fire-and-forget: the HTTP server is
  // already up (a backed surface 503s its api namespace until its mount
  // lands); failures are contained per-surface inside sync().
  const backendsReady = backends
    .sync(state.registeredUis)
    .catch((e) => logger.warn(`[app] backend mount pass failed: ${(e as Error).message}`));

  // Credential renewal (P3): boot sweep + interval loop, renewing each
  // custodied credential against the hub by proof of possession before it
  // expires. Terminal 401s mark the credential needs-operator (no retry
  // spin); the loop never pins the process (unref'd timer) and stops on
  // shutdown.
  const renewal = opts.skipCredentialRenewal
    ? undefined
    : startCredentialRenewal({
        hubOrigin: getHubOrigin(config.hub_url),
        ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
        logger,
      });

  // OAuth redirect-uri self-heal (surface#118). A surface installed while the
  // box was loopback-only registered only loopback redirect_uris; once the
  // operator runs `parachute expose`, the browser's public-origin redirect_uri
  // is unregistered and sign-in fails ("Redirect mismatch"). On each boot, any
  // UI whose stored client is missing a now-known hub origin is re-registered.
  // Fire-and-forget — best-effort, never blocks startup; retried next boot on
  // failure. Mirrors the credential-renewal boot sweep above.
  const redirectSelfHeal = opts.skipRedirectSelfHeal
    ? undefined
    : selfHealRedirectUris({
        uis: state.registeredUis,
        hubUrl: config.hub_url,
        operatorToken:
          (opts.operatorTokenOverride
            ? opts.operatorTokenOverride()
            : readOperatorToken({ logger })) ?? undefined,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
        logger,
      }).catch((e) => {
        logger.warn(`[app] redirect self-heal sweep failed: ${(e as Error).message}`);
        return {
          checked: 0,
          reregistered: [],
          upToDate: [],
          failed: [],
        } satisfies import("./dcr.ts").RedirectSelfHealOutcome;
      });

  // `#surface` discovery (Surface Git Transport Phase 1). Query the vault for
  // `tag:surface` (with a custodied read credential) and register each declared
  // surface with the hub (`POST /admin/surfaces`) so its bare repo is
  // provisioned + the git endpoint gates provisioning on it — "vault declares,
  // hub authenticates." Fire-and-forget, best-effort: skips cleanly when there's
  // no usable read credential or operator token. Mirrors the boot sweeps above.
  // (Phase 1b: periodic re-scan / live-query so a note created post-boot is
  // picked up without a restart — today it's boot-only.)
  const surfaceDiscovery = opts.skipSurfaceDiscovery
    ? undefined
    : (() => {
        // The whole IIFE body (the synchronous credential resolution + client
        // construction, not just the async sweep) is wrapped so NOTHING here can
        // throw out of serve() and abort startup — discovery is strictly
        // best-effort. The inner `.catch` handles async rejections; this outer
        // try/catch handles a synchronous throw (a malformed cred, a bad hub_url).
        try {
          const discoveryVault = opts.discoveryVault ?? "default";
          const operatorToken =
            (opts.operatorTokenOverride
              ? opts.operatorTokenOverride()
              : readOperatorToken({ logger })) ?? undefined;
          // Query fn: injected (tests) or built over a custodied read credential.
          let queryNotes = opts.discoveryQueryNotes;
          if (!queryNotes) {
            const cred = resolveDiscoveryCredential(discoveryVault, {
              ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
            });
            if (cred) {
              // Production uses the global fetch; tests inject `discoveryQueryNotes`
              // directly (so the VaultClient path isn't exercised under test).
              const client = VaultClient.fromHub({
                hubOrigin: getHubOrigin(config.hub_url),
                vaultName: discoveryVault,
                tokenProvider: () => cred.token,
              });
              queryNotes = (q) => client.queryNotes(q);
            }
          }
          return runSurfaceDiscovery({
            ...(queryNotes !== undefined ? { queryNotes } : {}),
            hubOrigin: getHubOrigin(config.hub_url),
            ...(operatorToken !== undefined ? { operatorToken } : {}),
            ...(opts.fetchFn !== undefined ? { fetchImpl: opts.fetchFn } : {}),
            logger,
          }).catch((e) => {
            logger.warn(`[app] surface discovery sweep failed: ${(e as Error).message}`);
            return {
              declared: [],
              skipped: [],
              registered: [],
              failed: [],
              skipReason: "exception",
            } satisfies SurfaceDiscoveryResult;
          });
        } catch (e) {
          logger.warn(`[app] surface discovery setup failed: ${(e as Error).message}`);
          return Promise.resolve({
            declared: [],
            skipped: [],
            registered: [],
            failed: [],
            skipReason: "setup-exception",
          } satisfies SurfaceDiscoveryResult);
        }
      })();

  let bootstrapPromise: Promise<import("./bootstrap.ts").BootstrapResult> | undefined;
  if (!opts.skipBootstrap && !config.disabled && state.registeredUis.length === 0) {
    // Fire-and-forget — daemon doesn't block on bootstrap. The add path
    // re-scans + swaps state in-place, so subsequent requests pick up
    // the newly-mounted UIs without a restart. The promise is exposed
    // on the handle so tests can `await handle.bootstrap`.
    bootstrapPromise = runBootstrap({
      config,
      uisDir: opts.uisDir ?? resolveUisDir(),
      adminOpts: {
        state,
        uisDir: opts.uisDir,
        manifestPath: opts.manifestPath,
        fetchFn: opts.fetchFn,
        operatorTokenOverride: opts.operatorTokenOverride,
        npmSpawnFn: opts.npmSpawnFn,
        logger,
        // Bootstrap's own callsite owns the post-bootstrap selfRegister;
        // skip the per-add refresh to avoid stamping a stale partial
        // services.json mid-iteration.
        skipSelfRegisterRefresh: true,
      },
      manifestPath: opts.manifestPath,
      skipSelfRegister: opts.skipSelfRegister,
      boundPort: portWritten,
      logger,
    }).catch((e) => {
      logger.warn(`[app] bootstrap failed unexpectedly: ${(e as Error).message}`);
      return { bootstrapped: [], skipped: [], failed: [], skipReason: "exception" };
    });
  }

  if (!opts.skipSelfRegister) {
    selfRegister({
      boundPort: portWritten,
      installDir: resolveProjectRoot(),
      manifestPath: opts.manifestPath,
      extraFields: buildSelfRegisterExtraFields(state.registeredUis),
      logger,
    });
  }

  const stop = async () => {
    logger.log("[app] shutting down");
    // Tear down any dev-mode file watchers so the process exits cleanly.
    // The watcher slots own AbortControllers + FSWatchers; without this
    // the daemon can hang on shutdown until the FSEvents stream closes.
    stopAllWatchers();
    // Stop the credential-renewal loop before the backends go down.
    renewal?.stop();
    // Unmount every backed surface: ctx.shutdownSignal aborts, bounded
    // shutdown() awaited — before the HTTP server drops.
    await backends.stop();
    server.stop();
    logger.log("[app] stopped");
  };

  return {
    config,
    server,
    state,
    stop,
    backendsReady,
    ...(bootstrapPromise ? { bootstrap: bootstrapPromise } : {}),
    ...(redirectSelfHeal ? { redirectSelfHeal } : {}),
    ...(surfaceDiscovery ? { surfaceDiscovery } : {}),
  };
}

/**
 * One-shot: scan UIs + report status, exit. Non-daemon counterpart to
 * `serve` — useful for `parachute-surface list` (Phase 1.2) and config
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

/**
 * Phase 1.3 surface — toggle dev mode for a UI with live reload.
 *
 * The dev-mode API now ships via `./dev-mode.ts`. Callers that want
 * fine-grained control import `enableDevMode` / `disableDevMode` /
 * `broadcastReload` directly. This wrapper stays as the canonical
 * library-level façade for the simple "flip a UI into dev mode" case
 * and keeps the surface stable for downstream consumers.
 */
export function setDevMode(
  name: string,
  enable: boolean,
): { name: string; enabled: boolean; enabledAt: number } {
  const state = enable ? enableDevMode(name) : disableDevMode(name);
  return { name, enabled: state.enabled, enabledAt: state.enabledAt };
}

/**
 * Internal helper — invokes `maybeBootstrapDefaultApps` with a closure
 * that delegates to `addUiInternal` for each declared default app.
 * Exported for tests that want to exercise the wiring without going
 * through the full `serve()` HTTP boot.
 *
 * After the bootstrap iteration completes, if any UIs were added, we
 * call `selfRegister` once so services.json carries the new `uis` map
 * in a single atomic write (vs the per-add stamps the admin path would
 * normally do — `skipSelfRegisterRefresh: true` is set on the addOpts).
 */
export async function runBootstrap(args: {
  config: AppConfig;
  uisDir: string;
  /** Pre-built admin opts — same shape `routeAdmin` consumes. */
  adminOpts: import("./admin-routes.ts").AdminHandlerOpts;
  /** Override the services.json manifest path (tests). */
  manifestPath?: string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Skip post-bootstrap selfRegister (tests). */
  skipSelfRegister?: boolean;
  /**
   * Port the app's HTTP server is bound to. The post-bootstrap selfRegister
   * passes this to `selfRegister.boundPort` as the first-boot fallback.
   * (selfRegister prefers `existing?.port` from services.json when set; this
   * is only the fallback for the edge case where the row is missing.)
   *
   * Hardcoding 0 here previously caused a hub-rejected write when the
   * existing row was somehow missing at bootstrap-completion time —
   * port=0 fails hub's validateEntry. See parachute-app#33 for the
   * specific Render-deploy repro.
   */
  boundPort: number;
}): Promise<import("./bootstrap.ts").BootstrapResult> {
  const logger = args.logger ?? console;
  const result = await maybeBootstrapDefaultApps({
    config: args.config,
    uisDir: args.uisDir,
    logger,
    add: async (spec) => {
      const outcome = await addUiInternal({ source: spec }, args.adminOpts);
      if (!outcome.added) {
        // Surface the underlying error message — best-effort body parse.
        let detail = `HTTP ${outcome.response.status}`;
        try {
          const parsed = (await outcome.response.clone().json()) as {
            error?: string;
            message?: string;
          };
          detail = parsed.message ?? parsed.error ?? detail;
        } catch {
          // ignore
        }
        throw new Error(detail);
      }
      return { name: outcome.added.meta.name, path: outcome.added.meta.path };
    },
  });

  // One-shot post-bootstrap services.json refresh: stamps the full uis
  // map atomically so hub's per-request discovery sees the bootstrapped
  // UIs on its next read.
  if (!args.skipSelfRegister && result.bootstrapped.length > 0) {
    try {
      selfRegister({
        boundPort: args.boundPort,
        installDir: resolveProjectRoot(),
        manifestPath: args.manifestPath,
        extraFields: buildSelfRegisterExtraFields(args.adminOpts.state.registeredUis),
        logger,
      });
    } catch (e) {
      logger.warn(`[app] bootstrap: services.json refresh failed: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Expose canonical resolvers for the bin. */
export { resolveConfigPath, resolveUisDir };
