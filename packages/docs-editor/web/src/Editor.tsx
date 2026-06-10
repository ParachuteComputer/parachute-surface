/**
 * The collaborative editor pane — TipTap 3 over the SHARED schema
 * (`@openparachute/doc-schema/tiptap`; never a parallel extension list)
 * with Yjs through a HocuspocusProvider speaking to `${mount}/ws`
 * (hub WS bridge → host pump → the backend's Hocuspocus engine).
 *
 * Auth: the provider's `token` mints a fresh single-use ticket per
 * connect (POST /api/collab/ticket — cookie or Bearer, same gateway as
 * every route). History is Yjs's (the schema package omits the editor
 * history extension by design).
 */

import { HocuspocusProvider } from "@hocuspocus/provider";
import { docSchemaExtensions } from "@openparachute/doc-schema/tiptap";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import type { DocsApi } from "./api.ts";

const CARET_COLORS = ["#b45309", "#0e7490", "#6d28d9", "#be185d", "#15803d", "#a16207"];

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return CARET_COLORS[h % CARET_COLORS.length] as string;
}

export interface EditorPaneProps {
  api: DocsApi;
  docId: string;
  /** Display name for presence (cursor labels). */
  userName: string;
  /** Server-enforced; mirrored here so the UI doesn't pretend. */
  editable: boolean;
}

type ConnState = "connecting" | "connected" | "denied" | "disconnected";

export function EditorPane({ api, docId, userName, editable }: EditorPaneProps) {
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [peers, setPeers] = useState<string[]>([]);

  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: api.wsUrl(),
        name: docId,
        token: () => api.ticket(),
        onAuthenticated: () => setConnState("connected"),
        onAuthenticationFailed: () => setConnState("denied"),
        onClose: () => setConnState((s) => (s === "denied" ? s : "disconnected")),
      }),
    [api, docId],
  );

  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const update = () => {
      const names: string[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const user = (state as { user?: { name?: string } }).user;
        if (user?.name) names.push(user.name);
      }
      setPeers(names.sort());
    };
    awareness.on("update", update);
    update();
    return () => awareness.off("update", update);
  }, [provider]);

  useEffect(
    () => () => {
      provider.destroy();
      provider.configuration.websocketProvider.destroy();
    },
    [provider],
  );

  const editor = useEditor(
    {
      editable,
      extensions: [
        ...docSchemaExtensions,
        Collaboration.configure({ document: provider.document }),
        CollaborationCaret.configure({
          provider,
          user: { name: userName, color: colorFor(userName) },
        }),
      ],
    },
    [provider, editable],
  );

  return (
    <div className="editor-pane">
      <div className="editor-status">
        <span className={`conn conn-${connState}`}>
          {connState === "connected" ? (editable ? "live" : "live · read-only") : connState}
        </span>
        {peers.length > 0 && (
          <span className="peers">
            {peers.map((name) => (
              <span className="peer" key={name} style={{ borderColor: colorFor(name) }}>
                {name}
              </span>
            ))}
          </span>
        )}
      </div>
      {connState === "denied" ? (
        <p className="notice">This link doesn't grant access to this document.</p>
      ) : (
        <EditorContent editor={editor} className="editor-content" />
      )}
    </div>
  );
}
