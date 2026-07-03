import type { VaultClient } from "./client";
import type { RequiredTagDecl } from "./schema";
import { auditSchema } from "./schema-audit";

// Per-session ref guard so we don't hammer the vault on every capture. The
// audit + create calls are idempotent, but there's no point making the
// network round-trip if we already ensured this vault's schema in this
// session.
//
// Module-level Set rather than a hook because the call sites
// (NoteNew's save paths) are short-lived components and we want the guard to
// survive remount. localStorage was the alternative but it has the
// "delete localStorage = re-run forever" failure mode the team-lead
// flagged — refs in a module are the right scope: ephemeral, but
// session-stable.
const ensuredVaults = new Set<string>();

// The schema-apply machinery as a plain function: writes the given tag
// declarations via `update-tag`. Callers decide WHICH declarations to write —
// the lazy-ensure passes only the audit's `missing` set so an existing
// (possibly user-customized) tag row is never overwritten.
async function applyTagDecls(client: VaultClient, decls: RequiredTagDecl[]): Promise<void> {
  // Sequential rather than Promise.all — write parents before children so
  // `parent_names` can resolve. The vault's PUT is permissive about ordering,
  // but keeping the order matches the conceptual model + makes failure modes
  // clearer in logs. (The declared schema is a single parentless tag today;
  // the ordering discipline stands if it ever grows again.)
  for (const decl of decls) {
    await client.updateTag(decl.name, {
      description: decl.description,
      ...(decl.parent_names ? { parent_names: decl.parent_names } : {}),
    });
  }
}

// Quiet lazy-ensure, fired on first capture into a vault this session
// (NoteNew's text + voice save paths). Audits the vault's tags against
// `NOTES_REQUIRED_SCHEMA` and creates only the MISSING ones — a tag the
// vault already has is left alone even if its description drifted; the row
// belongs to the operator once it exists. Replaces the connect-time
// suggestion banner (notes#129, retired 2026-07): populate quietly instead
// of prompting.
//
// Contract: best-effort, silent, idempotent — NEVER blocks or fails the
// capture. Failures are logged and the guard rolls back so a later capture
// retries.
export async function ensureNotesSchema(vaultId: string, client: VaultClient): Promise<void> {
  if (ensuredVaults.has(vaultId)) return;
  // Mark as ensured BEFORE the async calls so concurrent invocations don't
  // race into a double-fire (two save paths can run in the same tick).
  ensuredVaults.add(vaultId);
  try {
    const audit = await auditSchema(client);
    const missing = audit.missing.map((row) => row.expected);
    if (missing.length > 0) {
      await applyTagDecls(client, missing);
    }
  } catch (err) {
    // Roll back the guard so a future capture can retry. Schema-ensure is
    // best-effort; a transient 5xx shouldn't permanently disable it for the
    // session.
    ensuredVaults.delete(vaultId);
    // Don't rethrow — the capture itself still succeeds without the schema
    // setup (vault accepts notes whose tags have no identity row yet).
    if (typeof console !== "undefined") {
      console.warn(`[schema-ensure] failed to ensure required schema for vault ${vaultId}:`, err);
    }
  }
}

// Test-only escape hatch — resets the in-session guard so a test can
// exercise the ensure-once behavior across multiple captures without
// reloading the module.
export function _resetEnsuredVaultsForTesting(): void {
  ensuredVaults.clear();
}
