/**
 * Credential custody (surface-runtime design P3 + hub#648 H4).
 *
 * The hub's Connections engine provisions a STANDING tag-scoped vault
 * credential for this module (`kind: "credential"`): operator-approved,
 * hub-minted, REGISTERED (revocable), ~90-day, delivered to our declared
 * endpoint (`module.json` `credentials[].endpoint`) over loopback with a
 * short-lived `surface:admin` bearer. This module CUSTODIES it:
 *
 *   - Stored at `$PARACHUTE_HOME/surface/credentials/<connectionId>.credential.json`,
 *     mode 0600 (the channels.json discipline). Backends never read it —
 *     they hold a `ScopedVaultClient` whose tokenProvider closes over this
 *     store host-side.
 *   - KEYED BY CONNECTION ID, not surface name: the hub's delivery payload
 *     (`CredentialPayload` in parachute-hub/src/admin-connections.ts)
 *     identifies `connection_id / key / vault / scoped_tags` — it carries
 *     NO surface-instance name (the credential is a module↔vault grant).
 *     Surface→credential binding is resolved host-side:
 *       1. an explicit `credential_connections: { "<surface>": "<connection id>" }`
 *          mapping in the daemon config wins;
 *       2. else, if exactly ONE stored credential matches the surface's
 *          vault, it binds (the single-backed-surface common case);
 *       3. else, if the vault-matching set has exactly one READ credential,
 *          least-privilege binds it;
 *       4. else the binding is ambiguous → vault calls fail with an
 *          operator-actionable error until the mapping is configured.
 *   - Renewed host-side before expiry (see `credential-renewal.ts`) by
 *     proof-of-possession against `POST /admin/connections/<id>/renew`.
 *   - Dropped on the hub's `op: "removed"` notify AND on local surface
 *     removal (when no other surface resolves to it). Teardown of the
 *     CONNECTION itself is operator-driven via the hub — the host only
 *     ever drops its copy.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AppConfig } from "./config.ts";
import type { RegisteredUi } from "./ui-registry.ts";

/** Mirrors the hub's wire `CredentialPayload.op` values (hub#648). */
export const CREDENTIAL_OPS = ["provisioned", "renewed", "removed"] as const;
export type CredentialOp = (typeof CREDENTIAL_OPS)[number];

/**
 * The hub's delivery payload (parachute-hub/src/admin-connections.ts
 * `CredentialPayload`) — field names verbatim. `provisioned`/`renewed`
 * carry the token; `removed` carries identity fields only.
 */
export interface CredentialPayload {
  kind: "credential";
  op: CredentialOp;
  connection_id: string;
  key: string;
  vault: string;
  scope: string;
  scoped_tags: string[];
  token?: string;
  jti?: string;
  expires_at?: string;
  /** Hub path for proof-of-possession renewal. */
  renew_path?: string;
}

/** What we persist per connection (0600). */
export interface StoredCredential {
  connection_id: string;
  key: string;
  vault: string;
  scope: string;
  scoped_tags: string[];
  token: string;
  /** jti hint — informational (the hub binds renewal to it server-side). */
  jti: string;
  expires_at: string;
  renew_path: string;
  /**
   * "ok" — usable; "needs-operator" — renewal got a terminal 401 (expired /
   * revoked): the operator must re-approve in the hub UI; the sweep stops
   * retrying and vault calls fail with a clear message.
   */
  status: "ok" | "needs-operator";
  updated_at: string;
}

/** Same conservative slug the hub enforces on connection ids. */
export const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** `$PARACHUTE_HOME/surface/credentials/`. */
export function resolveCredentialsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "surface", "credentials");
}

export function credentialPathFor(connectionId: string, dir = resolveCredentialsDir()): string {
  return path.join(dir, `${connectionId}.credential.json`);
}

/**
 * Persist a credential, 0600. `writeFileSync`'s `mode` only applies on
 * CREATE — the explicit chmod covers overwrites of a file that somehow
 * widened.
 */
export function writeCredential(record: StoredCredential, dir = resolveCredentialsDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialPathFor(record.connection_id, dir);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readCredential(
  connectionId: string,
  dir = resolveCredentialsDir(),
): StoredCredential | null {
  const file = credentialPathFor(connectionId, dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredCredential;
    if (!parsed || typeof parsed !== "object" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteCredential(connectionId: string, dir = resolveCredentialsDir()): void {
  rmSync(credentialPathFor(connectionId, dir), { force: true });
}

export function listCredentials(dir = resolveCredentialsDir()): StoredCredential[] {
  if (!existsSync(dir)) return [];
  const out: StoredCredential[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".credential.json")) continue;
    const id = f.slice(0, -".credential.json".length);
    const rec = readCredential(id, dir);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Apply one hub delivery payload to the store. Returns a human line for
 * the daemon log. Validation here is shape-only — AUTH happened at the
 * endpoint (surface:admin bearer); the hub is the trusted writer.
 */
export function applyCredentialPayload(
  payload: CredentialPayload,
  dir = resolveCredentialsDir(),
  now: () => Date = () => new Date(),
): string {
  if (payload.op === "removed") {
    deleteCredential(payload.connection_id, dir);
    return `credential ${payload.connection_id} removed (hub teardown notify)`;
  }
  // provisioned | renewed — token fields are required.
  if (!payload.token || !payload.jti || !payload.expires_at) {
    throw new Error(`credential payload op=${payload.op} is missing token/jti/expires_at`);
  }
  const record: StoredCredential = {
    connection_id: payload.connection_id,
    key: payload.key,
    vault: payload.vault,
    scope: payload.scope,
    scoped_tags: [...payload.scoped_tags],
    token: payload.token,
    jti: payload.jti,
    expires_at: payload.expires_at,
    renew_path: payload.renew_path ?? `/admin/connections/${payload.connection_id}/renew`,
    status: "ok",
    updated_at: now().toISOString(),
  };
  writeCredential(record, dir);
  return `credential ${payload.connection_id} ${payload.op} (vault=${payload.vault}, scope=${payload.scope}, tags=[${payload.scoped_tags.join(", ")}], expires ${payload.expires_at})`;
}

/** Mark a credential needs-operator (terminal renewal failure). */
export function markCredentialNeedsOperator(
  connectionId: string,
  dir = resolveCredentialsDir(),
  now: () => Date = () => new Date(),
): void {
  const rec = readCredential(connectionId, dir);
  if (!rec) return;
  writeCredential({ ...rec, status: "needs-operator", updated_at: now().toISOString() }, dir);
}

export type CredentialResolution =
  | { ok: true; record: StoredCredential }
  | { ok: false; reason: string };

/**
 * Resolve which stored credential a surface uses (see the module header
 * for the precedence). REPORTED DELTA vs the design sketch: the hub's
 * delivery payload carries no surface name, so binding is host-side —
 * explicit config mapping first, vault-match heuristics after.
 */
export function resolveCredentialForSurface(
  ui: RegisteredUi,
  opts: { dir?: string; config?: Pick<AppConfig, "credential_connections"> } = {},
): CredentialResolution {
  const dir = opts.dir ?? resolveCredentialsDir();
  const name = ui.meta.name;
  const vault = ui.meta.vault_default ?? "default";

  const mapped = opts.config?.credential_connections?.[name];
  if (mapped) {
    const rec = readCredential(mapped, dir);
    if (!rec) {
      return {
        ok: false,
        reason: `config maps surface "${name}" to credential connection "${mapped}" but no such credential is stored — approve it in the hub admin (Connections)`,
      };
    }
    return { ok: true, record: rec };
  }

  const all = listCredentials(dir);
  const matching = all.filter((c) => c.vault === vault);
  if (matching.length === 1) return { ok: true, record: matching[0]! };
  if (matching.length === 0) {
    return {
      ok: false,
      reason: `no vault credential provisioned for surface "${name}" (vault "${vault}") — approve a credential connection in the hub admin (Connections → surface)`,
    };
  }
  // Multiple candidates: least privilege — bind the single READ credential
  // if exactly one exists; otherwise require an explicit mapping.
  const reads = matching.filter((c) => c.scope.endsWith(":read"));
  if (reads.length === 1) return { ok: true, record: reads[0]! };
  return {
    ok: false,
    reason: `multiple credentials match vault "${vault}" for surface "${name}" (${matching
      .map((c) => c.connection_id)
      .join(", ")}) — set credential_connections["${name}"] in the surface config`,
  };
}

/**
 * The host-side tokenProvider for a surface's ScopedVaultClient (P2↔P3
 * seam). Reads the store FRESH per call (deliveries + renewals take effect
 * without a remount); throws operator-actionable errors on every
 * non-usable state. The backend sees the error message, never the token.
 */
export function createCredentialTokenProvider(
  ui: RegisteredUi,
  opts: {
    dir?: string;
    getConfig?: () => Pick<AppConfig, "credential_connections">;
    now?: () => Date;
  } = {},
): () => string {
  const now = opts.now ?? (() => new Date());
  return () => {
    const resolution = resolveCredentialForSurface(ui, {
      ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
      ...(opts.getConfig ? { config: opts.getConfig() } : {}),
    });
    if (!resolution.ok) throw new Error(resolution.reason);
    const rec = resolution.record;
    if (rec.status === "needs-operator") {
      throw new Error(
        `vault credential "${rec.connection_id}" needs operator re-approval (renewal was rejected) — re-approve it in the hub admin (Connections)`,
      );
    }
    const expires = Date.parse(rec.expires_at);
    if (Number.isFinite(expires) && expires <= now().getTime()) {
      throw new Error(
        `vault credential "${rec.connection_id}" expired ${rec.expires_at} — re-approve it in the hub admin (Connections)`,
      );
    }
    return rec.token;
  };
}
