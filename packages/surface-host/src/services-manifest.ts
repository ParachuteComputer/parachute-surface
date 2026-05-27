/**
 * Self-registration into `~/.parachute/services.json` on `parachute-surface
 * serve` boot.
 *
 * Mirrors `parachute-runner/src/services-manifest.ts` deliberately — the file
 * shape is the contract between every Parachute module and the hub
 * (`parachute-hub/src/services-manifest.ts` is the canonical reader).
 *
 * Failure mode: any write error is logged + swallowed by the caller. Self-
 * registration is best-effort — the daemon still serves locally even if the
 * manifest write fails (permissions, disk full, race with another writer,
 * malformed pre-existing file).
 *
 * `installDir` is the third-party-module hook (parachute-hub#84): hub looks
 * the field up to resolve `parachute restart app` back to the checkout it
 * should drive. Self-registering it here means app doesn't need a vendored
 * fallback in hub's `FIRST_PARTY_FALLBACKS` registry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  displayName?: string;
  tagline?: string;
  installDir?: string;
  /**
   * Hub-stamped fields (e.g. `installDir` from parachute-hub#84, future
   * uiUrl / managementUrl pass-throughs) ride on the row even though the
   * module itself doesn't author them. The upsert merges rather than
   * replaces so those survive a self-registration write.
   *
   * App-specific: the per-UI `uis` map (design doc section 12) also lands
   * here once Phase 1.2 ships per-UI registration. The current shape lets
   * a Phase 1.2 PR add `uis` without re-touching the storage layer.
   */
  [key: string]: unknown;
}

interface ServicesManifest {
  services: ServiceEntry[];
}

/**
 * Canonical location of `services.json`. Honors `PARACHUTE_HOME` for sandbox +
 * Render deployments (matches the convention every other committed-core
 * module follows).
 */
export function resolveManifestPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.PARACHUTE_HOME ?? join(env.HOME ?? os.homedir(), ".parachute");
  return join(base, "services.json");
}

function readManifest(path: string): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { services?: unknown }).services)) {
    throw new Error(`services manifest at ${path} is malformed (missing "services" array)`);
  }
  return raw as ServicesManifest;
}

/**
 * Read an existing service entry from the manifest. Returns `undefined` when
 * the file is missing or no row matches `name`.
 *
 * Used at boot so app can respect an operator- or hub-set port already
 * recorded in services.json (same first-boot-vs-subsequent-boot discipline
 * scribe + agent settled on — see paraclaw#145 / scribe#40).
 */
export function readServiceEntry(
  name: string,
  path: string = resolveManifestPath(),
): ServiceEntry | undefined {
  const manifest = readManifest(path);
  return manifest.services.find((s) => s.name === name);
}

/**
 * Idempotent upsert of a service entry. Merges into any existing row rather
 * than replacing it — preserves hub-stamped fields the module doesn't own
 * (installDir from hub#84, future uiUrl, etc.). The module still wins for
 * the fields it owns (port, paths, version, health, displayName, installDir
 * — because `entry` spreads last in the merge).
 *
 * Atomic write: stages to `<path>.tmp-<pid>-<now>`, then renames over the
 * target. A crash mid-write leaves the prior file intact rather than
 * corrupting it.
 */
export function upsertService(entry: ServiceEntry, path: string = resolveManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = readManifest(path);
  const idx = manifest.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) manifest.services[idx] = { ...manifest.services[idx], ...entry };
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
