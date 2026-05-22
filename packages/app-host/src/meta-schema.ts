/**
 * `meta.json` schema definition + validator for parachute-app's hosted UIs.
 *
 * Each hosted UI ships a `meta.json` (Draft-07-shaped, see design doc section
 * 5). This file defines the in-memory `UiMeta` type and a hand-rolled
 * validator. We use a hand-rolled checker rather than pulling in ajv because:
 *
 *   1. The schema is small and stable (8 fields, half optional).
 *   2. Hand-rolling lets validation errors point at human-meaningful paths
 *      (`"meta.json: path must match ^/app/[a-z0-9-]+$"`) without ajv's
 *      JSON-pointer noise.
 *   3. One fewer transitive dep keeps app's startup footprint lean.
 *
 * If schema complexity grows past ~15 fields we'll revisit. For now the
 * tradeoff favors the hand-roll.
 *
 * Canonical reference: design doc section 5 (`meta.json` schema). When
 * fields change there, update this file's shape + `metaSchemaJson()` together.
 */

/** Allowed pattern for a UI's `name` (directory + URL-safe key). */
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Allowed pattern for a UI's mount `path` (always under `/app/`). */
export const PATH_PATTERN = /^\/app\/[a-z0-9-]+$/;

/**
 * Default scopes applied when meta.json omits `scopes_required`.
 *
 * Per design doc section 5: vault-agnostic UIs (those that don't pin a
 * specific vault via `vault_default`) default to the wildcard form
 * `vault:*:read` — the `*` is the `<vault-name>` segment, expressing
 * "read access to whichever vault the session is bound to." The bare
 * `vault:read` form is not a valid scope shape (missing the name segment).
 */
export const DEFAULT_SCOPES_REQUIRED: readonly string[] = ["vault:*:read"];

/**
 * Allowed field types for `required_schema.tags[].fields`. Mirrors what
 * vault's tag-identity schema accepts on the `fields` column — `string`,
 * `number`, `boolean`, `date`. New types should be added here AND in
 * vault's schema before being declared by an app, otherwise the
 * Phase 2.1+ auto-provisioner will reject the declaration.
 */
export const REQUIRED_SCHEMA_FIELD_TYPES = ["string", "number", "boolean", "date"] as const;
export type RequiredSchemaFieldType = (typeof REQUIRED_SCHEMA_FIELD_TYPES)[number];

/**
 * Field declaration within a tag-role schema. Mirrors vault's tag-
 * identity field shape closely enough that the Phase 2.1+ auto-
 * provisioner can map declarations to upsert calls without translation.
 */
export type TagSchemaFieldDeclaration = {
  type: RequiredSchemaFieldType;
  required?: boolean;
  description?: string;
};

/**
 * Tag-role schema declaration — what an app says it needs vault to have
 * defined to function. Phase 2.0 (this revision): validate the shape
 * only. Phase 2.1+ will auto-provision missing tag definitions in vault
 * via `VaultClient.updateTag` at install time; that wiring is captured
 * separately and depends on this declaration landing first.
 */
export type TagSchemaDeclaration = {
  /** Tag name (e.g. `"capture"`). */
  name: string;
  /** Operator-facing description; surfaced in the admin SPA. */
  description?: string;
  /** Per-field declarations. Keys are field names; values are type + optionality. */
  fields?: Record<string, TagSchemaFieldDeclaration>;
};

/**
 * Top-level `required_schema` shape. Apps declare schema requirements
 * inside this envelope so future extensions (links, indexes, etc.)
 * don't pollute the top-level meta.json namespace.
 *
 * Patterns#57 — "Surfaces declare required vault schema." Each app
 * should be able to declare its needed tag schemas in meta.json so
 * they auto-provision. This Phase 2.0 lands the SCHEMA declaration
 * (validate + surface); auto-provisioning is Phase 2.1+.
 */
export type RequiredSchemaDeclaration = {
  tags?: TagSchemaDeclaration[];
};

/**
 * Validated, in-memory shape of a UI's meta.json. Optional fields are filled
 * with their schema defaults at parse time, so consumers can read them
 * unconditionally.
 */
export type UiMeta = {
  /** Stable identifier. Pattern: `^[a-z][a-z0-9-]*$`. */
  name: string;
  /** Human label rendered on hub discovery. */
  displayName: string;
  /** One-line description rendered under displayName. */
  tagline?: string;
  /** Mount path under hub origin. Pattern: `^/app/[a-z0-9-]+$`. */
  path: string;
  /** Free-form version string (rendered for diagnostics). */
  version?: string;
  /** Path to icon, relative to the UI bundle (e.g. `"icon.svg"`). */
  iconUrl?: string;
  /** OAuth scopes the UI declares as required. Defaults to `["vault:*:read"]`. */
  scopes_required: string[];
  /** Optional single-vault binding hint for vault-specific UIs. */
  vault_default?: string;
  /** Whether app should serve a service worker for this UI. Defaults to `false`. */
  pwa: boolean;
  /** Path within `dist/` to the SW file (e.g. `"sw.js"`). Required when `pwa: true`. */
  pwa_service_worker?: string;
  /** If `true`, hub does NOT enforce a session gate at `/app/<name>/*`. Defaults to `false`. */
  public: boolean;
  /**
   * Optional declaration of vault schema this app needs to function.
   * Phase 2.0 lands the shape (validate + surface in admin SPA); the
   * auto-provisioning that would create missing tag-identity rows in
   * vault at install time is Phase 2.1+. See `RequiredSchemaDeclaration`.
   * Per patterns#57 ("Surfaces declare required vault schema").
   */
  required_schema?: RequiredSchemaDeclaration;
};

/**
 * Thrown when a `meta.json` doesn't parse, doesn't typecheck, or fails one
 * of the schema constraints. `details` is a flat list of field-level errors
 * the caller can surface to the operator (CLI + admin SPA).
 */
export class InvalidMetaError extends Error {
  override name = "InvalidMetaError" as const;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
  constructor(message: string, details: Array<{ path: string; message: string }>) {
    super(`${message}: ${details.map((d) => `${d.path}: ${d.message}`).join("; ")}`);
    this.details = details;
  }
}

/**
 * Parse + validate a raw JSON object as `UiMeta`. Throws `InvalidMetaError`
 * with a flat list of field-level reasons on any structural problem.
 *
 * Defaults filled at parse time:
 *   - `scopes_required` → `["vault:*:read"]` when absent
 *   - `pwa` → `false` when absent
 *   - `public` → `false` when absent
 */
export function parseMeta(raw: unknown): UiMeta {
  const errors: Array<{ path: string; message: string }> = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidMetaError("meta.json", [{ path: "", message: "must be a JSON object" }]);
  }
  const o = raw as Record<string, unknown>;

  // name — required, pattern-constrained.
  let name = "";
  if (typeof o.name !== "string" || o.name.length === 0) {
    errors.push({ path: "name", message: "is required (string)" });
  } else if (!NAME_PATTERN.test(o.name)) {
    errors.push({ path: "name", message: `must match ${NAME_PATTERN.source}` });
  } else {
    name = o.name;
  }

  // displayName — required, non-empty string.
  let displayName = "";
  if (typeof o.displayName !== "string" || o.displayName.length === 0) {
    errors.push({ path: "displayName", message: "is required (non-empty string)" });
  } else {
    displayName = o.displayName;
  }

  // tagline — optional, string when present.
  let tagline: string | undefined;
  if (o.tagline !== undefined) {
    if (typeof o.tagline !== "string") {
      errors.push({ path: "tagline", message: "must be a string" });
    } else {
      tagline = o.tagline;
    }
  }

  // path — required, pattern-constrained.
  let pathField = "";
  if (typeof o.path !== "string" || o.path.length === 0) {
    errors.push({ path: "path", message: "is required (string)" });
  } else if (!PATH_PATTERN.test(o.path)) {
    errors.push({ path: "path", message: `must match ${PATH_PATTERN.source}` });
  } else {
    pathField = o.path;
  }

  // version — optional, string when present.
  let version: string | undefined;
  if (o.version !== undefined) {
    if (typeof o.version !== "string") {
      errors.push({ path: "version", message: "must be a string" });
    } else {
      version = o.version;
    }
  }

  // iconUrl — optional, string when present.
  let iconUrl: string | undefined;
  if (o.iconUrl !== undefined) {
    if (typeof o.iconUrl !== "string") {
      errors.push({ path: "iconUrl", message: "must be a string" });
    } else {
      iconUrl = o.iconUrl;
    }
  }

  // scopes_required — optional array of strings; default to DEFAULT_SCOPES_REQUIRED.
  let scopes_required: string[] = [...DEFAULT_SCOPES_REQUIRED];
  if (o.scopes_required !== undefined) {
    if (!Array.isArray(o.scopes_required)) {
      errors.push({ path: "scopes_required", message: "must be an array of strings" });
    } else {
      const items: string[] = [];
      let bad = false;
      for (let i = 0; i < o.scopes_required.length; i++) {
        const v = o.scopes_required[i];
        if (typeof v !== "string" || v.length === 0) {
          errors.push({
            path: `scopes_required[${i}]`,
            message: "must be a non-empty string",
          });
          bad = true;
          break;
        }
        items.push(v);
      }
      if (!bad) scopes_required = items;
    }
  }

  // vault_default — optional, string when present.
  let vault_default: string | undefined;
  if (o.vault_default !== undefined) {
    if (typeof o.vault_default !== "string" || o.vault_default.length === 0) {
      errors.push({ path: "vault_default", message: "must be a non-empty string" });
    } else {
      vault_default = o.vault_default;
    }
  }

  // pwa — optional boolean; default false.
  let pwa = false;
  if (o.pwa !== undefined) {
    if (typeof o.pwa !== "boolean") {
      errors.push({ path: "pwa", message: "must be a boolean" });
    } else {
      pwa = o.pwa;
    }
  }

  // pwa_service_worker — optional string; required when pwa===true.
  let pwa_service_worker: string | undefined;
  if (o.pwa_service_worker !== undefined) {
    if (typeof o.pwa_service_worker !== "string" || o.pwa_service_worker.length === 0) {
      errors.push({
        path: "pwa_service_worker",
        message: "must be a non-empty string",
      });
    } else if (o.pwa_service_worker.startsWith("/")) {
      // Path within dist/ — leading-slash would imply "absolute under mount"
      // and trip up the resolver. Force operator-friendly relative form.
      errors.push({
        path: "pwa_service_worker",
        message: "must be a relative path within dist/ (no leading slash)",
      });
    } else {
      pwa_service_worker = o.pwa_service_worker;
    }
  }
  if (pwa && !pwa_service_worker) {
    errors.push({
      path: "pwa_service_worker",
      message: "is required when `pwa` is true",
    });
  }

  // public — optional boolean; default false.
  let publicField = false;
  if (o.public !== undefined) {
    if (typeof o.public !== "boolean") {
      errors.push({ path: "public", message: "must be a boolean" });
    } else {
      publicField = o.public;
    }
  }

  // required_schema — optional object; patterns#57 (Phase 2.0 lands shape,
  // Phase 2.1+ auto-provisions).
  const required_schema = parseRequiredSchema(o.required_schema, errors);

  if (errors.length > 0) {
    throw new InvalidMetaError("meta.json", errors);
  }

  return {
    name,
    displayName,
    tagline,
    path: pathField,
    version,
    iconUrl,
    scopes_required,
    vault_default,
    pwa,
    pwa_service_worker,
    public: publicField,
    ...(required_schema ? { required_schema } : {}),
  };
}

/**
 * Parse + validate the `required_schema` envelope. Returns `undefined`
 * when the key is absent (it's optional); appends to the shared `errors`
 * list and returns `undefined` on any shape problem (rejecting the
 * meta.json as a whole when the top-level `parseMeta` loop sees errors).
 *
 * Validation rules:
 *   - top-level must be an object (not array, not null)
 *   - `tags` must be an array if present
 *   - each tag entry must be an object with a required `name` string
 *   - `description` optional; must be string when present
 *   - `fields` optional; must be an object whose values are
 *     `{ type: <one of REQUIRED_SCHEMA_FIELD_TYPES>, required?: bool, description?: string }`
 */
function parseRequiredSchema(
  raw: unknown,
  errors: Array<{ path: string; message: string }>,
): RequiredSchemaDeclaration | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path: "required_schema", message: "must be an object" });
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: RequiredSchemaDeclaration = {};

  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) {
      errors.push({ path: "required_schema.tags", message: "must be an array" });
    } else {
      const tags: TagSchemaDeclaration[] = [];
      let bad = false;
      for (let i = 0; i < o.tags.length; i++) {
        const entry = o.tags[i];
        const pathPrefix = `required_schema.tags[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push({ path: pathPrefix, message: "must be an object" });
          bad = true;
          continue;
        }
        const t = entry as Record<string, unknown>;

        if (typeof t.name !== "string" || t.name.length === 0) {
          errors.push({ path: `${pathPrefix}.name`, message: "is required (non-empty string)" });
          bad = true;
          continue;
        }
        const tag: TagSchemaDeclaration = { name: t.name };

        if (t.description !== undefined) {
          if (typeof t.description !== "string") {
            errors.push({ path: `${pathPrefix}.description`, message: "must be a string" });
            bad = true;
            continue;
          }
          tag.description = t.description;
        }

        if (t.fields !== undefined) {
          if (!t.fields || typeof t.fields !== "object" || Array.isArray(t.fields)) {
            errors.push({ path: `${pathPrefix}.fields`, message: "must be an object" });
            bad = true;
            continue;
          }
          const fields: Record<string, TagSchemaFieldDeclaration> = {};
          let fieldsBad = false;
          for (const [fieldName, fieldRaw] of Object.entries(
            t.fields as Record<string, unknown>,
          )) {
            const fieldPath = `${pathPrefix}.fields.${fieldName}`;
            if (!fieldRaw || typeof fieldRaw !== "object" || Array.isArray(fieldRaw)) {
              errors.push({ path: fieldPath, message: "must be an object" });
              fieldsBad = true;
              continue;
            }
            const f = fieldRaw as Record<string, unknown>;
            const t2 = f.type;
            if (
              typeof t2 !== "string" ||
              !(REQUIRED_SCHEMA_FIELD_TYPES as readonly string[]).includes(t2)
            ) {
              errors.push({
                path: `${fieldPath}.type`,
                message: `must be one of ${REQUIRED_SCHEMA_FIELD_TYPES.join(", ")}`,
              });
              fieldsBad = true;
              continue;
            }
            const decl: TagSchemaFieldDeclaration = { type: t2 as RequiredSchemaFieldType };
            if (f.required !== undefined) {
              if (typeof f.required !== "boolean") {
                errors.push({ path: `${fieldPath}.required`, message: "must be a boolean" });
                fieldsBad = true;
                continue;
              }
              decl.required = f.required;
            }
            if (f.description !== undefined) {
              if (typeof f.description !== "string") {
                errors.push({ path: `${fieldPath}.description`, message: "must be a string" });
                fieldsBad = true;
                continue;
              }
              decl.description = f.description;
            }
            fields[fieldName] = decl;
          }
          if (!fieldsBad) tag.fields = fields;
          else {
            bad = true;
            continue;
          }
        }

        tags.push(tag);
      }
      if (!bad) out.tags = tags;
    }
  }

  // Even with empty/no `tags`, an explicit empty `required_schema: {}` is
  // a deliberate operator declaration ("no schema needed"). Surface it
  // unchanged so the admin SPA can distinguish "didn't declare" from
  // "declared empty."
  return out;
}

/**
 * Public JSON-Schema description, matching the in-memory `UiMeta` shape.
 * Exposed so the admin SPA + docs can render a single source of truth.
 * Kept in sync with `parseMeta()` by hand — there's only one schema to
 * keep aligned, and the unit tests below assert both surfaces agree.
 */
export function metaSchemaJson(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://parachute.computer/schemas/app-ui-meta.json",
    title: "parachute-app UI meta.json",
    type: "object",
    additionalProperties: false,
    required: ["name", "displayName", "path"],
    properties: {
      name: {
        type: "string",
        pattern: NAME_PATTERN.source,
        description: "Stable identifier. Becomes the uis/<name>/ directory and OAuth client name.",
      },
      displayName: {
        type: "string",
        description: "Human label rendered on hub discovery.",
      },
      tagline: {
        type: "string",
        description: "One-line description rendered under displayName.",
      },
      path: {
        type: "string",
        pattern: PATH_PATTERN.source,
        description: "Mount path under hub origin, always under /app/ (e.g. '/app/gitcoin-brain').",
      },
      version: {
        type: "string",
        description: "Bundle version. Free-form; rendered for diagnostics.",
      },
      iconUrl: {
        type: "string",
        description: "Path to icon, relative to the UI bundle (e.g. 'icon.svg').",
      },
      scopes_required: {
        type: "array",
        items: { type: "string" },
        default: [...DEFAULT_SCOPES_REQUIRED],
        description: "OAuth scopes the UI declares as required.",
      },
      vault_default: {
        type: "string",
        description: "Optional single-vault binding hint for vault-specific UIs.",
      },
      pwa: {
        type: "boolean",
        default: false,
        description: "Opt into PWA mode — app serves the SW file with no-cache.",
      },
      pwa_service_worker: {
        type: "string",
        description: "Path within dist/ to the SW file (e.g. 'sw.js'). Required when pwa: true.",
      },
      public: {
        type: "boolean",
        default: false,
        description: "If true, hub does not enforce a session gate at /app/<name>/*.",
      },
      required_schema: {
        type: "object",
        additionalProperties: false,
        description:
          "Optional declaration of vault schema this app needs to function. Phase 2.0 validates shape; Phase 2.1+ auto-provisions missing tag-identity rows. Per patterns#57.",
        properties: {
          tags: {
            type: "array",
            description: "Tag-role declarations the app expects vault to have.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: {
                name: {
                  type: "string",
                  description: "Tag name (e.g. 'capture').",
                },
                description: {
                  type: "string",
                  description: "Operator-facing description; surfaced in the admin SPA.",
                },
                fields: {
                  type: "object",
                  description: "Per-field declarations keyed by field name.",
                  additionalProperties: {
                    type: "object",
                    additionalProperties: false,
                    required: ["type"],
                    properties: {
                      type: {
                        type: "string",
                        enum: [...REQUIRED_SCHEMA_FIELD_TYPES],
                        description: "Field type (matches vault's tag-identity field shape).",
                      },
                      required: {
                        type: "boolean",
                        description: "Whether the field is required on tag instances.",
                      },
                      description: {
                        type: "string",
                        description: "Field-level description; surfaced in the admin SPA.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
