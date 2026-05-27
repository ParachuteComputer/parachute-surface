/**
 * Per-UI detail — full meta.json + OAuth client info + filesystem paths.
 *
 * Phase 2.1 adds a "Provision schema" affordance when the UI declares
 * `required_schema`: a button next to the schema-requirements section
 * that POSTs to `/surface/<name>/provision-schema` and surfaces the
 * per-tag summary (provisioned + errors + skipReason) inline.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SchemaRequirements } from "../components/SchemaRequirements.tsx";
import {
  type ProvisionSchemaResponse,
  type UiInfoResponse,
  formatError,
  getUiInfo,
  provisionSchema,
} from "../lib/api.ts";

export function UiInfo() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<UiInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState<ProvisionSchemaResponse | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

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

  const onProvision = useCallback(async () => {
    if (!name) return;
    setProvisioning(true);
    setProvisionResult(null);
    setProvisionError(null);
    try {
      const res = await provisionSchema(name);
      setProvisionResult(res);
    } catch (e) {
      setProvisionError(formatError(e));
    } finally {
      setProvisioning(false);
    }
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
    <section className="ui-info" data-route-content>
      <Link to="/" className="back-link">
        ← All UIs
      </Link>

      <header className="page-header">
        <div className="page-header__title">
          <h1>{data.ui.displayName}</h1>
          {data.ui.tagline && <p className="page-header__sub">{data.ui.tagline}</p>}
        </div>
        <a href={data.ui.path} className="btn btn-primary">
          Open UI
        </a>
      </header>

      <div className="info-grid">
        <article className="info-card">
          <h2 className="info-card__title">Mount</h2>
          <dl className="info-card__list">
            <div>
              <dt>Path</dt>
              <dd>
                <a href={data.ui.path}>
                  <code>{data.ui.path}</code>
                </a>
              </dd>
            </div>
            <div>
              <dt>Package</dt>
              <dd>
                <code>{data.ui.name}</code>
                {data.ui.version && <span className="muted"> · v{data.ui.version}</span>}
              </dd>
            </div>
            <div>
              <dt>UI directory</dt>
              <dd>
                <code className="path-code">{data.paths.uiDir}</code>
              </dd>
            </div>
            <div>
              <dt>Dist directory</dt>
              <dd>
                <code className="path-code">{data.paths.distDir}</code>
              </dd>
            </div>
          </dl>
        </article>

        <article className="info-card">
          <h2 className="info-card__title">OAuth client</h2>
          {data.oauth_client ? (
            <dl className="info-card__list">
              <div>
                <dt>Client ID</dt>
                <dd>
                  <code className="path-code">{data.oauth_client.client_id}</code>
                </dd>
              </div>
              <div>
                <dt>Scopes</dt>
                <dd>
                  <code>{data.oauth_client.scope}</code>
                </dd>
              </div>
              <div>
                <dt>Hub</dt>
                <dd>
                  <code>{data.oauth_client.hub_url}</code>
                </dd>
              </div>
              <div>
                <dt>Registered</dt>
                <dd>{new Date(data.oauth_client.registered_at).toLocaleString()}</dd>
              </div>
              {data.oauth_client.status && (
                <div>
                  <dt>Status</dt>
                  <dd>
                    <span
                      className={`status status-${data.oauth_client.status === "approved" ? "active" : "pending"}`}
                    >
                      {data.oauth_client.status}
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="muted">No OAuth client registered for this UI.</p>
          )}
        </article>
      </div>

      {data.ui.required_schema && (
        <article className="info-card">
          <h2 className="info-card__title">Schema requirements</h2>
          <SchemaRequirements schema={data.ui.required_schema} defaultExpanded={true} />
          <div className="ui-info__provision">
            <button
              type="button"
              onClick={() => void onProvision()}
              disabled={provisioning}
              aria-label="Re-run schema auto-provisioning"
            >
              {provisioning ? "Provisioning…" : "Provision schema"}
            </button>
            <p className="muted small">
              Idempotent — re-running against a vault that already has these tags is a no-op.
            </p>
            {provisionError && (
              <p role="alert" className="error">
                {provisionError}
              </p>
            )}
            {provisionResult && (
              <div className="ui-info__provision-result">
                {provisionResult.skipReason && (
                  <p className="muted">Skipped: {provisionResult.skipReason}</p>
                )}
                {provisionResult.vaultUrl && (
                  <p className="muted small">
                    Vault: <code>{provisionResult.vaultUrl}</code>
                  </p>
                )}
                {provisionResult.provisioned.length > 0 && (
                  <>
                    <p>Provisioned ({provisionResult.provisioned.length}):</p>
                    <ul>
                      {provisionResult.provisioned.map((t) => (
                        <li key={t}>
                          <code>{t}</code>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {provisionResult.errors.length > 0 && (
                  <>
                    <p className="error">Failed ({provisionResult.errors.length}):</p>
                    <ul>
                      {provisionResult.errors.map((e) => (
                        <li key={e.tag}>
                          <code>{e.tag}</code>: {e.error}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </article>
      )}

      <article className="info-card">
        <h2 className="info-card__title">meta.json</h2>
        <pre className="meta-json">{JSON.stringify(data.meta, null, 2)}</pre>
      </article>
    </section>
  );
}
