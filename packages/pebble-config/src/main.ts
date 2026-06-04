/**
 * Pebble config surface — a tiny hosted OAuth page for the Pebble watch app.
 *
 * Flow (see README + the PR body for the full contract):
 *
 *   1. The Pebble phone app opens its config webview, collects ONLY the hub
 *      origin, then redirects the browser here:
 *
 *        <hub>/surface/pebble-config/?return_to=<enc>&current=<enc-json>
 *
 *   2. This page (a real browser, secure context) runs the hub's OAuth 2.1 +
 *      PKCE flow via `@openparachute/surface-client`'s `ParachuteOAuth`. Because
 *      the bundle is served by a Parachute surface-host, it uses the HOSTED
 *      bootstrap: `getClientId()` fetches `/surface/pebble-config/oauth-client`
 *      for the DCR-registered client_id — no pasted token anywhere.
 *
 *   3. After auth it shows a quick-logs editor (one `Label | note text` per
 *      line) prefilled from `current.quicklogs`.
 *
 *   4. Save navigates back to the Pebble app:
 *
 *        return_to + encodeURIComponent(JSON.stringify(payload))
 *
 *      where payload is the {@link PebblePayload} below. `return_to` defaults to
 *      `pebblejs://close#` when absent.
 *
 * The page handles the OAuth callback leg on the same URL: the surface-host
 * SPA-fallback serves this index.html for `/surface/pebble-config/oauth/callback`
 * too, so a `?code=…&state=…` query means "finish the exchange". `return_to` +
 * `current` are persisted in sessionStorage across the redirect round-trip.
 */

import {
  InsecureContextError,
  ParachuteOAuth,
  PendingApprovalError,
  type StoredToken,
  getHubOrigin,
} from "@openparachute/surface-client";

/** Matches the `name` in meta.json + the `<name>` in `/surface/<name>/oauth-client`. */
const APP_NAME = "pebble-config";
/** Default return target when the Pebble app didn't supply one (closes the webview). */
const DEFAULT_RETURN_TO = "pebblejs://close#";
/** sessionStorage keys that survive the OAuth redirect round-trip. */
const SS_RETURN_TO = "pebble_config_return_to";
const SS_CURRENT = "pebble_config_current";
const SS_VAULT = "pebble_config_vault";

/** A single Pebble quick-log button: a short label + the note text it writes. */
export interface QuickLog {
  label: string;
  text: string;
}

/** Prefill payload handed in via the `current` query param (all optional). */
export interface CurrentConfig {
  hub?: string;
  vault?: string;
  quicklogs?: QuickLog[];
}

/**
 * The payload handed BACK to the Pebble app on Save. The watch persists this
 * and uses `token` (+ `refresh_token` / `token_endpoint` / `client_id` to
 * rotate it) to write captures into `<hub>/vault/<vault>/api/...`.
 */
export interface PebblePayload {
  hub: string;
  vault: string;
  token: string;
  refresh_token: string;
  token_endpoint: string;
  client_id: string;
  quicklogs: QuickLog[];
}

// ---------------------------------------------------------------------------
// Query-param + sessionStorage plumbing
// ---------------------------------------------------------------------------

/**
 * Parse the `current` query param (URL-encoded JSON). Tolerant: returns an
 * empty config on absence or any parse failure rather than throwing — a bad
 * prefill should never block the connect flow.
 */
export function parseCurrent(raw: string | null): CurrentConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const out: CurrentConfig = {};
    if (typeof obj.hub === "string") out.hub = obj.hub;
    if (typeof obj.vault === "string") out.vault = obj.vault;
    if (Array.isArray(obj.quicklogs)) {
      out.quicklogs = obj.quicklogs
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          label: typeof q.label === "string" ? q.label : "",
          text: typeof q.text === "string" ? q.text : "",
        }));
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize the quick-logs textarea (`Label | note text` per line) → array. */
export function parseQuickLogsText(text: string): QuickLog[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf("|");
      if (sep === -1) {
        // No separator — treat the whole line as both label and text.
        return { label: line, text: line };
      }
      const label = line.slice(0, sep).trim();
      const body = line.slice(sep + 1).trim();
      return { label, text: body };
    })
    .filter((q) => q.label.length > 0 || q.text.length > 0);
}

/** Render a quick-logs array back to the editable textarea form. */
export function quickLogsToText(logs: QuickLog[]): string {
  return logs.map((q) => `${q.label} | ${q.text}`).join("\n");
}

/**
 * Build the final return URL: `return_to` with the JSON payload appended as a
 * single URL-encoded component. The Pebble app's webview-close handler reads it
 * back off the fragment / query.
 */
export function buildReturnUrl(returnTo: string, payload: PebblePayload): string {
  return returnTo + encodeURIComponent(JSON.stringify(payload));
}

/**
 * Allowlist the final navigation target. The payload carries a vault write
 * token + a rotating refresh token, so handing it to an arbitrary URL would be
 * an open redirect with credentials attached. Only the Pebble app's
 * webview-close scheme is a legitimate consumer; anything else collapses to
 * the default.
 */
export function validateReturnTo(raw: string | null): string {
  if (raw) {
    try {
      if (new URL(raw).protocol === "pebblejs:") return raw;
    } catch {
      // not a parseable URL — fall through to the default
    }
  }
  return DEFAULT_RETURN_TO;
}

// ---------------------------------------------------------------------------
// DOM helpers (kept dependency-free on purpose — see meta.json `pwa: false`)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(id: string): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} element`);
  return node as HTMLElementTagNameMap[K];
}

function setStatus(msg: string, kind: "" | "ok" | "error" = ""): void {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = msg;
  status.className = `status${kind ? ` ${kind}` : ""}`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Resolve the hub origin this page is served from (host-injected meta → origin). */
function resolveHubOrigin(): string {
  return getHubOrigin() ?? window.location.origin;
}

function makeOAuth(hubUrl: string): ParachuteOAuth {
  return new ParachuteOAuth({ appName: APP_NAME, hubUrl });
}

/** Scope string for the chosen vault. The watch writes captures, so request write. */
function scopeFor(vault: string): string {
  return `vault:${vault}:write`;
}

/**
 * Entry point. Decides between three legs:
 *   - OAuth callback (`?code=&state=` present) → finish exchange, show editor.
 *   - Already-signed-in for the chosen vault → show editor.
 *   - Fresh visit → show the connect form.
 */
export async function boot(): Promise<void> {
  const url = new URL(window.location.href);
  const hubUrl = resolveHubOrigin();
  const oauth = makeOAuth(hubUrl);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (code && state) {
    await completeCallback(oauth, hubUrl, code, state);
    return;
  }

  // Fresh visit — capture return_to + current from the query and stash them so
  // they survive the OAuth redirect round-trip.
  const returnTo = validateReturnTo(url.searchParams.get("return_to"));
  const current = parseCurrent(url.searchParams.get("current"));
  sessionStorage.setItem(SS_RETURN_TO, returnTo);
  sessionStorage.setItem(SS_CURRENT, JSON.stringify(current));

  renderConnect(oauth, hubUrl, current);
}

async function completeCallback(
  oauth: ParachuteOAuth,
  hubUrl: string,
  code: string,
  state: string,
): Promise<void> {
  const vault = sessionStorage.getItem(SS_VAULT) ?? "default";
  setStatus("Finishing sign-in…");
  try {
    await oauth.handleCallback(code, state, vault);
  } catch (err) {
    if (err instanceof PendingApprovalError) {
      setStatus(
        "Your hub needs to approve this app before sign-in can finish. Approve it, then try again.",
        "error",
      );
      return;
    }
    setStatus(`Sign-in failed: ${(err as Error).message}`, "error");
    return;
  }

  // Strip code/state from the URL so a reload doesn't replay the (now spent)
  // authorization code.
  window.history.replaceState({}, "", `${window.location.origin}/surface/${APP_NAME}/`);

  const current = readStoredCurrent();
  renderEditor(oauth, hubUrl, vault, current);
  setStatus("Connected.", "ok");
}

function readStoredCurrent(): CurrentConfig {
  const raw = sessionStorage.getItem(SS_CURRENT);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CurrentConfig;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// View: connect
// ---------------------------------------------------------------------------

function renderConnect(oauth: ParachuteOAuth, hubUrl: string, current: CurrentConfig): void {
  const view = el<"div">("view");
  const defaultVault = current.vault ?? "default";
  view.innerHTML = `
    <div class="panel">
      <label for="vault">Vault</label>
      <input id="vault" type="text" value="${escapeAttr(defaultVault)}" autocomplete="off"
        autocapitalize="off" autocorrect="off" spellcheck="false" />
      <p class="hint">The vault on your hub the watch should write captures into.</p>
      <button id="connect">Connect to your vault</button>
    </div>
  `;

  el<"button">("connect").addEventListener("click", () => {
    const vault = el<"input">("vault").value.trim() || "default";
    sessionStorage.setItem(SS_VAULT, vault);
    void startOAuth(oauth, hubUrl, vault);
  });
}

async function startOAuth(oauth: ParachuteOAuth, hubUrl: string, vault: string): Promise<void> {
  const connectBtn = el<"button">("connect");
  connectBtn.disabled = true;
  setStatus("Connecting to your hub…");
  try {
    const redirectUri = `${hubUrl}/surface/${APP_NAME}/oauth/callback`;
    const { authorizeUrl } = await oauth.beginFlow({
      vaultName: vault,
      scope: scopeFor(vault),
      redirectUri,
    });
    window.location.assign(authorizeUrl);
  } catch (err) {
    connectBtn.disabled = false;
    if (err instanceof InsecureContextError) {
      setStatus(err.message, "error");
      return;
    }
    setStatus(`Could not start sign-in: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// View: quick-logs editor
// ---------------------------------------------------------------------------

function renderEditor(
  oauth: ParachuteOAuth,
  hubUrl: string,
  vault: string,
  current: CurrentConfig,
): void {
  const view = el<"div">("view");
  const seed = current.quicklogs && current.quicklogs.length > 0 ? current.quicklogs : [];
  view.innerHTML = `
    <div class="panel">
      <p>Signed in to <span class="vault-badge">${escapeHtml(vault)}</span>.</p>
      <label for="quicklogs">Quick logs</label>
      <p class="hint">One per line, as <code>Label | note text</code>. The watch shows the
        label; tapping it writes the note text to your vault.</p>
      <textarea id="quicklogs" spellcheck="false">${escapeHtml(quickLogsToText(seed))}</textarea>
      <button id="save">Save &amp; return to watch</button>
    </div>
  `;

  el<"button">("save").addEventListener("click", () => {
    void save(oauth, hubUrl, vault);
  });
}

async function save(oauth: ParachuteOAuth, hubUrl: string, vault: string): Promise<void> {
  const saveBtn = el<"button">("save");
  saveBtn.disabled = true;
  setStatus("Saving…");

  const stored: StoredToken | null = oauth.getToken(vault);
  if (!stored) {
    saveBtn.disabled = false;
    setStatus("Lost the vault token — please connect again.", "error");
    return;
  }

  let tokenEndpoint: string;
  let clientId: string;
  try {
    const metadata = await oauth.getMetadata();
    tokenEndpoint = metadata.token_endpoint;
    const clientInfo = await oauth.getClientId();
    clientId = clientInfo.client_id;
  } catch (err) {
    saveBtn.disabled = false;
    setStatus(`Could not read hub config: ${(err as Error).message}`, "error");
    return;
  }

  const quicklogs = parseQuickLogsText(el<"textarea">("quicklogs").value);
  const returnTo = validateReturnTo(sessionStorage.getItem(SS_RETURN_TO));

  const payload: PebblePayload = {
    hub: hubUrl,
    vault,
    token: stored.accessToken,
    refresh_token: stored.refreshToken ?? "",
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    quicklogs,
  };

  setStatus("Returning to your watch…", "ok");
  window.location.assign(buildReturnUrl(returnTo, payload));
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// Auto-boot in the browser. Guarded so the module can be imported in tests
// (Bun's test runner has no `document`) without firing the DOM path.
if (typeof document !== "undefined" && document.getElementById("view")) {
  void boot().catch((err) => setStatus(`Unexpected error: ${(err as Error).message}`, "error"));
}
