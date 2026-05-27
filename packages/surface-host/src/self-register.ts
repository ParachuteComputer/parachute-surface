/**
 * `selfRegister()` — stamp app's entry into `~/.parachute/services.json`
 * on `parachute-surface serve` boot.
 *
 * Why this exists, in one sentence: hub-as-supervisor (v0.6) reads
 * `~/.parachute/services.json` to know which modules exist on the host; a
 * module that doesn't self-register is invisible to `parachute status`,
 * `parachute restart`, the admin SPA module catalog, and the live
 * `/.well-known/parachute.json` builder.
 *
 * Two reads from the file before we write:
 *   1. The existing row's `port` is preserved on subsequent boots so an
 *      operator (or hub) who set `app.port = 1948` in services.json stays
 *      at 1948 across restarts — even if the env var that pointed app at
 *      1948 is later unset. Same first-boot-vs-subsequent-boot rule
 *      scribe + agent + runner settled (scribe#40, paraclaw#145).
 *   2. The existing row's hub-stamped fields (`installDir` from
 *      parachute-hub#84, future `uiUrl` / `managementUrl`) merge through
 *      because `upsertService` spreads `entry` last. We re-stamp our own
 *      `installDir = PROJECT_ROOT` regardless — hub#293/#302 made the
 *      runtime install path stamp installDir, and we want services.json
 *      to keep that resolution after a `git pull` moves the checkout.
 *
 * Failure mode: any error during the write is logged + swallowed by the
 * caller (see `serve()` in `src/index.ts`). The daemon still serves locally
 * if services.json is unwritable, malformed, or fights with a concurrent
 * writer — the operator just won't see app in `parachute status` until the
 * underlying issue clears.
 *
 * Phase 1.2 hook: this function writes only the module-level row today.
 * When per-UI `uis` map lands (design doc section 12), the caller assembles
 * the `uis` field and passes it through via `extraFields`.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import pkg from "../package.json" with { type: "json" };
import { type ServiceEntry, readServiceEntry, upsertService } from "./services-manifest.ts";

/**
 * The canonical services.json row key for the app module — sourced from
 * `.parachute/module.json#manifestName`. Hub looks up modules in
 * services.json by `manifestName` (vault + scribe use this convention), so
 * self-registering under the short name "app" would create a duplicate row
 * alongside the hub-installed `parachute-surface` row and trip hub's
 * duplicate-port detector on re-read. See parachute-patterns or the
 * `manifestName` field on .parachute/module.json files. */
const ROW_NAME = resolveManifestName();

function resolveManifestName(): string {
  // Read once at module load — `.parachute/module.json` ships in the
  // package and doesn't change at runtime.
  try {
    const manifestPath = path.resolve(import.meta.dir, "..", ".parachute", "module.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as { manifestName?: unknown };
    if (typeof raw.manifestName === "string" && raw.manifestName.length > 0) {
      return raw.manifestName;
    }
  } catch {
    // Fall through to the conservative fallback. The module.json is part
    // of the published package, so this branch is effectively unreachable
    // in production — it exists so tests that mount a stub package layout
    // don't hard-crash on import.
  }
  return "parachute-surface";
}

export type SelfRegisterOpts = {
  /**
   * The port app just bound. Used only as the first-run fallback — if
   * services.json already has an entry, we re-stamp the existing port
   * unchanged to preserve operator/hub overrides.
   */
  boundPort: number;
  /**
   * Absolute path to the app package root (where `.parachute/` and
   * `package.json` live). Stamped as `installDir` so hub can resolve
   * `parachute restart app` back to this checkout.
   */
  installDir: string;
  /**
   * Additional fields to merge into the row — used for the per-UI `uis` map
   * (Phase 1.2) and any future schema extensions without touching this
   * function's signature.
   */
  extraFields?: Record<string, unknown>;
  /**
   * Override the services.json location (tests). Defaults to
   * `$PARACHUTE_HOME/services.json`.
   */
  manifestPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type SelfRegisterResult = {
  ok: boolean;
  /** The path we wrote to (or attempted to write to). */
  manifestPath: string;
  /** True when services.json already had a row for `parachute-surface` before we wrote. */
  hadExistingEntry: boolean;
  /** The port we ended up stamping (existing-entry port or boundPort). */
  portWritten: number;
  /** Set when ok=false — the error swallowed by the caller. */
  error?: Error;
};

/**
 * Self-register app's services.json entry. Best-effort: returns
 * `{ok: false, error}` on any failure rather than throwing, so the caller's
 * "log + continue" branch is one shape regardless of failure mode.
 *
 * Idempotent against repeated calls — the canonical case is `serve()`
 * invoking this once per boot, but if the daemon restarts in-process or a
 * Phase 1.2 UI add/remove re-runs the registration to refresh the `uis`
 * map, repeated calls converge to the same disk state.
 */
export function selfRegister(opts: SelfRegisterOpts): SelfRegisterResult {
  const logger = opts.logger ?? console;
  const manifestPath = opts.manifestPath; // undefined → resolveManifestPath() default

  let existing: ServiceEntry | undefined;
  try {
    existing = readServiceEntry(ROW_NAME, manifestPath);
  } catch (e) {
    const err = e as Error;
    logger.warn(`[app] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: false,
      portWritten: opts.boundPort,
      error: err,
    };
  }

  // Treat a POISONED existing port (e.g. left over from the rc.10
  // bootstrap-completion bug that wrote port=0) the same as a missing
  // row — fall through to boundPort so a fresh restart can heal the
  // corruption. Without this guard, an existing port=0 row stays at 0
  // forever even after the operator upgrades to a fixed version.
  const existingPortIsValid =
    existing?.port !== undefined &&
    Number.isInteger(existing.port) &&
    existing.port > 0 &&
    existing.port <= 65535;
  const portToWrite = existingPortIsValid ? (existing as ServiceEntry).port : opts.boundPort;
  // Defensive: reject invalid ports BEFORE writing rather than
  // corrupting services.json + waiting for hub to barf on read. Hub's
  // validator rejects any port not in [1, 65535] — this guard matches.
  // Caller paths to be aware of:
  //   - serve() passes `server.port` (always a real bound port)
  //   - runBootstrap() passes the same boundPort threaded from serve()
  //   - admin-routes selfRegister calls also use real ports
  // The legacy hardcoded `boundPort: 0` in runBootstrap (pre-parachute-app#33)
  // hit this exact failure mode when `existing` was undefined.
  if (!Number.isInteger(portToWrite) || portToWrite <= 0 || portToWrite > 65535) {
    const err = new Error(
      `selfRegister: invalid port ${portToWrite} (existing=${existing?.port}, boundPort=${opts.boundPort}); refusing to corrupt services.json`,
    );
    logger.warn(`[app] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: existing !== undefined,
      portWritten: portToWrite,
      error: err,
    };
  }
  const entry: ServiceEntry = {
    name: ROW_NAME,
    port: portToWrite,
    paths: ["/surface", "/.parachute"],
    health: "/surface/healthz",
    version: pkg.version,
    displayName: "App",
    tagline:
      "Host module for custom Parachute UIs — drop a built bundle in and serve it under one origin.",
    installDir: opts.installDir,
    ...(opts.extraFields ?? {}),
  };

  try {
    upsertService(entry, manifestPath);
  } catch (e) {
    const err = e as Error;
    logger.warn(`[app] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: existing !== undefined,
      portWritten: portToWrite,
      error: err,
    };
  }

  logger.log(
    `[app] self-registered services.json entry (port=${portToWrite}, installDir=${opts.installDir}${existing ? ", existing entry merged" : ", first boot"})`,
  );
  return {
    ok: true,
    manifestPath: manifestPath ?? "~/.parachute/services.json",
    hadExistingEntry: existing !== undefined,
    portWritten: portToWrite,
  };
}

/**
 * Resolve the app package root — the directory containing
 * `.parachute/module.json` + `package.json`. `import.meta.dir` points at
 * `src/`; walk up one level. Matches the resolver in `http-server.ts`'s
 * `defaultParachuteDir()`.
 */
export function resolveProjectRoot(): string {
  return path.resolve(import.meta.dir, "..");
}
