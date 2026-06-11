/**
 * Docs — minimal reference shell: session probe → doc list → editor.
 *
 *   - OPERATOR: hosted-mode hub OAuth (surface-client), full list,
 *     create + share.
 *   - AUDIENCE: arrives through a capability entry link (the httpOnly
 *     cookie is already set by the time this app loads); sees exactly the
 *     granted docs.
 *   - ANON: a landing with the two ways in.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { EditorPane } from "./Editor.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import { type DocListItem, DocsApi, type Me } from "./api.ts";
import { createOperatorAuth, isOAuthCallback, operatorBearer } from "./auth.ts";

function docIdFromHash(): string | null {
  const match = /#doc=(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1] as string) : null;
}

export function App() {
  const operatorAuth = useMemo(() => createOperatorAuth(), []);
  const api = useMemo(() => new DocsApi({ bearer: operatorBearer }), []);
  const [me, setMe] = useState<Me | null>(null);
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [openDocId, setOpenDocId] = useState<string | null>(docIdFromHash());
  const [error, setError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>(
    () => localStorage.getItem("docs_display_name") ?? "",
  );

  const refreshDocs = useCallback(async () => {
    try {
      setDocs(await api.listDocs());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  // Boot: finish an OAuth callback if present, then probe the session.
  useEffect(() => {
    (async () => {
      try {
        if (isOAuthCallback()) await operatorAuth.handleCallback();
      } catch (e) {
        setError(`Sign-in failed: ${(e as Error).message}`);
      }
      try {
        const who = await api.me();
        setMe(who);
        if (who.kind !== "anon") await refreshDocs();
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [api, operatorAuth, refreshDocs]);

  useEffect(() => {
    const onHash = () => setOpenDocId(docIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openDoc = (id: string | null) => {
    window.location.hash = id ? `doc=${encodeURIComponent(id)}` : "";
    setOpenDocId(id);
  };

  const createDoc = async () => {
    const title = window.prompt("Title for the new doc?");
    if (!title) return;
    try {
      const { id } = await api.createDoc(title);
      await refreshDocs();
      openDoc(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (me === null) {
    return <main className="shell centered">Loading…</main>;
  }

  if (me.kind === "anon") {
    return (
      <main className="shell centered">
        <h1>Docs</h1>
        <p>Collaborative markdown documents over your Parachute vault.</p>
        <button type="button" onClick={() => void operatorAuth.login()}>
          Sign in
        </button>
        <p className="muted">Invited? Open the link you were given — it signs you in by itself.</p>
        {error && <p className="notice">{error}</p>}
      </main>
    );
  }

  const displayName =
    userName.trim().length > 0 ? userName.trim() : me.kind === "operator" ? "Operator" : "Guest";
  const openDocMeta = docs.find((d) => d.id === openDocId);
  const editable =
    openDocMeta !== undefined && (openDocMeta.level === "owner" || openDocMeta.level === "edit");

  return (
    <main className="shell">
      <aside className="sidebar">
        <header>
          <h1>Docs</h1>
          <span className="muted">{me.kind === "operator" ? "operator" : "invited"}</span>
        </header>
        <input
          className="name-input"
          placeholder="Your name (for cursors)"
          value={userName}
          onChange={(e) => {
            setUserName(e.target.value);
            localStorage.setItem("docs_display_name", e.target.value);
          }}
        />
        <nav className="doc-list">
          {docs.map((d) => (
            <button
              type="button"
              key={d.id}
              className={d.id === openDocId ? "doc active" : "doc"}
              onClick={() => openDoc(d.id)}
            >
              <span className="doc-title">{d.title}</span>
              <span className="doc-level">{d.level}</span>
            </button>
          ))}
          {docs.length === 0 && <p className="muted">No docs yet.</p>}
        </nav>
        {me.kind === "operator" && (
          <button type="button" className="create" onClick={() => void createDoc()}>
            + New doc
          </button>
        )}
        {error && <p className="notice">{error}</p>}
      </aside>
      <section className="content">
        {openDocId ? (
          <>
            <EditorPane
              key={openDocId}
              api={api}
              docId={openDocId}
              userName={displayName}
              editable={editable}
            />
            {me.kind === "operator" && <ShareDialog api={api} docId={openDocId} />}
          </>
        ) : (
          <div className="centered muted">Pick a doc.</div>
        )}
      </section>
    </main>
  );
}
