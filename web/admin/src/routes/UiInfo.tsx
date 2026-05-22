/**
 * Per-UI detail — full meta.json + OAuth client info + filesystem paths.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SchemaRequirements } from "../components/SchemaRequirements.tsx";
import { type UiInfoResponse, formatError, getUiInfo } from "../lib/api.ts";

export function UiInfo() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<UiInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    void (async () => {
      try {
        const res = await getUiInfo(name);
        setData(res);
      } catch (e) {
        setError(formatError(e));
      }
    })();
  }, [name]);

  if (error) {
    return (
      <section>
        <p role="alert" className="error">
          {error}
        </p>
        <Link to="/">← Back</Link>
      </section>
    );
  }
  if (!data) {
    return <p className="loading">Loading…</p>;
  }
  return (
    <section className="ui-info">
      <Link to="/">← Back</Link>
      <h2>{data.ui.displayName}</h2>
      {data.ui.tagline && <p className="tagline">{data.ui.tagline}</p>}

      <h3>Mount</h3>
      <p>
        <a href={data.ui.path}>{data.ui.path}</a>
      </p>

      <h3>Paths</h3>
      <ul>
        <li>
          UI dir: <code>{data.paths.uiDir}</code>
        </li>
        <li>
          dist: <code>{data.paths.distDir}</code>
        </li>
      </ul>

      <h3>OAuth client</h3>
      {data.oauth_client ? (
        <ul>
          <li>
            client_id: <code>{data.oauth_client.client_id}</code>
          </li>
          <li>
            scope: <code>{data.oauth_client.scope}</code>
          </li>
          <li>
            hub: <code>{data.oauth_client.hub_url}</code>
          </li>
          <li>registered: {data.oauth_client.registered_at}</li>
          {data.oauth_client.status && <li>status: {data.oauth_client.status}</li>}
        </ul>
      ) : (
        <p className="muted">no OAuth client registered</p>
      )}

      {data.ui.required_schema && (
        <>
          <h3>Schema requirements</h3>
          <SchemaRequirements schema={data.ui.required_schema} defaultExpanded={true} />
        </>
      )}

      <h3>meta.json</h3>
      <pre className="meta-json">{JSON.stringify(data.meta, null, 2)}</pre>
    </section>
  );
}
