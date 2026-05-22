/**
 * Modules — list of installed UIs.
 *
 * Each row shows displayName, mount path, version, scopes, and OAuth client
 * state. Per-row actions: Reload (re-scan from disk), Remove (delete + revoke).
 * A skipped/invalid UI surfaces with its reason inline.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ListResponse, formatError, listUis, reloadUi, removeUi } from "../lib/api.ts";

export function Modules() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await listUis();
      setData(res);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoaded(true);
    }
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

  const onRemove = async (name: string) => {
    if (!window.confirm(`Remove "${name}"? This deletes its files + revokes its OAuth client.`)) {
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

  if (!loaded) {
    return <p className="loading">Loading…</p>;
  }

  return (
    <section className="modules">
      <div className="modules__header">
        <h2>Installed UIs</h2>
        <Link to="/add" className="btn btn-primary">
          + Add UI
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
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.uis.map((u) => (
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
                </td>
                <td className="modules__actions">
                  <button
                    type="button"
                    onClick={() => void onReload(u.name)}
                    disabled={busy === `reload:${u.name}`}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemove(u.name)}
                    disabled={busy === `remove:${u.name}`}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
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
