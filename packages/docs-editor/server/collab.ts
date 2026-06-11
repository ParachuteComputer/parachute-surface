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
  type Connection,
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
import {
  type Actor,
  type SurfaceAuthz,
  type VaultReconciler,
  isVaultNotFound,
} from "@openparachute/surface-server";
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

  /** One live, authenticated document connection. */
  interface CollabSession {
    documentName: string;
    actor: Actor;
    /** edit_content verdict at auth time — a change forces re-auth. */
    writable: boolean;
    connection: Connection<CollabContext>;
  }

  // socketId + documentName → session. The ONLY mutable disconnect
  // bookkeeping; keyed so the upstream double-onDisconnect dedupes.
  const sessions = new Map<string, CollabSession>();

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
      // Explicit not-found handling: Hocuspocus's outer catch would also
      // collapse a VaultNotFoundError throw to "permission-denied" (verified
      // against the 4.1.1 dist), but relying on that couples our no-oracle
      // property to an upstream error path — convert it ourselves.
      let note: Awaited<ReturnType<typeof ctx.vault.getNote>>;
      try {
        note = await ctx.vault.getNote(data.documentName);
      } catch (err) {
        if (isVaultNotFound(err)) throw new Error("document access denied");
        throw err;
      }
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
      // If unload() itself throws (vault write failure on the final
      // flush), the exception escapes this hook: Hocuspocus aborts the
      // unload (doc stays mapped) and the reconciler owns its own
      // partial-unload recovery — the re-adopt below is only for the
      // clean-unload + raced-connection case.
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
      const actor = data.context.actor;
      if (actor === undefined) return; // unreachable: onAuthenticate gates
      sessions.set(sessionKey(data.socketId, data.documentName), {
        documentName: data.documentName,
        actor,
        writable: data.connectionConfig.readOnly !== true,
        connection: data.connection,
      });
    },

    async onDisconnect(data: onDisconnectPayload<CollabContext>): Promise<void> {
      // IDEMPOTENT by construction: the second upstream invocation finds
      // the key already deleted and does nothing.
      sessions.delete(sessionKey(data.socketId, data.documentName));
    },
  });

  // LONG-LIVED AUTHORIZATION: the HTTP plane re-resolves grants on every
  // request, but a WS connection authenticates ONCE — without this, a
  // revoked collaborator keeps editing until they disconnect. The
  // GrantStore's onChange seam (SSE-fed + local optimistic mutations)
  // triggers a sweep of every live AUDIENCE session (the operator never
  // consults grants): any session whose read access is gone — or whose
  // write verdict changed — is closed, forcing re-auth on reconnect with
  // a fresh ticket. Single-flight with a re-queue bit so a burst of
  // grant changes costs one sweep.
  let sweeping = false;
  let sweepQueued = false;
  const sweepSessions = async (): Promise<void> => {
    if (sweeping) {
      sweepQueued = true;
      return;
    }
    sweeping = true;
    try {
      do {
        sweepQueued = false;
        for (const [key, session] of [...sessions]) {
          if (session.actor.kind === "operator") continue;
          if (!sessions.has(key)) continue; // disconnected mid-sweep
          let allowed = false;
          let writable = false;
          try {
            const note = await ctx.vault.getNote(session.documentName);
            if (note !== null && Array.isArray(note.tags) && note.tags.includes(workingTag)) {
              allowed = await authz.can(session.actor, note, "read");
              writable = allowed && (await authz.can(session.actor, note, "edit_content"));
            }
          } catch (err) {
            // Transient vault failure: the GrantStore already fails
            // closed on its own plane; killing every live session here
            // would be a self-DoS. Keep it — the next change re-sweeps.
            ctx.log.warn(
              `collab: re-auth sweep for ${session.documentName} failed (${(err as Error).message ?? err})`,
            );
            continue;
          }
          // `writable !== session.writable` includes UPGRADES (view->edit):
          // close + force re-auth so the connection picks up its new
          // readOnly flag — in-place mutation of a live engine connection
          // has no supported seam.
          if (!allowed || writable !== session.writable) {
            sessions.delete(key);
            try {
              // Generic reason — revoked and never-granted look alike.
              session.connection.close({ code: 1008, reason: "permission changed" });
            } catch {
              // already closing
            }
          }
        }
      } while (sweepQueued);
    } finally {
      sweeping = false;
    }
  };
  const detachGrantWatch = authz.grants.onChange(() => {
    void sweepSessions();
  });

  // USER-FACING RESYNC SIGNAL: when an external vault edit wins (live
  // re-seed) or a writeback 409s into a re-seed, connected clients see
  // their content replaced under them — tell them why. The engine's
  // stateless channel carries a tiny JSON payload the editor turns into
  // a banner; documents nobody has open need no signal.
  const detachReconcilerWatch = reconciler.on((event) => {
    if (event.type !== "external-edit" && event.type !== "writeback-conflict") return;
    const document = hocuspocus.documents.get(event.noteId);
    document?.broadcastStateless(JSON.stringify({ type: "resync", reason: event.type }));
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
      for (const session of sessions.values()) {
        counts[session.documentName] = (counts[session.documentName] ?? 0) + 1;
      }
      return counts;
    },
    async shutdown(): Promise<void> {
      detachGrantWatch();
      detachReconcilerWatch();
      for (const [ws, connection] of connections) {
        connection.handleClose({ code: 1001, reason: "surface shutting down" });
        try {
          // handleClose tears down ENGINE state; the raw socket is the
          // host's — close it too so no client lingers on a dead backend.
          ws.close(1001, "surface shutting down");
        } catch {
          // already closing
        }
      }
      connections.clear();
      sessions.clear();
      // Run any still-debounced store now; the reconciler's stop() (the
      // factory calls it after this) is the final backstop.
      hocuspocus.flushPendingStores();
    },
  };
}
