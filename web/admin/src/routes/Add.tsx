/**
 * Add surface — the R3b unified add flow (channel's add-form is the bar).
 *
 * Two honest steps instead of one blind POST:
 *
 *   1. SOURCE — pick the source kind (npm package | server path | URL
 *      tarball), enter the source with per-kind validation, hit
 *      "Inspect source". The host stages the bundle WITHOUT installing
 *      (`POST /surface/inspect`) and reports what an install would see.
 *
 *   2. CONFIRM — meta.json-derived fields are SHOWN (not retyped); manual
 *      name/mount fields appear only when the bundle ships no meta.json.
 *      A surface declaring a `server` block gets a trust card — what it
 *      requests (capabilities, format, timeout, scopes) rendered BEFORE
 *      install, because installing a backed surface is a trust act. The
 *      audience selector (default hub-users) decides who can reach the
 *      surface through the hub. Then Install → `POST /surface/add`.
 *
 * Changing the source (or its kind) resets the inspection — the preview can
 * never go stale against what install will actually fetch.
 */
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type AddResponse,
  type ApiError,
  type InspectResponse,
  type UiAudience,
  addUi,
  formatError,
  inspectSource,
} from "../lib/api.ts";

type SourceKind = "npm" | "path" | "url";

const KIND_META: Record<SourceKind, { label: string; placeholder: string; hint: string }> = {
  npm: {
    label: "npm package",
    placeholder: "@openparachute/notes-ui[@version]",
    hint: "A published npm package whose tarball ships dist/index.html (and usually meta.json).",
  },
  path: {
    label: "Server path",
    placeholder: "/abs/path/to/bundle",
    hint: "An absolute path on the host machine — a built bundle (index.html or dist/index.html).",
  },
  url: {
    label: "URL / GitHub release",
    placeholder: "owner/repo · github.com link · https://…/my-surface.tgz",
    hint: "A GitHub repo (owner/repo or its URL — installs the latest release's .tgz asset; a release-tag URL pins that release; #asset-name.tgz picks one of several), or a direct https:// .tgz link.",
  },
};

/**
 * GitHub-release shorthand the host resolves server-side: `owner/repo` with
 * an optional `#asset-name.tgz` disambiguation. Mirrors the host's charset
 * validation (github-release.ts) closely enough for client-side sanity.
 */
// The #asset suffix is intentionally permissive (any non-empty string):
// release asset names can contain arbitrary characters; the server matches
// them exactly against the API's asset list, not a charset.
const GITHUB_SHORTHAND_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+(?:#.+)?$/;

export const AUDIENCE_OPTIONS: Array<{ value: UiAudience; label: string; description: string }> = [
  {
    value: "hub-users",
    label: "Hub users",
    description:
      "Anyone signed in to this hub (or holding a hub-issued token with the surface's scopes). The default.",
  },
  {
    value: "public",
    label: "Public",
    description:
      "Anyone who can reach this hub's address — no sign-in. Only for surfaces designed to be public.",
  },
  {
    value: "operator",
    label: "Operator only",
    description: "Only the first admin's session. For admin tools and works-in-progress.",
  },
];

/** Client-side source sanity per kind — catches the obvious mismatch before a round-trip. */
export function validateSource(kind: SourceKind, source: string): string | null {
  const s = source.trim();
  if (s.length === 0) return "Required.";
  if (kind === "path") {
    if (!s.startsWith("/")) return "Must be an absolute path on the host (starts with /).";
    return null;
  }
  if (kind === "url") {
    if (GITHUB_SHORTHAND_RE.test(s)) return null; // owner/repo[#asset.tgz]
    if (!/^https?:\/\//i.test(s)) {
      return "Must be an http(s):// URL or a GitHub owner/repo shorthand.";
    }
    if (/^http:\/\//i.test(s) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(s)) {
      return "Plain http:// is only allowed for loopback hosts — use https://.";
    }
    return null;
  }
  // npm
  if (s.startsWith("/") || s.startsWith(".")) {
    return "That looks like a filesystem path — switch the source kind to “Server path”.";
  }
  if (/^https?:\/\//i.test(s)) {
    return "That looks like a URL — switch the source kind to “URL / GitHub release”.";
  }
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@.+)?$/.test(s)) {
    if (GITHUB_SHORTHAND_RE.test(s)) {
      return "That looks like a GitHub owner/repo — switch the source kind to “URL / GitHub release”.";
    }
    return "Not a valid npm specifier (name, @scope/name, or @scope/name@version).";
  }
  return null;
}

export function Add() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<SourceKind>("npm");
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspected, setInspected] = useState<InspectResponse | null>(null);

  // Confirm-step state.
  const [audience, setAudience] = useState<UiAudience>("hub-users");
  const [name, setName] = useState("");
  const [pathField, setPathField] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [force, setForce] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<AddResponse | null>(null);

  /** Any change to the source invalidates the staged preview. */
  const resetInspection = () => {
    setInspected(null);
    setError(null);
    setSuccess(null);
  };

  const onInspect = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const invalid = validateSource(kind, source);
    setSourceError(invalid);
    if (invalid) return;
    setInspecting(true);
    try {
      const res = await inspectSource(source.trim());
      setInspected(res);
      // Seed confirm-step fields from the bundle's declaration.
      setAudience(res.meta?.audience ?? "hub-users");
      setName(res.meta?.name ?? "");
      setPathField(res.meta?.path ?? "");
      setDisplayName(res.meta?.displayName ?? "");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setInspecting(false);
    }
  };

  const needsManualIdentity = inspected !== null && inspected.meta === null;

  const onInstall = async () => {
    if (!inspected) return;
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      // A GitHub-resolved source installs the EXACT inspected asset (its
      // browser_download_url) — no second GitHub API call, and no race
      // against a new "latest" published between inspect and install.
      const body: Parameters<typeof addUi>[0] = {
        source: inspected.github_release?.download_url ?? source.trim(),
        audience,
      };
      // Identity overrides ride only when the operator had to (or chose to)
      // type them — meta-derived values are NOT retyped back at the host.
      if (needsManualIdentity || name !== (inspected.meta?.name ?? "")) {
        if (name) body.name = name;
      }
      if (needsManualIdentity || pathField !== (inspected.meta?.path ?? "")) {
        if (pathField) body.path = pathField;
      }
      if (needsManualIdentity || displayName !== (inspected.meta?.displayName ?? "")) {
        if (displayName) body.displayName = displayName;
      }
      if (force) body.force = true;
      const res = await addUi(body);
      setSuccess(res);
    } catch (e) {
      const ae = e as ApiError;
      let msg = formatError(e);
      if (ae.details && Array.isArray(ae.details)) {
        msg = `${msg}: ${(ae.details as Array<{ path: string; message: string }>)
          .map((d) => `${d.path} ${d.message}`)
          .join("; ")}`;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="add" data-route-content>
      <header className="page-header">
        <div className="page-header__title">
          <h1>Add a surface</h1>
          <p className="page-header__sub">
            Point at a built bundle — the host inspects it first so you see exactly what you're
            installing (and what it asks for) before anything lands.
          </p>
        </div>
      </header>

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
              Mounted at <a href={success.ui.path}>{success.ui.path}</a> · audience{" "}
              <strong>{success.ui.audience ?? "hub-users"}</strong>.
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
            Back to surfaces
          </button>
        </div>
      )}

      {/* --- Step 1: source ------------------------------------------------ */}
      <form onSubmit={onInspect} className="add__form form-card">
        <fieldset className="form-section">
          <legend className="form-section__title">Source</legend>
          <div className="kind-select" role="radiogroup" aria-label="Source kind">
            {(Object.keys(KIND_META) as SourceKind[]).map((k) => (
              <label key={k} className={`kind-option${kind === k ? " kind-option--active" : ""}`}>
                <input
                  type="radio"
                  name="source-kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                    setSourceError(null);
                    resetInspection();
                  }}
                />
                <span>{KIND_META[k].label}</span>
              </label>
            ))}
          </div>
          <label className="form-field">
            <span className="form-field__label">{KIND_META[kind].label}</span>
            <input
              type="text"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSourceError(null);
                resetInspection();
              }}
              placeholder={KIND_META[kind].placeholder}
              required
            />
            <small>{KIND_META[kind].hint}</small>
            {sourceError && <span className="field-error">{sourceError}</span>}
          </label>
          <div className="form-actions">
            <button type="submit" disabled={inspecting || source.trim().length === 0}>
              {inspecting ? "Inspecting…" : "Inspect source"}
            </button>
          </div>
        </fieldset>
      </form>

      {/* --- Step 2: confirm ------------------------------------------------ */}
      {inspected && !success && (
        <div className="form-card add__confirm">
          {inspected.meta_errors && (
            <div className="warning">
              <p>
                The bundle ships a <code>meta.json</code> that doesn't validate — fix the bundle, or
                supply name + mount below to override:
              </p>
              <ul>
                {inspected.meta_errors.map((d) => (
                  <li key={`${d.path}:${d.message}`}>
                    <code>{d.path}</code> {d.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inspected.warnings.length > 0 && (
            <p className="warning">{inspected.warnings.join(" · ")}</p>
          )}

          {inspected.github_release && (
            <fieldset className="form-section">
              <legend className="form-section__title">Resolved GitHub release</legend>
              <p className="form-section__sub">
                Install will fetch exactly this release asset from{" "}
                <code>
                  {inspected.github_release.owner}/{inspected.github_release.repo}
                </code>
                .
              </p>
              <dl className="info-card__list add__derived">
                <div>
                  <dt>Release</dt>
                  <dd>
                    <code>{inspected.github_release.tag}</code>
                  </dd>
                </div>
                <div>
                  <dt>Asset</dt>
                  <dd>
                    <code>{inspected.github_release.asset_name}</code>
                  </dd>
                </div>
              </dl>
            </fieldset>
          )}

          {inspected.meta && (
            <fieldset className="form-section">
              <legend className="form-section__title">From the bundle's meta.json</legend>
              <p className="form-section__sub">
                These come from the bundle itself — nothing to retype.
              </p>
              <dl className="info-card__list add__derived">
                <div>
                  <dt>Name</dt>
                  <dd>
                    <code>{inspected.meta.name}</code>
                  </dd>
                </div>
                <div>
                  <dt>Display name</dt>
                  <dd>{inspected.meta.displayName}</dd>
                </div>
                <div>
                  <dt>Mount</dt>
                  <dd>
                    <code>{inspected.meta.path}</code>
                  </dd>
                </div>
                {inspected.meta.version && (
                  <div>
                    <dt>Version</dt>
                    <dd>{inspected.meta.version}</dd>
                  </div>
                )}
                <div>
                  <dt>Scopes</dt>
                  <dd>
                    {inspected.meta.scopes_required.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      inspected.meta.scopes_required.map((s) => <code key={s}>{s} </code>)
                    )}
                  </dd>
                </div>
                {inspected.meta.vault_default && (
                  <div>
                    <dt>Default vault</dt>
                    <dd>
                      <code>{inspected.meta.vault_default}</code>
                    </dd>
                  </div>
                )}
              </dl>
            </fieldset>
          )}

          {(needsManualIdentity || inspected.meta_errors) && (
            <fieldset className="form-section">
              <legend className="form-section__title">Identity</legend>
              <p className="form-section__sub">
                {needsManualIdentity
                  ? "The bundle ships no meta.json — give the surface a name and mount path."
                  : "Overrides applied on top of the bundle's meta.json."}
              </p>
              <label className="form-field">
                <span className="form-field__label">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-surface"
                  pattern="^[a-z][a-z0-9-]*$"
                />
                <small>Lowercase, hyphenated.</small>
              </label>
              <label className="form-field">
                <span className="form-field__label">Mount path</span>
                <input
                  type="text"
                  value={pathField}
                  onChange={(e) => setPathField(e.target.value)}
                  placeholder="/surface/my-surface"
                  pattern="^/surface/[a-z0-9-]+$"
                />
                <small>
                  Always under <code>/surface/</code>. Single segment.
                </small>
              </label>
              <label className="form-field">
                <span className="form-field__label">Display name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="My Surface"
                />
              </label>
            </fieldset>
          )}

          {inspected.server && (
            <fieldset className="form-section trust-card">
              <legend className="form-section__title">This surface ships a server</legend>
              <p className="form-section__sub">
                It will run <strong>inside the surface daemon</strong> on this machine. Installing
                it is a trust act — here's what it declares:
              </p>
              <dl className="info-card__list">
                <div>
                  <dt>Server entry</dt>
                  <dd>
                    <code>{inspected.server.entry}</code>
                  </dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {inspected.server.capabilities.length === 0 ? (
                      <span className="muted">none declared</span>
                    ) : (
                      inspected.server.capabilities.map((c) => <code key={c}>{c} </code>)
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Content format</dt>
                  <dd>
                    <code>{inspected.server.format}</code>
                  </dd>
                </div>
                <div>
                  <dt>Request timeout</dt>
                  <dd>{inspected.server.timeoutMs} ms (host-enforced)</dd>
                </div>
              </dl>
              <p className="muted small">
                Vault access is NOT granted by installing: the backend only reaches a vault after
                you approve a tag-scoped credential connection (Surfaces → this surface → “Link to a
                vault”). Its token never reaches a browser.
              </p>
            </fieldset>
          )}

          <fieldset className="form-section">
            <legend className="form-section__title">Who can open it?</legend>
            <div className="audience-select" role="radiogroup" aria-label="Audience">
              {AUDIENCE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`audience-option${audience === opt.value ? " audience-option--active" : ""}`}
                >
                  <input
                    type="radio"
                    name="audience"
                    value={opt.value}
                    checked={audience === opt.value}
                    onChange={() => setAudience(opt.value)}
                  />
                  <span className="audience-option__label">{opt.label}</span>
                  <span className="audience-option__desc">{opt.description}</span>
                </label>
              ))}
            </div>
            <p className="muted small">
              Enforced by the hub before any request reaches the surface. Editable later from the
              surface's detail page.
            </p>
          </fieldset>

          <label className="form-checkbox">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>
              <strong>Force</strong> — replace an existing surface with the same name.
            </span>
          </label>

          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => navigate("/")}>
              Cancel
            </button>
            <button type="button" onClick={() => void onInstall()} disabled={submitting}>
              {submitting ? "Installing…" : "Install surface"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
