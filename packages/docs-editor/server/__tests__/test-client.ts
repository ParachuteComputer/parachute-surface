/**
 * A minimal in-process Hocuspocus client + fake host pump for the collab
 * integration tests.
 *
 * The pump mirrors the host's WS contract exactly (backend-ws.ts): ONE
 * stable SurfaceSocket per connection, binary frames as exact-bounds
 * Uint8Arrays, server-initiated closes pumped back into the backend's
 * close handler — so the suite exercises the same wiring the daemon runs.
 *
 * The client speaks the real wire protocol (the same bytes
 * `@hocuspocus/provider` 4.1.1 sends): every message is enveloped
 * `varString(documentName) · varUint(messageType) · payload`, with Auth
 * first (`varUint(0 = Token) · varString(token) · varString(version)`),
 * then y-protocols sync + awareness.
 */

import type { BackendWebSocketHandlers, SurfaceSocket } from "@openparachute/surface";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/** Hocuspocus envelope message types (server/src/types.ts). */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_AUTH = 2;
const MESSAGE_CLOSE = 7;

/** Auth sub-message types (@hocuspocus/common auth.ts). */
const AUTH_TOKEN = 0;
const AUTH_PERMISSION_DENIED = 1;
const AUTH_AUTHENTICATED = 2;

let socketCounter = 0;

/**
 * One fake connection: the SurfaceSocket the backend sees + the delivery
 * loop to the client. Mirrors backend-ws's stable-wrapper contract.
 */
export class FakeConnection {
  readonly socket: SurfaceSocket;
  #readyState = 1;
  #closedByServer: { code?: number; reason?: string } | null = null;
  readonly #backend: BackendWebSocketHandlers;
  readonly #deliver: (data: Uint8Array) => void;

  constructor(backend: BackendWebSocketHandlers, deliver: (data: Uint8Array) => void) {
    this.#backend = backend;
    this.#deliver = deliver;
    const self = this;
    this.socket = {
      send(data: string | Uint8Array) {
        if (self.#readyState !== 1) return;
        if (typeof data === "string") throw new Error("test pump: binary frames only");
        // Copy — a real network frame never aliases server memory.
        queueMicrotask(() => self.#deliver(new Uint8Array(data)));
      },
      close(code?: number, reason?: string) {
        if (self.#readyState >= 2) return;
        self.#readyState = 3;
        self.#closedByServer = { code, reason };
        // A server-side close surfaces as a close event, like a real socket.
        queueMicrotask(() => self.#backend.close?.(self.socket, code ?? 1000, reason ?? ""));
      },
      get readyState() {
        return self.#readyState;
      },
      data: {
        surface: "docs",
        layer: "public",
        clientIp: "203.0.113.7",
        socketId: `test-sock-${++socketCounter}`,
      },
    };
  }

  get closedByServer(): { code?: number; reason?: string } | null {
    return this.#closedByServer;
  }

  open(): void {
    this.#backend.open?.(this.socket);
  }

  /** Client → server. */
  sendToServer(data: Uint8Array): void {
    if (this.#readyState !== 1) return;
    this.#backend.message?.(this.socket, data);
  }

  /** Client-initiated close. */
  close(code = 1000, reason = "client closed"): void {
    if (this.#readyState >= 2) return;
    this.#readyState = 3;
    this.#backend.close?.(this.socket, code, reason);
  }
}

export type AuthState = "pending" | "authenticated" | "denied";

/** An in-process collaborator on one document. */
export class CollabTestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly documentName: string;
  authState: AuthState = "pending";
  /** Server-granted scope from the Authenticated reply ("read-write" | "readonly"). */
  scope: string | null = null;
  denyReason: string | null = null;
  /** Reason from a server-sent protocol CLOSE message (Connection.close). */
  serverClosedReason: string | null = null;
  readonly #token: string;
  #connection: FakeConnection | null = null;

  constructor(documentName: string, token: string) {
    this.documentName = documentName;
    this.#token = token;
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      // Local edits ride to the server; remote applies (origin === this)
      // don't echo back.
      if (origin === this) return;
      if (this.authState !== "authenticated") return;
      const encoder = this.#envelope(MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.#send(encoder);
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      if (origin === this) return;
      if (this.authState !== "authenticated") return;
      const changed = [...added, ...updated, ...removed];
      const encoder = this.#envelope(MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
      this.#send(encoder);
    });
  }

  /** Wire to a backend through a fresh fake connection and authenticate. */
  connect(backend: BackendWebSocketHandlers): FakeConnection {
    const connection = new FakeConnection(backend, (data) => this.#receive(data));
    this.#connection = connection;
    connection.open();
    // Auth message first — the engine queues everything else until it lands.
    const encoder = this.#envelope(MESSAGE_AUTH);
    encoding.writeVarUint(encoder, AUTH_TOKEN);
    encoding.writeVarString(encoder, this.#token);
    encoding.writeVarString(encoder, "test-client");
    this.#send(encoder);
    return connection;
  }

  /** The doc's root fragment as XML-ish text (convergence probes). */
  fragmentText(): string {
    return this.doc.getXmlFragment("default").toString();
  }

  /** Append a paragraph the way an editor binding would. */
  appendParagraph(text: string): void {
    const fragment = this.doc.getXmlFragment("default");
    this.doc.transact(() => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(text)]);
      fragment.insert(fragment.length, [paragraph]);
    });
  }

  setPresence(name: string): void {
    this.awareness.setLocalStateField("user", { name });
  }

  /** Awareness states visible to this client (incl. its own). */
  presenceNames(): string[] {
    const names: string[] = [];
    for (const state of this.awareness.getStates().values()) {
      const user = (state as { user?: { name?: string } }).user;
      if (user?.name) names.push(user.name);
    }
    return names.sort();
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
  }

  #envelope(type: number): encoding.Encoder {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, this.documentName);
    encoding.writeVarUint(encoder, type);
    return encoder;
  }

  #send(encoder: encoding.Encoder): void {
    this.#connection?.sendToServer(encoding.toUint8Array(encoder));
  }

  #receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    decoding.readVarString(decoder); // documentName (single-doc client)
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case MESSAGE_AUTH: {
        const sub = decoding.readVarUint(decoder);
        if (sub === AUTH_AUTHENTICATED) {
          this.authState = "authenticated";
          this.scope = decoding.readVarString(decoder);
          // Provider behavior on authenticated: start sync + announce
          // awareness.
          const sync = this.#envelope(MESSAGE_SYNC);
          syncProtocol.writeSyncStep1(sync, this.doc);
          this.#send(sync);
          if (this.awareness.getLocalState() !== null) {
            const aw = this.#envelope(MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(
              aw,
              awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
            );
            this.#send(aw);
          }
        } else if (sub === AUTH_PERMISSION_DENIED) {
          this.authState = "denied";
          this.denyReason = decoding.readVarString(decoder);
        }
        break;
      }
      case MESSAGE_SYNC: {
        const reply = this.#envelope(MESSAGE_SYNC);
        const before = encoding.length(reply);
        syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
        if (encoding.length(reply) > before) this.#send(reply);
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        break;
      }
      case MESSAGE_CLOSE: {
        // The engine's Connection.close sends a protocol-level Close
        // message (it never closes the raw socket itself); the real
        // provider reacts by closing the connection — mirror that.
        this.serverClosedReason = decoding.readVarString(decoder);
        this.disconnect();
        break;
      }
      default:
        // SyncStatus / Stateless — irrelevant to these tests.
        break;
    }
  }
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
