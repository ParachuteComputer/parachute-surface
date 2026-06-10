/**
 * Admin endpoints — Phase 1.2 of parachute-app, extended by the R3b admin
 * revamp (inspect-before-install, URL-tarball sources, audience edit,
 * credential visibility + binding config, DCR retry).
 *
 * Routes implemented here:
 *
 *   GET  /surface/list                         — list mounted UIs (surface:read or surface:admin)
 *   POST /surface/add                          — register a new UI (surface:admin)
 *   POST /surface/inspect                      — stage + parse a source WITHOUT installing (surface:admin)
 *   DELETE /surface/<name>                     — unregister + remove (surface:admin)
 *   PATCH /surface/<name>                      — edit post-install fields (audience) (surface:admin)
 *   POST /surface/<name>/reload                — re-scan from disk (surface:admin)
 *   POST /surface/<name>/register-oauth        — re-attempt DCR registration (surface:admin)
 *   GET  /surface/<name>/info                  — full info for one UI (surface:read or surface:admin)
 *   GET  /surface/<name>/oauth-client          — public client_id discovery (UNAUTHENTICATED)
 *   GET  /surface/api/credentials              — stored credential copies, tokens stripped (surface:admin)
 *   PATCH /surface/api/config                  — edit daemon config (credential_connections) (surface:admin)
 *
 * The handlers operate on `AppState` (the same mutable state object the HTTP
 * server's `handle()` closes over). Every state-mutating handler:
 *
 *   1. Resolves the on-disk change (`uis/<name>/` write or unlink).
 *   2. Re-runs `scanUis()` to rebuild the in-memory list.
 *   3. Swaps `state.registeredUis` + `state.skippedUis` atomically.
 *   4. Re-runs `selfRegister` to refresh the `uis` map in services.json.
 *
 * That keeps the routing layer's "find the matching UI" lookup pointed at
 * a fresh source of truth without restarting the daemon. Hub reads
 * services.json per-request (post-hub#292) so the per-UI sub-units surface
 * in discovery on the next request.
 *
 * Auth model:
 *   - `surface:read` ≤ `surface:admin` (admin implies read). Enforced in `auth.ts`.
 *   - `oauth-client` is unauthenticated by design — the UI's JS reads it at
 *     page load before any token exists. The `client_id` is public OAuth
 *     metadata (RFC 7591 public client + PKCE).
 *
 * Path traversal defense: `<name>` is constrained to `[a-z][a-z0-9-]*` at
 * every layer — meta.json validation, `parseAddRequest`, and the URL
 * extractor below all reject anything else, so a request like
 * `DELETE /surface/..%2Fetc/passwd` falls through to a 404.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import { SCOPE_ADMIN, SCOPE_READ, enforceScope as defaultEnforceScope } from "./auth.ts";
import type { AppConfig } from "./config.ts";
import { resolveConfigPath, resolveUisDir } from "./config.ts";
import { DEFAULT_RENEW_WITHIN_MS } from "./credential-renewal.ts";
import {
  CONNECTION_ID_RE,
  CREDENTIAL_OPS,
  type CredentialPayload,
  type StoredCredential,
  applyCredentialPayload,
  deleteCredential,
  listCredentials,
  resolveCredentialForSurface,
} from "./credential-store.ts";
import {
  DcrError,
  type OauthClientRecord,
  readOauthClientFile,
  registerOauthClient,
  unregisterOauthClient,
  writeOauthClientFile,
} from "./dcr.ts";
import { removeSurfaceState } from "./host-context.ts";
import {
  InvalidMetaError,
  NAME_PATTERN,
  PATH_PATTERN,
  UI_AUDIENCES,
  type UiAudience,
  type UiMeta,
  parseMeta,
  parseMetaWithDiagnostics,
} from "./meta-schema.ts";
import { NpmFetchError, copyDir, fetchNpmPackage, parseNpmSpec } from "./npm-fetch.ts";
import { readOperatorToken } from "./operator-token.ts";
import { type ProvisionSchemaResult, provisionSchemaForUi } from "./provision-schema.ts";
import { resolveProjectRoot, selfRegister } from "./self-register.ts";
import { RESERVED_PATHS, type RegisteredUi, type SkippedUi, scanUis } from "./ui-registry.ts";
import { UrlFetchError, fetchUrlTarball, looksLikeUrlSource } from "./url-fetch.ts";

import type { AppState } from "./http-server.ts";

/**
 * Subset of `AppState` admin handlers mutate. Spelled separately so a unit
 * test can pass a synthetic state without needing the full http-server
 * dependency closure. `backends` (the backed-surface supervisor, P5) is
 * optional throughout — tests without it exercise the static paths only.
 */
export type AdminMutableState = Pick<
  AppState,
  "config" | "registeredUis" | "skippedUis" | "backends"
>;

/**
 * Test-only seam: override the auth-enforcement step. Production callers do
 * NOT pass this; the real `enforceScope` from `auth.ts` is used. Tests pass
 * a short-circuit that returns either a Response (forwarded) or a granted-
 * scopes object (allowed) without minting a real hub JWT.
 */
export type EnforceScopeFn = (
  req: Request,
  requiredScope: "surface:admin" | "surface:read",
) => Promise<Response | { scopes: readonly string[] }>;

export type AdminHandlerOpts = {
  /** Live mutable state — admin handlers re-scan + swap in-place. */
  state: AdminMutableState;
  /** Override the uis-dir location (tests). Defaults to `resolveUisDir(state.config)`. */
  uisDir?: string;
  /** Override the services.json path (tests). Defaults to `resolveManifestPath()`. */
  manifestPath?: string;
  /** Injected fetch for DCR calls (tests). */
  fetchFn?: import("./dcr.ts").FetchFn;
  /** Override operator token env / path (tests). */
  operatorTokenOverride?: () => string | undefined;
  /** Override npm-fetch spawner (tests). */
  npmSpawnFn?: import("./npm-fetch.ts").NpmSpawnFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** Skip self-register refresh after a mutation (tests). */
  skipSelfRegisterRefresh?: boolean;
  /** Test-only seam: replace `enforceScope` with a stub. */
  enforceScopeFn?: EnforceScopeFn;
  /**
   * Override the per-surface state dir (tests). Defaults to
   * `resolveSurfaceStateDir()` — `$PARACHUTE_HOME/surface/state/`.
   */
  stateDir?: string;
  /**
   * Override the credentials dir (tests). Defaults to
   * `resolveCredentialsDir()` — `$PARACHUTE_HOME/surface/credentials/`.
   */
  credentialsDir?: string;
  /**
   * Path of the daemon config file `PATCH /surface/api/config` persists to.
   * Defaults to `resolveConfigPath()`; serve() threads its own override
   * through so the PATCH writes the same file the daemon loaded.
   */
  configPath?: string;
};

type RouteOutcome = { handled: false } | { handled: true; response: Promise<Response> | Response };

/**
 * Route a request to an admin handler. Returns `{handled: false}` when the
 * request is not an admin route — the caller falls through to its next
 * matcher (per-UI static asset serving, then 404).
 *
 * Pattern matches the runner's `handle()` dispatch — short table at the
 * top, fall through is a 404.
 */
export function routeAdmin(req: Request, opts: AdminHandlerOpts): RouteOutcome {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /surface/list
  if (pathname === "/surface/list" && method === "GET") {
    return { handled: true, response: handleList(req, opts) };
  }

  // POST /surface/add
  if (pathname === "/surface/add" && method === "POST") {
    return { handled: true, response: handleAdd(req, opts) };
  }

  // POST /surface/inspect — stage + parse a source WITHOUT installing (R3b:
  // the add flow shows meta-derived fields + the server block's trust act
  // BEFORE the operator commits).
  if (pathname === "/surface/inspect" && method === "POST") {
    return { handled: true, response: handleInspect(req, opts) };
  }

  // POST /surface/api/credential — the hub's credential delivery/renewal/
  // removal endpoint (P3/H4). `/surface/api` is a RESERVED namespace (no
  // surface can claim it — see ui-registry RESERVED_PATHS), so this route
  // can never shadow a hosted surface.
  if (pathname === "/surface/api/credential" && method === "POST") {
    return { handled: true, response: handleCredentialDelivery(req, opts) };
  }

  // GET /surface/api/credentials — the host's stored credential copies,
  // TOKENS STRIPPED (operator visibility + the explicit-binding picker).
  if (pathname === "/surface/api/credentials" && method === "GET") {
    return { handled: true, response: handleListCredentials(req, opts) };
  }

  // PATCH /surface/api/config — daemon-config edits (today: the
  // `credential_connections` surface→connection binding map).
  if (pathname === "/surface/api/config" && method === "PATCH") {
    return { handled: true, response: handlePatchConfig(req, opts) };
  }

  // GET /surface/<name>/oauth-client — unauthenticated.
  const oauthMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)\/oauth-client$/);
  if (oauthMatch && method === "GET") {
    return { handled: true, response: handleOauthClient(oauthMatch[1]!, opts) };
  }

  // GET /surface/<name>/info
  const infoMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)\/info$/);
  if (infoMatch && method === "GET") {
    return { handled: true, response: handleInfo(req, infoMatch[1]!, opts) };
  }

  // POST /surface/<name>/reload
  const reloadMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)\/reload$/);
  if (reloadMatch && method === "POST") {
    return { handled: true, response: handleReload(req, reloadMatch[1]!, opts) };
  }

  // POST /surface/<name>/register-oauth — re-attempt DCR registration (R3b:
  // the in-SPA exit from the pending/failed dead-end).
  const registerOauthMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)\/register-oauth$/);
  if (registerOauthMatch && method === "POST") {
    return { handled: true, response: handleRegisterOauth(req, registerOauthMatch[1]!, opts) };
  }

  // POST /surface/<name>/provision-schema — Phase 2.1 manual re-trigger.
  const provisionMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)\/provision-schema$/);
  if (provisionMatch && method === "POST") {
    return { handled: true, response: handleProvisionSchema(req, provisionMatch[1]!, opts) };
  }

  // DELETE /surface/<name> + PATCH /surface/<name> (post-install edits).
  const nameMatch = pathname.match(/^\/surface\/([a-z][a-z0-9-]*)$/);
  if (nameMatch && method === "DELETE") {
    return { handled: true, response: handleDelete(req, nameMatch[1]!, opts) };
  }
  if (nameMatch && method === "PATCH") {
    return { handled: true, response: handlePatchUi(req, nameMatch[1]!, opts) };
  }

  return { handled: false };
}

/**
 * Run the auth gate. Uses `opts.enforceScopeFn` when supplied (tests),
 * otherwise calls the production `enforceScope` with the daemon's hub URL.
 */
function runEnforce(
  req: Request,
  scope: typeof SCOPE_ADMIN | typeof SCOPE_READ,
  opts: AdminHandlerOpts,
): Promise<Response | { scopes: readonly string[] }> {
  if (opts.enforceScopeFn) return opts.enforceScopeFn(req, scope);
  return defaultEnforceScope(req, scope, { hubUrl: opts.state.config.hub_url });
}

// --- /surface/list -----------------------------------------------------------

async function handleList(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  return Response.json({
    uis: opts.state.registeredUis.map((u) => serializeUi(u, opts)),
    skipped: opts.state.skippedUis,
  });
}

/**
 * REAL per-surface status (P5 — replaces the hardcoded `"active"`):
 * static surfaces report `"static-only"`; backed surfaces report the
 * supervisor's lifecycle state (`active | failing | backend-error |
 * backend-disabled`). Without a supervisor in scope (runOnce, unit tests),
 * a declared-but-unmounted backend honestly reads `"backend-error"`.
 */
function statusFor(
  u: RegisteredUi,
  backends?: import("./backend-supervisor.ts").BackendSupervisor,
): import("./backend-types.ts").SurfaceStatus {
  if (!u.meta.server) return "static-only";
  if (!backends) return "backend-error";
  return backends.statusFor(u);
}

/**
 * Operator-facing credential summary for a BACKED surface (R3b). `null` for
 * static surfaces (no server block → no credential story). Tokens never
 * appear here — identity + lifecycle fields only.
 *
 *   "ok"             — bound, valid, outside the renewal window.
 *   "expiring"       — bound + valid but inside the host's auto-renewal
 *                      window (informational; renewal is automatic).
 *   "expired"        — bound but past expiry; operator re-approves in hub.
 *   "needs-operator" — renewal got a terminal 401; re-approve in hub.
 *   "none"           — no stored credential matches this surface's vault.
 *   "ambiguous"      — multiple candidates; the explicit
 *                      `credential_connections` mapping is required
 *                      (`candidates` carries the connection ids to pick from).
 *   "missing"        — the config maps to a connection id with no stored copy.
 */
export type CredentialSummary = {
  state: "ok" | "expiring" | "expired" | "needs-operator" | "none" | "ambiguous" | "missing";
  connection_id?: string;
  vault: string;
  scope?: string;
  scoped_tags?: string[];
  expires_at?: string;
  /** Operator-actionable explanation for any non-ok state. */
  reason?: string;
  /** Candidate connection ids when the binding is ambiguous. */
  candidates?: string[];
  /** Other installed backed surfaces resolving to the same connection. */
  shared_with?: string[];
};

function credentialSummaryFor(ui: RegisteredUi, opts: AdminHandlerOpts): CredentialSummary | null {
  if (!ui.meta.server) return null;
  const dirOpt = opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {};
  const vault = ui.meta.vault_default ?? "default";
  const resolution = resolveCredentialForSurface(ui, { ...dirOpt, config: opts.state.config });

  if (resolution.ok) {
    const rec = resolution.record;
    const sharedWith = opts.state.registeredUis
      .filter((u) => u.meta.server !== undefined && u.meta.name !== ui.meta.name)
      .filter((u) => {
        const r = resolveCredentialForSurface(u, { ...dirOpt, config: opts.state.config });
        return r.ok && r.record.connection_id === rec.connection_id;
      })
      .map((u) => u.meta.name);
    let state: CredentialSummary["state"] = "ok";
    let reason: string | undefined;
    if (rec.status === "needs-operator") {
      state = "needs-operator";
      reason =
        "renewal was rejected by the hub — re-approve the connection in the hub admin (Connections)";
    } else {
      const expires = Date.parse(rec.expires_at);
      if (Number.isFinite(expires)) {
        if (expires <= Date.now()) {
          state = "expired";
          reason = `expired ${rec.expires_at} — re-approve the connection in the hub admin (Connections)`;
        } else if (expires - Date.now() <= DEFAULT_RENEW_WITHIN_MS) {
          state = "expiring";
          reason =
            "inside the renewal window — the host renews automatically; if this persists, check that the hub is reachable";
        }
      }
    }
    return {
      state,
      connection_id: rec.connection_id,
      vault: rec.vault,
      scope: rec.scope,
      scoped_tags: rec.scoped_tags,
      expires_at: rec.expires_at,
      ...(reason !== undefined ? { reason } : {}),
      ...(sharedWith.length > 0 ? { shared_with: sharedWith } : {}),
    };
  }

  // Unresolved — discriminate why so the SPA can render the right remediation.
  const mapped = opts.state.config.credential_connections?.[ui.meta.name];
  if (mapped !== undefined) {
    return { state: "missing", connection_id: mapped, vault, reason: resolution.reason };
  }
  const matching = listCredentials(opts.credentialsDir).filter((c) => c.vault === vault);
  if (matching.length === 0) {
    return { state: "none", vault, reason: resolution.reason };
  }
  return {
    state: "ambiguous",
    vault,
    reason: resolution.reason,
    candidates: matching.map((c) => c.connection_id),
  };
}

function serializeUi(u: RegisteredUi, opts: AdminHandlerOpts): SerializedUi {
  const backends = opts.state.backends;
  const oauth = readOauthClientFile(u.uiDir);
  const status = statusFor(u, backends);
  return {
    name: u.meta.name,
    dirName: u.dirName,
    displayName: u.meta.displayName,
    tagline: u.meta.tagline,
    path: u.meta.path,
    version: u.meta.version,
    iconUrl: u.meta.iconUrl,
    scopes_required: u.meta.scopes_required,
    pwa: u.meta.pwa,
    audience: u.meta.audience,
    public: u.meta.public,
    server: u.meta.server ?? null,
    status,
    // Operator-facing reason for a non-healthy backend (admin surfacing).
    statusReason: backends?.reasonFor(u.meta.name),
    // Credential lifecycle at a glance (R3b) — null for static surfaces.
    credential: credentialSummaryFor(u, opts),
    oauthClientId: oauth?.client_id,
    oauthStatus: oauth?.status,
    // Surface required_schema (patterns#57) so the admin SPA can render
    // a "Schema requirements" expandable section per row. Phase 2.0 is
    // display-only; auto-provisioning lands in Phase 2.1+.
    required_schema: u.meta.required_schema,
  };
}

export type SerializedUi = {
  name: string;
  dirName: string;
  displayName: string;
  tagline?: string;
  path: string;
  version?: string;
  iconUrl?: string;
  scopes_required: string[];
  pwa: boolean;
  /** Audience exposure (canonical; `public` is the derived legacy view). */
  audience: import("./meta-schema.ts").UiAudience;
  public: boolean;
  /** The validated `server` block when the surface is backed; null otherwise. */
  server: import("./meta-schema.ts").UiServerBlock | null;
  /** Real per-surface status (P5). Static surfaces are "static-only". */
  status: import("./backend-types.ts").SurfaceStatus;
  /** Operator-facing reason for a non-healthy backend, when any. */
  statusReason?: string;
  /** Credential lifecycle summary (R3b). `null` for static surfaces. */
  credential: CredentialSummary | null;
  oauthClientId?: string;
  oauthStatus?: string;
  /**
   * Optional declaration of vault schema this app needs to function.
   * Mirrors the UiMeta field of the same name (see `meta-schema.ts`).
   * Phase 2.0: display-only in admin SPA; Phase 2.1+ auto-provisions.
   */
  required_schema?: import("./meta-schema.ts").RequiredSchemaDeclaration;
};

// --- /surface/<name>/info ----------------------------------------------------

async function handleInfo(req: Request, name: string, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
  }
  const oauth = readOauthClientFile(ui.uiDir);
  return Response.json({
    ui: serializeUi(ui, opts),
    meta: ui.meta,
    paths: {
      uiDir: ui.uiDir,
      distDir: ui.distDir,
    },
    oauth_client: oauth ?? null,
  });
}

// --- /surface/<name>/oauth-client (UNAUTHENTICATED) --------------------------

async function handleOauthClient(name: string, opts: AdminHandlerOpts): Promise<Response> {
  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
  }
  const oauth = readOauthClientFile(ui.uiDir);
  if (!oauth) {
    return Response.json(
      {
        error: "not_found",
        message: `UI "${name}" has no registered OAuth client; either DCR was disabled or hub was unreachable at add time`,
      },
      { status: 404 },
    );
  }
  return Response.json({
    client_id: oauth.client_id,
    hub_url: oauth.hub_url,
    scope: oauth.scope,
    redirect_uris: oauth.redirect_uris,
  });
}

// --- POST /surface/api/credential (P3/H4 — hub credential delivery) ----------

/**
 * Receive a hub `CredentialPayload` (provisioned / renewed / removed —
 * parachute-hub/src/admin-connections.ts). AUTH: the hub authenticates its
 * deliveries with a short-lived `surface:admin` bearer (aud "surface") —
 * exactly what `enforceScope(SCOPE_ADMIN)` validates, so a random on-box
 * process can't plant a forged credential.
 *
 * `provisioned`/`renewed` persist the credential (0600, keyed by
 * connection id); `removed` drops our copy (the hub's best-effort teardown
 * notify — the authoritative kill is the jti revocation list).
 */
async function handleCredentialDelivery(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: CredentialPayload;
  try {
    body = (await req.json()) as CredentialPayload;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }

  const bad = (message: string) =>
    Response.json({ error: "invalid_payload", message }, { status: 400 });
  if (body?.kind !== "credential") return bad('expected kind: "credential"');
  if (!(CREDENTIAL_OPS as readonly string[]).includes(body.op as string)) {
    return bad(`op must be one of ${CREDENTIAL_OPS.join(", ")}`);
  }
  if (typeof body.connection_id !== "string" || !CONNECTION_ID_RE.test(body.connection_id)) {
    return bad("connection_id must be a valid identifier");
  }
  for (const field of ["key", "vault", "scope"] as const) {
    if (typeof body[field] !== "string" || body[field].length === 0) {
      return bad(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(body.scoped_tags) || body.scoped_tags.some((t) => typeof t !== "string")) {
    return bad("scoped_tags must be an array of strings");
  }

  try {
    const line = applyCredentialPayload(body, opts.credentialsDir);
    opts.logger?.log(`[app-admin] ${line}`);
  } catch (e) {
    // Missing token/jti/expires_at on a provisioned/renewed op.
    return bad((e as Error).message);
  }
  return Response.json({ ok: true, op: body.op, connection_id: body.connection_id });
}

// --- POST /surface/add -------------------------------------------------------

export type AddRequestBody = {
  /** Local path, npm package specifier, OR `http(s)://` tarball URL. Required. */
  source: string;
  /** UI name. When `source` is a local path with no meta.json, this is required. */
  name?: string;
  /** Mount path under `/surface/`. Same requirement as `name`. */
  path?: string;
  /** Override meta.json's displayName. */
  displayName?: string;
  /** Override meta.json's tagline. */
  tagline?: string;
  /** Override meta.json's scopes_required. */
  scopes_required?: string[];
  /** Override meta.json's vault_default. */
  vault_default?: string;
  /**
   * Override meta.json's audience (R3b: the add form's audience selector).
   * Validated through `parseMeta` like every other merged field.
   */
  audience?: UiAudience;
  /** Force reinstall over an existing UI of the same name. */
  force?: boolean;
};

/**
 * The three source kinds the add/inspect flows accept. URL is checked first
 * (an `https://` string is never a local path); an existing filesystem path
 * beats the npm-spec pattern (matches the original add behavior).
 */
export type SourceKind = "path" | "npm" | "url";

type StagedSource =
  | {
      ok: true;
      kind: SourceKind;
      /** Absolute path to the staged `dist/` (with index.html). */
      distDir: string;
      /** Absolute path to the staged `meta.json`, when one ships. */
      metaPath?: string;
      /** Cleanup for staged temp dirs (npm / url). Absent for local paths. */
      cleanup?: () => void;
    }
  | { ok: false; response: Response };

/**
 * Stage a source for add/inspect: resolve which kind it is, fetch/locate the
 * bundle, validate `dist/index.html` exists, find the sibling meta.json.
 * Shared by `addUiInternal` and `handleInspect` so the inspect preview can
 * never diverge from what an install would actually see.
 */
async function stageSource(source: string, opts: AdminHandlerOpts): Promise<StagedSource> {
  // URL-tarball branch (R3b).
  if (looksLikeUrlSource(source)) {
    try {
      const fetched = await fetchUrlTarball({
        url: source,
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
        ...(opts.npmSpawnFn !== undefined ? { spawnFn: opts.npmSpawnFn } : {}),
        ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      });
      return {
        ok: true,
        kind: "url",
        distDir: fetched.distPath,
        ...(fetched.metaJsonPath !== undefined ? { metaPath: fetched.metaJsonPath } : {}),
        cleanup: fetched.cleanup,
      };
    } catch (e) {
      if (e instanceof UrlFetchError) {
        const status =
          e.code === "http_error" || e.code === "network_error"
            ? 502
            : e.code === "too_large"
              ? 413
              : e.code === "bad_url" || e.code === "insecure_url"
                ? 400
                : 422; // bad_content_type | extract_failed | no_dist | staging_failed
        return {
          ok: false,
          response: Response.json(
            {
              error: e.code,
              message: e.message,
              ...(e.httpStatus !== undefined ? { http_status: e.httpStatus } : {}),
              ...(e.retryHint !== undefined ? { retry_hint: e.retryHint } : {}),
            },
            { status },
          ),
        };
      }
      throw e;
    }
  }

  // Identify whether `source` is a local path or an npm spec. Path takes
  // precedence — if it points at a real directory we treat it as filesystem.
  const sourceIsExistingPath = existsSync(source);
  const npmSpec = sourceIsExistingPath ? undefined : parseNpmSpec(source);
  if (!sourceIsExistingPath && !npmSpec) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "bad_source",
          message: `\"${source}\" is neither an existing local path, a valid npm package specifier, nor an http(s):// tarball URL`,
        },
        { status: 400 },
      ),
    };
  }

  if (sourceIsExistingPath) {
    // Local-path branch. Two layouts supported:
    //   (a) source is a `dist/` directory directly → use it as is
    //   (b) source is a parent containing `dist/` → use parent/dist
    // Detected by presence of `index.html` directly vs `dist/index.html`.
    const sourceAbs = path.resolve(source);
    const directIndex = path.join(sourceAbs, "index.html");
    const nestedIndex = path.join(sourceAbs, "dist", "index.html");
    let distDir: string;
    if (existsSync(directIndex)) {
      distDir = sourceAbs;
    } else if (existsSync(nestedIndex)) {
      distDir = path.join(sourceAbs, "dist");
    } else {
      return {
        ok: false,
        response: Response.json(
          {
            error: "bad_source",
            message: `local path ${sourceAbs} has neither index.html nor dist/index.html`,
          },
          { status: 400 },
        ),
      };
    }
    // Optional meta.json sibling: prefer `<source>/meta.json`, fall back
    // to `<source>/../meta.json` if source pointed at the dist itself.
    const directMeta = path.join(sourceAbs, "meta.json");
    const parentMeta = path.join(path.dirname(sourceAbs), "meta.json");
    const metaPath = existsSync(directMeta)
      ? directMeta
      : existsSync(parentMeta)
        ? parentMeta
        : undefined;
    return { ok: true, kind: "path", distDir, ...(metaPath !== undefined ? { metaPath } : {}) };
  }

  // npm-fetch branch.
  try {
    const fetched = await fetchNpmPackage({
      spec: source,
      spawnFn: opts.npmSpawnFn,
      logger: opts.logger,
    });
    return {
      ok: true,
      kind: "npm",
      distDir: fetched.distPath,
      ...(fetched.metaJsonPath !== undefined ? { metaPath: fetched.metaJsonPath } : {}),
      cleanup: fetched.cleanup,
    };
  } catch (e) {
    if (e instanceof NpmFetchError) {
      const status =
        e.code === "not_found"
          ? 404
          : e.code === "no_dist"
            ? 422
            : e.code === "network_error"
              ? 502
              : 422;
      return {
        ok: false,
        response: Response.json(
          {
            error: e.code,
            message: e.message,
            stderr: e.stderr,
            retry_hint: e.retryHint,
          },
          { status },
        ),
      };
    }
    throw e;
  }
}

async function handleAdd(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: AddRequestBody;
  try {
    body = (await req.json()) as AddRequestBody;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }

  const outcome = await addUiInternal(body, opts);
  return outcome.response;
}

/**
 * Result envelope from `addUiInternal`. `response` is always set so the
 * HTTP handler can return it directly. On success, `added` carries the
 * post-scan `RegisteredUi` so callers (bootstrap, the schema-
 * provisioner) can chain follow-up work without re-reading state.
 */
export type AddUiInternalResult = {
  response: Response;
  /** The newly-registered UI, when the add succeeded. */
  added?: RegisteredUi;
  /** The OAuth record stamped on disk, when DCR ran + succeeded. */
  oauthRecord?: OauthClientRecord;
};

/**
 * Core add-a-UI flow — extracted from `handleAdd` so it's callable
 * outside the HTTP path (bootstrap, schema-provisioner). The HTTP
 * handler parses the body + delegates here; bootstrap constructs the
 * body in-process. The auth gate stays in `handleAdd` — internal
 * callers are already trusted (they're inside the daemon process).
 *
 * Returns an `AddUiInternalResult` whose `.response` mirrors what the
 * HTTP endpoint returns; tests + bootstrap can read the parsed JSON to
 * branch on success/failure without unmarshalling a Response a second
 * time.
 */
export async function addUiInternal(
  body: AddRequestBody,
  opts: AdminHandlerOpts,
): Promise<AddUiInternalResult> {
  if (typeof body.source !== "string" || body.source.length === 0) {
    return {
      response: Response.json(
        { error: "bad_request", message: "`source` is required (string)" },
        { status: 400 },
      ),
    };
  }

  // Stage the source — local path copy, npm fetch, or URL-tarball download.
  const staged = await stageSource(body.source, opts);
  if (!staged.ok) return { response: staged.response };
  const stagedDistDir = staged.distDir;
  const stagedMetaPath = staged.metaPath;
  const cleanupStaging = staged.cleanup;

  try {
    // Assemble the meta.json the new UI will use. Priority:
    //   1. body overrides
    //   2. stagedMetaPath contents
    //   3. defaults
    let stagedMeta: Record<string, unknown> = {};
    if (stagedMetaPath) {
      try {
        stagedMeta = JSON.parse(readFileSync(stagedMetaPath, "utf8"));
        if (!stagedMeta || typeof stagedMeta !== "object" || Array.isArray(stagedMeta)) {
          stagedMeta = {};
        }
      } catch (e) {
        opts.logger?.warn(
          `[app-admin] couldn't parse staged meta.json at ${stagedMetaPath}: ${(e as Error).message}`,
        );
      }
    }
    const merged: Record<string, unknown> = { ...stagedMeta };
    if (body.name !== undefined) merged.name = body.name;
    if (body.path !== undefined) merged.path = body.path;
    if (body.displayName !== undefined) merged.displayName = body.displayName;
    if (body.tagline !== undefined) merged.tagline = body.tagline;
    if (body.scopes_required !== undefined) merged.scopes_required = body.scopes_required;
    if (body.vault_default !== undefined) merged.vault_default = body.vault_default;
    if (body.audience !== undefined) {
      // The operator's add-form choice wins over the bundle's declaration.
      // Drop a staged legacy `public` boolean so the override can't trip
      // parseMeta's audience/public contradiction check.
      merged.audience = body.audience;
      delete merged.public;
    }
    // Fall back to sensible defaults when neither body nor staged meta has it.
    if (merged.displayName === undefined && typeof merged.name === "string") {
      merged.displayName = merged.name;
    }

    // Validate the merged meta. Returns `parseMeta`'s typed shape or 400.
    let parsedMeta: ReturnType<typeof parseMeta>;
    try {
      parsedMeta = parseMeta(merged);
    } catch (e) {
      if (e instanceof InvalidMetaError) {
        return {
          response: Response.json(
            { error: "invalid_meta", message: e.message, details: e.details },
            { status: 400 },
          ),
        };
      }
      throw e;
    }

    // Name + path constraint extra (parseMeta covers regex, but we sanity
    // check that the name fits NAME_PATTERN explicitly here for clarity).
    if (!NAME_PATTERN.test(parsedMeta.name)) {
      return {
        response: Response.json(
          {
            error: "invalid_meta",
            message: `name "${parsedMeta.name}" violates ${NAME_PATTERN.source}`,
          },
          { status: 400 },
        ),
      };
    }
    if (!PATH_PATTERN.test(parsedMeta.path)) {
      return {
        response: Response.json(
          {
            error: "invalid_meta",
            message: `path "${parsedMeta.path}" violates ${PATH_PATTERN.source}`,
          },
          { status: 400 },
        ),
      };
    }
    if (RESERVED_PATHS.has(parsedMeta.path)) {
      return {
        response: Response.json(
          {
            error: "reserved_path",
            message: `\`${parsedMeta.path}\` is reserved by the surface host (admin SPA / dev routes / host API)`,
          },
          { status: 409 },
        ),
      };
    }

    const uisDir = opts.uisDir ?? resolveUisDir();
    const targetDir = path.join(uisDir, parsedMeta.name);

    if (existsSync(targetDir) && !body.force) {
      return {
        response: Response.json(
          {
            error: "name_exists",
            message: `UI named "${parsedMeta.name}" is already installed at ${targetDir}; pass force=true to replace`,
          },
          { status: 409 },
        ),
      };
    }

    // Mount-path collision check against the in-memory state (skipped UIs
    // can share a path-by-collision; we want a clean reject).
    const collision = opts.state.registeredUis.find(
      (u) => u.meta.path === parsedMeta.path && u.meta.name !== parsedMeta.name,
    );
    if (collision) {
      return {
        response: Response.json(
          {
            error: "path_taken",
            message: `mount path ${parsedMeta.path} is already claimed by "${collision.meta.name}"`,
          },
          { status: 409 },
        ),
      };
    }

    // Commit to disk: clear targetDir (force path), copy dist, write meta.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });
    const targetDist = path.join(targetDir, "dist");
    copyDir(stagedDistDir, targetDist);
    // Backed surface (P1): the server entry lives OUTSIDE dist/ (e.g.
    // `server/index.js`), so the dist-only copy above wouldn't carry it.
    // Copy the entry's top-level path segment from the staged package root
    // into the install dir. Missing files don't fail the install — the
    // supervisor reports `backend-error` (entry not found) and the static
    // bundle still serves.
    if (parsedMeta.server) {
      const copyWarn = copyServerFiles(
        stagedMetaPath ? path.dirname(stagedMetaPath) : path.dirname(stagedDistDir),
        targetDir,
        parsedMeta.server.entry,
        opts.logger,
      );
      if (copyWarn) opts.logger?.warn(`[app-admin] ${parsedMeta.name}: ${copyWarn}`);
    }
    const targetMetaPath = path.join(targetDir, "meta.json");
    writeFileSync(
      targetMetaPath,
      `${JSON.stringify(
        {
          name: parsedMeta.name,
          displayName: parsedMeta.displayName,
          tagline: parsedMeta.tagline,
          path: parsedMeta.path,
          version: parsedMeta.version,
          iconUrl: parsedMeta.iconUrl,
          scopes_required: parsedMeta.scopes_required,
          vault_default: parsedMeta.vault_default,
          pwa: parsedMeta.pwa,
          pwa_service_worker: parsedMeta.pwa_service_worker,
          // `audience` is canonical; `public` is written alongside (derived,
          // always consistent) for readers still on the legacy boolean.
          audience: parsedMeta.audience,
          public: parsedMeta.public,
          // Server block (P1) — preserved so re-scans rehydrate the backed
          // surface and the supervisor can mount it.
          server: parsedMeta.server,
          // Phase 2.0 — preserve required_schema so the scan in `scanUis()`
          // can rehydrate it from disk + the Phase 2.1 provisioner can
          // re-trigger off it. Without this projection, re-running
          // `parachute-surface reload <name>` would lose the declaration.
          required_schema: parsedMeta.required_schema,
        },
        null,
        2,
      )}\n`,
    );

    // DCR registration. Best-effort — failures don't unwind the install
    // because the UI is still mountable; the operator can re-register
    // later or click approve in hub admin.
    let oauthRecord: OauthClientRecord | undefined;
    let dcrWarning: string | undefined;
    if (opts.state.config.auto_register_oauth_clients) {
      const operatorToken =
        (opts.operatorTokenOverride
          ? opts.operatorTokenOverride()
          : readOperatorToken({ logger: opts.logger })) ?? undefined;
      const hubUrl = opts.state.config.hub_url;
      const redirectBase = `${hubUrl.replace(/\/$/, "")}${parsedMeta.path}`;
      try {
        const reg = await registerOauthClient({
          hubUrl,
          clientName: parsedMeta.displayName,
          redirectUris: [`${redirectBase}/`, `${redirectBase}/oauth-callback`],
          scopes: parsedMeta.scopes_required,
          operatorToken,
          fetchFn: opts.fetchFn,
          logger: opts.logger,
        });
        oauthRecord = {
          client_id: reg.client_id,
          client_name: reg.client_name ?? parsedMeta.displayName,
          redirect_uris: reg.redirect_uris,
          scope: reg.scope ?? parsedMeta.scopes_required.join(" "),
          status: reg.status,
          registered_at: new Date().toISOString(),
          hub_url: hubUrl,
        };
        writeOauthClientFile(targetDir, oauthRecord);
      } catch (e) {
        if (e instanceof DcrError) {
          dcrWarning = e.message;
          opts.logger?.warn(
            `[app-admin] DCR registration failed for ${parsedMeta.name}: ${e.message}`,
          );
        } else {
          throw e;
        }
      }
    }

    // Re-scan + swap state.
    const scan = scanUis({ uisDir, logger: opts.logger });
    opts.state.registeredUis = scan.registered;
    opts.state.skippedUis = scan.skipped.map((s: SkippedUi) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    }));

    // Backed surfaces (P5): mount the new backend / remount a force-replaced
    // one. sync() reconciles, so unrelated mounted backends are untouched.
    await opts.state.backends?.sync(opts.state.registeredUis);

    // Refresh services.json so hub picks up the new uis-map entry.
    if (!opts.skipSelfRegisterRefresh) {
      try {
        selfRegister({
          boundPort: 0, // ignored — existing entry's port preserves
          installDir: resolveProjectRoot(),
          manifestPath: opts.manifestPath,
          extraFields: buildSelfRegisterExtraFields(opts.state.registeredUis, opts.state.backends),
          logger: opts.logger,
        });
      } catch (e) {
        opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
      }
    }

    const added = opts.state.registeredUis.find((u) => u.meta.name === parsedMeta.name);

    // Phase 2.1 — auto-provision required_schema. Best-effort; failures
    // surface as a `provision_schema` warning slot on the response but
    // never unwind the install.
    let provisionSummary: ProvisionSchemaResult | undefined;
    if (added && opts.state.config.auto_provision_required_schema && added.meta.required_schema) {
      try {
        provisionSummary = await provisionSchemaForUi({
          ui: added,
          hubUrl: opts.state.config.hub_url,
          operatorTokenResolver:
            opts.operatorTokenOverride ?? (() => readOperatorToken({ logger: opts.logger })),
          fetchFn: opts.fetchFn,
          logger: opts.logger,
        });
      } catch (e) {
        opts.logger?.warn(
          `[app-admin] schema auto-provision failed for ${parsedMeta.name}: ${(e as Error).message}`,
        );
      }
    }

    return {
      response: Response.json(
        {
          ok: true,
          ui: added ? serializeUi(added, opts) : null,
          oauth_client_id: oauthRecord?.client_id,
          oauth_status: oauthRecord?.status,
          warning: dcrWarning,
          provision_schema: provisionSummary,
        },
        { status: 201 },
      ),
      ...(added ? { added } : {}),
      ...(oauthRecord ? { oauthRecord } : {}),
    };
  } finally {
    if (cleanupStaging) cleanupStaging();
  }
}

// --- POST /surface/inspect (R3b — stage + parse, no install) ------------------

export type InspectRequestBody = {
  /** Same source forms `POST /surface/add` accepts. */
  source: string;
};

/**
 * Stage a source and report what an install WOULD see — meta.json-derived
 * fields, validation problems, and the `server` block (the trust act the
 * operator should read before committing). Never touches `uis/`; staging
 * temp dirs are cleaned up before the response returns.
 */
async function handleInspect(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: InspectRequestBody;
  try {
    body = (await req.json()) as InspectRequestBody;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }
  if (typeof body.source !== "string" || body.source.length === 0) {
    return Response.json(
      { error: "bad_request", message: "`source` is required (string)" },
      { status: 400 },
    );
  }

  const staged = await stageSource(body.source, opts);
  if (!staged.ok) return staged.response;

  try {
    let rawMeta: Record<string, unknown> | null = null;
    if (staged.metaPath) {
      try {
        const parsed = JSON.parse(readFileSync(staged.metaPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          rawMeta = parsed as Record<string, unknown>;
        }
      } catch (e) {
        opts.logger?.warn(
          `[app-admin] inspect: couldn't parse staged meta.json: ${(e as Error).message}`,
        );
      }
    }

    let meta: UiMeta | null = null;
    let metaErrors: ReadonlyArray<{ path: string; message: string }> | null = null;
    let warnings: string[] = [];
    if (rawMeta !== null) {
      try {
        const r = parseMetaWithDiagnostics(rawMeta);
        meta = r.meta;
        warnings = r.warnings;
      } catch (e) {
        if (e instanceof InvalidMetaError) {
          metaErrors = e.details;
        } else {
          throw e;
        }
      }
    }

    return Response.json({
      ok: true,
      source_kind: staged.kind,
      has_meta: rawMeta !== null,
      /** Validated meta (defaults filled) — null when absent or invalid. */
      meta,
      /** Field-level validation problems when the staged meta.json is invalid. */
      meta_errors: metaErrors,
      warnings,
      /** The server block — the trust act to render BEFORE install. */
      server: meta?.server ?? null,
    });
  } finally {
    staged.cleanup?.();
  }
}

// --- DELETE /surface/<name> --------------------------------------------------

async function handleDelete(req: Request, name: string, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  const uisDir = opts.uisDir ?? resolveUisDir();
  const targetDir = path.join(uisDir, name);

  // We tolerate the case where the UI is in skipped state — operator wants
  // to clean up a broken install. So we look at the directory, not just the
  // active list.
  if (!existsSync(targetDir)) {
    return Response.json({ error: "not_found", message: `no UI at ${targetDir}` }, { status: 404 });
  }

  // Best-effort revoke OAuth client first.
  const oauth = readOauthClientFile(targetDir);
  const operatorToken =
    (opts.operatorTokenOverride
      ? opts.operatorTokenOverride()
      : readOperatorToken({ logger: opts.logger })) ?? undefined;
  const revoke = await unregisterOauthClient({
    hubUrl: opts.state.config.hub_url,
    clientId: oauth?.client_id,
    uiDir: targetDir,
    operatorToken,
    fetchFn: opts.fetchFn,
    logger: opts.logger,
  });

  // Capture the surface's credential binding BEFORE the scan swap drops it
  // from state (P3 removal: the host drops its COPY; tearing down the
  // connection itself is operator-driven via the hub).
  const removedUi = opts.state.registeredUis.find((u) => u.meta.name === name);
  const removedCredential =
    removedUi?.meta.server !== undefined
      ? resolveCredentialForSurface(removedUi, {
          ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
          config: opts.state.config,
        })
      : undefined;

  // Unmount the backend FIRST (shutdownSignal aborts, bounded shutdown
  // awaits) so in-flight work isn't pulling files out from under rmSync.
  await opts.state.backends?.unmount(name);

  // Remove the directory.
  rmSync(targetDir, { recursive: true, force: true });

  // Delete the surface's operational state (P2 lifecycle: the per-surface
  // SQLite store + config file must not outlive the surface).
  try {
    removeSurfaceState(name, opts.stateDir);
  } catch (e) {
    opts.logger?.warn(`[app-admin] state cleanup for "${name}" failed: ${(e as Error).message}`);
  }

  // Re-scan + swap state.
  const scan = scanUis({ uisDir, logger: opts.logger });
  opts.state.registeredUis = scan.registered;
  opts.state.skippedUis = scan.skipped.map((s) => ({
    dirName: s.dirName,
    status: s.status,
    reason: s.reason,
  }));

  // Reconcile any remaining backed surfaces (no-op for unrelated mounts).
  await opts.state.backends?.sync(opts.state.registeredUis);

  // Drop the local credential copy iff no remaining BACKED surface resolves
  // to the same connection (a credential is a module↔vault grant that may
  // be shared). We never call DELETE /admin/connections — connection
  // teardown is the operator's act in the hub; this only removes our copy.
  if (removedCredential?.ok) {
    const connectionId = removedCredential.record.connection_id;
    const stillReferenced = opts.state.registeredUis.some((u) => {
      if (!u.meta.server) return false;
      const r = resolveCredentialForSurface(u, {
        ...(opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {}),
        config: opts.state.config,
      });
      return r.ok && r.record.connection_id === connectionId;
    });
    if (!stillReferenced) {
      deleteCredential(connectionId, opts.credentialsDir);
      opts.logger?.log(
        `[app-admin] dropped local credential copy "${connectionId}" (no remaining surface uses it; the connection itself is torn down from the hub admin)`,
      );
    }
  }

  if (!opts.skipSelfRegisterRefresh) {
    try {
      selfRegister({
        boundPort: 0,
        installDir: resolveProjectRoot(),
        manifestPath: opts.manifestPath,
        extraFields: buildSelfRegisterExtraFields(opts.state.registeredUis, opts.state.backends),
        logger: opts.logger,
      });
    } catch (e) {
      opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
    }
  }

  return Response.json({
    ok: true,
    removed: name,
    oauth_revoke: revoke,
  });
}

// --- POST /surface/<name>/reload --------------------------------------------

async function handleReload(req: Request, name: string, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  const uisDir = opts.uisDir ?? resolveUisDir();
  const targetDir = path.join(uisDir, name);
  if (!existsSync(targetDir)) {
    return Response.json({ error: "not_found", message: `no UI at ${targetDir}` }, { status: 404 });
  }

  const scan = scanUis({ uisDir, logger: opts.logger });
  opts.state.registeredUis = scan.registered;
  opts.state.skippedUis = scan.skipped.map((s) => ({
    dirName: s.dirName,
    status: s.status,
    reason: s.reason,
  }));

  // Operator reload is the quarantine exit (P5): force a full unmount +
  // remount for THIS surface (fresh module import, crash-loop window reset)
  // even when nothing on disk changed; sync() reconciles the rest.
  const reloaded = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (opts.state.backends) {
    if (reloaded?.meta.server) {
      await opts.state.backends.reload(reloaded);
    } else {
      await opts.state.backends.sync(opts.state.registeredUis);
    }
  }

  if (!opts.skipSelfRegisterRefresh) {
    try {
      selfRegister({
        boundPort: 0,
        installDir: resolveProjectRoot(),
        manifestPath: opts.manifestPath,
        extraFields: buildSelfRegisterExtraFields(opts.state.registeredUis, opts.state.backends),
        logger: opts.logger,
      });
    } catch (e) {
      opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
    }
  }

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    const skipped = opts.state.skippedUis.find((s) => s.dirName === name);
    return Response.json({
      ok: true,
      ui: null,
      skipped: skipped ?? null,
      message: `UI "${name}" exists on disk but is currently inactive`,
    });
  }
  return Response.json({
    ok: true,
    ui: serializeUi(ui, opts),
  });
}

// --- PATCH /surface/<name> (R3b — post-install edits) -------------------------

export type PatchUiRequestBody = {
  /** New audience exposure. The only editable field today. */
  audience?: unknown;
};

/**
 * Edit a surface's post-install settings. Today: `audience` only. The write
 * goes to the installed `meta.json` (audience canonical + the derived legacy
 * `public` boolean kept consistent), then the standard re-scan + services.json
 * refresh — the hub's audience gate reads the refreshed `uis{}` map
 * per-request, so the change takes effect on the next proxied request.
 */
async function handlePatchUi(
  req: Request,
  name: string,
  opts: AdminHandlerOpts,
): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: PatchUiRequestBody;
  try {
    body = (await req.json()) as PatchUiRequestBody;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }
  if (body.audience === undefined) {
    return Response.json(
      { error: "bad_request", message: "nothing to update — supported fields: audience" },
      { status: 400 },
    );
  }
  if (
    typeof body.audience !== "string" ||
    !(UI_AUDIENCES as readonly string[]).includes(body.audience)
  ) {
    return Response.json(
      {
        error: "invalid_audience",
        message: `audience must be one of ${UI_AUDIENCES.map((a) => `"${a}"`).join(", ")}`,
      },
      { status: 400 },
    );
  }
  const audience = body.audience as UiAudience;

  const uisDir = opts.uisDir ?? resolveUisDir();
  const targetDir = path.join(uisDir, name);
  const metaPath = path.join(targetDir, "meta.json");
  if (!existsSync(metaPath)) {
    return Response.json({ error: "not_found", message: `no UI at ${targetDir}` }, { status: 404 });
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("meta.json root is not an object");
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    return Response.json(
      { error: "meta_unreadable", message: `couldn't read ${metaPath}: ${(e as Error).message}` },
      { status: 500 },
    );
  }
  raw.audience = audience;
  raw.public = audience === "public"; // keep the derived legacy view consistent
  writeFileSync(metaPath, `${JSON.stringify(raw, null, 2)}\n`);

  // Re-scan + swap state, then refresh services.json (the hub gate's
  // transport — H3 enforcement reads the refreshed audience per-request).
  const scan = scanUis({ uisDir, logger: opts.logger });
  opts.state.registeredUis = scan.registered;
  opts.state.skippedUis = scan.skipped.map((s) => ({
    dirName: s.dirName,
    status: s.status,
    reason: s.reason,
  }));
  if (!opts.skipSelfRegisterRefresh) {
    try {
      selfRegister({
        boundPort: 0,
        installDir: resolveProjectRoot(),
        manifestPath: opts.manifestPath,
        extraFields: buildSelfRegisterExtraFields(opts.state.registeredUis, opts.state.backends),
        logger: opts.logger,
      });
    } catch (e) {
      opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
    }
  }

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    // The edit landed but the re-scan rejected the result (corrupt meta
    // beyond the field we touched). Honest partial-state report.
    const skipped = opts.state.skippedUis.find((s) => s.dirName === name);
    return Response.json(
      {
        error: "ui_inactive_after_patch",
        message: `meta.json was updated but the UI failed re-scan${skipped ? `: ${skipped.reason}` : ""}`,
      },
      { status: 500 },
    );
  }
  return Response.json({ ok: true, ui: serializeUi(ui, opts) });
}

// --- POST /surface/<name>/register-oauth (R3b — DCR retry) --------------------

/**
 * Re-attempt DCR registration for an installed surface — the in-SPA exit
 * from the "DCR failed at add time / landed pending forever" dead-end. Runs
 * the same `registerOauthClient` the add path runs, with the CURRENT
 * operator token (an operator who has since signed in gets `approved`
 * instead of `pending`). Overwrites the on-disk `.oauth-client.json`; the
 * hub upserts by client_name+redirects or issues a fresh client_id —
 * either way the stamped record is what the UI's OAuth dance reads next.
 */
async function handleRegisterOauth(
  req: Request,
  name: string,
  opts: AdminHandlerOpts,
): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
  }

  const operatorToken =
    (opts.operatorTokenOverride
      ? opts.operatorTokenOverride()
      : readOperatorToken({ logger: opts.logger })) ?? undefined;
  const hubUrl = opts.state.config.hub_url;
  const redirectBase = `${hubUrl.replace(/\/$/, "")}${ui.meta.path}`;

  try {
    const reg = await registerOauthClient({
      hubUrl,
      clientName: ui.meta.displayName,
      redirectUris: [`${redirectBase}/`, `${redirectBase}/oauth-callback`],
      scopes: ui.meta.scopes_required,
      operatorToken,
      fetchFn: opts.fetchFn,
      logger: opts.logger,
    });
    const record: OauthClientRecord = {
      client_id: reg.client_id,
      client_name: reg.client_name ?? ui.meta.displayName,
      redirect_uris: reg.redirect_uris,
      scope: reg.scope ?? ui.meta.scopes_required.join(" "),
      status: reg.status,
      registered_at: new Date().toISOString(),
      hub_url: hubUrl,
    };
    writeOauthClientFile(ui.uiDir, record);

    // The client_id rides the services.json uis{} map — refresh it.
    if (!opts.skipSelfRegisterRefresh) {
      try {
        selfRegister({
          boundPort: 0,
          installDir: resolveProjectRoot(),
          manifestPath: opts.manifestPath,
          extraFields: buildSelfRegisterExtraFields(opts.state.registeredUis, opts.state.backends),
          logger: opts.logger,
        });
      } catch (e) {
        opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
      }
    }
    return Response.json({ ok: true, oauth_client: record });
  } catch (e) {
    if (e instanceof DcrError) {
      // Honest failure surfacing: the hub's words, not a paraphrase.
      const status =
        e.status === "hub_rejected" &&
        e.hubResponseStatus !== undefined &&
        e.hubResponseStatus < 500
          ? 422
          : 502;
      return Response.json(
        {
          error: e.status,
          message: e.message,
          hub_status: e.hubResponseStatus,
          hub_body: e.hubResponseBody,
        },
        { status },
      );
    }
    throw e;
  }
}

// --- GET /surface/api/credentials (R3b — credential visibility) ---------------

/** A stored credential with the SECRET fields stripped (wire shape). */
export type CredentialListEntry = Omit<StoredCredential, "token" | "jti"> & {
  /** Installed backed surfaces currently resolving to this connection. */
  used_by: string[];
};

async function handleListCredentials(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  const dirOpt = opts.credentialsDir !== undefined ? { dir: opts.credentialsDir } : {};
  const credentials: CredentialListEntry[] = listCredentials(opts.credentialsDir).map((c) => {
    const { token: _token, jti: _jti, ...rest } = c;
    const usedBy = opts.state.registeredUis
      .filter((u) => {
        if (!u.meta.server) return false;
        const r = resolveCredentialForSurface(u, { ...dirOpt, config: opts.state.config });
        return r.ok && r.record.connection_id === c.connection_id;
      })
      .map((u) => u.meta.name);
    return { ...rest, used_by: usedBy };
  });
  return Response.json({ ok: true, credentials });
}

// --- PATCH /surface/api/config (R3b — credential_connections binding) ---------

export type PatchConfigRequestBody = {
  /**
   * Merge-patch of the surface→connection binding map: a string value sets
   * the binding, an explicit `null` deletes it. Other config fields are NOT
   * editable here.
   */
  credential_connections?: Record<string, string | null>;
};

/**
 * Edit the daemon config's `credential_connections` map — the explicit
 * disambiguation the SPA writes when a surface's credential binding is
 * ambiguous (R3a resolution rule 1). Applies to the LIVE in-memory config
 * (the credential token provider reads `state.config` per call, so the
 * binding takes effect on the backend's next vault call — no remount) and
 * persists to the config file read-modify-write, preserving every other
 * field as written.
 */
async function handlePatchConfig(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: PatchConfigRequestBody;
  try {
    body = (await req.json()) as PatchConfigRequestBody;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }
  const patch = body.credential_connections;
  if (patch === undefined) {
    return Response.json(
      {
        error: "bad_request",
        message: "nothing to update — supported fields: credential_connections",
      },
      { status: 400 },
    );
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return Response.json(
      {
        error: "bad_request",
        message:
          "credential_connections must be an object mapping surface names to connection ids (null deletes)",
      },
      { status: 400 },
    );
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!NAME_PATTERN.test(k)) {
      return Response.json(
        { error: "bad_request", message: `"${k}" is not a valid surface name` },
        { status: 400 },
      );
    }
    if (v !== null && (typeof v !== "string" || !CONNECTION_ID_RE.test(v))) {
      return Response.json(
        {
          error: "bad_request",
          message: `credential_connections["${k}"] must be a connection id (or null to unbind)`,
        },
        { status: 400 },
      );
    }
  }

  // Persist FIRST (read-modify-write, preserving unknown fields), then swap
  // the in-memory map — a failed write never leaves memory + disk diverged.
  const configPath = opts.configPath ?? resolveConfigPath();
  let rawFile: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config root is not a JSON object");
      }
      rawFile = parsed as Record<string, unknown>;
    } catch (e) {
      return Response.json(
        {
          error: "config_unreadable",
          message: `refusing to overwrite an unparseable config at ${configPath}: ${(e as Error).message}`,
        },
        { status: 500 },
      );
    }
  }

  const next: Record<string, string> = { ...opts.state.config.credential_connections };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  rawFile.credential_connections = next;
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(rawFile, null, 2)}\n`);
  } catch (e) {
    return Response.json(
      {
        error: "config_write_failed",
        message: `couldn't write ${configPath}: ${(e as Error).message}`,
      },
      { status: 500 },
    );
  }
  opts.state.config.credential_connections = next;

  return Response.json({ ok: true, credential_connections: next });
}

// --- POST /surface/<name>/provision-schema (Phase 2.1) -----------------------

/**
 * Manual re-trigger for the auto-provisioning that runs on `add`. Use
 * cases:
 *   - Auto-provision failed at add time (vault down, no operator token);
 *     operator fixes the underlying issue + re-runs.
 *   - Operator changed the meta.json's `required_schema` post-install
 *     (added a new tag) and wants the new declarations seeded.
 *   - Multi-vault apps where the operator wants to push schema to a
 *     specific vault rather than the `vault_default` (override planned;
 *     Phase 2.2).
 */
async function handleProvisionSchema(
  req: Request,
  name: string,
  opts: AdminHandlerOpts,
): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
  }

  const summary = await provisionSchemaForUi({
    ui,
    hubUrl: opts.state.config.hub_url,
    operatorTokenResolver:
      opts.operatorTokenOverride ?? (() => readOperatorToken({ logger: opts.logger })),
    fetchFn: opts.fetchFn,
    logger: opts.logger,
  });

  // 200 either way — best-effort. The body carries the per-tag status so
  // the caller can render success/skip/error in the admin SPA.
  return Response.json({
    ok: summary.errors.length === 0,
    name,
    ...summary,
  });
}

/**
 * Assemble the per-UI `uis` map stamped into services.json. Carries the
 * minimum hub needs to render sub-tiles in discovery AND to enforce the
 * per-UI audience gate (H3): display metadata, mount path, scopes,
 * `audience`, status, and the per-UI OAuth client_id when DCR was
 * successful.
 *
 * `audience` + `scopes_required` are the transport half of the audience
 * gate — the hub's `UiSubUnit` reads exactly these field names
 * (parachute-hub/src/services-manifest.ts) and `gateUiAudience` enforces
 * them at the proxy BEFORE forwarding. surface-host TRANSPORTS the
 * declaration; the hub owns enforcement.
 */
function buildUisExtraField(
  uis: ReadonlyArray<RegisteredUi>,
  backends?: import("./backend-supervisor.ts").BackendSupervisor,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const u of uis) {
    const oauth = readOauthClientFile(u.uiDir);
    // Map the rich SurfaceStatus onto hub's UiSubUnitStatus vocabulary
    // (active|pending|inactive|failing — services-manifest.ts validation
    // REJECTS unknown values, dropping the whole row): a serving surface
    // (static-only or healthy backend) is "active"; any backend trouble is
    // "failing". The rich status lives on /surface/list (`serializeUi`).
    const rich = statusFor(u, backends);
    const hubStatus = rich === "static-only" || rich === "active" ? "active" : "failing";
    out[u.meta.name] = {
      displayName: u.meta.displayName,
      tagline: u.meta.tagline,
      path: u.meta.path,
      iconUrl: u.meta.iconUrl,
      version: u.meta.version,
      scopes_required: u.meta.scopes_required,
      audience: u.meta.audience,
      oauthClientId: oauth?.client_id,
      status: hubStatus,
    };
  }
  return out;
}

/**
 * Copy the server entry's files from the staged package root into the
 * install dir (P1). The dist-only copy predates backed surfaces; the entry
 * (plus whatever rides in its top-level directory — handlers, deps the
 * author bundled) lives outside dist/. Copies the entry's FIRST path
 * segment as a tree (or the file itself when the entry sits at the package
 * root). Already-present destinations (entry inside dist/, force-reinstall
 * leftovers) are skipped. Returns a warning string instead of throwing —
 * a missing server tree degrades to `backend-error`, never a failed add.
 */
function copyServerFiles(
  stagedRoot: string,
  targetDir: string,
  entry: string,
  logger?: Pick<Console, "log" | "warn" | "error">,
): string | undefined {
  const firstSeg = entry.split("/")[0] ?? "";
  if (firstSeg === "") return `server entry "${entry}" has no path segments`;
  const src = path.join(stagedRoot, firstSeg);
  const dest = path.join(targetDir, firstSeg);
  if (existsSync(dest)) return undefined; // e.g. entry inside dist/ — already copied
  if (!existsSync(src)) {
    return `server entry source not found in staged package: ${firstSeg} (looked in ${stagedRoot})`;
  }
  try {
    const st = statSync(src);
    if (st.isDirectory()) {
      copyDir(src, dest);
    } else {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    logger?.log(`[app-admin] copied server files: ${firstSeg}/`);
    return undefined;
  } catch (e) {
    return `failed to copy server files: ${(e as Error).message}`;
  }
}

/**
 * Assemble the FULL `extraFields` bag for `selfRegister` — the per-UI `uis`
 * map plus the row-level `websocket` capability flag (H1): `true` iff ANY
 * installed surface declares `server.capabilities: ["websocket"]`. The
 * hub's upgrade bridge is deny-by-default; without this flag a WS upgrade
 * for `/surface/<name>/ws` is refused (426) at the hub and never reaches
 * this daemon. Always written (explicit `false` clears a stale `true` after
 * the last WS-declaring surface is removed — the upsert merges, so absence
 * would leave the old value standing).
 */
export function buildSelfRegisterExtraFields(
  uis: ReadonlyArray<RegisteredUi>,
  backends?: import("./backend-supervisor.ts").BackendSupervisor,
): Record<string, unknown> {
  const websocket = uis.some((u) => u.meta.server?.capabilities.includes("websocket") === true);
  return { uis: buildUisExtraField(uis, backends), websocket };
}

/** Used by serve() at boot to stamp the same `uis` map on first selfRegister. */
export function buildUisExtraFieldForBoot(
  uis: ReadonlyArray<RegisteredUi>,
): Record<string, unknown> {
  return buildUisExtraField(uis);
}
