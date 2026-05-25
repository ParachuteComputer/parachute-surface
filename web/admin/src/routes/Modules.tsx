/**
 * Modules — list of installed UIs.
 *
 * Each row shows displayName, mount path, version, scopes, OAuth client
 * state, and dev-mode status (Phase 1.3). Per-row actions: Reload (re-scan
 * from disk), Uninstall (delete + revoke), and the dev-mode triad — Enable
 * dev / Disable dev / Trigger reload. The dev-status map is fetched in
 * parallel with the UI list and re-fetched on every refresh; a row shows
 * a "Dev" badge when the UI's name is in the active set.
 *
 * "Uninstall" matches the canonical verb vocabulary
 * (parachute-patterns/patterns/design-system.md §5) for removing a module
 * — the action revokes the OAuth client + deletes the files, exactly the
 * same shape as `parachute uninstall <short>`.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SchemaRequirements } from "../components/SchemaRequirements.tsx";
import {
  type DevModeStatus,
  type ListResponse,
  disableDevMode,
  enableDevMode,
  formatError,
  listDevMode,
  listUis,
  reloadUi,
  removeUi,
  triggerReload,
} from "../lib/api.ts";

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

export function Modules() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [devMap, setDevMap] = useState<Map<string, DevModeStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
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

  const onUninstall = async (name: string) => {
    if (
      !window.confirm(`Uninstall "${name}"? This deletes its files + revokes its OAuth client.`)
    ) {
      return;
    }
    setBusy(`remove:${name}`);
    setError(null);
    try {
      await removeUi(name);
      await refresh();
    } catch (e) {
      setError(formatError(e));
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
    <section className="modules">
      <div className="modules__header">
        <h2>Installed UIs</h2>
        <Link to="/add" className="btn btn-primary">
          Add UI
        </Link>
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {data && data.uis.length === 0 && (
        <p className="empty">
          No UIs installed yet. <Link to="/add">Add your first UI</Link>.
        </p>
      )}

      {data && data.uis.length > 0 && (
        <table className="modules__table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Name</th>
              <th>Version</th>
              <th>OAuth client</th>
              <th>Scopes</th>
              <th>Dev</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.uis.map((u) => {
              const dev = devMap.get(u.name);
              const devOn = dev?.enabled === true;
              return (
                <tr key={u.name}>
                  <td>
                    <a href={u.path} className="modules__mount">
                      {u.path}
                    </a>
                  </td>
                  <td>
                    <Link to={`/info/${u.name}`}>{u.displayName}</Link>
                    <br />
                    <small>
                      <code>{u.name}</code>
                    </small>
                    {u.pwa && (
                      <>
                        <br />
                        <span className="badge">PWA</span>
                      </>
                    )}
                    {u.public && (
                      <>
                        <br />
                        <span className="badge">public</span>
                      </>
                    )}
                  </td>
                  <td>{u.version ?? "—"}</td>
                  <td>
                    {u.oauthClientId ? (
                      <>
                        <code className="small-code">{u.oauthClientId.slice(0, 16)}…</code>
                        {u.oauthStatus && <small>{` (${u.oauthStatus})`}</small>}
                      </>
                    ) : (
                      <span className="muted">not registered</span>
                    )}
                  </td>
                  <td>
                    <ul className="modules__scopes">
                      {u.scopes_required.map((s) => (
                        <li key={s}>
                          <code>{s}</code>
                        </li>
                      ))}
                    </ul>
                    {u.required_schema && (
                      <SchemaRequirements schema={u.required_schema} compact={true} />
                    )}
                  </td>
                  <td className="modules__dev">
                    {devOn ? (
                      <>
                        <span className="badge badge-dev" aria-label={`dev mode on for ${u.name}`}>
                          Dev ON
                        </span>
                        {dev && dev.subscribers > 0 && (
                          <>
                            <br />
                            <small>{dev.subscribers} tab(s)</small>
                          </>
                        )}
                        {dev?.watcher?.watching && (
                          <>
                            <br />
                            <small className="muted" title={dev.watcher.watchDir}>
                              watching {shortenPath(dev.watcher.watchDir)}
                              {dev.watcher.buildCmd && (
                                <>
                                  <br />
                                  build: <code>{dev.watcher.buildCmd}</code>
                                </>
                              )}
                            </small>
                          </>
                        )}
                        {dev?.watcher && !dev.watcher.watching && (
                          <>
                            <br />
                            <small className="muted">
                              watcher off{dev.watcher.warning ? `: ${dev.watcher.warning}` : ""}
                            </small>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="muted">off</span>
                    )}
                  </td>
                  <td className="modules__actions">
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
                          onClick={() => void onTriggerReload(u.name)}
                          disabled={busy === `dev-trigger:${u.name}`}
                        >
                          Trigger reload
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDisableDev(u.name)}
                          disabled={busy === `dev-disable:${u.name}`}
                        >
                          Disable dev
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void onEnableDev(u.name)}
                        disabled={busy === `dev-enable:${u.name}`}
                      >
                        Enable dev
                      </button>
                    )}
                    <button
                      type="button"
                      className="destructive"
                      onClick={() => void onUninstall(u.name)}
                      disabled={busy === `remove:${u.name}`}
                    >
                      Uninstall
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
