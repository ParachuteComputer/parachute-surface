/**
 * Per-surface detail — the heart of the R3b revamp.
 *
 * Cards, top to bottom:
 *   - Health: REAL status (R3a's per-surface lifecycle) with plain-language
 *     explanation + remediation; the Reload button is the quarantine exit for
 *     backend-disabled / backend-error.
 *   - Mount: path / package / version / filesystem paths + dev-mode state.
 *   - Audience: editable post-install (PATCH /surface/<name>) — enforced at
 *     the hub gate per request.
 *   - OAuth client: approve-vs-pending shown honestly; "Retry registration"
 *     fixes the pending/failed dead-end in-SPA (POST .../register-oauth).
 *   - Vault credential (backed surfaces): lifecycle + the link-to-a-vault
 *     flow (`CredentialPanel`).
 *   - Schema requirements + raw meta.json (as before).
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CredentialPanel } from "../components/CredentialPanel.tsx";
import { SchemaRequirements } from "../components/SchemaRequirements.tsx";
import {
  type DevModeStatus,
  type ProvisionSchemaResponse,
  type UiAudience,
  type UiInfoResponse,
  type UiSummary,
  formatError,
  getDevModeStatus,
  getUiInfo,
  patchUi,
  provisionSchema,
  registerOauth,
  reloadUi,
} from "../lib/api.ts";
import { AUDIENCE_OPTIONS } from "./Add.tsx";

/** Plain-language status copy + remediation per real surface status (P5). */
export function statusCopy(ui: UiSummary): {
  label: string;
  tone: "active" | "pending" | "failing" | "inactive";
  explanation: string;
  showReload: boolean;
} {
  switch (ui.status) {
    case "static-only":
      return {
        label: "Static",
        tone: "active",
        explanation:
          "This surface is a static bundle — it serves files, nothing runs server-side for it.",
        showReload: false,
      };
    case "active":
      return {
        label: "Active",
        tone: "active",
        explanation: "The surface's server is mounted and healthy.",
        showReload: false,
      };
    case "pending-credential":
      return {
        label: "Awaiting credential",
        tone: "pending",
        explanation: `The surface needs a vault credential before its server starts — approve a credential connection in the hub admin (Connections); the server mounts automatically when it arrives.${ui.statusReason ? ` Detail: ${ui.statusReason}` : ""}`,
        showReload: false,
      };
    case "failing":
      return {
        label: "Failing",
        tone: "pending",
        explanation: `The server hit recent contained failures (inside the crash-loop window) but is still serving. If it keeps failing it will be quarantined.${ui.statusReason ? ` Latest: ${ui.statusReason}` : ""}`,
        showReload: true,
      };
    case "backend-error":
      return {
        label: "Backend error",
        tone: "failing",
        explanation: `The server entry failed to mount — the static bundle still serves, but its API returns 503.${ui.statusReason ? ` Reason: ${ui.statusReason}` : ""} Fix the bundle (or the underlying issue) and reload.`,
        showReload: true,
      };
    case "backend-disabled":
      return {
        label: "Quarantined",
        tone: "failing",
        explanation: `The server crashed repeatedly and was quarantined — API requests return 503 until you reload it.${ui.statusReason ? ` Reason: ${ui.statusReason}` : ""}`,
        showReload: true,
      };
  }
}

export function UiInfo() {
  const { name } = useParams<{ name: string }>();
  const [data, setData] = useState<UiInfoResponse | null>(null);
  const [dev, setDev] = useState<DevModeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Audience editing.
  const [audienceDraft, setAudienceDraft] = useState<UiAudience>("hub-users");

  // Schema provisioning (Phase 2.1, carried over).
  const [provisionResult, setProvisionResult] = useState<ProvisionSchemaResponse | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<UiSummary | null> => {
    if (!name) return null;
    try {
      const [infoRes, devRes] = await Promise.allSettled([getUiInfo(name), getDevModeStatus(name)]);
      if (infoRes.status === "fulfilled") {
        setData(infoRes.value);
        setAudienceDraft(infoRes.value.ui.audience ?? "hub-users");
      } else {
        setError(formatError(infoRes.reason));
        return null;
      }
      // Dev status is best-effort (older daemons / static hosts may 404).
      setDev(devRes.status === "fulfilled" ? devRes.value : null);
      return infoRes.value.ui;
    } catch (e) {
      setError(formatError(e));
      return null;
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onReload = async () => {
    if (!name) return;
    setBusy("reload");
    setError(null);
    setNotice(null);
    try {
      await reloadUi(name);
      await refresh();
      setNotice("Reloaded — the surface was re-scanned and its backend remounted fresh.");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const onSaveAudience = async () => {
    if (!name || !data) return;
    setBusy("audience");
    setError(null);
    setNotice(null);
    try {
      const res = await patchUi(name, { audience: audienceDraft });
      await refresh();
      setNotice(`Audience is now “${res.ui.audience}” — the hub enforces it on the next request.`);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const onRetryRegistration = async () => {
    if (!name) return;
    setBusy("dcr");
    setError(null);
    setNotice(null);
    try {
      const res = await registerOauth(name);
      await refresh();
      setNotice(
        res.oauth_client.status === "approved"
          ? `OAuth client re-registered and approved (${res.oauth_client.client_id}).`
          : `OAuth client re-registered as “${res.oauth_client.status ?? "pending"}” (${res.oauth_client.client_id}) — it still needs approval in hub admin → Clients.`,
      );
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(null);
    }
  };

  const onProvision = useCallback(async () => {
    if (!name) return;
    setBusy("provision");
    setProvisionResult(null);
    setProvisionError(null);
    try {
      const res = await provisionSchema(name);
      setProvisionResult(res);
    } catch (e) {
      setProvisionError(formatError(e));
    } finally {
      setBusy(null);
    }
  }, [name]);

  if (error && !data) {
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

  const ui = data.ui;
  const status = statusCopy(ui);
  const oauthApproved = ui.oauthStatus === "approved";
  const currentAudience = ui.audience ?? "hub-users";

  return (
    <section className="ui-info" data-route-content>
      <Link to="/" className="back-link">
        ← All surfaces
      </Link>

      <header className="page-header">
        <div className="page-header__title">
          <h1>{ui.displayName}</h1>
          {ui.tagline && <p className="page-header__sub">{ui.tagline}</p>}
        </div>
        <a href={ui.path} className="btn btn-primary">
          Open surface
        </a>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p className="success">{notice}</p>}

      {/* --- Health --------------------------------------------------------- */}
      <article className="info-card">
        <h2 className="info-card__title">Health</h2>
        <p>
          <span className={`status status-${status.tone}`}>{status.label}</span>
          {ui.server && (
            <span className="muted">
              {" "}
              · backed surface (<code>{ui.server.entry}</code>
              {ui.server.capabilities.length > 0 && <> · {ui.server.capabilities.join(", ")}</>})
            </span>
          )}
          {dev?.enabled && <span className="badge badge-dev"> Dev ON</span>}
        </p>
        <p className="muted">{status.explanation}</p>
        {status.showReload && (
          <div className="form-actions form-actions--start">
            <button type="button" onClick={() => void onReload()} disabled={busy === "reload"}>
              {busy === "reload" ? "Reloading…" : "Reload surface"}
            </button>
          </div>
        )}
      </article>

      <div className="info-grid">
        <article className="info-card">
          <h2 className="info-card__title">Mount</h2>
          <dl className="info-card__list">
            <div>
              <dt>Path</dt>
              <dd>
                <a href={ui.path}>
                  <code>{ui.path}</code>
                </a>
              </dd>
            </div>
            <div>
              <dt>Package</dt>
              <dd>
                <code>{ui.name}</code>
                {ui.version && <span className="muted"> · v{ui.version}</span>}
              </dd>
            </div>
            <div>
              <dt>Scopes</dt>
              <dd>
                {ui.scopes_required.length === 0 ? (
                  <span className="muted">none</span>
                ) : (
                  ui.scopes_required.map((s) => <code key={s}>{s} </code>)
                )}
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
            {dev && (
              <div>
                <dt>Dev mode</dt>
                <dd>
                  {dev.enabled ? (
                    <>
                      on
                      {dev.watcher?.watching ? (
                        <span className="muted"> · watching {dev.watcher.watchDir}</span>
                      ) : null}
                    </>
                  ) : (
                    "off"
                  )}
                </dd>
              </div>
            )}
          </dl>
        </article>

        <article className="info-card">
          <h2 className="info-card__title">Audience</h2>
          <p className="muted small">
            Who can open this surface through the hub. Enforced at the hub proxy before any request
            reaches the bundle.
          </p>
          <div className="audience-select" role="radiogroup" aria-label="Audience">
            {AUDIENCE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`audience-option${audienceDraft === opt.value ? " audience-option--active" : ""}`}
              >
                <input
                  type="radio"
                  name="audience-edit"
                  value={opt.value}
                  checked={audienceDraft === opt.value}
                  onChange={() => setAudienceDraft(opt.value)}
                />
                <span className="audience-option__label">{opt.label}</span>
                <span className="audience-option__desc">{opt.description}</span>
              </label>
            ))}
          </div>
          {audienceDraft !== currentAudience && (
            <div className="form-actions form-actions--start">
              <button
                type="button"
                onClick={() => void onSaveAudience()}
                disabled={busy === "audience"}
              >
                {busy === "audience" ? "Saving…" : `Set audience to “${audienceDraft}”`}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setAudienceDraft(currentAudience)}
              >
                Cancel
              </button>
            </div>
          )}
        </article>
      </div>

      {/* --- OAuth client ----------------------------------------------------- */}
      <article className="info-card">
        <h2 className="info-card__title">OAuth client</h2>
        {data.oauth_client ? (
          <>
            <p>
              <span className={`status status-${oauthApproved ? "active" : "pending"}`}>
                {oauthApproved ? "Approved" : (ui.oauthStatus ?? "pending")}
              </span>{" "}
              <code className="muted">{data.oauth_client.client_id}</code>
            </p>
            {!oauthApproved && (
              <p className="muted">
                The client is registered but not approved — sign-ins through it will fail until it's
                approved in hub admin → Clients, or until you retry registration with the operator
                token present (which lands approved).
              </p>
            )}
            <dl className="info-card__list">
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
            </dl>
          </>
        ) : (
          <p className="muted">
            No OAuth client is registered for this surface — DCR was disabled or the hub was
            unreachable at install time. Users can't sign in to it until one exists.
          </p>
        )}
        {(!data.oauth_client || !oauthApproved) && (
          <div className="form-actions form-actions--start">
            <button
              type="button"
              onClick={() => void onRetryRegistration()}
              disabled={busy === "dcr"}
            >
              {busy === "dcr" ? "Registering…" : "Retry registration"}
            </button>
          </div>
        )}
      </article>

      {/* --- Vault credential (backed surfaces only) -------------------------- */}
      {ui.server && <CredentialPanel ui={ui} onChanged={refresh} />}

      {/* --- Schema requirements (Phase 2.0/2.1, carried over) ---------------- */}
      {ui.required_schema && (
        <article className="info-card">
          <h2 className="info-card__title">Schema requirements</h2>
          <SchemaRequirements schema={ui.required_schema} defaultExpanded={true} />
          <div className="ui-info__provision">
            <button
              type="button"
              onClick={() => void onProvision()}
              disabled={busy === "provision"}
              aria-label="Re-run schema auto-provisioning"
            >
              {busy === "provision" ? "Provisioning…" : "Provision schema"}
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
