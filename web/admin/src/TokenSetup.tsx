import { useCallback, useEffect, useState } from "react";
import { clearOperatorToken, getOperatorToken, setOperatorToken } from "./lib/api.ts";
import { ensureToken } from "./lib/auth.ts";

/**
 * Sign-in banner (boundary C4 — the planned Phase 1.3).
 *
 * Default experience behind the hub is zero-paste: on mount we attempt a
 * silent mint from the hub session cookie (`lib/auth.ts`). When it succeeds
 * the banner renders nothing — page loads, you're in. If a legacy pasted
 * token is still sitting in localStorage we show a one-line hint that it's
 * no longer needed (it stays honored as a fallback, we just nudge cleanup).
 *
 * When the silent mint can't work — no signed-in admin session, or no hub at
 * all (direct-on-:1946 404s the mint path) — the banner surfaces:
 *   - sign-in guidance pointing at the hub's `/login`, and
 *   - the legacy pasted-token path, collapsed behind an "advanced"
 *     disclosure, for direct / no-hub deployments.
 *
 * The pasted token still persists to localStorage (it's the explicit
 * fallback for browsers that never see a hub session); the session path
 * never writes storage.
 */

type Probe =
  | { state: "checking" }
  | { state: "session" }
  | { state: "auth-required" }
  | { state: "network-error"; message: string };

export function TokenSetup() {
  const [probe, setProbe] = useState<Probe>({ state: "checking" });
  const [legacyToken, setLegacyToken] = useState<string | null>(() => getOperatorToken());
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  const attemptMint = useCallback(async () => {
    setProbe({ state: "checking" });
    const result = await ensureToken();
    if (result.kind === "ok") {
      setProbe({ state: "session" });
    } else if (result.kind === "auth-required") {
      setProbe({ state: "auth-required" });
    } else {
      setProbe({ state: "network-error", message: result.message });
    }
  }, []);

  useEffect(() => {
    void attemptMint();
  }, [attemptMint]);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    setOperatorToken(trimmed);
    setLegacyToken(trimmed);
    setDraft("");
    setEditing(false);
  };

  const clear = () => {
    clearOperatorToken();
    setLegacyToken(null);
    setEditing(false);
  };

  // Silent mint in flight — render nothing rather than flashing a banner
  // that disappears a beat later on the happy path.
  if (probe.state === "checking") return null;

  if (probe.state === "session") {
    // Signed in via the hub session. Zero chrome — unless a legacy pasted
    // token lingers in localStorage, in which case nudge cleanup. (It stays
    // honored if the session ever goes away; clearing is optional.)
    if (!legacyToken) return null;
    return (
      <div className="token-setup token-setup--collapsed">
        <span className="token-setup__status">
          <span className="token-setup__dot" aria-hidden="true" />
          Signed in via the hub — the pasted token stored in this browser is no longer needed.
        </span>
        <div className="token-setup__actions">
          <button type="button" className="secondary" onClick={clear}>
            Clear stored token
          </button>
        </div>
      </div>
    );
  }

  // Silent mint failed. Legacy pasted token (if present) keeps working —
  // show the familiar collapsed state with Change/Clear.
  if (legacyToken && !editing) {
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
      </div>
    );
  }

  return (
    <div className="token-setup">
      <h3 className="token-setup__heading">Sign in to manage UIs</h3>
      {probe.state === "auth-required" ? (
        <p className="token-setup__hint">
          Running behind a hub? <a href="/login">Sign in to the hub</a> as the admin, then{" "}
          <button type="button" className="link-button" onClick={() => void attemptMint()}>
            try again
          </button>
          — no token paste needed.
        </p>
      ) : (
        <p className="token-setup__hint">
          Could not reach the hub to sign in ({probe.message}).{" "}
          <button type="button" className="link-button" onClick={() => void attemptMint()}>
            Try again
          </button>
        </p>
      )}
      <details className="token-setup__advanced" open={editing || undefined}>
        <summary>Advanced: paste an operator token (direct / no-hub deployments)</summary>
        <p className="token-setup__hint">
          Mint one with <code>parachute auth mint-token --scope surface:admin</code> and paste it
          here. Stored in this browser only.
        </p>
        <div className="token-setup__row">
          <input
            aria-label="Operator bearer token"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="eyJ…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim().length > 0) save();
            }}
          />
          <button type="button" onClick={save} disabled={draft.trim().length === 0}>
            Save
          </button>
        </div>
      </details>
    </div>
  );
}
