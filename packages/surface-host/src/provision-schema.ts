/**
 * required_schema auto-provisioner — Phase 2.1.
 *
 * Per patterns#57 ("Surfaces declare required vault schema"), each
 * hosted UI may declare a `required_schema` envelope in its
 * `meta.json`:
 *
 *   {
 *     "required_schema": {
 *       "tags": [
 *         {
 *           "name": "capture",
 *           "description": "Quick captures",
 *           "fields": {
 *             "source": { "type": "string", "required": true },
 *             "createdAt": { "type": "date" }
 *           }
 *         }
 *       ]
 *     }
 *   }
 *
 * Phase 2.0 landed the *shape* (validate + surface in admin SPA). This
 * file lands the auto-provisioning logic: when `POST /surface/add` succeeds
 * and the UI's meta declares `required_schema.tags`, we call
 * `VaultClient.updateTag` against each declared tag so vault has the
 * schema row the app expects.
 *
 * Idempotent — vault's `PUT /api/tags/:name` upserts (omitted keys
 * preserve, declared keys overwrite). Re-running provisioning against
 * a vault that already has the schema is a no-op at the row level.
 *
 * **Best-effort.** If vault is unreachable, the operator token is
 * absent, or the tag-PUT 4xxs, we log + warn but never unwind the
 * install. The operator can re-trigger via `POST /surface/<name>/provision-
 * schema` once the underlying issue is fixed.
 *
 * Which vault?
 *   - If `meta.vault_default` is set (single-vault apps), we provision
 *     against that vault via `<hub_url>/vault/<vault_default>`.
 *   - If unset (multi-vault / vault-agnostic apps), we skip with a
 *     human-readable reason. Per design doc Section 5, vault-agnostic
 *     UIs declare `vault:*:read`; we don't know which vault to seed,
 *     so the operator runs `provision-schema` manually against each
 *     vault they want set up.
 */

import type { TagUpsertPayload } from "@openparachute/surface-client";
import { VaultClient } from "@openparachute/surface-client/vault-client";

import type { FetchFn } from "./dcr.ts";
import type { RegisteredUi } from "./ui-registry.ts";

export type ProvisionSchemaOpts = {
  ui: RegisteredUi;
  /** Hub origin (used to construct the per-vault base URL). */
  hubUrl: string;
  /** Resolver for the operator bearer used to authenticate to vault. */
  operatorTokenResolver: () => string | undefined;
  /** Inject fetch (tests). */
  fetchFn?: FetchFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type ProvisionSchemaResult = {
  /** Tag names successfully provisioned (PUT returned 2xx). */
  provisioned: string[];
  /** Tags whose PUT failed with the per-tag error message. */
  errors: Array<{ tag: string; error: string }>;
  /**
   * Reason the whole pass was skipped (per-UI), if it was. Examples:
   *   - "ui declared no required_schema"
   *   - "ui has no vault_default; skip (operator can re-trigger manually)"
   *   - "no operator token available"
   */
  skipReason?: string;
  /** Resolved vault URL, when one was used. */
  vaultUrl?: string;
};

/**
 * Provision the tags declared in `ui.meta.required_schema.tags` into
 * the vault implied by `ui.meta.vault_default`.
 *
 * Best-effort: every error path logs + warns and continues to the next
 * tag. Returns a summary the caller surfaces in the admin response +
 * SSE log.
 */
export async function provisionSchemaForUi(
  opts: ProvisionSchemaOpts,
): Promise<ProvisionSchemaResult> {
  const logger = opts.logger ?? console;
  const required = opts.ui.meta.required_schema;
  const tags = required?.tags ?? [];

  if (!required || tags.length === 0) {
    return {
      provisioned: [],
      errors: [],
      skipReason: "ui declared no required_schema",
    };
  }

  const vaultName = opts.ui.meta.vault_default;
  if (!vaultName) {
    const reason =
      "ui has no vault_default — apps declaring required_schema must pin a vault, or operator must run provision-schema manually";
    logger.warn(`[app-provision] ${opts.ui.meta.name}: ${reason}`);
    return {
      provisioned: [],
      errors: [],
      skipReason: reason,
    };
  }

  const operatorToken = opts.operatorTokenResolver();
  if (!operatorToken) {
    const reason =
      "no operator token available (PARACHUTE_HUB_TOKEN unset, ~/.parachute/operator.token missing/unreadable)";
    logger.warn(`[app-provision] ${opts.ui.meta.name}: ${reason}`);
    return {
      provisioned: [],
      errors: [],
      skipReason: reason,
    };
  }

  const vaultUrl = `${opts.hubUrl.replace(/\/$/, "")}/vault/${encodeURIComponent(vaultName)}`;
  const fetchImpl = opts.fetchFn ?? (fetch as typeof fetch);
  const client = new VaultClient({
    vaultUrl,
    accessToken: operatorToken,
    // Cast fits — server-side FetchFn matches DOM `typeof fetch` at the
    // call-site shape VaultClient needs (URL string + RequestInit).
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  const provisioned: string[] = [];
  const errors: Array<{ tag: string; error: string }> = [];

  for (const tag of tags) {
    const payload: TagUpsertPayload = {};
    if (tag.description !== undefined) payload.description = tag.description;
    if (tag.fields !== undefined) {
      // Translate the meta.json shape (`{type, required?, description?}`)
      // into vault's `TagFieldSchema` (`{type, description?, enum?}`).
      // The `required` flag from meta.json doesn't have a direct vault
      // equivalent today — vault enforces required-ness at the
      // applySchemaDefaults layer (see vault/routes.ts:applySchemaDefaults).
      // We pass `type` + `description` through; `required` is preserved
      // in the meta.json view + the admin SPA surface, but isn't
      // forwarded as a wire-level flag because vault doesn't store one.
      const fields: Record<string, { type: string; description?: string }> = {};
      for (const [fieldName, decl] of Object.entries(tag.fields)) {
        const f: { type: string; description?: string } = { type: decl.type };
        if (decl.description !== undefined) f.description = decl.description;
        fields[fieldName] = f;
      }
      payload.fields = fields;
    }
    try {
      await client.updateTag(tag.name, payload);
      provisioned.push(tag.name);
      logger.log(`[app-provision] ${opts.ui.meta.name}: provisioned tag "${tag.name}"`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      errors.push({ tag: tag.name, error: msg });
      logger.warn(
        `[app-provision] ${opts.ui.meta.name}: failed to provision tag "${tag.name}": ${msg}`,
      );
    }
  }

  return {
    provisioned,
    errors,
    vaultUrl,
  };
}
