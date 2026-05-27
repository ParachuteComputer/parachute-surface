/**
 * First-boot default-app bootstrap — Phase 2.1.
 *
 * On `parachute-surface serve` startup, when `$PARACHUTE_HOME/surface/uis/` is
 * empty and `config.bootstrap_default_apps.enabled` is true, apps
 * auto-installs each entry in `config.bootstrap_default_apps.apps` via
 * the same npm-fetch pipeline `parachute-surface add` uses.
 *
 * Friend-deploy story: spin up a hub + run `parachute-surface serve`, and
 * Notes is there waiting — no manual `add` step. The operator can
 * always disable this by flipping `bootstrap_default_apps.enabled =
 * false` or setting `apps: []`.
 *
 * Design rationale (design doc Section 16): Notes is the canonical
 * first app installed under parachute-app. The bootstrap registry is
 * the implementation of "Notes ships with app." Future committed-core
 * apps may join the default list; today it's just notes-ui.
 *
 * Failure mode: if npm-fetch fails (network down, package not on
 * registry, registry timeout), log a warning and continue. The
 * operator can run `parachute-surface add @openparachute/notes-ui` later
 * to retry. We never block daemon startup on the bootstrap — the
 * daemon's primary job is hosting whatever's in `uis/` already (which,
 * in the empty case, is "nothing"), and a failed bootstrap is just
 * "nothing got added."
 */

import { readdirSync, statSync } from "node:fs";

import type { AppConfig } from "./config.ts";
import type { NpmSpawnFn, fetchNpmPackage } from "./npm-fetch.ts";

/**
 * Minimal `add` surface bootstrap needs. The full admin handler does
 * staging + meta-merge + DCR + state-swap + services.json refresh;
 * bootstrap reuses that same flow by passing a callback that performs
 * the equivalent (in practice, the caller in `index.ts` adapts the
 * admin handler so bootstrap stays decoupled from admin-routes.ts's
 * `AppState` mutation pattern).
 */
export type BootstrapAddFn = (source: string) => Promise<{ name: string; path: string }>;

export type BootstrapOpts = {
  config: AppConfig;
  /** Resolved uis dir; allows tests to inject a tempdir. */
  uisDir: string;
  /** The npm-fetch entry-point — overridable for tests. */
  npmFetch?: typeof fetchNpmPackage;
  /** The `add` callback — orchestrator wires this to admin-routes' add path. */
  add: BootstrapAddFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** npm-spawn override (tests). Passed to `npmFetch`. */
  npmSpawnFn?: NpmSpawnFn;
};

export type BootstrapResult = {
  /** npm specs of packages successfully added. */
  bootstrapped: string[];
  /** npm specs skipped (per-spec reason). */
  skipped: Array<{ pkg: string; reason: string }>;
  /** npm specs that failed (per-spec error). */
  failed: Array<{ pkg: string; error: string }>;
  /** Why the whole pass was skipped, if it was (else undefined). */
  skipReason?: string;
};

/**
 * Inspect `uisDir` + `config`, then maybe run bootstrap. Returns a
 * summary the caller (`serve()` in index.ts) logs.
 *
 * Skip conditions (any one triggers an early return):
 *   - `config.bootstrap_default_apps.enabled === false`
 *   - `config.bootstrap_default_apps.apps` is empty
 *   - `uisDir` exists AND contains at least one entry (we don't touch
 *     installs the operator already manages)
 *
 * When none of the skip conditions fire: iterate `apps` and call
 * `add(spec)` for each. Each call is independent — a failure on one
 * doesn't stop the rest.
 */
export async function maybeBootstrapDefaultApps(opts: BootstrapOpts): Promise<BootstrapResult> {
  const logger = opts.logger ?? console;
  const result: BootstrapResult = {
    bootstrapped: [],
    skipped: [],
    failed: [],
  };

  if (!opts.config.bootstrap_default_apps.enabled) {
    result.skipReason = "config.bootstrap_default_apps.enabled is false";
    return result;
  }
  if (opts.config.bootstrap_default_apps.apps.length === 0) {
    result.skipReason = "config.bootstrap_default_apps.apps is empty";
    return result;
  }

  if (uisDirHasEntries(opts.uisDir)) {
    result.skipReason = "uisDir is non-empty (existing operator install)";
    return result;
  }

  for (const spec of opts.config.bootstrap_default_apps.apps) {
    try {
      const added = await opts.add(spec);
      result.bootstrapped.push(spec);
      logger.log(`[app] bootstrap: installed ${spec} as ${added.name} at ${added.path}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      result.failed.push({ pkg: spec, error: msg });
      logger.warn(`[app] bootstrap: failed to install ${spec}: ${msg}`);
    }
  }

  if (result.bootstrapped.length > 0) {
    logger.log(
      `[app] bootstrap: installed ${result.bootstrapped.length} default app(s) — ${result.bootstrapped.join(", ")}`,
    );
  }
  return result;
}

/**
 * Predicate: does `uisDir` exist + contain at least one entry that
 * looks like a UI install candidate? A pure missing-directory or a
 * directory containing only hidden files (e.g. `.DS_Store`) counts as
 * "empty" — operators don't deliberately seed UIs as dotfile dirs.
 *
 * We deliberately accept "exists + has at least one non-dotfile
 * entry" — even an entry that doesn't pass `scanUis` (broken meta,
 * missing dist/) signals "operator was here," and bootstrap shouldn't
 * trample.
 */
function uisDirHasEntries(uisDir: string): boolean {
  try {
    const st = statSync(uisDir);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(uisDir);
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    return true;
  }
  return false;
}
