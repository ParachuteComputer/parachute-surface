/**
 * `meta.json` schema definition + validator for parachute-surface's hosted UIs.
 *
 * Each hosted UI ships a `meta.json` (Draft-07-shaped, see design doc section
 * 5). This file defines the in-memory `UiMeta` type and a hand-rolled
 * validator. We use a hand-rolled checker rather than pulling in ajv because:
 *
 *   1. The schema is small and stable (8 fields, half optional).
 *   2. Hand-rolling lets validation errors point at human-meaningful paths
 *      (`"meta.json: path must match ^/surface/[a-z0-9-]+$"`) without ajv's
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

/** Allowed pattern for a UI's mount `path` (always under `/surface/`). */
export const PATH_PATTERN = /^\/surface\/[a-z0-9-]+$/;

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
 * Audience exposure for a hosted surface (surface-runtime design §12; the
 * hub's audience gate H3 enforces it at the proxy BEFORE forwarding):
 *
 *   "public"    — anyone; no hub identity required (chrome strip off).
 *   "hub-users" — a valid hub session OR a hub-issued Bearer whose scopes
 *                 satisfy `scopes_required`. THE DEFAULT when absent.
 *   "operator"  — the first-admin session only.
 *   "surface"   — the surface backend owns audience admission (capability
 *                 links / its own sessions); the hub passes traffic through
 *                 to the backend's deny-by-default gateway. REQUIRES a hub
 *                 version that ships the `surface` audience tier: older
 *                 hubs' manifest validation rejects unknown audience values
 *                 and the lenient read DROPS the row — the mount 404s.
 *                 Declare it only once the operator's hub has the tier.
 *
 * The legacy boolean `public` field is accepted as an alias for one release
 * window (`public: true` → `"public"`, `public: false` → the default) with a
 * deprecation note in the validation diagnostics. When both are declared
 * they must agree — a meta.json saying `public: true` AND
 * `audience: "operator"` is a contradiction we refuse rather than guess.
 */
export const UI_AUDIENCES = ["public", "hub-users", "operator", "surface"] as const;
export type UiAudience = (typeof UI_AUDIENCES)[number];

/**
 * Operator-facing heads-up for `audience: "surface"` (#99). The warn is
 * UNCONDITIONAL because no cheap definitive hub-capability probe exists:
 * services.json carries no hub row, /.well-known/parachute.json exposes no
 * hub version, and the services.json write always succeeds locally — an
 * older hub only drops the row in ITS reader, invisible from here. Emitted
 * through `parseMetaWithDiagnostics` warnings (the scanner logs them on
 * every registration path: boot, add, PATCH re-scan, reload) and as the
 * `statusReason` hint on serialized rows.
 */
export const SURFACE_AUDIENCE_HUB_HINT =
  'audience "surface" requires a hub that ships the surface audience tier (hub#651 — releases after hub 0.7.0): an older hub\'s manifest validation drops this surface\'s services.json row and the mount 404s';

/** Default audience when neither `audience` nor legacy `public` is declared. */
export const DEFAULT_AUDIENCE: UiAudience = "hub-users";

/**
 * Capabilities a surface's server entry may declare (P1). Host-gated,
 * deny-by-default: an undeclared capability is refused at the routing layer
 * (a WS upgrade for a surface without `"websocket"` → 426), and the
 * services.json row only sets `websocket: true` (the hub bridge's
 * deny-by-default forwarding flag) when at least one installed surface
 * declares it.
 */
export const SERVER_CAPABILITIES = ["websocket"] as const;
export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];

/**
 * Canonical persisted-content format for a backed surface (backed-surface
 * pattern, "Content contract"): `"markdown"` (the default — vaults are
 * markdown; every other consumer assumes it) or `"opaque"` (e.g. Excalidraw
 * scenes — the surface must mark the note's format in metadata and accept
 * degraded siblings).
 */
export const SERVER_FORMATS = ["markdown", "opaque"] as const;
export type ServerFormat = (typeof SERVER_FORMATS)[number];

/** Bounds + default for the per-request containment timeout (P5/§11). */
export const SERVER_TIMEOUT_MIN_MS = 1_000;
export const SERVER_TIMEOUT_MAX_MS = 120_000;
export const SERVER_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * CSP directives a surface's `server.csp` override may ADD sources to
 * (P6/§13). v1 is strict: an override can only APPEND source entries to
 * these fetch-class directives — it can never touch `default-src`,
 * `object-src`, `frame-ancestors`, `base-uri`, or `form-action`, and it
 * can never LOOSEN (no `'unsafe-eval'` anywhere, no `'unsafe-inline'` for
 * scripts). Wider override semantics need an explicit allowlist design.
 */
export const CSP_OVERRIDABLE_DIRECTIVES = [
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "worker-src",
  "frame-src",
] as const;
export type CspOverridableDirective = (typeof CSP_OVERRIDABLE_DIRECTIVES)[number];

/**
 * One CSP source entry: a single token (no whitespace — that would smuggle
 * extra sources/directives), no `;`/`,` (directive/header injection).
 */
const CSP_SOURCE_RE = /^[^\s;,]+$/;

/**
 * The `server` block (P1) — a surface package that ships server logic
 * alongside its bundle declares it here. surface-host mounts the entry
 * in-process (see `backend-supervisor.ts`) under the surface's namespace.
 *
 * `entry` is a path WITHIN the surface package (relative to the surface's
 * installed root directory, `<uis>/<name>/`). Traversal is rejected at
 * parse time (no leading `/`, no `..` segments, no NUL, no backslashes) —
 * the mount path resolution re-checks containment as defense in depth.
 */
export type UiServerBlock = {
  /** Path within the package to the server entry (e.g. `"server/index.js"`). */
  entry: string;
  /** Canonical persisted format. Default `"markdown"`. */
  format: ServerFormat;
  /** Declared capabilities, host-gated. Default `[]`. */
  capabilities: ServerCapability[];
  /** Per-request containment timeout override, bounded 1s–120s. Default 30s. */
  timeoutMs: number;
  /**
   * CSP override (P6/§13): ADDITIONAL source entries per directive,
   * merged into the host's strict defaults (e.g.
   * `{ "connect-src": ["https://api.example.com"] }`). Add-only — see
   * {@link CSP_OVERRIDABLE_DIRECTIVES} for the rules.
   */
  csp?: Partial<Record<CspOverridableDirective, string[]>>;
};

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
  /**
   * Optional parent tag names for nested tag hierarchies. Each entry must
   * itself be declared elsewhere in the same `required_schema.tags` array
   * (or be a tag the vault already has). Phase 2.1+ auto-provisioner uses
   * this to mint the parent-child relationship in vault via vault's
   * `parent_names` column (see parachute-vault core/src/tag-hierarchy.ts).
   *
   * Example: `{ name: "capture/text", parent_names: ["capture"] }` —
   * a query for `tag: "capture"` then auto-expands to notes tagged
   * `capture/text` or `capture/voice`. Phase 2.0 validates the shape
   * only; cross-reference validation ("does the parent exist?") is the
   * auto-provisioner's job.
   */
  parent_names?: string[];
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
  /** Mount path under hub origin. Pattern: `^/surface/[a-z0-9-]+$`. */
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
  /**
   * Audience exposure (surface-runtime design §12). Canonical field; filled
   * with `"hub-users"` when neither it nor the legacy `public` alias is
   * declared. Transported to the hub via the services.json `uis{}` map and
   * ENFORCED at the hub proxy (audience gate, H3).
   */
  audience: UiAudience;
  /**
   * DERIVED legacy view of `audience` (`audience === "public"`), kept so
   * existing consumers (admin SPA list rows, older readers of the written
   * meta.json) don't break during the alias window. The canonical field is
   * `audience`; declaring `public` in meta.json emits a deprecation note.
   */
  public: boolean;
  /**
   * Optional server entry (P1) — present iff the surface is a BACKED
   * surface. See {@link UiServerBlock}.
   */
  server?: UiServerBlock;
  /**
   * Optional declaration of vault schema this app needs to function.
   * Phase 2.0 lands the shape (validate + surface in admin SPA); the
   * auto-provisioning that would create missing tag-identity rows in
   * vault at install time is Phase 2.1+. See `RequiredSchemaDeclaration`.
   * Per patterns#57 ("Surfaces declare required vault schema").
   */
  required_schema?: RequiredSchemaDeclaration;
  /**
   * Phase 3.0 — dev-mode file watcher source dir, expressed as a path
   * relative to the UI's root directory (`<uis>/<dirName>/`). The watcher
   * (recursive) fires `onChange` on any descendant change. Default when
   * absent: the UI's root dir minus `dist/` and `node_modules/` (handled
   * by the watcher's filter). Set this to e.g. `"../gitcoin-brain-ui/src"`
   * when the UI's source tree lives outside the installed bundle and the
   * operator is iterating from a checkout.
   */
  dev_watch_dir?: string;
  /**
   * Phase 3.0 — shell command to run on file change before broadcasting a
   * reload. Spawned via `sh -c <cmd>` with the UI's root dir as cwd. Empty
   * / absent → no build step; the watcher emits a reload directly. The
   * command should produce a fresh `dist/` (or whatever the bundle's
   * served files are) — app rebroadcasts on success and skips reload on
   * non-zero exit. Build output is captured to logs.
   */
  dev_build_cmd?: string;
  /**
   * Phase 3.0 — debounce window (ms) for batched file-change events.
   * Default 250ms. Build tools that touch many files in quick succession
   * (esbuild, Vite, tsc --watch) produce one reload per quiet-window
   * instead of one per file. Lower bound enforced at 50ms — anything
   * smaller risks reload-thrashing during a multi-file build.
   */
  dev_debounce_ms?: number;
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
 *   - `audience` → `"hub-users"` when absent (`public` derived from it)
 *   - `server.format` → `"markdown"`, `server.capabilities` → `[]`,
 *     `server.timeoutMs` → 30000 when a `server` block is present
 *
 * Non-fatal diagnostics (the legacy-`public` deprecation note) are dropped
 * here; callers that surface them use {@link parseMetaWithDiagnostics}.
 */
export function parseMeta(raw: unknown): UiMeta {
  return parseMetaWithDiagnostics(raw).meta;
}

/**
 * Like {@link parseMeta} but also returns non-fatal `warnings` — today the
 * legacy-`public`-alias deprecation note. The UI scanner logs these so
 * operators see the note in `parachute-surface list` / daemon logs without
 * the meta.json being rejected.
 */
export function parseMetaWithDiagnostics(raw: unknown): { meta: UiMeta; warnings: string[] } {
  const errors: Array<{ path: string; message: string }> = [];
  const warnings: string[] = [];

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

  // audience — optional enum; legacy boolean `public` accepted as an alias
  // (true → "public") with a deprecation note. When both are declared they
  // must agree — refuse the contradiction rather than guess.
  let audience: UiAudience = DEFAULT_AUDIENCE;
  let audienceDeclared = false;
  if (o.audience !== undefined) {
    if (
      typeof o.audience !== "string" ||
      !(UI_AUDIENCES as readonly string[]).includes(o.audience)
    ) {
      errors.push({
        path: "audience",
        message: `must be one of ${UI_AUDIENCES.map((a) => `"${a}"`).join(", ")}`,
      });
    } else {
      audience = o.audience as UiAudience;
      audienceDeclared = true;
    }
  }
  if (o.public !== undefined) {
    if (typeof o.public !== "boolean") {
      errors.push({ path: "public", message: "must be a boolean" });
    } else if (audienceDeclared) {
      const consistent = o.public === (audience === "public");
      if (!consistent) {
        errors.push({
          path: "public",
          message: `conflicts with audience "${audience}" — drop the legacy boolean (audience is canonical)`,
        });
      }
    } else {
      audience = o.public ? "public" : DEFAULT_AUDIENCE;
      warnings.push(
        `meta.json: "public" (boolean) is deprecated — declare audience: "${o.public ? "public" : DEFAULT_AUDIENCE}" instead`,
      );
    }
  }
  const publicField = audience === "public";
  if (audience === "surface") {
    // #99 — unconditional registration-time diagnostic (no cheap hub
    // probe exists; see SURFACE_AUDIENCE_HUB_HINT's doc comment).
    warnings.push(`meta.json: ${SURFACE_AUDIENCE_HUB_HINT}`);
  }

  // server — optional block (P1). See `UiServerBlock`.
  const server = parseServerBlock(o.server, errors);

  // required_schema — optional object; patterns#57 (Phase 2.0 lands shape,
  // Phase 2.1+ auto-provisions).
  const required_schema = parseRequiredSchema(o.required_schema, errors);

  // dev_watch_dir — optional string; Phase 3.0. Must be relative to the
  // UI's root directory — absolute paths are rejected as a footgun guard
  // (operators who genuinely want to watch an absolute path should use a
  // symlink or different tooling). Mirrors `pwa_service_worker`'s
  // leading-slash rejection.
  let dev_watch_dir: string | undefined;
  if (o.dev_watch_dir !== undefined) {
    if (typeof o.dev_watch_dir !== "string" || o.dev_watch_dir.length === 0) {
      errors.push({
        path: "dev_watch_dir",
        message: "must be a non-empty string (path relative to UI root)",
      });
    } else if (o.dev_watch_dir.startsWith("/")) {
      errors.push({
        path: "dev_watch_dir",
        message: `must be relative to the UI's root directory (got absolute path: "${o.dev_watch_dir}")`,
      });
    } else {
      dev_watch_dir = o.dev_watch_dir;
    }
  }

  // dev_build_cmd — optional string; Phase 3.0. Spawned via `sh -c`.
  let dev_build_cmd: string | undefined;
  if (o.dev_build_cmd !== undefined) {
    if (typeof o.dev_build_cmd !== "string" || o.dev_build_cmd.length === 0) {
      errors.push({
        path: "dev_build_cmd",
        message: "must be a non-empty string (shell command to run on file change)",
      });
    } else {
      dev_build_cmd = o.dev_build_cmd;
    }
  }

  // dev_debounce_ms — optional integer ≥ 50; Phase 3.0.
  let dev_debounce_ms: number | undefined;
  if (o.dev_debounce_ms !== undefined) {
    if (
      typeof o.dev_debounce_ms !== "number" ||
      !Number.isFinite(o.dev_debounce_ms) ||
      !Number.isInteger(o.dev_debounce_ms) ||
      o.dev_debounce_ms < 50
    ) {
      errors.push({
        path: "dev_debounce_ms",
        message: "must be an integer ≥ 50 (milliseconds)",
      });
    } else {
      dev_debounce_ms = o.dev_debounce_ms;
    }
  }

  if (errors.length > 0) {
    throw new InvalidMetaError("meta.json", errors);
  }

  const meta: UiMeta = {
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
    audience,
    public: publicField,
    ...(server ? { server } : {}),
    ...(required_schema ? { required_schema } : {}),
    ...(dev_watch_dir !== undefined ? { dev_watch_dir } : {}),
    ...(dev_build_cmd !== undefined ? { dev_build_cmd } : {}),
    ...(dev_debounce_ms !== undefined ? { dev_debounce_ms } : {}),
  };
  return { meta, warnings };
}

/**
 * Parse + validate the optional `server` block (P1). Returns `undefined`
 * when absent; appends field-level errors otherwise. Defaults filled:
 * `format: "markdown"`, `capabilities: []`, `timeoutMs: 30000`.
 *
 * The `entry` no-traversal rule is the load-bearing line: the entry is
 * dynamically imported into the daemon process at mount time, so a meta.json
 * must not be able to point it outside the surface's own package directory.
 * The mount path re-checks resolved containment as defense in depth
 * (`backend-supervisor.ts`).
 */
function parseServerBlock(
  raw: unknown,
  errors: Array<{ path: string; message: string }>,
): UiServerBlock | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path: "server", message: "must be an object" });
    return undefined;
  }
  const s = raw as Record<string, unknown>;

  // entry — required; a relative path within the package, traversal-free.
  let entry = "";
  if (typeof s.entry !== "string" || s.entry.length === 0) {
    errors.push({ path: "server.entry", message: "is required (non-empty string)" });
  } else if (s.entry.startsWith("/")) {
    errors.push({
      path: "server.entry",
      message: "must be a relative path within the surface package (no leading slash)",
    });
  } else if (
    s.entry.includes("\0") ||
    s.entry.includes("\\") ||
    s.entry.split("/").some((seg) => seg === ".." || seg === "")
  ) {
    errors.push({
      path: "server.entry",
      message: "must not contain traversal segments ('..'), backslashes, or NUL",
    });
  } else {
    entry = s.entry;
  }

  // format — optional enum; default "markdown".
  let format: ServerFormat = "markdown";
  if (s.format !== undefined) {
    if (typeof s.format !== "string" || !(SERVER_FORMATS as readonly string[]).includes(s.format)) {
      errors.push({
        path: "server.format",
        message: `must be one of ${SERVER_FORMATS.map((f) => `"${f}"`).join(", ")}`,
      });
    } else {
      format = s.format as ServerFormat;
    }
  }

  // capabilities — optional array of declared capabilities; default [].
  let capabilities: ServerCapability[] = [];
  if (s.capabilities !== undefined) {
    if (!Array.isArray(s.capabilities)) {
      errors.push({ path: "server.capabilities", message: "must be an array" });
    } else {
      const out: ServerCapability[] = [];
      let bad = false;
      for (let i = 0; i < s.capabilities.length; i++) {
        const v = s.capabilities[i];
        if (typeof v !== "string" || !(SERVER_CAPABILITIES as readonly string[]).includes(v)) {
          errors.push({
            path: `server.capabilities[${i}]`,
            message: `must be one of ${SERVER_CAPABILITIES.map((c) => `"${c}"`).join(", ")}`,
          });
          bad = true;
          break;
        }
        if (!out.includes(v as ServerCapability)) out.push(v as ServerCapability);
      }
      if (!bad) capabilities = out;
    }
  }

  // timeoutMs — optional integer, bounded [1s, 120s]; default 30s.
  let timeoutMs = SERVER_TIMEOUT_DEFAULT_MS;
  if (s.timeoutMs !== undefined) {
    if (
      typeof s.timeoutMs !== "number" ||
      !Number.isInteger(s.timeoutMs) ||
      s.timeoutMs < SERVER_TIMEOUT_MIN_MS ||
      s.timeoutMs > SERVER_TIMEOUT_MAX_MS
    ) {
      errors.push({
        path: "server.timeoutMs",
        message: `must be an integer between ${SERVER_TIMEOUT_MIN_MS} and ${SERVER_TIMEOUT_MAX_MS} (milliseconds)`,
      });
    } else {
      timeoutMs = s.timeoutMs;
    }
  }

  // csp — optional add-only override (P6/§13).
  const csp = parseCspOverride(s.csp, errors);

  if (entry === "") return undefined; // entry error already recorded
  return { entry, format, capabilities, timeoutMs, ...(csp ? { csp } : {}) };
}

/**
 * Validate the `server.csp` override: only ADD source entries to the
 * overridable fetch-class directives, never loosen. Rejected outright:
 * unknown directives, non-token entries (whitespace / `;` / `,` —
 * injection shapes), `'unsafe-eval'` anywhere, `'unsafe-inline'` for
 * `script-src`. v1 keeps this strict by design — a wider override grammar
 * needs an explicit allowlist design, not incremental loosening here.
 */
function parseCspOverride(
  raw: unknown,
  errors: Array<{ path: string; message: string }>,
): Partial<Record<CspOverridableDirective, string[]>> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ path: "server.csp", message: "must be an object (directive → source list)" });
    return undefined;
  }
  const out: Partial<Record<CspOverridableDirective, string[]>> = {};
  let bad = false;
  for (const [directive, sources] of Object.entries(raw as Record<string, unknown>)) {
    const at = `server.csp["${directive}"]`;
    if (!(CSP_OVERRIDABLE_DIRECTIVES as readonly string[]).includes(directive)) {
      errors.push({
        path: at,
        message: `directive is not overridable — overrides may only ADD sources to: ${CSP_OVERRIDABLE_DIRECTIVES.join(", ")}`,
      });
      bad = true;
      continue;
    }
    if (!Array.isArray(sources)) {
      errors.push({ path: at, message: "must be an array of source strings" });
      bad = true;
      continue;
    }
    const entries: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const v = sources[i];
      if (typeof v !== "string" || v.length === 0 || !CSP_SOURCE_RE.test(v)) {
        errors.push({
          path: `${at}[${i}]`,
          message: "must be a single CSP source token (no whitespace, ';' or ',')",
        });
        bad = true;
        break;
      }
      const lower = v.toLowerCase();
      if (lower === "'unsafe-eval'" || lower === "'wasm-unsafe-eval'") {
        errors.push({
          path: `${at}[${i}]`,
          message: "'unsafe-eval'-class sources are not permitted (v1 keeps CSP strict)",
        });
        bad = true;
        break;
      }
      if (directive === "script-src" && lower === "'unsafe-inline'") {
        errors.push({
          path: `${at}[${i}]`,
          message: "'unsafe-inline' is not permitted for script-src",
        });
        bad = true;
        break;
      }
      if (!entries.includes(v)) entries.push(v);
    }
    if (bad) continue;
    if (entries.length > 0) out[directive as CspOverridableDirective] = entries;
  }
  if (bad) return undefined;
  return Object.keys(out).length > 0 ? out : undefined;
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

        if (t.parent_names !== undefined) {
          if (!Array.isArray(t.parent_names)) {
            errors.push({
              path: `${pathPrefix}.parent_names`,
              message: "must be an array of non-empty strings",
            });
            bad = true;
            continue;
          }
          const parents: string[] = [];
          let parentsBad = false;
          for (let j = 0; j < t.parent_names.length; j++) {
            const p = t.parent_names[j];
            if (typeof p !== "string" || p.length === 0) {
              errors.push({
                path: `${pathPrefix}.parent_names[${j}]`,
                message: "must be a non-empty string",
              });
              parentsBad = true;
              break;
            }
            parents.push(p);
          }
          if (parentsBad) {
            bad = true;
            continue;
          }
          // Preserve `[]` distinct from `undefined` — explicit empty
          // is a deliberate operator signal (no parents) and we let
          // the admin SPA / auto-provisioner distinguish the two.
          tag.parent_names = parents;
        }

        if (t.fields !== undefined) {
          if (!t.fields || typeof t.fields !== "object" || Array.isArray(t.fields)) {
            errors.push({ path: `${pathPrefix}.fields`, message: "must be an object" });
            bad = true;
            continue;
          }
          const fields: Record<string, TagSchemaFieldDeclaration> = {};
          let fieldsBad = false;
          for (const [fieldName, fieldRaw] of Object.entries(t.fields as Record<string, unknown>)) {
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
    title: "parachute-surface UI meta.json",
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
        description:
          "Mount path under hub origin, always under /surface/ (e.g. '/surface/gitcoin-brain').",
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
      audience: {
        type: "string",
        enum: [...UI_AUDIENCES],
        default: DEFAULT_AUDIENCE,
        description:
          "Audience exposure, enforced at the hub proxy (surface-runtime design §12): 'public' (anyone), 'hub-users' (hub session or scoped Bearer — the default), 'operator' (first admin only), 'surface' (backend-owned admission — requires a hub shipping the surface audience tier).",
      },
      public: {
        type: "boolean",
        default: false,
        description:
          "DEPRECATED legacy alias for audience (true → 'public'). Declare `audience` instead; when both are present they must agree.",
      },
      server: {
        type: "object",
        additionalProperties: false,
        required: ["entry"],
        description:
          "Server entry for a BACKED surface (surface-runtime design P1). surface-host mounts it in-process; default export is `(ctx) => SurfaceBackend`.",
        properties: {
          entry: {
            type: "string",
            description:
              "Path within the surface package to the server entry (e.g. 'server/index.js'). Relative, traversal-free.",
          },
          format: {
            type: "string",
            enum: [...SERVER_FORMATS],
            default: "markdown",
            description:
              "Canonical persisted-content format. 'opaque' formats must mark the note's format in metadata.",
          },
          capabilities: {
            type: "array",
            items: { type: "string", enum: [...SERVER_CAPABILITIES] },
            default: [],
            description: "Declared capabilities, host-gated (deny-by-default).",
          },
          timeoutMs: {
            type: "integer",
            minimum: SERVER_TIMEOUT_MIN_MS,
            maximum: SERVER_TIMEOUT_MAX_MS,
            default: SERVER_TIMEOUT_DEFAULT_MS,
            description: "Per-request containment timeout override (bounded 1s–120s).",
          },
          csp: {
            type: "object",
            description:
              "Add-only CSP override: extra source entries per fetch-class directive, merged into the host's strict defaults. Never loosens (no 'unsafe-eval'; no 'unsafe-inline' for script-src).",
            propertyNames: { enum: [...CSP_OVERRIDABLE_DIRECTIVES] },
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
      },
      dev_watch_dir: {
        type: "string",
        description:
          "Phase 3.0 — directory (relative to UI root) the dev-mode file watcher monitors. Default: the UI's root directory minus dist/ and node_modules/.",
      },
      dev_build_cmd: {
        type: "string",
        description:
          "Phase 3.0 — shell command run on file change in dev mode (via `sh -c`); cwd is the UI's root directory. Absent → no build step; the watcher emits a reload directly.",
      },
      dev_debounce_ms: {
        type: "integer",
        minimum: 50,
        description:
          "Phase 3.0 — debounce window (ms) for batched file-change events. Default 250.",
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
                parent_names: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional parent tag names for nested tag hierarchies (e.g. ['capture'] for tag 'capture/text'). Phase 2.1+ auto-provisioner uses this to mint the parent-child relationship in vault.",
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
