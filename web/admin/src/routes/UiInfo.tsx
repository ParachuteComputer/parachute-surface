/**
 * Per-UI detail — full meta.json + OAuth client info + filesystem paths.
 *
 * Phase 2.1 adds a "Provision schema" affordance when the UI declares
 * `required_schema`: a button next to the schema-requirements section
 * that POSTs to `/app/<name>/provision-schema` and surfaces the
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
              Idempotent: re-running against a vault that already has these tags is a no-op.
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
        </>
      )}

      <h3>meta.json</h3>
      <pre className="meta-json">{JSON.stringify(data.meta, null, 2)}</pre>
    </section>
  );
}
