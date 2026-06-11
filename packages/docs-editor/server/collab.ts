/**
 * The collab loop — Hocuspocus ENGINE CLASS under Bun, manually pumped
 * (design appendix "Resolved: Hocuspocus under Bun"; verified on
 * Bun 1.3.13 + @hocuspocus/server 4.1.1 — re-verify this wiring on any
 * upgrade of either).
 *
 * The wiring contract, as built:
 *
 *   - NEVER `Server` / `listen()`: `new Hocuspocus(...)` only. The host
 *     owns the port; the hub's WS bridge (H1) forwards upgrades to
 *     `${mount}/ws`, the host pumps frames into the backend's
 *     `websocket` handlers (P4), and these handlers pump into the engine:
 *     `handleConnection` on open → `ClientConnection.handleMessage` per
 *     binary frame → `handleClose` on close. One endpoint, all docs —
 *     document routing rides the message envelope.
 *   - The host's `SurfaceSocket` is the engine's `WebSocketLike`
 *     (`send`/`close`/`readyState`) — wrapper identity is stable per
 *     connection (host contract), so a plain Map keys connection state.
 *   - **documentName = note id** (reconciler rule). `onLoadDocument`
 *     hands the engine's Y.Doc to `reconciler.load` for adoption; the
 *     reconciler owns seeding, writeback (`if_updated_at`, never force)
 *     and external-edit re-seeds from there.
 *
 * AUTH — one connection authorizer, per DOCUMENT: every doc a connection
 * opens sends a Hocuspocus Auth message whose token is a single-use
 * TICKET minted over the HTTP gateway (see tickets.ts — same P7 actor
 * resolution as every route; hub JWTs and capability secrets never ride
 * the WS). `onAuthenticate` redeems it, requires `read` on the backing
 * note, and maps `edit_content` → write access (Hocuspocus `readOnly`
 * enforces structurally: a read-only connection's Sync updates are
 * rejected by the engine, never applied). No grant → indistinguishable
 * refusal (permission-denied), matching the gateway's no-existence-oracle
 * posture.
 *
 * DISCONNECT IDEMPOTENCY (the R6 requirement): upstream Hocuspocus 4.1.1
 * fires `onDisconnect` TWICE when the departing client had awareness
 * state (`Document.removeConnection` broadcasts to the dying socket
 * before deleting it; the failed send re-enters close). All disconnect
 * bookkeeping here dedupes on `socketId + documentName` — the presence
 * registry can't double-decrement, test-pinned.
 */

import {
  Hocuspocus,
  type WebSocketLike,
  type connectedPayload,
  type onAuthenticatePayload,
  type onDisconnectPayload,
} from "@hocuspocus/server";

/** The engine's per-connection handle (not re-exported by the package). */
type ClientConnection = ReturnType<Hocuspocus["handleConnection"]>;
import type { SurfaceHostContext } from "@openparachute/surface";
import type { BackendWebSocketHandlers, SurfaceSocket } from "@openparachute/surface";
import type { Actor, SurfaceAuthz, VaultReconciler } from "@openparachute/surface-server";
import type { TicketStore } from "./tickets.ts";

export interface CollabDeps {
  ctx: SurfaceHostContext;
  authz: SurfaceAuthz;
  reconciler: VaultReconciler;
  tickets: TicketStore;
  /**
   * The surface's working tag. Collab is REFUSED for notes outside it:
   * the reconciler's watch is tag-scoped, so a tracked-but-untagged note
   * would collaborate fine until the first SSE snapshot — which treats
   * it as REMOVED and silently drops its state without flushing.
   */
  workingTag: string;
}

/** What the backend factory mounts. */
export interface Collab {
  /** Plug into `SurfaceBackend.websocket`. */
  websocket: BackendWebSocketHandlers;
  /** Live presence: documentName → number of connected sessions. */
  presence(): Record<string, number>;
  /** Close every connection and drop engine state (bounded). */
  shutdown(): Promise<void>;
  /** The engine — exposed for tests only. */
  readonly engine: Hocuspocus;
}

/** Context attached to each authenticated document connection. */
interface CollabContext {
  actor?: Actor;
}

export function createCollab(deps: CollabDeps): Collab {
  const { ctx, authz, reconciler, tickets, workingTag } = deps;

  // socketId + documentName → present. The ONLY mutable disconnect
  // bookkeeping; keyed so the upstream double-onDisconnect dedupes.
  const sessions = new Map<string, string>(); // key → documentName

  const sessionKey = (socketId: string, documentName: string): string =>
    `${socketId}\0${documentName}`;

  const hocuspocus = new Hocuspocus({
    quiet: true,

    async onAuthenticate(data: onAuthenticatePayload<CollabContext>): Promise<CollabContext> {
      const actor = tickets.redeem(data.token);
      if (actor === null) {
        // Unknown, expired, and reused tickets all look alike.
        throw new Error("invalid ticket");
      }
      const note = await ctx.vault.getNote(data.documentName);
      // Missing, OUT-OF-SCOPE (not carrying the working tag — see
      // CollabDeps.workingTag for why that would lose edits), and denied
      // are the SAME refusal — no existence oracle.
      if (
        note === null ||
        !(Array.isArray(note.tags) && note.tags.includes(workingTag)) ||
        !(await authz.can(actor, note, "read"))
      ) {
        throw new Error("document access denied");
      }
      const writable = await authz.can(actor, note, "edit_content");
      data.connectionConfig.readOnly = !writable;
      return { actor };
    },

    async onLoadDocument(data): Promise<void> {
      // Adopt the engine's Y.Doc instance; the reconciler seeds it from
      // the vault note (or its persisted snapshot) and owns it from here.
      await reconciler.load(data.documentName, data.document);
    },

    async onStoreDocument(data): Promise<void> {
      // The engine's store moments (debounced; executed immediately on
      // last disconnect) flush the reconciler's pending writeback. The
      // reconciler's own debounce covers steady-state; flush is a no-op
      // when nothing is dirty.
      await reconciler.flush(data.documentName);
    },

    async beforeUnloadDocument(data): Promise<void> {
      // A live connection means this unload is already doomed — the
      // engine re-checks getConnectionsCount() AFTER this hook and aborts
      // (Hocuspocus 4.1.1, verified against the installed dist). Throwing
      // aborts it EARLY and keeps the reconciler attached, instead of a
      // pointless flush → detach → re-adopt churn.
      if (data.document.getConnectionsCount() > 0) {
        throw new Error("connections present — unload aborted");
      }
      // Before the engine destroys the Y.Doc: final flush + snapshot
      // persist + drop live tracking. (After reconciler.stop() this is a
      // no-op — tracking is already gone.)
      await reconciler.unload(data.documentName);
      // A connection may have raced in DURING the unload's vault round
      // trip: createDocument returns the still-mapped doc WITHOUT
      // re-firing onLoadDocument, and the engine's post-hook re-check
      // aborts the unload — leaving a live doc the reconciler has already
      // detached from (edits would never write back; state destroyed at
      // the final unload). Re-adopt it. The restored baseline is the
      // just-persisted snapshot; any edit that landed inside this window
      // rides out with the next flush (serialize covers the full doc).
      if (data.document.getConnectionsCount() > 0) {
        await reconciler.load(data.documentName, data.document);
      }
    },

    async connected(data: connectedPayload<CollabContext>): Promise<void> {
      sessions.set(sessionKey(data.socketId, data.documentName), data.documentName);
    },

    async onDisconnect(data: onDisconnectPayload<CollabContext>): Promise<void> {
      // IDEMPOTENT by construction: the second upstream invocation finds
      // the key already deleted and does nothing.
      sessions.delete(sessionKey(data.socketId, data.documentName));
    },
  });

  // Stable SurfaceSocket identity (host contract) keys the engine's
  // per-connection handle.
  const connections = new Map<SurfaceSocket, ClientConnection>();

  /** SurfaceSocket → the engine's WebSocketLike (send/close/readyState). */
  const wsLike = (ws: SurfaceSocket): WebSocketLike => ({
    send: (data) => {
      ws.send(data as Uint8Array);
    },
    close: (code?: number, reason?: string) => {
      ws.close(code, reason);
    },
    get readyState() {
      return ws.readyState;
    },
  });

  const websocket: BackendWebSocketHandlers = {
    open(ws) {
      // The host hands trust signals, not the upgrade Request; auth rides
      // the protocol's ticket. A synthetic Request satisfies the engine's
      // parameter probing (`getParameters` handles web-Request URLs).
      const request = new Request(`http://surface.internal${ctx.mount}/ws`);
      connections.set(ws, hocuspocus.handleConnection(wsLike(ws), request, {}));
    },
    message(ws, message) {
      if (typeof message === "string") {
        // Binary protocol only — a text frame is a protocol violation.
        ws.close(1003, "binary protocol required");
        return;
      }
      connections.get(ws)?.handleMessage(message);
    },
    close(ws, code, reason) {
      connections.get(ws)?.handleClose({ code, reason });
      connections.delete(ws);
    },
  };

  return {
    websocket,
    engine: hocuspocus,
    presence(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const documentName of sessions.values()) {
        counts[documentName] = (counts[documentName] ?? 0) + 1;
      }
      return counts;
    },
    async shutdown(): Promise<void> {
      for (const connection of connections.values()) {
        connection.handleClose({ code: 1001, reason: "surface shutting down" });
      }
      connections.clear();
      sessions.clear();
      // Run any still-debounced store now; the reconciler's stop() (the
      // factory calls it after this) is the final backstop.
      hocuspocus.flushPendingStores();
    },
  };
}
