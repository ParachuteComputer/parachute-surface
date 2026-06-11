/**
 * Instance-record sidecar (#105) — instance name/mount override at install.
 *
 * One surface PACKAGE can be installed as several INSTANCES (the
 * instance-per-vault shape; channel's named-instances are the precedent):
 * the docs editor at `/surface/docs` bound to vault `default` AND at
 * `/surface/boulder-docs` bound to vault `boulder`, each with its own
 * credential binding + per-instance config/state.
 *
 * WHERE THE OVERRIDE LIVES — and why a sidecar:
 *
 *   The registry (`ui-registry.ts`) rehydrates installs from disk, and the
 *   package's `meta.json` is deliberately left as the package authored it
 *   (name/path identify the PACKAGE; provenance survives for upgrade flows
 *   and for the admin list's "package name/version" secondary line).
 *   Instance identity therefore needs its own home: `instance.json`, a
 *   minimal sidecar next to `meta.json` inside the instance dir
 *   (`$PARACHUTE_HOME/surface/uis/<instance>/instance.json`).
 *
 *   The sidecar is written ONLY when an override differs from the package
 *   meta. No override → no file → the on-disk install record is
 *   byte-compatible with every pre-override install, so existing installs
 *   load identically after upgrade with no migration.
 *
 * At scan time the registry applies the sidecar to produce the EFFECTIVE
 * meta (`meta.name` / `meta.path` become the instance values) — every
 * downstream consumer (routing, supervisor mounts, per-instance
 * state/config, credential binding, DCR records, the services.json `uis{}`
 * row, the api namespace) keys off those two fields, so instance scoping
 * propagates without per-consumer special cases. The package's own values
 * are preserved on `RegisteredUi.packageName` / `.packagePath`.
 *
 * Validation mirrors meta.json's charset rules exactly (NAME_PATTERN /
 * PATH_PATTERN) — an instance name is subject to the same constraints as a
 * package name, and the same path-traversal posture holds (the name is the
 * uis/ directory name and the state/credential key).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { NAME_PATTERN, PATH_PATTERN } from "./meta-schema.ts";

/** Sidecar filename inside the instance dir, sibling of meta.json. */
export const INSTANCE_RECORD_FILENAME = "instance.json";

/**
 * The persisted override. Both fields optional — only what actually
 * differs from the package meta is recorded (though the add flow writes
 * both effective values for self-description whenever it writes the file
 * at all).
 */
export type InstanceRecord = {
  /** Instance name override. Pattern: NAME_PATTERN (same as meta names). */
  name?: string;
  /** Mount path override. Pattern: PATH_PATTERN (always under /surface/). */
  path?: string;
};

/** Thrown on a malformed sidecar. The scanner converts it into a skip. */
export class InvalidInstanceRecordError extends Error {
  override name = "InvalidInstanceRecordError" as const;
}

/**
 * Parse + validate a raw JSON value as an `InstanceRecord`. Unknown fields
 * are rejected (the sidecar is OURS — a typo'd field name should fail loud,
 * not silently no-op).
 */
export function parseInstanceRecord(raw: unknown): InstanceRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidInstanceRecordError("instance.json must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "name" && key !== "path") {
      throw new InvalidInstanceRecordError(`instance.json: unknown field "${key}"`);
    }
  }
  const out: InstanceRecord = {};
  if (o.name !== undefined) {
    if (typeof o.name !== "string" || !NAME_PATTERN.test(o.name)) {
      throw new InvalidInstanceRecordError(`instance.json: name must match ${NAME_PATTERN.source}`);
    }
    out.name = o.name;
  }
  if (o.path !== undefined) {
    if (typeof o.path !== "string" || !PATH_PATTERN.test(o.path)) {
      throw new InvalidInstanceRecordError(`instance.json: path must match ${PATH_PATTERN.source}`);
    }
    out.path = o.path;
  }
  return out;
}

/**
 * Read the sidecar from an instance dir. Returns `null` when absent (the
 * pre-override / no-override case — the package meta is the identity).
 * Throws `InvalidInstanceRecordError` on unreadable/invalid content — the
 * scanner skips that install with an operator-actionable reason rather
 * than guessing an identity.
 */
export function readInstanceRecord(uiDir: string): InstanceRecord | null {
  const file = path.join(uiDir, INSTANCE_RECORD_FILENAME);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new InvalidInstanceRecordError(
      `instance.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  return parseInstanceRecord(raw);
}

/** Write the sidecar (the add flow's commit step, override case only). */
export function writeInstanceRecord(uiDir: string, record: InstanceRecord): void {
  writeFileSync(path.join(uiDir, INSTANCE_RECORD_FILENAME), `${JSON.stringify(record, null, 2)}\n`);
}
