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

/** Default scopes applied when meta.json omits `scopes_required`. */
export const DEFAULT_SCOPES_REQUIRED: readonly string[] = ["vault:read"];

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
  /** OAuth scopes the UI declares as required. Defaults to `["vault:read"]`. */
  scopes_required: string[];
  /** Optional single-vault binding hint for vault-specific UIs. */
  vault_default?: string;
  /** Whether app should serve a service worker for this UI. Defaults to `false`. */
  pwa: boolean;
  /** Path within `dist/` to the SW file (e.g. `"sw.js"`). Required when `pwa: true`. */
  pwa_service_worker?: string;
  /** If `true`, hub does NOT enforce a session gate at `/app/<name>/*`. Defaults to `false`. */
  public: boolean;
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
 *   - `scopes_required` → `["vault:read"]` when absent
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
  };
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
    },
  };
}
