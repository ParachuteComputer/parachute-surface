/**
 * SurfaceHostContext builder (surface-runtime design P2 — the keystone
 * injection). Capability, never secret:
 *
 *   - `vault` — a {@link ScopedVaultClient} over surface-client's
 *     `VaultClient.fromHub` server path. The `tokenProvider` closure reads
 *     the HOST-custodied credential (P3, commit 4); the wrapper exposes no
 *     token accessor and rejects `force` writes.
 *   - `store` — per-surface SQLite ({@link SurfaceStateStore}) under
 *     `$PARACHUTE_HOME/surface/state/`, closed on unmount, file deleted on
 *     surface removal.
 *   - `layer(req)` / `clientIp(req)` — the HUB-stamped substrate trust
 *     headers (design §10): `X-Parachute-Layer` / `X-Parachute-Client-IP`,
 *     exactly the names hub's proxy stamps (and strips inbound at the
 *     public edge — parachute-hub/src/hub-server.ts). FAIL-CLOSED:
 *     direct-to-1946 access carries no stamps → `"public"` / `null`. The
 *     kit ships no `isLocal()`; header-absence is never trust.
 *   - `config` — the surface's own config file
 *     (`<state>/<name>.config.json`, admin-editable), re-read per call so
 *     edits take effect without a remount.
 *   - `log` — `[surface:<name>]`-prefixed into the daemon's stream.
 *   - `mount`, `shutdownSignal` — wired by the supervisor at mount.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getHubOrigin } from "./auth.ts";
import type {
  SurfaceConfigAccess,
  SurfaceHostContext,
  SurfaceLogger,
  TrustLayer,
} from "./backend-types.ts";
import { TRUST_LAYERS } from "./backend-types.ts";
import type { AppConfig } from "./config.ts";
import { ScopedVaultClient } from "./scoped-vault-client.ts";
import { SurfaceStateStore } from "./surface-state-store.ts";
import type { RegisteredUi } from "./ui-registry.ts";

/**
 * The substrate trust headers, byte-identical to the hub's stamps
 * (parachute-hub/src/hub-server.ts `PARACHUTE_LAYER_HEADER` /
 * `PARACHUTE_CLIENT_IP_HEADER`).
 */
export const PARACHUTE_LAYER_HEADER = "x-parachute-layer";
export const PARACHUTE_CLIENT_IP_HEADER = "x-parachute-client-ip";

/**
 * Read the hub-stamped trust layer. Fail-closed: absent (direct-to-1946) or
 * unrecognized → `"public"`. Never derive trust from any other header.
 */
export function layerFromRequest(req: Request): TrustLayer {
  const v = req.headers.get(PARACHUTE_LAYER_HEADER);
  return v !== null && (TRUST_LAYERS as readonly string[]).includes(v)
    ? (v as TrustLayer)
    : "public";
}

/** Read the hub-stamped client IP. Fail-closed: absent → null. */
export function clientIpFromRequest(req: Request): string | null {
  const v = req.headers.get(PARACHUTE_CLIENT_IP_HEADER);
  return v !== null && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Resolve `$PARACHUTE_HOME/surface/state/` — per-surface operational state
 * (SQLite stores, per-surface config). Sibling of `surface/uis/`.
 */
export function resolveSurfaceStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "surface", "state");
}

/**
 * Backing SQLite file for one surface's state store.
 *
 * Path safety is PREDICATED on `name` being a NAME_PATTERN-validated
 * surface name (`^[a-z][a-z0-9-]*$` — enforced by meta-schema parsing,
 * the admin add flow, and the route extractors): the join is not itself a
 * traversal guard. Callers must never pass raw operator/wire input here.
 */
export function stateStorePathFor(name: string, stateDir = resolveSurfaceStateDir()): string {
  return path.join(stateDir, `${name}.sqlite`);
}

/**
 * The surface's own (admin-editable) config file. Same precondition as
 * {@link stateStorePathFor}: `name` must be NAME_PATTERN-validated.
 */
export function surfaceConfigPathFor(name: string, stateDir = resolveSurfaceStateDir()): string {
  return path.join(stateDir, `${name}.config.json`);
}

/**
 * Delete a removed surface's operational state: the SQLite store (+ WAL
 * sidecars) and its config file. Best-effort + idempotent — called from the
 * admin DELETE path after the backend unmounts.
 */
export function removeSurfaceState(name: string, stateDir = resolveSurfaceStateDir()): void {
  const store = stateStorePathFor(name, stateDir);
  for (const f of [store, `${store}-wal`, `${store}-shm`, surfaceConfigPathFor(name, stateDir)]) {
    rmSync(f, { force: true });
  }
}

/** Dynamic per-call read of the surface's config file (absent → {}). */
function configAccessFor(name: string, stateDir: string, log: SurfaceLogger): SurfaceConfigAccess {
  const file = surfaceConfigPathFor(name, stateDir);
  const readAll = (): Record<string, unknown> => {
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      log.warn(`config file ${file} is not a JSON object — ignoring`);
      return {};
    } catch (e) {
      log.warn(`config file ${file} unreadable: ${(e as Error).message}`);
      return {};
    }
  };
  return {
    all: readAll,
    get: (key: string) => readAll()[key],
  };
}

/** `[surface:<name>]`-prefixed logger flowing into the daemon's stream. */
export function surfaceLoggerFor(
  base: Pick<Console, "log" | "warn" | "error">,
  name: string,
): SurfaceLogger {
  const prefix = `[surface:${name}]`;
  return {
    log: (...a: unknown[]) => base.log(prefix, ...a),
    warn: (...a: unknown[]) => base.warn(prefix, ...a),
    error: (...a: unknown[]) => base.error(prefix, ...a),
  };
}

export type HostContextDeps = {
  /** The daemon config (hub_url for the vault client's origin). */
  config: AppConfig;
  /**
   * Resolve the per-surface token provider — the host-side closure over
   * the custodied credential (P3). The provider may THROW (no credential
   * provisioned / needs-operator); those errors surface to the backend's
   * vault calls unchanged.
   */
  tokenProviderFor: (ui: RegisteredUi) => () => Promise<string> | string;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Override the state dir (tests; production = resolveSurfaceStateDir()). */
  stateDir?: string;
  /** Test seam for the vault client. */
  fetchImpl?: typeof fetch;
};

/**
 * Build the supervisor's `buildContext` function. Per mount: opens the
 * surface's state store (closed automatically when the mount's
 * shutdownSignal aborts) and constructs the scoped vault client bound to
 * the surface's vault (`vault_default`, falling back to `"default"`).
 */
export function createHostContextBuilder(
  deps: HostContextDeps,
): (ui: RegisteredUi, signal: AbortSignal) => SurfaceHostContext {
  const baseLogger = deps.logger ?? console;
  return (ui, signal) => {
    const name = ui.meta.name;
    const stateDir = deps.stateDir ?? resolveSurfaceStateDir();
    const log = surfaceLoggerFor(baseLogger, name);

    const store = new SurfaceStateStore(stateStorePathFor(name, stateDir));
    // Close the store when the mount goes away — the file persists (state
    // survives reloads); only surface REMOVAL deletes it.
    signal.addEventListener("abort", () => {
      try {
        store.close();
      } catch {
        // already closed
      }
    });

    const vault = new ScopedVaultClient({
      hubOrigin: getHubOrigin(deps.config.hub_url),
      vaultName: ui.meta.vault_default ?? "default",
      tokenProvider: deps.tokenProviderFor(ui),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });

    return {
      vault,
      store,
      layer: layerFromRequest,
      clientIp: clientIpFromRequest,
      config: configAccessFor(name, stateDir, log),
      log,
      mount: ui.meta.path,
      shutdownSignal: signal,
    };
  };
}
