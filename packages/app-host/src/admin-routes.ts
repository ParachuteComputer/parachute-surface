/**
 * Admin endpoints — Phase 1.2 of parachute-app.
 *
 * Routes implemented here:
 *
 *   GET  /app/list                         — list mounted UIs (app:read or app:admin)
 *   POST /app/add                          — register a new UI (app:admin)
 *   DELETE /app/<name>                     — unregister + remove (app:admin)
 *   POST /app/<name>/reload                — re-scan from disk (app:admin)
 *   GET  /app/<name>/info                  — full info for one UI (app:read or app:admin)
 *   GET  /app/<name>/oauth-client          — public client_id discovery (UNAUTHENTICATED)
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
 *   - `app:read` ≤ `app:admin` (admin implies read). Enforced in `auth.ts`.
 *   - `oauth-client` is unauthenticated by design — the UI's JS reads it at
 *     page load before any token exists. The `client_id` is public OAuth
 *     metadata (RFC 7591 public client + PKCE).
 *
 * Path traversal defense: `<name>` is constrained to `[a-z][a-z0-9-]*` at
 * every layer — meta.json validation, `parseAddRequest`, and the URL
 * extractor below all reject anything else, so a request like
 * `DELETE /app/..%2Fetc/passwd` falls through to a 404.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { SCOPE_ADMIN, SCOPE_READ, enforceScope as defaultEnforceScope } from "./auth.ts";
import type { AppConfig } from "./config.ts";
import { resolveUisDir } from "./config.ts";
import {
  DcrError,
  type OauthClientRecord,
  readOauthClientFile,
  registerOauthClient,
  unregisterOauthClient,
  writeOauthClientFile,
} from "./dcr.ts";
import { InvalidMetaError, NAME_PATTERN, PATH_PATTERN, parseMeta } from "./meta-schema.ts";
import { NpmFetchError, copyDir, fetchNpmPackage, parseNpmSpec } from "./npm-fetch.ts";
import { readOperatorToken } from "./operator-token.ts";
import { resolveProjectRoot, selfRegister } from "./self-register.ts";
import { type RegisteredUi, type SkippedUi, scanUis } from "./ui-registry.ts";

import type { AppState } from "./http-server.ts";

/**
 * Subset of `AppState` admin handlers mutate. Spelled separately so a unit
 * test can pass a synthetic state without needing the full http-server
 * dependency closure.
 */
export type AdminMutableState = Pick<AppState, "config" | "registeredUis" | "skippedUis">;

/**
 * Test-only seam: override the auth-enforcement step. Production callers do
 * NOT pass this; the real `enforceScope` from `auth.ts` is used. Tests pass
 * a short-circuit that returns either a Response (forwarded) or a granted-
 * scopes object (allowed) without minting a real hub JWT.
 */
export type EnforceScopeFn = (
  req: Request,
  requiredScope: "app:admin" | "app:read",
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

  // GET /app/list
  if (pathname === "/app/list" && method === "GET") {
    return { handled: true, response: handleList(req, opts) };
  }

  // POST /app/add
  if (pathname === "/app/add" && method === "POST") {
    return { handled: true, response: handleAdd(req, opts) };
  }

  // GET /app/<name>/oauth-client — unauthenticated.
  const oauthMatch = pathname.match(/^\/app\/([a-z][a-z0-9-]*)\/oauth-client$/);
  if (oauthMatch && method === "GET") {
    return { handled: true, response: handleOauthClient(oauthMatch[1]!, opts) };
  }

  // GET /app/<name>/info
  const infoMatch = pathname.match(/^\/app\/([a-z][a-z0-9-]*)\/info$/);
  if (infoMatch && method === "GET") {
    return { handled: true, response: handleInfo(req, infoMatch[1]!, opts) };
  }

  // POST /app/<name>/reload
  const reloadMatch = pathname.match(/^\/app\/([a-z][a-z0-9-]*)\/reload$/);
  if (reloadMatch && method === "POST") {
    return { handled: true, response: handleReload(req, reloadMatch[1]!, opts) };
  }

  // DELETE /app/<name>
  const deleteMatch = pathname.match(/^\/app\/([a-z][a-z0-9-]*)$/);
  if (deleteMatch && method === "DELETE") {
    return { handled: true, response: handleDelete(req, deleteMatch[1]!, opts) };
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

// --- /app/list -----------------------------------------------------------

async function handleList(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;
  return Response.json({
    uis: opts.state.registeredUis.map((u) => serializeUi(u)),
    skipped: opts.state.skippedUis,
  });
}

function serializeUi(u: RegisteredUi): SerializedUi {
  const oauth = readOauthClientFile(u.uiDir);
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
    public: u.meta.public,
    status: "active" as const,
    oauthClientId: oauth?.client_id,
    oauthStatus: oauth?.status,
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
  public: boolean;
  status: "active";
  oauthClientId?: string;
  oauthStatus?: string;
};

// --- /app/<name>/info ----------------------------------------------------

async function handleInfo(req: Request, name: string, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_READ, opts);
  if (auth instanceof Response) return auth;

  const ui = opts.state.registeredUis.find((u) => u.meta.name === name);
  if (!ui) {
    return Response.json({ error: "not_found", message: `no UI named "${name}"` }, { status: 404 });
  }
  const oauth = readOauthClientFile(ui.uiDir);
  return Response.json({
    ui: serializeUi(ui),
    meta: ui.meta,
    paths: {
      uiDir: ui.uiDir,
      distDir: ui.distDir,
    },
    oauth_client: oauth ?? null,
  });
}

// --- /app/<name>/oauth-client (UNAUTHENTICATED) --------------------------

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

// --- POST /app/add -------------------------------------------------------

export type AddRequestBody = {
  /** Local path OR npm package specifier. Required. */
  source: string;
  /** UI name. When `source` is a local path with no meta.json, this is required. */
  name?: string;
  /** Mount path under `/app/`. Same requirement as `name`. */
  path?: string;
  /** Override meta.json's displayName. */
  displayName?: string;
  /** Override meta.json's tagline. */
  tagline?: string;
  /** Override meta.json's scopes_required. */
  scopes_required?: string[];
  /** Override meta.json's vault_default. */
  vault_default?: string;
  /** Force reinstall over an existing UI of the same name. */
  force?: boolean;
};

async function handleAdd(req: Request, opts: AdminHandlerOpts): Promise<Response> {
  const auth = await runEnforce(req, SCOPE_ADMIN, opts);
  if (auth instanceof Response) return auth;

  let body: AddRequestBody;
  try {
    body = (await req.json()) as AddRequestBody;
  } catch (e) {
    return Response.json({ error: "invalid_json", message: (e as Error).message }, { status: 400 });
  }

  if (typeof body.source !== "string" || body.source.length === 0) {
    return Response.json(
      { error: "bad_request", message: "`source` is required (string)" },
      { status: 400 },
    );
  }

  // Identify whether `source` is a local path or an npm spec. Path takes
  // precedence — if it points at a real directory we treat it as filesystem.
  // Otherwise we try the npm spec pattern.
  const sourceIsExistingPath = existsSync(body.source);
  const npmSpec = sourceIsExistingPath ? undefined : parseNpmSpec(body.source);

  if (!sourceIsExistingPath && !npmSpec) {
    return Response.json(
      {
        error: "bad_source",
        message: `\"${body.source}\" is neither an existing local path nor a valid npm package specifier`,
      },
      { status: 400 },
    );
  }

  // Stage the source — either copy from the local path or fetch from npm.
  let stagedDistDir: string;
  let stagedMetaPath: string | undefined;
  let cleanupNpm: (() => void) | undefined;

  try {
    if (sourceIsExistingPath) {
      // Local-path branch. Two layouts supported:
      //   (a) source is a `dist/` directory directly → use it as is
      //   (b) source is a parent containing `dist/` → use parent/dist
      // Detected by presence of `index.html` directly vs `dist/index.html`.
      const sourceAbs = path.resolve(body.source);
      const directIndex = path.join(sourceAbs, "index.html");
      const nestedIndex = path.join(sourceAbs, "dist", "index.html");
      if (existsSync(directIndex)) {
        stagedDistDir = sourceAbs;
      } else if (existsSync(nestedIndex)) {
        stagedDistDir = path.join(sourceAbs, "dist");
      } else {
        return Response.json(
          {
            error: "bad_source",
            message: `local path ${sourceAbs} has neither index.html nor dist/index.html`,
          },
          { status: 400 },
        );
      }
      // Optional meta.json sibling: prefer `<source>/meta.json`, fall back
      // to `<source>/../meta.json` if source pointed at the dist itself.
      const directMeta = path.join(sourceAbs, "meta.json");
      const parentMeta = path.join(path.dirname(sourceAbs), "meta.json");
      stagedMetaPath = existsSync(directMeta)
        ? directMeta
        : existsSync(parentMeta)
          ? parentMeta
          : undefined;
    } else {
      // npm-fetch branch.
      try {
        const fetched = await fetchNpmPackage({
          spec: body.source,
          spawnFn: opts.npmSpawnFn,
          logger: opts.logger,
        });
        stagedDistDir = fetched.distPath;
        stagedMetaPath = fetched.metaJsonPath;
        cleanupNpm = fetched.cleanup;
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
          return Response.json(
            {
              error: e.code,
              message: e.message,
              stderr: e.stderr,
              retry_hint: e.retryHint,
            },
            { status },
          );
        }
        throw e;
      }
    }

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
        return Response.json(
          { error: "invalid_meta", message: e.message, details: e.details },
          { status: 400 },
        );
      }
      throw e;
    }

    // Name + path constraint extra (parseMeta covers regex, but we sanity
    // check that the name fits NAME_PATTERN explicitly here for clarity).
    if (!NAME_PATTERN.test(parsedMeta.name)) {
      return Response.json(
        {
          error: "invalid_meta",
          message: `name "${parsedMeta.name}" violates ${NAME_PATTERN.source}`,
        },
        { status: 400 },
      );
    }
    if (!PATH_PATTERN.test(parsedMeta.path)) {
      return Response.json(
        {
          error: "invalid_meta",
          message: `path "${parsedMeta.path}" violates ${PATH_PATTERN.source}`,
        },
        { status: 400 },
      );
    }
    if (parsedMeta.path === "/app/admin") {
      return Response.json(
        { error: "reserved_path", message: "`/app/admin` is reserved for the admin SPA" },
        { status: 409 },
      );
    }

    const uisDir = opts.uisDir ?? resolveUisDir();
    const targetDir = path.join(uisDir, parsedMeta.name);

    if (existsSync(targetDir) && !body.force) {
      return Response.json(
        {
          error: "name_exists",
          message: `UI named "${parsedMeta.name}" is already installed at ${targetDir}; pass force=true to replace`,
        },
        { status: 409 },
      );
    }

    // Mount-path collision check against the in-memory state (skipped UIs
    // can share a path-by-collision; we want a clean reject).
    const collision = opts.state.registeredUis.find(
      (u) => u.meta.path === parsedMeta.path && u.meta.name !== parsedMeta.name,
    );
    if (collision) {
      return Response.json(
        {
          error: "path_taken",
          message: `mount path ${parsedMeta.path} is already claimed by "${collision.meta.name}"`,
        },
        { status: 409 },
      );
    }

    // Commit to disk: clear targetDir (force path), copy dist, write meta.
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(targetDir, { recursive: true });
    const targetDist = path.join(targetDir, "dist");
    copyDir(stagedDistDir, targetDist);
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
          public: parsedMeta.public,
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

    // Refresh services.json so hub picks up the new uis-map entry.
    if (!opts.skipSelfRegisterRefresh) {
      try {
        selfRegister({
          boundPort: 0, // ignored — existing entry's port preserves
          installDir: resolveProjectRoot(),
          manifestPath: opts.manifestPath,
          extraFields: { uis: buildUisExtraField(opts.state.registeredUis) },
          logger: opts.logger,
        });
      } catch (e) {
        opts.logger?.warn(`[app-admin] services.json refresh failed: ${(e as Error).message}`);
      }
    }

    const added = opts.state.registeredUis.find((u) => u.meta.name === parsedMeta.name);
    return Response.json(
      {
        ok: true,
        ui: added ? serializeUi(added) : null,
        oauth_client_id: oauthRecord?.client_id,
        oauth_status: oauthRecord?.status,
        warning: dcrWarning,
      },
      { status: 201 },
    );
  } finally {
    if (cleanupNpm) cleanupNpm();
  }
}

// --- DELETE /app/<name> --------------------------------------------------

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

  // Remove the directory.
  rmSync(targetDir, { recursive: true, force: true });

  // Re-scan + swap state.
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
        extraFields: { uis: buildUisExtraField(opts.state.registeredUis) },
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

// --- POST /app/<name>/reload --------------------------------------------

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

  if (!opts.skipSelfRegisterRefresh) {
    try {
      selfRegister({
        boundPort: 0,
        installDir: resolveProjectRoot(),
        manifestPath: opts.manifestPath,
        extraFields: { uis: buildUisExtraField(opts.state.registeredUis) },
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
    ui: serializeUi(ui),
  });
}

/**
 * Assemble the per-UI `uis` map stamped into services.json. Carries the
 * minimum hub needs to render sub-tiles in discovery: display metadata,
 * mount path, scopes, status, and the per-UI OAuth client_id when DCR
 * was successful.
 */
function buildUisExtraField(uis: ReadonlyArray<RegisteredUi>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const u of uis) {
    const oauth = readOauthClientFile(u.uiDir);
    out[u.meta.name] = {
      displayName: u.meta.displayName,
      tagline: u.meta.tagline,
      path: u.meta.path,
      iconUrl: u.meta.iconUrl,
      version: u.meta.version,
      scopes_required: u.meta.scopes_required,
      oauthClientId: oauth?.client_id,
      status: "active",
    };
  }
  return out;
}

/** Used by serve() at boot to stamp the same `uis` map on first selfRegister. */
export function buildUisExtraFieldForBoot(
  uis: ReadonlyArray<RegisteredUi>,
): Record<string, unknown> {
  return buildUisExtraField(uis);
}
