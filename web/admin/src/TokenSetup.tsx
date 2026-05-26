import { useEffect, useState } from "react";
import { TOKEN_STORAGE_KEY, getOperatorToken, setOperatorToken } from "./lib/api.ts";

/**
 * Inline token-setup banner.
 *
 * Phase 1.2 MVP: the admin SPA's API calls require `app:admin`. There's no
 * hub-session-based auth yet (Phase 1.3); for now the operator pastes a
 * bearer once and we store it in localStorage. The banner stays visible when
 * no token is set; it collapses to a small "Token configured" affordance
 * once the operator's saved one.
 */
export function TokenSetup() {
  const [token, setToken] = useState<string>(() => getOperatorToken() ?? "");
  const [editing, setEditing] = useState<boolean>(() => !getOperatorToken());
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    // Refresh from storage on mount (in case another tab updated it).
    const fromStore = getOperatorToken();
    if (fromStore && !token) setToken(fromStore);
  }, [token]);

  const save = () => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    setOperatorToken(trimmed);
    setSavedAt(Date.now());
    setEditing(false);
  };

  const clear = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken("");
    setEditing(true);
  };

  if (!editing && token.length > 0) {
    return (
      <div className="token-setup token-setup--collapsed">
        <span className="token-setup__status">
          <span className="token-setup__dot" aria-hidden="true" />
          Token configured
        </span>
        <div className="token-setup__actions">
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            Change
          </button>
          <button type="button" className="secondary" onClick={clear}>
            Clear
          </button>
        </div>
        {savedAt && <small className="muted">saved {new Date(savedAt).toLocaleTimeString()}</small>}
      </div>
    );
  }

  return (
    <div className="token-setup">
      <h3 className="token-setup__heading">Sign in to manage UIs</h3>
      <p className="token-setup__hint">
        Paste an operator bearer with <code>app:admin</code> scope. Mint one with{" "}
        <code>parachute auth mint-token --scope app:admin</code>. Stored in this browser only.
      </p>
      <div className="token-setup__row">
        <input
          aria-label="Operator bearer token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJ…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim().length > 0) save();
          }}
        />
        <button type="button" onClick={save} disabled={token.trim().length === 0}>
          Save
        </button>
      </div>
    </div>
  );
}
