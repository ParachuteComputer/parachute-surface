/**
 * API helpers — thin fetch wrapper for the admin endpoints.
 *
 * All admin endpoints under `/app/*` (except `/oauth-client`) require a
 * bearer carrying `app:admin` or `app:read`. The SPA reads the operator's
 * token from `localStorage["parachute_operator_token"]`, set via the
 * `TokenSetup` banner.
 */

export const TOKEN_STORAGE_KEY = "parachute_operator_token";

export type UiSummary = {
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
  force?: boolean;
};

export type AddResponse = {
  ok: boolean;
  ui: UiSummary | null;
  oauth_client_id?: string;
  oauth_status?: string;
  warning?: string;
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

export function getOperatorToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setOperatorToken(t: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, t);
  } catch {
    // ignored — operator's localStorage is wedged, surface only via UX.
  }
}

function authHeaders(): Record<string, string> {
  const t = getOperatorToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

async function call<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      ...authHeaders(),
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
  if (res.status >= 200 && res.status < 300) return parsed as T;
  const err: ApiError = {
    status: res.status,
    ...(parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { body: parsed }),
  };
  throw err;
}

export function listUis(): Promise<ListResponse> {
  return call("GET", "/app/list");
}

export function addUi(body: AddRequestBody): Promise<AddResponse> {
  return call("POST", "/app/add", body);
}

export function removeUi(name: string): Promise<{ ok: boolean; removed: string }> {
  return call("DELETE", `/app/${encodeURIComponent(name)}`);
}

export function reloadUi(name: string): Promise<{ ok: boolean; ui: UiSummary | null }> {
  return call("POST", `/app/${encodeURIComponent(name)}/reload`);
}

export function getUiInfo(name: string): Promise<UiInfoResponse> {
  return call("GET", `/app/${encodeURIComponent(name)}/info`);
}

// --- Phase 1.3: dev mode ------------------------------------------------

export type DevModeStatus = {
  name: string;
  enabled: boolean;
  enabledAt: number;
  subscribers: number;
};

export type DevListResponse = {
  uis: DevModeStatus[];
};

export function listDevMode(): Promise<DevListResponse> {
  return call("GET", "/app/dev/list");
}

export function getDevModeStatus(name: string): Promise<DevModeStatus> {
  return call("GET", `/app/${encodeURIComponent(name)}/dev`);
}

export function enableDevMode(name: string): Promise<{ ok: boolean } & DevModeStatus> {
  return call("POST", `/app/${encodeURIComponent(name)}/dev/enable`);
}

export function disableDevMode(
  name: string,
): Promise<{ ok: boolean; name: string; enabled: false; was_on: boolean }> {
  return call("POST", `/app/${encodeURIComponent(name)}/dev/disable`);
}

export function triggerReload(
  name: string,
): Promise<{ ok: boolean; name: string; notified: number }> {
  return call("POST", `/app/${encodeURIComponent(name)}/dev/trigger`);
}

/** Format an ApiError for inline display. */
export function formatError(e: unknown): string {
  if (!e || typeof e !== "object") return String(e);
  const r = e as ApiError;
  const status = r.status ? `HTTP ${r.status}` : "Error";
  const msg = r.message ?? r.error ?? "";
  return msg ? `${status}: ${msg}` : status;
}
