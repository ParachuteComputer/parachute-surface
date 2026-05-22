/**
 * Add UI — form for `POST /app/add`.
 *
 * Two source modes:
 *   - Local path on the host filesystem
 *   - npm package specifier (e.g. `@openparachute/notes-ui`)
 *
 * Required fields when meta.json isn't sourced from the bundle: `name` + `path`.
 * Optional override fields: `displayName`, `tagline`, `scopes_required`,
 * `vault_default`, `force`.
 */
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AddResponse, type ApiError, addUi, formatError } from "../lib/api.ts";

export function Add() {
  const navigate = useNavigate();
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [pathField, setPathField] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tagline, setTagline] = useState("");
  const [scopesCsv, setScopesCsv] = useState("");
  const [vaultDefault, setVaultDefault] = useState("");
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<AddResponse | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { source };
      if (name) body.name = name;
      if (pathField) body.path = pathField;
      if (displayName) body.displayName = displayName;
      if (tagline) body.tagline = tagline;
      if (scopesCsv.trim()) {
        body.scopes_required = scopesCsv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (vaultDefault) body.vault_default = vaultDefault;
      if (force) body.force = true;
      const res = await addUi(body as Parameters<typeof addUi>[0]);
      setSuccess(res);
      // Don't auto-navigate; let the operator read the OAuth state first.
    } catch (e) {
      const ae = e as ApiError;
      setError(formatError(e));
      // Surface details when present (validation paths)
      if (ae.details && Array.isArray(ae.details)) {
        setError(
          `${formatError(e)}: ${(ae.details as Array<{ path: string; message: string }>).map((d) => `${d.path} ${d.message}`).join("; ")}`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="add">
      <h2>Add UI</h2>
      <p>
        Register a new UI under <code>~/.parachute/app/uis/&lt;name&gt;/</code>. Source can be a
        local path to a built bundle (contains
        <code>index.html</code>) or an npm package specifier.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {success && (
        <div className="success">
          <h3>Added {success.ui?.name}</h3>
          {success.ui?.path && (
            <p>
              Mounted at <a href={success.ui.path}>{success.ui.path}</a>.
            </p>
          )}
          {success.oauth_client_id && (
            <p>
              OAuth client_id: <code>{success.oauth_client_id}</code>
              {success.oauth_status && ` (status: ${success.oauth_status})`}
            </p>
          )}
          {success.warning && <p className="warning">Warning: {success.warning}</p>}
          <button type="button" onClick={() => navigate("/")}>
            Back to modules
          </button>
        </div>
      )}

      <form onSubmit={onSubmit} className="add__form">
        <label>
          <span>Source*</span>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="/abs/path or @openparachute/notes-ui[@version]"
            required
          />
          <small>Local path to a built bundle, OR an npm package specifier.</small>
        </label>

        <label>
          <span>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-ui"
            pattern="^[a-z][a-z0-9-]*$"
          />
          <small>Lowercase, hyphenated. Required when the source has no meta.json.</small>
        </label>

        <label>
          <span>Mount path</span>
          <input
            type="text"
            value={pathField}
            onChange={(e) => setPathField(e.target.value)}
            placeholder="/app/my-ui"
            pattern="^/app/[a-z0-9-]+$"
          />
          <small>
            Always under <code>/app/</code>. Single segment.
          </small>
        </label>

        <label>
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My UI"
          />
        </label>

        <label>
          <span>Tagline</span>
          <input
            type="text"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="One-line description"
          />
        </label>

        <label>
          <span>Scopes (comma-separated)</span>
          <input
            type="text"
            value={scopesCsv}
            onChange={(e) => setScopesCsv(e.target.value)}
            placeholder="vault:*:read, vault:*:write"
          />
        </label>

        <label>
          <span>Default vault</span>
          <input
            type="text"
            value={vaultDefault}
            onChange={(e) => setVaultDefault(e.target.value)}
            placeholder="(optional, for single-vault UIs)"
          />
        </label>

        <label>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          <span>Force (replace existing UI with the same name)</span>
        </label>

        <button type="submit" disabled={submitting || source.trim().length === 0}>
          {submitting ? "Adding…" : "Add UI"}
        </button>
      </form>
    </section>
  );
}
