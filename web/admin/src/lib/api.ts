/**
 * API helpers — thin fetch wrapper for the admin endpoints.
 *
 * All admin endpoints under `/surface/*` (except `/oauth-client`) require a
 * bearer carrying `surface:admin` or `surface:read`.
 *
 * Bearer resolution (boundary C4 — hub-session sign-in):
 *   1. Session path (default, zero-paste): `lib/auth.ts` silently mints a
 *      `surface:admin` JWT from the hub session cookie via
 *      `GET /admin/module-token/surface` and caches it in memory.
 *   2. Legacy fallback: when the silent mint can't work (no hub in front of
 *      us, or no signed-in admin session), the operator-pasted token from
 *      `localStorage["parachute_operator_token"]` is honored — set via the
 *      `TokenSetup` fallback affordance.
 *
 * On a 401 the wrapper drops the cached session token, re-mints once, and
 * retries the request once — covering token expiry races, revocation, and
 * hub restarts without surfacing an error for a recoverable blip.
 */

// Canonical type definitions live in app-host (`packages/surface-host/src/
// meta-schema.ts`) — re-imported here so the admin SPA can't drift from
// the server's shape. Type-only import keeps zero runtime bundle cost.
import type {
  RequiredSchemaDeclaration,
  RequiredSchemaFieldType,
  TagSchemaDeclaration,
  TagSchemaFieldDeclaration,
} from "@openparachute/surface/meta-schema";

import { clearSessionToken, ensureToken } from "./auth.ts";

export type {
  RequiredSchemaDeclaration,
  RequiredSchemaFieldType,
  TagSchemaDeclaration,
  TagSchemaFieldDeclaration,
};

export const TOKEN_STORAGE_KEY = "parachute_operator_token";

export type UiAudience = "public" | "hub-users" | "operator";

/** The validated `server` block of a backed surface (meta-schema P1). */
export type UiServerBlock = {
  entry: string;
  format: "markdown" | "opaque";
  capabilities: string[];
  timeoutMs: number;
  csp?: Record<string, string[]>;
};

/**
 * Credential lifecycle summary for a backed surface (R3b — mirrors
 * surface-host's `CredentialSummary`). `null` for static surfaces.
 */
export type CredentialSummary = {
  state: "ok" | "expiring" | "expired" | "needs-operator" | "none" | "ambiguous" | "missing";
  connection_id?: string;
  vault: string;
  scope?: string;
  scoped_tags?: string[];
  expires_at?: string;
  reason?: string;
  candidates?: string[];
  shared_with?: string[];
};

export type UiSummary = {
  name: string;
  dirName: string;
  /**
   * The PACKAGE's own name from its meta.json (#105). Equals `name` unless
   * the install is a renamed instance (instance_name override at add time).
   * Optional: older daemons don't send it — fall back to `name`.
   */
  packageName?: string;
  packagePath?: string;
  displayName: string;
  tagline?: string;
  path: string;
  version?: string;
  iconUrl?: string;
  scopes_required: string[];
  pwa: boolean;
  /** Audience exposure (canonical; `public` is the derived legacy view). */
  audience?: UiAudience;
  public: boolean;
  /** The validated server block when the surface is backed; null/absent otherwise. */
  server?: UiServerBlock | null;
  /**
   * Real per-surface status (surface-runtime P5): static surfaces report
   * "static-only"; backed surfaces report their backend lifecycle state.
   */
  status:
    | "static-only"
    | "active"
    | "pending-credential"
    | "failing"
    | "backend-error"
    | "backend-disabled";
  /** Operator-facing reason for a non-healthy backend, when any. */
  statusReason?: string;
  /** Credential lifecycle at a glance (R3b). Null/absent for static surfaces. */
  credential?: CredentialSummary | null;
  oauthClientId?: string;
  oauthStatus?: string;
  required_schema?: RequiredSchemaDeclaration;
};

export type SkippedUi = {
  dirName: string;
  status: string;
  reason: string;
};

export type ListResponse = {
  uis: UiSummary[];
  skipped: SkippedUi[];
};

export type AddRequestBody = {
  source: string;
  name?: string;
  path?: string;
  displayName?: string;
  tagline?: string;
  scopes_required?: string[];
  vault_default?: string;
  /** Audience exposure chosen in the add form (default hub-users). */
  audience?: UiAudience;
  /**
   * Instance name override (#105) — install the package under a distinct
   * instance identity so one package can be installed several times
   * (instance-per-vault). Defaults to the package meta's name.
   */
  instance_name?: string;
  /** Mount path override for this instance (#105). Defaults to meta's path. */
  mount_path?: string;
  force?: boolean;
};

export type AddResponse = {
  ok: boolean;
  ui: UiSummary | null;
  oauth_client_id?: string;
  oauth_status?: string;
  warning?: string;
  /** Which release asset a GitHub-release source resolved to (absent otherwise). */
  github_release?: ResolvedGithubRelease;
};

/**
 * A resolved GitHub release asset — what `owner/repo` / repo-home / release
 * URLs resolve to server-side before riding the URL-tarball install path.
 */
export type ResolvedGithubRelease = {
  owner: string;
  repo: string;
  /** The release's tag name (resolved even when the source said "latest"). */
  tag: string;
  /** The chosen asset's file name. */
  asset_name: string;
  /** The asset's browser_download_url — installing THIS exact artifact. */
  download_url: string;
};

export type UiInfoResponse = {
  ui: UiSummary;
  meta: Record<string, unknown>;
  paths: { uiDir: string; distDir: string };
  oauth_client: {
    client_id: string;
    hub_url: string;
    scope: string;
    registered_at: string;
    status?: string;
  } | null;
};

export type ApiError = {
  status: number;
  error?: string;
  message?: string;
  details?: unknown;
  body?: unknown;
};

/** Read the legacy pasted token. The FALLBACK path — see module docstring. */
export function getOperatorToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist a pasted token. Only the explicit fallback affordance calls this —
 *  the session path NEVER writes localStorage (in-memory cache only). */
export function setOperatorToken(t: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, t);
  } catch {
    // ignored — operator's localStorage is wedged, surface only via UX.
  }
}

/** Remove the legacy pasted token (the "Clear" affordances). */
export function clearOperatorToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignored — see setOperatorToken.
  }
}

/**
 * Resolve the bearer for one request: prefer a (possibly freshly-minted)
 * session token; fall back to the legacy pasted token when the silent mint
 * can't work. Returns `null` when neither path yields a token — the request
 * goes out unauthenticated and the server's 401 drives the banner.
 */
async function resolveBearer(): Promise<string | null> {
  const minted = await ensureToken();
  if (minted.kind === "ok") return minted.token;
  return getOperatorToken();
}

async function call<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const first = await callOnce<T>(method, path, body, await resolveBearer());
  if (!first.unauthorized) return first.value;
  // 401 → drop the cached session token, re-mint once, retry once. When the
  // re-mint fails (or yields the same rejected bearer) rethrow the original
  // 401 — there's nothing fresher to retry with.
  clearSessionToken();
  const reminted = await ensureToken();
  const retryBearer = reminted.kind === "ok" ? reminted.token : getOperatorToken();
  if (!retryBearer || retryBearer === first.bearer) throw first.error;
  const second = await callOnce<T>(method, path, body, retryBearer);
  if (second.unauthorized) throw second.error;
  return second.value;
}

type CallOutcome<T> =
  | { unauthorized: false; value: T }
  | { unauthorized: true; error: ApiError; bearer: string | null };

async function callOnce<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body: unknown,
  bearer: string | null,
): Promise<CallOutcome<T>> {
  const init: RequestInit = {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (res.status >= 200 && res.status < 300) return { unauthorized: false, value: parsed as T };
  const err: ApiError = {
    status: res.status,
    ...(parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { body: parsed }),
  };
  if (res.status === 401) return { unauthorized: true, error: err, bearer };
  throw err;
}

export function listUis(): Promise<ListResponse> {
  return call("GET", "/surface/list");
}

export function addUi(body: AddRequestBody): Promise<AddResponse> {
  return call("POST", "/surface/add", body);
}

// --- R3b: inspect-before-install ------------------------------------------

export type InspectResponse = {
  ok: boolean;
  source_kind: "path" | "npm" | "url";
  /**
   * The resolved release (tag + asset) when the source was a GitHub-release
   * shape (`owner/repo`, repo home, release page). Null otherwise. The
   * confirm step renders it AND installs via its `download_url` — the
   * operator installs exactly the inspected artifact (no latest-race, no
   * second GitHub API call).
   */
  github_release?: ResolvedGithubRelease | null;
  has_meta: boolean;
  /** Validated meta (defaults filled) — null when absent or invalid. */
  meta: {
    name: string;
    displayName: string;
    tagline?: string;
    path: string;
    version?: string;
    scopes_required: string[];
    vault_default?: string;
    pwa: boolean;
    audience: UiAudience;
    server?: UiServerBlock;
    required_schema?: RequiredSchemaDeclaration;
  } | null;
  /** Field-level validation problems when the staged meta.json is invalid. */
  meta_errors: Array<{ path: string; message: string }> | null;
  warnings: string[];
  /** The server block — the trust act to render BEFORE install. */
  server: UiServerBlock | null;
};

export function inspectSource(source: string): Promise<InspectResponse> {
  return call("POST", "/surface/inspect", { source });
}

/** Composed-remove response: the DCR-unregister outcome rides along. */
export type RemoveResponse = {
  ok: boolean;
  removed: string;
  oauth_revoke?: {
    localFileRemoved: boolean;
    hubDeleteStatus: "ok" | "not_found" | "unsupported" | "error" | "unreachable" | "skipped";
    detail?: string;
  };
};

export function removeUi(name: string): Promise<RemoveResponse> {
  return call("DELETE", `/surface/${encodeURIComponent(name)}`);
}

// --- R3b: post-install edits + DCR retry + credential visibility -----------

export function patchUi(
  name: string,
  body: { audience: UiAudience },
): Promise<{ ok: boolean; ui: UiSummary }> {
  return call("PATCH", `/surface/${encodeURIComponent(name)}`, body);
}

export type RegisterOauthResponse = {
  ok: boolean;
  oauth_client: {
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    scope: string;
    status?: string;
    registered_at: string;
    hub_url: string;
  };
};

export function registerOauth(name: string): Promise<RegisterOauthResponse> {
  return call("POST", `/surface/${encodeURIComponent(name)}/register-oauth`);
}

export type HostCredential = {
  connection_id: string;
  key: string;
  vault: string;
  scope: string;
  scoped_tags: string[];
  expires_at: string;
  renew_path: string;
  status: "ok" | "needs-operator";
  updated_at: string;
  /** Installed backed surfaces currently resolving to this connection. */
  used_by: string[];
};

export function listHostCredentials(): Promise<{ ok: boolean; credentials: HostCredential[] }> {
  return call("GET", "/surface/api/credentials");
}

export function patchHostConfig(body: {
  credential_connections: Record<string, string | null>;
}): Promise<{ ok: boolean; credential_connections: Record<string, string> }> {
  return call("PATCH", "/surface/api/config", body);
}

export function reloadUi(name: string): Promise<{ ok: boolean; ui: UiSummary | null }> {
  return call("POST", `/surface/${encodeURIComponent(name)}/reload`);
}

export function getUiInfo(name: string): Promise<UiInfoResponse> {
  return call("GET", `/surface/${encodeURIComponent(name)}/info`);
}

// --- Phase 2.1: required_schema provisioning ----------------------------

export type ProvisionSchemaResponse = {
  ok: boolean;
  name: string;
  /** Tag names successfully provisioned. */
  provisioned: string[];
  /** Per-tag failures. */
  errors: Array<{ tag: string; error: string }>;
  /** Why the pass was skipped (when applicable). */
  skipReason?: string;
  /** Resolved vault URL (when one was used). */
  vaultUrl?: string;
};

export function provisionSchema(name: string): Promise<ProvisionSchemaResponse> {
  return call("POST", `/surface/${encodeURIComponent(name)}/provision-schema`);
}

// --- Phase 1.3: dev mode ------------------------------------------------

/**
 * Phase 3.0 — dev-mode watcher status surfaced alongside the existing
 * Phase 1.3 dev state. When `watching: false`, the optional `warning`
 * carries the start-time failure reason for the admin SPA to render.
 */
export type DevWatcherInfo =
  | {
      watching: true;
      watchDir: string;
      debounceMs: number;
      buildCmd: string | null;
      building?: boolean;
    }
  | { watching: false; warning?: string };

export type DevModeStatus = {
  name: string;
  enabled: boolean;
  enabledAt: number;
  subscribers: number;
  /** Phase 3.0 — watcher diagnostics. May be missing on older daemons. */
  watcher?: DevWatcherInfo;
};

export type DevListResponse = {
  uis: DevModeStatus[];
};

export function listDevMode(): Promise<DevListResponse> {
  return call("GET", "/surface/dev/list");
}

export function getDevModeStatus(name: string): Promise<DevModeStatus> {
  return call("GET", `/surface/${encodeURIComponent(name)}/dev`);
}

export function enableDevMode(name: string): Promise<{ ok: boolean } & DevModeStatus> {
  return call("POST", `/surface/${encodeURIComponent(name)}/dev/enable`);
}

export function disableDevMode(
  name: string,
): Promise<{ ok: boolean; name: string; enabled: false; was_on: boolean }> {
  return call("POST", `/surface/${encodeURIComponent(name)}/dev/disable`);
}

export function triggerReload(
  name: string,
): Promise<{ ok: boolean; name: string; notified: number }> {
  return call("POST", `/surface/${encodeURIComponent(name)}/dev/trigger`);
}

/** Format an ApiError for inline display. */
export function formatError(e: unknown): string {
  if (!e || typeof e !== "object") return String(e);
  const r = e as ApiError;
  const status = r.status ? `HTTP ${r.status}` : "Error";
  const msg = r.message ?? r.error ?? "";
  return msg ? `${status}: ${msg}` : status;
}
