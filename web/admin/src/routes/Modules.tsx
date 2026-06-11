/**
 * Surfaces — the list view (R3b polish: dense + scannable, channel's list is
 * the bar).
 *
 * Each row: displayName + mount, REAL status chip (R3a lifecycle), audience
 * badge, backed-vs-static indicator, credential state at a glance, OAuth
 * state, dev-mode badge. Per-row actions: Reload, the dev triad, Uninstall.
 *
 * Uninstall is COMPOSED for a backed surface holding an exclusively-bound
 * credential connection (channel#46's lifecycle-symmetry shape): the hub
 * teardown runs FIRST — `DELETE /admin/connections/<id>` with the operator's
 * session cookie (the hub revokes the minted credential + notifies the host
 * to drop its copy) — then the host removal (bundle + state + local
 * credential copy + DCR unregister). A hub-side failure surfaces an explicit
 * two-step ask (proceed host-only / keep the surface) — never a silent
 * fallthrough. A credential shared with other surfaces is left standing,
 * with a note. The DCR orphan case (hub has no client-delete endpoint, E5)
 * is surfaced in the result message rather than swallowed.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SchemaRequirements } from "../components/SchemaRequirements.tsx";
import {
  type DevModeStatus,
  type ListResponse,
  type UiSummary,
  disableDevMode,
  enableDevMode,
  formatError,
  listDevMode,
  listUis,
  reloadUi,
  removeUi,
  triggerReload,
} from "../lib/api.ts";
import { deleteConnection } from "../lib/hub.ts";

/**
 * Render a watcher's absolute path in compressed form — keeps the
 * "watching <dir>" sub-text from blowing up the dev-column width. We
 * show the last two segments, prefixed with `…/` for clarity, and the
 * full path is on the wrapping element's `title` for hover.
 */
function shortenPath(p: string): string {
  if (!p) return p;
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Compact status-chip mapping for the list (full copy lives on the detail page). */
function statusChip(u: UiSummary): { label: string; tone: string; title?: string } {
  switch (u.status) {
    case "static-only":
      return { label: "static", tone: "inactive" };
    case "active":
      return { label: "active", tone: "active" };
    case "pending-credential":
      return {
        label: "awaiting credential",
        tone: "pending",
        ...(u.statusReason ? { title: u.statusReason } : {}),
      };
    case "failing":
      return {
        label: "failing",
        tone: "pending",
        ...(u.statusReason ? { title: u.statusReason } : {}),
      };
    case "backend-error":
      return {
        label: "backend error",
        tone: "failing",
        ...(u.statusReason ? { title: u.statusReason } : {}),
      };
    case "backend-disabled":
      return {
        label: "quarantined",
        tone: "failing",
        ...(u.statusReason ? { title: u.statusReason } : {}),
      };
  }
}

/** Credential at-a-glance chip for backed rows. */
function credentialChip(u: UiSummary): { label: string; tone: string; title?: string } | null {
  const c = u.credential;
  if (!u.server || !c) return null;
  switch (c.state) {
    case "ok":
      return {
        label: `vault: ${c.vault}`,
        tone: "active",
        title: `${c.scope ?? ""}${c.scoped_tags?.length ? ` · tags: ${c.scoped_tags.join(", ")}` : ""}`,
      };
    case "expiring":
      return {
        label: "credential renewing",
        tone: "pending",
        ...(c.reason ? { title: c.reason } : {}),
      };
    case "expired":
      return {
        label: "credential expired",
        tone: "failing",
        ...(c.reason ? { title: c.reason } : {}),
      };
    case "needs-operator":
      return {
        label: "credential needs you",
        tone: "failing",
        ...(c.reason ? { title: c.reason } : {}),
      };
    case "none":
      return {
        label: "no vault linked",
        tone: "inactive",
        ...(c.reason ? { title: c.reason } : {}),
      };
    case "ambiguous":
      return {
        label: "credential ambiguous",
        tone: "failing",
        ...(c.reason ? { title: c.reason } : {}),
      };
    case "missing":
      return {
        label: "credential missing",
        tone: "failing",
        ...(c.reason ? { title: c.reason } : {}),
      };
  }
}

type Banner = { kind: "success" | "warn" | "error"; text: string };

export function Modules() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [devMap, setDevMap] = useState<Map<string, DevModeStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    // Fetch list + dev-status in parallel — both endpoints carry the same
    // auth, and a dev-mode fetch failure shouldn't blank the list.
    const [listRes, devRes] = await Promise.allSettled([listUis(), listDevMode()]);
    if (listRes.status === "fulfilled") {
      setData(listRes.value);
    } else {
      setError(formatError(listRes.reason));
    }
    if (devRes.status === "fulfilled") {
      const next = new Map<string, DevModeStatus>();
      for (const u of devRes.value.uis) next.set(u.name, u);
      setDevMap(next);
    } else {
      // Dev-list failure is non-fatal — just log; reload list still rendered.
      console.warn("[admin] dev-list fetch failed:", devRes.reason);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onReload = async (name: string) => {
    setBusy(`reload:${name}`);
    setError(null);
    try {
      await reloadUi(name);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * The composed remove. See the module docstring for the shape; every
   * branch ends in an explicit banner naming which halves ran.
   */
  const onUninstall = async (u: UiSummary) => {
    const cred = u.credential;
    const sharedWith = cred?.shared_with ?? [];
    const exclusiveConnection =
      u.server && cred?.connection_id && sharedWith.length === 0 ? cred.connection_id : null;

    const lines = [`Uninstall "${u.name}"? This deletes its files + revokes its OAuth client.`];
    if (exclusiveConnection) {
      lines.push(
        `Its vault credential connection (${exclusiveConnection}) will be torn down at the hub first — the standing credential is revoked.`,
      );
    } else if (u.server && cred?.connection_id && sharedWith.length > 0) {
      lines.push(
        `Its vault credential connection (${cred.connection_id}) stays — still used by: ${sharedWith.join(", ")}.`,
      );
    }
    if (!window.confirm(lines.join("\n\n"))) return;

    setBusy(`remove:${u.name}`);
    setError(null);
    setBanner(null);

    // --- Step 1: hub credential teardown (exclusive connections only). ----
    let credentialNote = "";
    if (exclusiveConnection) {
      const teardown = await deleteConnection(exclusiveConnection);
      if (!teardown.ok) {
        const detail =
          "auth" in teardown && teardown.auth
            ? "not signed in to the hub (the teardown returned 401) — open this page through the hub portal, signed in, for a full teardown"
            : (teardown as { error: string }).error;
        const proceed = window.confirm(
          `Hub teardown failed for connection ${exclusiveConnection}:\n${detail}\n\nRemove the surface anyway (host side only)? Its credential connection stays live until cleaned up in hub admin → Connections.\n\nOK = remove the surface only. Cancel = keep everything.`,
        );
        if (!proceed) {
          setBanner({
            kind: "warn",
            text: `Removal cancelled — "${u.name}" was left intact. Hub teardown failed: ${detail}.`,
          });
          setBusy(null);
          return;
        }
        credentialNote = ` Hub teardown did NOT run (${detail}) — connection ${exclusiveConnection} may still be live: clean up in hub admin → Connections.`;
      } else if (teardown.alreadyGone) {
        credentialNote = ` Connection ${exclusiveConnection} was already gone at the hub.`;
      } else {
        credentialNote = ` Connection ${exclusiveConnection} torn down — credential revoked.`;
        if (teardown.warnings.length > 0) {
          credentialNote += ` Partial-teardown notes: ${teardown.warnings.join("; ")}.`;
        }
      }
    } else if (u.server && cred?.connection_id && sharedWith.length > 0) {
      credentialNote = ` Connection ${cred.connection_id} left standing (shared with ${sharedWith.join(", ")}).`;
    }

    // --- Step 2: host removal (bundle + state + local credential copy). ---
    try {
      const res = await removeUi(u.name);
      // DCR orphan honesty (E5): the hub may not support client deletion.
      let dcrNote = "";
      const revoke = res.oauth_revoke;
      if (revoke) {
        if (revoke.hubDeleteStatus === "ok") {
          dcrNote = " OAuth client revoked.";
        } else if (revoke.hubDeleteStatus === "skipped") {
          dcrNote = "";
        } else if (
          revoke.hubDeleteStatus === "unsupported" ||
          revoke.hubDeleteStatus === "not_found"
        ) {
          dcrNote =
            " The OAuth client record may remain registered at the hub (it doesn't support client deletion yet) — remove it in hub admin → Clients if it lingers.";
        } else {
          dcrNote = ` OAuth client revocation failed (${revoke.detail ?? revoke.hubDeleteStatus}) — remove it in hub admin → Clients.`;
        }
      }
      setBanner({
        kind: credentialNote.includes("did NOT run") ? "warn" : "success",
        text: `Removed "${u.name}".${credentialNote}${dcrNote}`,
      });
      await refresh();
    } catch (e) {
      const failText = credentialNote.includes("torn down")
        ? `Host removal failed: ${formatError(e)}. The hub credential teardown already completed${credentialNote} Retry Uninstall to finish the host side.`
        : `Remove failed: ${formatError(e)}.${credentialNote}`;
      setBanner({ kind: "error", text: failText });
    } finally {
      setBusy(null);
    }
  };

  const onEnableDev = async (name: string) => {
    setBusy(`dev-enable:${name}`);
    setError(null);
    try {
      await enableDevMode(name);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const onDisableDev = async (name: string) => {
    setBusy(`dev-disable:${name}`);
    setError(null);
    try {
      await disableDevMode(name);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const onTriggerReload = async (name: string) => {
    setBusy(`dev-trigger:${name}`);
    setError(null);
    try {
      const res = await triggerReload(name);
      // Tiny side-channel: surface the notified count in the success path.
      console.log(`[admin] dev reload for ${name}: notified ${res.notified}`);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) {
    return <p className="loading">Loading…</p>;
  }

  return (
    <section className="modules" data-route-content>
      <header className="page-header">
        <div className="page-header__title">
          <h1>Surfaces</h1>
          <p className="page-header__sub">
            Surfaces hosted by this <code>parachute-surface</code> instance.
            {data && data.uis.length > 0 && (
              <>
                {" "}
                Currently <strong>{data.uis.length}</strong>{" "}
                {data.uis.length === 1 ? "surface" : "surfaces"} live.
              </>
            )}
          </p>
        </div>
        <Link to="/add" className="btn btn-primary">
          Add surface
        </Link>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {banner && (
        <p
          role={banner.kind === "error" ? "alert" : "status"}
          className={
            banner.kind === "success" ? "success" : banner.kind === "warn" ? "warning" : "error"
          }
        >
          {banner.text}
        </p>
      )}

      {data && data.uis.length === 0 && (
        <div className="empty empty-rich">
          <p className="empty-headline">No surfaces installed yet.</p>
          <p className="muted">
            Surfaces are React or static bundles that mount under{" "}
            <code>/surface/&lt;name&gt;/</code>— and may ship a server for backed surfaces. Notes
            ships as the canonical first one; add your own next to it.
          </p>
          <Link to="/add" className="btn btn-primary" style={{ marginTop: "0.75rem" }}>
            Add your first surface
          </Link>
        </div>
      )}

      {data && data.uis.length > 0 && (
        <ul className="ui-list">
          {data.uis.map((u) => {
            const dev = devMap.get(u.name);
            const devOn = dev?.enabled === true;
            const chip = statusChip(u);
            const cred = credentialChip(u);
            const oauthBadge: { label: string; status: "active" | "pending" | "inactive" } =
              u.oauthClientId
                ? u.oauthStatus === "approved"
                  ? { label: "OAuth connected", status: "active" }
                  : { label: `OAuth ${u.oauthStatus ?? "pending"}`, status: "pending" }
                : { label: "OAuth not registered", status: "inactive" };
            return (
              <li key={u.name} className="ui-card">
                <div className="ui-card__head">
                  <div className="ui-card__title">
                    <Link to={`/info/${u.name}`} className="ui-card__name">
                      {u.displayName}
                    </Link>
                    <a href={u.path} className="ui-card__path">
                      {u.path}
                    </a>
                  </div>
                  <div className="ui-card__badges">
                    <span className={`status status-${chip.tone}`} title={chip.title}>
                      {chip.label}
                    </span>
                    <span className="badge badge-audience">{u.audience ?? "hub-users"}</span>
                    {u.server && <span className="badge badge-backed">backed</span>}
                    {cred && (
                      <span className={`status status-${cred.tone}`} title={cred.title}>
                        {cred.label}
                      </span>
                    )}
                    {u.pwa && <span className="badge">PWA</span>}
                    {devOn && (
                      <span className="badge badge-dev" aria-label={`dev mode on for ${u.name}`}>
                        Dev ON
                      </span>
                    )}
                    <span
                      className={`status status-${oauthBadge.status}`}
                      title={u.oauthClientId ?? "no client registered"}
                    >
                      {oauthBadge.label}
                    </span>
                  </div>
                </div>

                <dl className="ui-card__meta">
                  <div>
                    <dt>Package</dt>
                    <dd>
                      <code>{u.name}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{u.version ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Scopes</dt>
                    <dd>
                      {u.scopes_required.length === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        <ul className="ui-card__scopes">
                          {u.scopes_required.map((s) => (
                            <li key={s}>
                              <code>{s}</code>
                            </li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </div>
                </dl>

                {u.required_schema && (
                  <SchemaRequirements schema={u.required_schema} compact={true} />
                )}

                {devOn && (dev?.subscribers || dev?.watcher) && (
                  <p className="ui-card__dev-detail muted">
                    {dev?.subscribers && dev.subscribers > 0 && (
                      <>{dev.subscribers} tab(s) subscribed. </>
                    )}
                    {dev?.watcher?.watching && (
                      <span title={dev.watcher.watchDir}>
                        Watching {shortenPath(dev.watcher.watchDir)}
                        {dev.watcher.buildCmd && (
                          <>
                            {" "}
                            (build: <code>{dev.watcher.buildCmd}</code>)
                          </>
                        )}
                        .
                      </span>
                    )}
                    {dev?.watcher && !dev.watcher.watching && (
                      <>Watcher off{dev.watcher.warning ? `: ${dev.watcher.warning}` : ""}.</>
                    )}
                  </p>
                )}

                <div className="ui-card__actions">
                  <Link to={`/info/${u.name}`} className="btn btn-secondary">
                    Details
                  </Link>
                  <button
                    type="button"
                    onClick={() => void onReload(u.name)}
                    disabled={busy === `reload:${u.name}`}
                  >
                    Reload
                  </button>
                  {devOn ? (
                    <>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void onTriggerReload(u.name)}
                        disabled={busy === `dev-trigger:${u.name}`}
                      >
                        Trigger reload
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void onDisableDev(u.name)}
                        disabled={busy === `dev-disable:${u.name}`}
                      >
                        Disable dev
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void onEnableDev(u.name)}
                      disabled={busy === `dev-enable:${u.name}`}
                    >
                      Enable dev
                    </button>
                  )}
                  <button
                    type="button"
                    className="destructive ui-card__uninstall"
                    onClick={() => void onUninstall(u)}
                    disabled={busy === `remove:${u.name}`}
                  >
                    Uninstall
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {data && data.skipped.length > 0 && (
        <div className="modules__skipped">
          <h3>Skipped / invalid</h3>
          <ul>
            {data.skipped.map((s) => (
              <li key={s.dirName}>
                <code>{s.dirName}</code> — <strong>{s.status}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
