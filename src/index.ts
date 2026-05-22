/**
 * @openparachute/app — library entry. Phase 1.0 scaffold.
 *
 * App is the UI host module for custom Parachute UIs. It supervises a
 * directory of pre-built static bundles (each with a `meta.json`) and
 * serves them under the hub origin. See the design doc for the shape:
 *
 *   parachute.computer/design/2026-05-21-parachute-apps-design.md
 *
 * Phase 1.0 ships only the stub surface — every verb throws
 * `Error("not yet implemented (Phase 1.N)")`. The real implementations
 * land in Phase 1.1 (`serve`, `runOnce`), Phase 1.2 (`addUi`, `removeUi`,
 * `listUis`, `reloadUi`), and Phase 1.3 (`setDevMode`).
 */

import pkg from "../package.json" with { type: "json" };

/** Package semver. */
export const VERSION: string = pkg.version;

/** Default healthz port (per design doc + canonical-ports pattern, app claims 1946). */
export const DEFAULT_PORT = 1946;

/** Default mount path for app under hub's reverse proxy. */
export const DEFAULT_MOUNT = "/app";

/**
 * Start the long-running daemon. Watches `$PARACHUTE_HOME/app/uis/` for
 * declared UIs, mounts each bundle under its declared path, serves
 * SPA-routing fallback, exposes admin endpoints under `/app/admin/`.
 *
 * Phase 1.1.
 */
export function serve(): Promise<never> {
  throw new Error("serve: not yet implemented (Phase 1.1)");
}

/**
 * One-shot: read the declared UIs, validate each `meta.json`, emit a
 * status report, exit. The non-daemon counterpart to `serve` — useful
 * for `parachute-app list` and config validation in CI.
 *
 * Phase 1.1.
 */
export function runOnce(): Promise<never> {
  throw new Error("runOnce: not yet implemented (Phase 1.1)");
}

/**
 * Register a new UI under `$PARACHUTE_HOME/app/uis/<name>/`. Source may
 * be a local path to a built `dist/` directory or an npm package
 * specifier. Persists the resulting OAuth `client_id` (from hub DCR).
 *
 * Phase 1.2.
 */
export function addUi(): Promise<never> {
  throw new Error("addUi: not yet implemented (Phase 1.2)");
}

/**
 * Unregister a UI: removes the `uis/<name>/` directory and revokes the
 * associated OAuth client_id with hub.
 *
 * Phase 1.2.
 */
export function removeUi(): Promise<never> {
  throw new Error("removeUi: not yet implemented (Phase 1.2)");
}

/**
 * List installed UIs with status, mount path, version, OAuth client_id.
 *
 * Phase 1.2.
 */
export function listUis(): Promise<never> {
  throw new Error("listUis: not yet implemented (Phase 1.2)");
}

/**
 * Refresh a UI's bundle in-place — re-read `meta.json`, re-mount, no
 * daemon restart needed.
 *
 * Phase 1.2.
 */
export function reloadUi(): Promise<never> {
  throw new Error("reloadUi: not yet implemented (Phase 1.2)");
}

/**
 * Toggle dev mode for a UI: serve from a developer's source directory
 * with live reload, instead of the installed bundle. `--off` exits dev
 * mode and re-mounts the installed bundle.
 *
 * Phase 1.3.
 */
export function setDevMode(): Promise<never> {
  throw new Error("setDevMode: not yet implemented (Phase 1.3)");
}
