/**
 * Hub-orchestrated calls (R3b — the channel admin pattern, for surfaces).
 *
 * The admin SPA is served same-origin under the hub proxy at
 * `/surface/admin/`, so the operator's hub session cookie rides along on a
 * `credentials: "include"` fetch to the hub's cookie-gated `/admin/*`
 * endpoints AND the fetch carries a matching Origin header — the hub's CSRF
 * Origin check on /admin/* mutations passes automatically. No token dance:
 * the operator clicking the button IS the approval; the hub — the only thing
 * with cross-module authority — mints + delivers on their behalf.
 *
 * Every function here is NEVER-THROW: it resolves a discriminated result the
 * UI branches on (`auth` → sign-in guidance; `error` → the hub's words,
 * verbatim) — channel's honest-failure shape. A direct-on-:1946 deployment
 * (no hub in front) surfaces as `auth`/`error` results, never an exception.
 *
 *   - `fetchVaults()`              — GET /.well-known/parachute.json (public)
 *   - `listConnections()`          — GET /admin/connections
 *   - `createCredentialConnection` — POST /admin/connections kind:"credential"
 *   - `deleteConnection(id)`       — DELETE /admin/connections/<id>
 */

/** Where the hub lives: the page origin (same-origin under the proxy). */
function hubOrigin(): string {
  return window.location.origin;
}

export type HubResult<T> =
  | ({ ok: true } & T)
  | { ok: false; auth: true; status: number }
  | { ok: false; auth?: false; error: string; status?: number };

/** Extract the hub's own words from an error payload (verbatim surfacing). */
function hubErrorText(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const text = p.error_description ?? p.message ?? p.error;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return `the hub returned HTTP ${status}`;
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// --- Vault discovery (public, anonymous) -----------------------------------

export type DiscoveredVault = { name: string };

/**
 * Vault picker source: the hub's PUBLIC discovery doc. No token needed.
 * Returns `{ vaults: [] }` shapes honestly — a load failure is an error
 * result (the picker shows "could not load"), an empty hub is ok+[].
 */
export async function fetchVaults(): Promise<HubResult<{ vaults: DiscoveredVault[] }>> {
  let res: Response;
  try {
    res = await fetch(`${hubOrigin()}/.well-known/parachute.json`, {
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { ok: false, error: `vault discovery returned HTTP ${res.status}`, status: res.status };
  }
  const doc = (await parseJson(res)) as { vaults?: Array<{ name?: unknown }> } | null;
  const vaults = Array.isArray(doc?.vaults)
    ? doc.vaults
        .filter((v) => typeof v?.name === "string" && (v.name as string).length > 0)
        .map((v) => ({ name: v.name as string }))
    : [];
  return { ok: true, vaults };
}

// --- Connections ------------------------------------------------------------

/** The subset of a hub connection record the SPA reads. */
export type HubConnection = {
  id: string;
  kind?: string;
  source?: { module?: string; vault?: string; event?: string };
  sink?: { module?: string; action?: string; params?: Record<string, unknown> };
  provisioned?: {
    type?: string;
    vault?: string;
    scope?: string;
    scopedTags?: string[];
    credentialKey?: string;
  };
  requested_by?: string;
  legacy?: boolean;
};

export async function listConnections(): Promise<HubResult<{ connections: HubConnection[] }>> {
  let res: Response;
  try {
    res = await fetch(`${hubOrigin()}/admin/connections`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, auth: true, status: res.status };
  }
  const payload = await parseJson(res);
  if (!res.ok) {
    return { ok: false, error: hubErrorText(payload, res.status), status: res.status };
  }
  const p = payload as { connections?: unknown } | null;
  const connections = Array.isArray(p?.connections) ? (p.connections as HubConnection[]) : [];
  return { ok: true, connections };
}

/**
 * The credential link flow's POST (H4): the operator approves granting the
 * surface module a standing tag-scoped credential on a vault. The hub mints
 * (registered, revocable), delivers to surface-host's declared endpoint over
 * loopback, and records the connection. `key` picks the declared credential:
 * `"vault"` (read) or `"vault-write"` (write — the hub REQUIRES a non-empty
 * tag scope for write grants).
 */
export async function createCredentialConnection(args: {
  key: "vault" | "vault-write";
  vault: string;
  tags: string[];
}): Promise<HubResult<{ connection: HubConnection; expires_at?: string }>> {
  let res: Response;
  try {
    res = await fetch(`${hubOrigin()}/admin/connections`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        kind: "credential",
        requestedBy: "surface",
        credential: {
          module: "surface",
          key: args.key,
          vault: args.vault,
          tags: args.tags,
        },
      }),
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }
  if (res.status === 401) return { ok: false, auth: true, status: 401 };
  const payload = await parseJson(res);
  if (!res.ok) {
    return { ok: false, error: hubErrorText(payload, res.status), status: res.status };
  }
  const p = payload as { connection?: HubConnection; expires_at?: string } | null;
  if (!p?.connection?.id) {
    return { ok: false, error: "the hub reported success but returned no connection record" };
  }
  return {
    ok: true,
    connection: p.connection,
    ...(p.expires_at !== undefined ? { expires_at: p.expires_at } : {}),
  };
}

/**
 * Tear down a hub connection (the composed-remove first step). 404 is
 * treated as already-gone (ok) — the belt channel's delete flow wears.
 * A 207-partial rides back as ok with `warnings`.
 */
export async function deleteConnection(
  id: string,
): Promise<HubResult<{ alreadyGone?: boolean; warnings: string[] }>> {
  let res: Response;
  try {
    res = await fetch(`${hubOrigin()}/admin/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: `could not reach the hub: ${(e as Error).message}` };
  }
  if (res.status === 401) return { ok: false, auth: true, status: 401 };
  if (res.status === 404) return { ok: true, alreadyGone: true, warnings: [] };
  const payload = await parseJson(res);
  if (!res.ok) {
    return { ok: false, error: hubErrorText(payload, res.status), status: res.status };
  }
  const warnings: string[] = [];
  const p = payload as {
    partial?: boolean;
    errors?: Array<{ step?: string; detail?: string }>;
  } | null;
  if (p?.partial && Array.isArray(p.errors)) {
    for (const e of p.errors) {
      warnings.push(`step ${e?.step ?? "?"}: ${e?.detail ?? ""}`);
    }
  }
  return { ok: true, warnings };
}
