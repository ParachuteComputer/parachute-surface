/**
 * Credential panel for a backed surface's detail page (R3b §3 — channel's
 * "link to a vault" pattern, for surfaces).
 *
 * Renders the credential's lifecycle state in plain language, and carries the
 * LINK FLOW:
 *
 *   1. Vault picker — populated from the hub's public discovery doc
 *      (`/.well-known/parachute.json`, anonymous — exactly channel's picker).
 *   2. Access level — read, or read/write per the surface's declared scopes
 *      (a surface that never asked for `:write` defaults to read; write stays
 *      pickable but flagged).
 *   3. Tag scope — THE ATTENUATION MOMENT: the operator types the tags this
 *      surface may touch. Write grants REQUIRE tags (the hub refuses an
 *      untagged write — tags are the sharing scope); read may be vault-wide
 *      by explicit emptiness.
 *   4. POST the hub's `/admin/connections` (`kind: "credential"`,
 *      credentials: "include" — the click IS the approval). The hub mints a
 *      registered, renewable credential and delivers it to surface-host's
 *      endpoint; the browser never sees a token.
 *   5. Re-fetch the host's view. If the new connection didn't auto-bind to
 *      this surface (R3a's resolution found multiple candidates), set the
 *      explicit `credential_connections` mapping in the same flow
 *      (`PATCH /surface/api/config`) — the operator never lands in the
 *      ambiguous dead-end.
 *
 * Failure UX is channel's: hub 401 → sign-in guidance; anything else → the
 * hub's words verbatim.
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type CredentialSummary,
  type UiSummary,
  formatError,
  patchHostConfig,
} from "../lib/api.ts";
import { type DiscoveredVault, createCredentialConnection, fetchVaults } from "../lib/hub.ts";

/** Plain-language explanation + remediation per credential state. */
export function credentialStateCopy(c: CredentialSummary): {
  label: string;
  tone: "active" | "pending" | "failing" | "inactive";
  explanation: string;
} {
  switch (c.state) {
    case "ok":
      return {
        label: "Credential OK",
        tone: "active",
        explanation: `This surface's server reads vault “${c.vault}” with a standing ${
          c.scope?.endsWith(":write") ? "read/write" : "read"
        } credential${
          c.scoped_tags && c.scoped_tags.length > 0
            ? ` scoped to tags: ${c.scoped_tags.join(", ")}`
            : " (vault-wide read)"
        }. The host renews it automatically${c.expires_at ? ` (expires ${c.expires_at})` : ""}.`,
      };
    case "expiring":
      return {
        label: "Renewing soon",
        tone: "pending",
        explanation:
          c.reason ??
          "The credential is inside the renewal window; the host renews it automatically.",
      };
    case "expired":
      return {
        label: "Credential expired",
        tone: "failing",
        explanation:
          c.reason ??
          "The credential expired. Re-approve the connection in the hub admin (Connections), or link again below.",
      };
    case "needs-operator":
      return {
        label: "Needs re-approval",
        tone: "failing",
        explanation:
          c.reason ??
          "The hub rejected renewal — the connection needs operator re-approval. Link again below (the hub revokes the old credential and mints a fresh one).",
      };
    case "none":
      return {
        label: "No vault linked",
        tone: "inactive",
        explanation: `This surface's server has no vault credential yet — its vault calls fail with a clear error until you link one. Linking is your approval: pick the vault and the tags it may touch.`,
      };
    case "ambiguous":
      return {
        label: "Binding ambiguous",
        tone: "failing",
        explanation: `More than one stored credential matches vault “${c.vault}” (${(
          c.candidates ?? []
        ).join(", ")}) — pick which one this surface uses below.`,
      };
    case "missing":
      return {
        label: "Mapped credential missing",
        tone: "failing",
        explanation:
          c.reason ??
          `The config maps this surface to connection “${c.connection_id}” but no such credential is stored. Re-approve it in the hub admin, or link again below.`,
      };
  }
}

export function CredentialPanel(props: {
  ui: UiSummary;
  /**
   * Re-fetch the surface's info after a state-changing action; resolves the
   * FRESH summary so the link flow can check whether the new connection
   * auto-bound (the prop in this closure is stale by then).
   */
  onChanged: () => Promise<UiSummary | null>;
}) {
  const { ui } = props;
  const credential = ui.credential ?? null;

  const [vaults, setVaults] = useState<DiscoveredVault[] | null>(null);
  const [vaultsError, setVaultsError] = useState<string | null>(null);
  const [vault, setVault] = useState("");
  const declaresWrite = ui.scopes_required.some((s) => s.endsWith(":write"));
  const [access, setAccess] = useState<"read" | "write">(declaresWrite ? "write" : "read");
  const [tagsInput, setTagsInput] = useState("");
  const [linking, setLinking] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowNotice, setFlowNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Binding picker (ambiguous state).
  const [bindingChoice, setBindingChoice] = useState("");
  const [binding, setBinding] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetchVaults();
      if (res.ok) {
        setVaults(res.vaults);
        if (res.vaults.length > 0) setVault(res.vaults[0]?.name ?? "");
        if (res.vaults.length === 0) setVaultsError("No vaults exist on this hub yet.");
      } else {
        setVaults([]);
        setVaultsError("error" in res ? res.error : "Could not load vaults from the hub.");
      }
    })();
  }, []);

  if (!ui.server) return null; // static surfaces have no credential story

  const parseTags = (): string[] =>
    tagsInput
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  const onLink = async (e: FormEvent) => {
    e.preventDefault();
    setFlowError(null);
    setFlowNotice(null);
    if (!vault) {
      setFlowError("Pick a vault.");
      return;
    }
    const tags = parseTags();
    if (access === "write" && tags.length === 0) {
      setFlowError(
        "A write credential requires a tag scope — tags are the sharing boundary. List the tags this surface may write.",
      );
      return;
    }
    setLinking(true);
    try {
      const res = await createCredentialConnection({
        key: access === "write" ? "vault-write" : "vault",
        vault,
        tags,
      });
      if (!res.ok) {
        if (res.auth) {
          setFlowError(
            "Not signed in to the hub. Linking a vault uses your hub admin session — open this page through the hub portal (signed in) and try again.",
          );
        } else if (res.status === 403) {
          setFlowError(`Not permitted — only the hub admin can link a vault. ${res.error}`);
        } else {
          setFlowError(`The hub refused the link: ${res.error}`);
        }
        return;
      }

      // The hub minted + delivered. Check whether the host's resolution
      // bound the new connection to THIS surface; when it didn't (R3a's
      // resolution found multiple candidates), set the explicit mapping in
      // the same flow so the operator never lands in the ambiguous dead-end.
      const fresh = await props.onChanged();
      const bound =
        fresh?.credential?.state === "ok" && fresh.credential.connection_id === res.connection.id;
      let note = "";
      if (!bound) {
        try {
          await patchHostConfig({
            credential_connections: { [ui.name]: res.connection.id },
          });
          await props.onChanged();
          note = " Bound explicitly to this surface (credential_connections).";
        } catch (err) {
          note = ` Linked, but binding it to this surface failed: ${formatError(err)} — set the mapping below.`;
        }
      }
      const tagsLabel = tags.length > 0 ? ` · tags: ${tags.join(", ")}` : " (vault-wide read)";
      setFlowNotice(
        `Linked. Connection ${res.connection.id} grants ${
          access === "write" ? "read/write" : "read"
        } on vault “${vault}”${tagsLabel}.${note} The credential lives host-side — it never reaches a browser.`,
      );
      setShowForm(false);
      setTagsInput("");
    } finally {
      setLinking(false);
    }
  };

  const onBind = async () => {
    if (!bindingChoice) return;
    setFlowError(null);
    setFlowNotice(null);
    setBinding(true);
    try {
      await patchHostConfig({ credential_connections: { [ui.name]: bindingChoice } });
      await props.onChanged();
      setFlowNotice(`Bound to connection ${bindingChoice}.`);
    } catch (e) {
      setFlowError(formatError(e));
    } finally {
      setBinding(false);
    }
  };

  const copy = credential ? credentialStateCopy(credential) : null;

  return (
    <article className="info-card credential-panel">
      <h2 className="info-card__title">Vault credential</h2>

      {copy && credential && (
        <>
          <p>
            <span className={`status status-${copy.tone}`}>{copy.label}</span>
            {credential.connection_id && (
              <>
                {" "}
                <code className="muted">{credential.connection_id}</code>
              </>
            )}
          </p>
          <p className="muted">{copy.explanation}</p>
          {credential.shared_with && credential.shared_with.length > 0 && (
            <p className="muted small">
              Shared with: {credential.shared_with.map((s) => s).join(", ")} — removing this surface
              won't tear the connection down while they use it.
            </p>
          )}
        </>
      )}

      {flowError && (
        <p role="alert" className="error">
          {flowError}
        </p>
      )}
      {flowNotice && <p className="success">{flowNotice}</p>}

      {/* Ambiguous-binding picker */}
      {credential?.state === "ambiguous" && (credential.candidates?.length ?? 0) > 0 && (
        <div className="credential-panel__bind">
          <label className="form-field">
            <span className="form-field__label">Use credential</span>
            <select value={bindingChoice} onChange={(e) => setBindingChoice(e.target.value)}>
              <option value="">Pick a connection…</option>
              {credential.candidates?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void onBind()} disabled={binding || !bindingChoice}>
            {binding ? "Binding…" : "Bind"}
          </button>
        </div>
      )}

      {!showForm ? (
        <div className="form-actions form-actions--start">
          <button type="button" onClick={() => setShowForm(true)}>
            {credential?.state === "ok" || credential?.state === "expiring"
              ? "Link a different vault"
              : "Link to a vault"}
          </button>
        </div>
      ) : (
        <form onSubmit={onLink} className="credential-panel__form">
          <label className="form-field">
            <span className="form-field__label">Vault</span>
            <select value={vault} onChange={(e) => setVault(e.target.value)}>
              {vaults === null && <option value="">Loading vaults…</option>}
              {vaults !== null && vaults.length === 0 && (
                <option value="">No vaults available</option>
              )}
              {vaults?.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
            <small>{vaultsError ?? "Which vault this surface's server may reach."}</small>
          </label>

          <label className="form-field">
            <span className="form-field__label">Access</span>
            <select value={access} onChange={(e) => setAccess(e.target.value as "read" | "write")}>
              <option value="read">Read — project vault content to the surface's audience</option>
              <option value="write">Read/write — the surface also writes notes back</option>
            </select>
            <small>
              {declaresWrite
                ? "This surface declares write scopes — read/write is preselected."
                : access === "write"
                  ? "Note: this surface doesn't declare write scopes; grant write only if you know it needs it."
                  : "This surface only declares read scopes."}
            </small>
          </label>

          <label className="form-field">
            <span className="form-field__label">Tag scope</span>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="meeting, public-doc"
            />
            <small>
              The tags this surface may touch — this is where you narrow the grant. Comma or space
              separated.{" "}
              {access === "write"
                ? "Required for write: tags are the sharing boundary, vault-wide write is not grantable."
                : "Leave empty to allow reading the whole vault (read-only)."}
            </small>
          </label>

          <p className="muted small">
            Clicking <strong>Approve + link</strong> is your approval: the hub mints a standing,
            revocable credential at exactly this scope and hands it to the surface host. Revoke any
            time in hub admin → Connections.
          </p>

          <div className="form-actions form-actions--start">
            <button type="submit" disabled={linking || (vaults !== null && vaults.length === 0)}>
              {linking ? "Linking…" : "Approve + link"}
            </button>
            <button type="button" className="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
