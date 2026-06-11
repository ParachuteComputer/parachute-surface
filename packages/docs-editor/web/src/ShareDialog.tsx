/**
 * Operator share panel: mint capability / personal links at a grant level
 * for the open doc, list standing grants, revoke. The raw link renders
 * ONCE for copy-paste (it's not re-derivable — by design).
 */

import { useCallback, useEffect, useState } from "react";
import type { DocsApi, MintedShare, ShareGrant } from "./api.ts";

// v1 offers only the levels with BEHAVIOR in this build: view (read-only
// collab) and edit (write). comment/suggest stay in the backend's grant
// schema for forward-compat (overlay docs / propose-a-revision are the
// design's tracked v2) but minting them here would just confuse — they
// behave as read-only today.
const LEVELS = ["view", "edit"] as const;

export function ShareDialog({ api, docId }: { api: DocsApi; docId: string }) {
  const [grants, setGrants] = useState<ShareGrant[]>([]);
  const [level, setLevel] = useState<string>("view");
  const [email, setEmail] = useState("");
  const [minted, setMinted] = useState<MintedShare | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGrants((await api.listShares()).filter((g) => g.resource === docId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, docId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mint = async () => {
    setError(null);
    setMinted(null);
    try {
      const share = await api.mintShare({
        noteId: docId,
        level,
        ...(email.trim().length > 0 ? { email: email.trim() } : {}),
      });
      setMinted(share);
      setEmail("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const revoke = async (grantId: string) => {
    setError(null);
    try {
      await api.revokeShare(grantId);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const entryUrl = minted ? `${window.location.origin}${minted.entryPath}` : null;

  return (
    <div className="share-panel">
      <h3>Share</h3>
      <div className="share-mint">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <input
          type="email"
          placeholder="email (optional — personal link)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="button" onClick={() => void mint()}>
          Create link
        </button>
      </div>
      {entryUrl && (
        <div className="share-minted">
          <p>
            {minted?.kind === "personal"
              ? "Personal link (single use — send it to the invitee):"
              : "Anyone with this link:"}
          </p>
          <code>{entryUrl}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(entryUrl)}>
            Copy
          </button>
        </div>
      )}
      {error && <p className="notice">{error}</p>}
      <ul className="share-grants">
        {grants.map((g) => (
          <li key={g.id}>
            <span>
              {g.level} · {g.subject.startsWith("cap:") ? "link" : g.subject}
              {g.expiresAt ? ` · expires ${new Date(g.expiresAt).toLocaleDateString()}` : ""}
            </span>
            <button type="button" onClick={() => void revoke(g.id)}>
              Revoke
            </button>
          </li>
        ))}
        {grants.length === 0 && <li className="muted">No shares yet.</li>}
      </ul>
    </div>
  );
}
