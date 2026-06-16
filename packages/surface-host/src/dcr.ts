/**
 * Dynamic Client Registration (RFC 7591) for hosted UIs.
 *
 * When `POST /surface/add` succeeds with `config.auto_register_oauth_clients = true`,
 * parachute-surface registers the new UI as an OAuth public client of hub:
 *
 *   POST <hub_url>/oauth/register
 *   Authorization: Bearer <operator-token>     (sourced via operator-token.ts)
 *   Content-Type: application/json
 *
 *   {
 *     "client_name": "<displayName>",
 *     "redirect_uris": ["<hub_url><meta.path>/", "<hub_url><meta.path>/oauth/callback", "<hub_url><meta.path>/oauth-callback"],
 *     "scope": "<scopes_required joined by space>",
 *     "token_endpoint_auth_method": "none",
 *     "grant_types": ["authorization_code"],
 *     "response_types": ["code"]
 *   }
 *
 * Hub returns `201 Created` with `{client_id, ...}`. We persist the `client_id`
 * in `~/.parachute/surface/uis/<name>/.oauth-client.json` (chmod 0o600).
 *
 * Auth posture for the call:
 *   - When an operator bearer is available (`PARACHUTE_HUB_TOKEN` env or
 *     `~/.parachute/operator.token`), the bearer is sent and the resulting
 *     client lands `approved` (no human follow-up needed).
 *   - When no operator bearer is available, the call still works — the client
 *     lands `pending`, and the operator has to click approve in hub admin.
 *     We surface this in the response so the CLI/admin SPA can render the
 *     hint.
 *
 * Errors:
 *   - Hub unreachable / 5xx → `DcrError` with `status: "hub_unreachable"`
 *   - Hub returns 4xx (bad shape, scopes hub doesn't recognize, etc.) → the
 *     full hub body is folded into the error so the operator sees what hub
 *     said back. The caller decides whether to abort the add or proceed
 *     without OAuth (UI still mounts, OAuth dance just fails at runtime).
 *   - Local file write failure → propagated; the caller's `POST /surface/add`
 *     surfaces it.
 *
 * Revocation on remove. There's no spec'd RFC 7591 client-deletion endpoint
 * that hub implements universally; for now `removeOauthClient()` is a no-op
 * locally (just deletes the `.oauth-client.json` file), and the orphaned
 * client record stays in hub's DB until an operator runs `parachute auth
 * revoke-client <id>` or hub adds an `RFC 7592` /oauth/clients/<id> DELETE.
 * If hub later adds the endpoint, this function fires a best-effort DELETE
 * and ignores 404s.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { getHubOrigin } from "./auth.ts";

/**
 * The three redirect_uri path forms a hosted surface registers for a given
 * mount, rooted at one hub origin. Kept in one place so the install-time DCR,
 * the re-register entry point, and the self-heal all stay byte-identical.
 *
 *   - `<base>/`               — the SPA root (a callback-at-root flow).
 *   - `<base>/oauth/callback` — surface-client's hosted-mode RUNTIME callback
 *                               (the canonical form; closes surface#118 part 1).
 *   - `<base>/oauth-callback` — legacy hyphenated form (pre-R2 clients).
 */
export function redirectFormsForBase(redirectBase: string): string[] {
  const base = redirectBase.replace(/\/$/, "");
  return [`${base}/`, `${base}/oauth/callback`, `${base}/oauth-callback`];
}

/**
 * Resolve the SET of hub origins this surface-host knows about, for DCR
 * redirect_uri registration (surface#118).
 *
 * THE PROBLEM. surface-host registers its OAuth client's redirect_uris from a
 * single install-frozen origin (`config.hub_url`, default loopback). At
 * sign-in the browser computes its redirect_uri from its REAL origin
 * (`window.location.origin` — tailnet/public). The hub validates redirect_uris
 * by strict exact-match (RFC 8252 anti-open-redirect), so a loopback-only
 * registration rejects every off-localhost user with "Redirect mismatch".
 *
 * THE SEAM. surface-host learns the public hub origin the same way every
 * committed-core module does: `getHubOrigin()` resolves `PARACHUTE_HUB_ORIGIN`
 * (set by hub-as-supervisor when the box is exposed) first, then
 * `config.hub_url`, then loopback. We register against BOTH the config
 * loopback AND the env-resolved origin when they differ, so a supervised,
 * exposed surface registers the public-origin variant directly — independent
 * of (and belt-and-suspenders with) the hub-side DCR origin-expansion.
 *
 * Loopback is always included so the operator's local-box flow keeps working
 * even after the public origin lands. Order: env-resolved origin first (the
 * one most browsers will actually use once exposed), loopback second; deduped.
 */
export function knownHubOrigins(hubUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const trimmed = raw.replace(/\/$/, "");
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  // The env-resolved origin (PARACHUTE_HUB_ORIGIN → config.hub_url → loopback).
  // On a supervised exposed box this is the PUBLIC origin; on a bare loopback
  // box it equals config.hub_url and the dedupe collapses it.
  push(getHubOrigin(hubUrl));
  // The config loopback always stays registered.
  push(hubUrl);
  return out;
}

/**
 * Build the full redirect_uris array a surface registers for `mountPath`,
 * across every known hub origin. Each origin contributes the three path forms
 * (`redirectFormsForBase`). The order is stable + deduped.
 */
export function buildSurfaceRedirectUris(hubUrl: string, mountPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const origin of knownHubOrigins(hubUrl)) {
    for (const uri of redirectFormsForBase(`${origin}${mountPath}`)) {
      if (seen.has(uri)) continue;
      seen.add(uri);
      out.push(uri);
    }
  }
  return out;
}

/**
 * Persisted client record. Saved at `~/.parachute/surface/uis/<name>/.oauth-client.json`.
 * `same_hub: true` is hub's auto-trust flag (per design doc section 6) — we
 * carry it through so the admin SPA can show "auto-trusted" for these clients.
 */
export type OauthClientRecord = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  scope: string;
  status?: string;
  registered_at: string;
  hub_url: string;
};

/**
 * Shape of a DCR-register response from hub. Per RFC 7591 + hub's actual
 * response (see `handleRegister` in parachute-hub/src/oauth-handlers.ts).
 */
export type DcrRegisterResponse = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
  status?: string;
  client_secret?: string;
};

/**
 * Loose fetch signature. Bun's stricter `typeof fetch` requires the
 * `preconnect` static method we never use; this alias keeps test stubs
 * one-arg-and-init clean.
 */
export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DcrError extends Error {
  override name = "DcrError" as const;
  readonly status: "hub_unreachable" | "hub_rejected" | "invalid_response";
  readonly hubResponseStatus?: number;
  readonly hubResponseBody?: string;
  constructor(
    message: string,
    status: "hub_unreachable" | "hub_rejected" | "invalid_response",
    extra: { hubResponseStatus?: number; hubResponseBody?: string } = {},
  ) {
    super(message);
    this.status = status;
    this.hubResponseStatus = extra.hubResponseStatus;
    this.hubResponseBody = extra.hubResponseBody;
  }
}

export type RegisterOauthClientOpts = {
  /** Hub origin (e.g. `http://127.0.0.1:1939`). Stripped of trailing slash. */
  hubUrl: string;
  /** Human label — typically `meta.displayName`. */
  clientName: string;
  /** Where hub redirects back to after consent. Must be absolute (hub-origin-prefixed). */
  redirectUris: string[];
  /** Space-separated scope list — derived from `meta.scopes_required`. */
  scopes: string[];
  /** Operator bearer when available — sourced via `operator-token.ts`. */
  operatorToken?: string;
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Hit hub's `/oauth/register` and return the parsed response.
 *
 * Failure modes (each thrown as `DcrError`):
 *   - Network error / hub unreachable → `status: "hub_unreachable"`
 *   - 4xx/5xx response → `status: "hub_rejected"` with body folded in
 *   - 2xx but unparseable JSON → `status: "invalid_response"`
 */
export async function registerOauthClient(
  opts: RegisterOauthClientOpts,
): Promise<DcrRegisterResponse> {
  const logger = opts.logger ?? console;
  const fetchFn = opts.fetchFn ?? fetch;
  const hubUrl = opts.hubUrl.replace(/\/$/, "");
  const url = `${hubUrl}/oauth/register`;

  const body = {
    client_name: opts.clientName,
    redirect_uris: opts.redirectUris,
    scope: opts.scopes.join(" "),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.operatorToken) {
    headers.authorization = `Bearer ${opts.operatorToken}`;
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = (e as Error).message;
    logger.warn(`[app-dcr] hub unreachable at ${url}: ${msg}`);
    throw new DcrError(
      `hub unreachable at ${url}: ${msg}. Retry once hub is running, or set auto_register_oauth_clients=false.`,
      "hub_unreachable",
    );
  }

  const text = await res.text();
  if (res.status >= 400) {
    logger.warn(`[app-dcr] hub rejected DCR (${res.status}): ${text.slice(0, 500)}`);
    throw new DcrError(
      `hub rejected DCR registration (status ${res.status}): ${text.slice(0, 200)}`,
      "hub_rejected",
      { hubResponseStatus: res.status, hubResponseBody: text },
    );
  }

  let parsed: DcrRegisterResponse;
  try {
    parsed = JSON.parse(text) as DcrRegisterResponse;
  } catch (e) {
    throw new DcrError(
      `hub returned ${res.status} but body was not valid JSON: ${(e as Error).message}`,
      "invalid_response",
      { hubResponseStatus: res.status, hubResponseBody: text },
    );
  }

  if (typeof parsed.client_id !== "string" || parsed.client_id.length === 0) {
    throw new DcrError(
      `hub returned ${res.status} but response is missing client_id`,
      "invalid_response",
      { hubResponseStatus: res.status, hubResponseBody: text },
    );
  }

  return parsed;
}

/**
 * Persist the OAuth client record to disk under the UI's directory.
 *
 * Mode 0o600 — only the running daemon's user reads it. The client_id is
 * not technically a secret (public OAuth clients), but mode 0o600 mirrors
 * the operator-token-file pattern and keeps the file out of casual reads.
 */
export function writeOauthClientFile(uiDir: string, record: OauthClientRecord): string {
  mkdirSync(uiDir, { recursive: true });
  const filePath = path.join(uiDir, ".oauth-client.json");
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // chmod may fail on Windows / odd filesystems; the file is still written.
  }
  return filePath;
}

/**
 * Read the persisted OAuth client record for a UI. Returns `undefined` when
 * the file is missing (UI was added before DCR, or DCR failed).
 */
export function readOauthClientFile(uiDir: string): OauthClientRecord | undefined {
  const filePath = path.join(uiDir, ".oauth-client.json");
  if (!existsSync(filePath)) return undefined;
  try {
    const body = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(body);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).client_id !== "string"
    ) {
      return undefined;
    }
    return parsed as OauthClientRecord;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort revocation of a UI's OAuth client.
 *
 * Three pieces:
 *   1. Try `DELETE <hub_url>/oauth/clients/<client_id>` (RFC 7592). 4xx other
 *      than 404 → log + carry on; 404 → fine, already gone.
 *   2. Remove the local `.oauth-client.json`.
 *
 * Never throws — removal must complete even if hub is unreachable. Returns
 * a status object the caller surfaces in the response.
 */
export type UnregisterResult = {
  /** True when the local file was removed (or didn't exist to begin with). */
  localFileRemoved: boolean;
  /** Status of the upstream DELETE call. `"unsupported"` covers 404 from hub (the route doesn't exist yet). */
  hubDeleteStatus: "ok" | "not_found" | "unsupported" | "error" | "unreachable" | "skipped";
  /** Optional human-readable detail. */
  detail?: string;
};

export type UnregisterOauthClientOpts = {
  hubUrl: string;
  clientId?: string;
  uiDir: string;
  operatorToken?: string;
  fetchFn?: FetchFn;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export async function unregisterOauthClient(
  opts: UnregisterOauthClientOpts,
): Promise<UnregisterResult> {
  const logger = opts.logger ?? console;
  const fetchFn = opts.fetchFn ?? fetch;
  const hubUrl = opts.hubUrl.replace(/\/$/, "");

  let hubDeleteStatus: UnregisterResult["hubDeleteStatus"] = "skipped";
  let detail: string | undefined;

  if (opts.clientId) {
    const url = `${hubUrl}/oauth/clients/${encodeURIComponent(opts.clientId)}`;
    const headers: Record<string, string> = {};
    if (opts.operatorToken) headers.authorization = `Bearer ${opts.operatorToken}`;
    try {
      const res = await fetchFn(url, { method: "DELETE", headers });
      if (res.status === 204 || res.status === 200) {
        hubDeleteStatus = "ok";
      } else if (res.status === 404) {
        // Hub doesn't have an RFC 7592 endpoint yet, OR the client was
        // already removed. Either way: no work to do.
        hubDeleteStatus = res.headers.get("content-type")?.includes("json")
          ? "not_found"
          : "unsupported";
        detail = "hub returned 404 — endpoint may not exist or client already gone";
      } else if (res.status === 405) {
        // Method not allowed — hub doesn't expose DELETE here.
        hubDeleteStatus = "unsupported";
        detail = `hub returned ${res.status}; DELETE not supported`;
      } else {
        hubDeleteStatus = "error";
        const body = await res.text();
        detail = `hub returned ${res.status}: ${body.slice(0, 200)}`;
        logger.warn(`[app-dcr] revoke ${opts.clientId} failed: ${detail}`);
      }
    } catch (e) {
      hubDeleteStatus = "unreachable";
      detail = `hub unreachable: ${(e as Error).message}`;
      logger.warn(`[app-dcr] revoke ${opts.clientId} failed: ${detail}`);
    }
  }

  // Always remove the local file last so a re-run of `remove` after a hub
  // restore re-attempts the upstream delete.
  const filePath = path.join(opts.uiDir, ".oauth-client.json");
  let localFileRemoved = true;
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch (e) {
      localFileRemoved = false;
      detail = `${detail ? `${detail}; ` : ""}local file unlink failed: ${(e as Error).message}`;
    }
  }

  return { localFileRemoved, hubDeleteStatus, detail };
}

// ===========================================================================
// Boot-time redirect-uri self-heal (surface#118)
// ===========================================================================

/** Minimal shape the self-heal needs from a registered UI. */
export type SelfHealUi = {
  uiDir: string;
  meta: { path: string; scopes_required?: string[] };
};

export type RedirectSelfHealOpts = {
  uis: readonly SelfHealUi[];
  hubUrl: string;
  operatorToken?: string;
  fetchFn?: FetchFn;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type RedirectSelfHealOutcome = {
  checked: number;
  /** UI dirs whose client was re-registered (a known hub origin was missing). */
  reregistered: string[];
  /** UI dirs already covering every known hub origin — no work. */
  upToDate: string[];
  /** Re-register attempts that failed (best-effort — retried next boot). */
  failed: Array<{ uiDir: string; detail: string }>;
};

/**
 * Boot-time self-heal for the surface#118 class: a surface that registered its
 * OAuth client while the box was loopback-only (initial install pre-`expose`)
 * has only loopback redirect_uris on file. Once the operator runs
 * `parachute expose`, `PARACHUTE_HUB_ORIGIN` resolves to the public origin and
 * the browser's `window.location.origin` redirect_uri is no longer registered
 * → "Redirect mismatch" → no off-localhost sign-in.
 *
 * This sweep (mirrors the credential-renewal boot sweep, index.ts:300-306)
 * walks every UI with a stored `.oauth-client.json`, and re-registers any
 * whose stored `redirect_uris` are MISSING a currently-known hub origin. The
 * re-register reuses the stored `client_name` (the hub upserts by
 * client_name + redirects), registers all forms across all known origins via
 * `buildSurfaceRedirectUris`, and overwrites the on-disk record.
 *
 * Best-effort: a hub-unreachable / rejected re-register logs + is retried on
 * the next boot; it never blocks daemon startup. A no-op when nothing changed
 * (the common steady-state case) — the membership check is pure-local.
 */
export async function selfHealRedirectUris(
  opts: RedirectSelfHealOpts,
): Promise<RedirectSelfHealOutcome> {
  const logger = opts.logger ?? console;
  const outcome: RedirectSelfHealOutcome = {
    checked: 0,
    reregistered: [],
    upToDate: [],
    failed: [],
  };

  for (const ui of opts.uis) {
    const record = readOauthClientFile(ui.uiDir);
    if (!record) continue; // no client registered for this UI — nothing to heal
    outcome.checked++;

    const wanted = buildSurfaceRedirectUris(opts.hubUrl, ui.meta.path);
    const have = new Set(record.redirect_uris ?? []);
    const missing = wanted.filter((uri) => !have.has(uri));
    if (missing.length === 0) {
      outcome.upToDate.push(ui.uiDir);
      continue;
    }

    try {
      const reg = await registerOauthClient({
        hubUrl: opts.hubUrl,
        clientName: record.client_name,
        redirectUris: wanted,
        scopes: ui.meta.scopes_required ?? [],
        ...(opts.operatorToken !== undefined ? { operatorToken: opts.operatorToken } : {}),
        ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
        logger,
      });
      const updated: OauthClientRecord = {
        client_id: reg.client_id,
        client_name: reg.client_name ?? record.client_name,
        redirect_uris: reg.redirect_uris,
        scope: reg.scope ?? record.scope,
        ...(reg.status !== undefined ? { status: reg.status } : {}),
        registered_at: new Date().toISOString(),
        hub_url: opts.hubUrl,
      };
      writeOauthClientFile(ui.uiDir, updated);
      outcome.reregistered.push(ui.uiDir);
      logger.log(
        `[app-dcr] self-heal: re-registered ${record.client_name} with ${missing.length} added redirect_uri(s) for newly-known hub origin(s)`,
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      outcome.failed.push({ uiDir: ui.uiDir, detail });
      logger.warn(
        `[app-dcr] self-heal: re-register failed for ${record.client_name} — will retry next boot: ${detail}`,
      );
    }
  }

  return outcome;
}
