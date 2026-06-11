/**
 * UI discovery for parachute-app.
 *
 * Scans `$PARACHUTE_HOME/surface/uis/` for subdirectories. For each:
 *   1. Look for `meta.json` — skip + warn if missing.
 *   2. Look for `dist/index.html` — skip + warn if missing.
 *   3. Parse + validate meta.json via `parseMeta` — skip + warn on invalid.
 *   4. Compute the absolute paths app will resolve assets against at serve-time.
 *
 * Returns the validated `RegisteredUi[]` list. Mount-path collisions are
 * resolved deterministically: alphabetical-by-name wins, others are demoted
 * to `status: "collision"` and dropped from the active mount set (still
 * surfaced in `parachute-surface list` once that lands in Phase 1.2). Same shape
 * the design doc landed in section 8, modulo the alphabetical tie-break
 * which the Phase 1.1 brief asked for explicitly.
 *
 * `RegisteredUi.distDir` is the absolute path to the `dist/` directory; the
 * HTTP layer resolves each asset request against it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import { resolveUisDir } from "./config.ts";
import { InvalidInstanceRecordError, readInstanceRecord } from "./instance-record.ts";
import { InvalidMetaError, type UiMeta, parseMetaWithDiagnostics } from "./meta-schema.ts";

export type UiStatus =
  | "active"
  | "missing-meta"
  | "missing-dist"
  | "invalid-meta"
  | "invalid-instance"
  | "collision"
  | "reserved-path";

export type RegisteredUi = {
  /** Directory name under `uis/`. May differ from `meta.name` until Phase 1.2 enforces alignment. */
  dirName: string;
  /** Absolute path to the `<uis>/<dirName>/` directory. */
  uiDir: string;
  /** Absolute path to the `<uis>/<dirName>/dist/` directory. */
  distDir: string;
  /**
   * The EFFECTIVE meta: the package's parsed meta.json with any
   * `instance.json` overrides applied (#105 — `meta.name`/`meta.path`
   * carry the INSTANCE identity; everything downstream keys off them).
   */
  meta: UiMeta;
  /**
   * The PACKAGE's own name from meta.json, recorded iff an instance.json
   * override renamed this install (#105). Absent when the instance uses
   * the package identity unchanged — pre-override installs + default adds.
   */
  packageName?: string;
  /** The package's own mount path from meta.json, iff overridden (#105). */
  packagePath?: string;
};

export type SkippedUi = {
  dirName: string;
  uiDir: string;
  status: Exclude<UiStatus, "active">;
  reason: string;
};

export type ScanResult = {
  /** UIs that mounted successfully + survived collision resolution. */
  registered: RegisteredUi[];
  /** UIs the scanner found but couldn't activate. */
  skipped: SkippedUi[];
};

export type ScanOpts = {
  /** Override the uis-dir location (tests). Defaults to `resolveUisDir()`. */
  uisDir?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Paths the HOST reserves. A meta.json that tries to claim one is rejected
 * at scan time (the `add` flow shares the check):
 *   - /surface/admin — the admin SPA
 *   - /surface/dev   — dev-mode routes
 *   - /surface/api   — host API namespace (the hub's credential-delivery
 *     endpoint lives at /surface/api/credential — P3; a surface named
 *     "api" could otherwise shadow it)
 */
export const RESERVED_PATHS: ReadonlySet<string> = new Set([
  "/surface/admin",
  "/surface/dev",
  "/surface/api",
]);

/**
 * Scan `uisDir` for declared UIs. Best-effort: a malformed UI is skipped +
 * surfaced in `skipped`; it never throws. Only an exception reading the
 * uisDir itself (permissions, broken symlink at the directory level)
 * propagates — that's a fatal config issue the operator needs to see.
 */
export function scanUis(opts: ScanOpts = {}): ScanResult {
  const uisDir = opts.uisDir ?? resolveUisDir();
  const logger = opts.logger ?? console;

  if (!existsSync(uisDir)) {
    // Fresh install — no `uis/` directory yet. That's fine; just return empty.
    logger.log(`[app] uis dir not found at ${uisDir}; no UIs to mount`);
    return { registered: [], skipped: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(uisDir);
  } catch (e) {
    logger.error(`[app] failed to read uis dir ${uisDir}: ${(e as Error).message}`);
    throw e;
  }

  const candidates: Array<RegisteredUi | SkippedUi> = [];

  for (const dirName of entries.sort()) {
    const uiDir = path.join(uisDir, dirName);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(uiDir);
    } catch {
      // Disappearing entries (race, broken symlink) — skip silently.
      continue;
    }
    if (!st.isDirectory()) continue;

    const metaPath = path.join(uiDir, "meta.json");
    const distDir = path.join(uiDir, "dist");
    const indexPath = path.join(distDir, "index.html");

    if (!existsSync(metaPath)) {
      const reason = `missing meta.json at ${metaPath}`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "missing-meta", reason });
      continue;
    }

    if (!existsSync(indexPath)) {
      const reason = `missing dist/index.html at ${indexPath}`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "missing-dist", reason });
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (e) {
      const reason = `meta.json is not valid JSON: ${(e as Error).message}`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "invalid-meta", reason });
      continue;
    }

    let meta: UiMeta;
    try {
      const parsed = parseMetaWithDiagnostics(raw);
      meta = parsed.meta;
      // Non-fatal diagnostics (e.g. the legacy-`public` deprecation note) —
      // surfaced in the daemon log / `parachute-surface list`, never a skip.
      for (const w of parsed.warnings) {
        logger.warn(`[app] ${dirName}: ${w}`);
      }
    } catch (e) {
      const reason =
        e instanceof InvalidMetaError
          ? e.message
          : `meta.json validation failed: ${(e as Error).message}`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "invalid-meta", reason });
      continue;
    }

    // instance.json sidecar (#105) — apply the instance identity override
    // BEFORE the reserved-path check so the check sees the EFFECTIVE mount.
    // Pre-override installs have no sidecar and take none of these branches.
    let packageName: string | undefined;
    let packagePath: string | undefined;
    try {
      const instance = readInstanceRecord(uiDir);
      if (instance) {
        if (instance.name !== undefined && instance.name !== dirName) {
          // Instance identity IS the uis/ directory name (delete/reload
          // resolve `uis/<name>` from the URL); a disagreeing sidecar would
          // split the registry key from the on-disk key — refuse it.
          const reason = `instance.json name "${instance.name}" must match the directory name "${dirName}"`;
          logger.warn(`[app] skip ${dirName}: ${reason}`);
          candidates.push({ dirName, uiDir, status: "invalid-instance", reason });
          continue;
        }
        if (instance.name !== undefined && instance.name !== meta.name) {
          packageName = meta.name;
        }
        if (instance.path !== undefined && instance.path !== meta.path) {
          packagePath = meta.path;
        }
        meta = {
          ...meta,
          name: instance.name ?? meta.name,
          path: instance.path ?? meta.path,
        };
      }
    } catch (e) {
      const reason =
        e instanceof InvalidInstanceRecordError
          ? e.message
          : `instance.json validation failed: ${(e as Error).message}`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "invalid-instance", reason });
      continue;
    }

    if (RESERVED_PATHS.has(meta.path)) {
      const reason = `meta.path "${meta.path}" is reserved (admin SPA)`;
      logger.warn(`[app] skip ${dirName}: ${reason}`);
      candidates.push({ dirName, uiDir, status: "reserved-path", reason });
      continue;
    }

    candidates.push({
      dirName,
      uiDir,
      distDir,
      meta,
      ...(packageName !== undefined ? { packageName } : {}),
      ...(packagePath !== undefined ? { packagePath } : {}),
    });
  }

  // Resolve mount-path collisions deterministically: among UIs declaring the
  // same `meta.path`, the lexicographically-smallest `meta.name` wins; the
  // others are demoted to `status: "collision"`.
  const byPath = new Map<string, RegisteredUi[]>();
  const skipped: SkippedUi[] = [];
  for (const c of candidates) {
    if ("meta" in c) {
      const list = byPath.get(c.meta.path) ?? [];
      list.push(c);
      byPath.set(c.meta.path, list);
    } else {
      skipped.push(c);
    }
  }

  const registered: RegisteredUi[] = [];
  for (const [mountPath, list] of byPath) {
    if (list.length === 1) {
      registered.push(list[0]!);
      continue;
    }
    list.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    const winner = list[0]!;
    registered.push(winner);
    for (let i = 1; i < list.length; i++) {
      const loser = list[i]!;
      const reason = `mount path ${mountPath} also claimed by "${winner.meta.name}" — alphabetical tie-break wins`;
      logger.warn(`[app] skip ${loser.dirName}: ${reason}`);
      skipped.push({
        dirName: loser.dirName,
        uiDir: loser.uiDir,
        status: "collision",
        reason,
      });
    }
  }

  // Stable ordering for downstream consumers (HTTP routing + admin list).
  registered.sort((a, b) => a.meta.path.localeCompare(b.meta.path));
  return { registered, skipped };
}
