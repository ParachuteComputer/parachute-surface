/**
 * A minimal in-process Streamable-HTTP MCP hub for the bridge tests.
 *
 * Speaks the same dialect as the real hub door (`parachute-hub`
 * src/account-mcp-http.ts): JSON-response mode POSTs, 202 for notifications,
 * 405 for GET, 200 for DELETE — and, crucially, it ASSERTS a valid NIP-98
 * `Authorization: Nostr <b64>` on EVERY request with a fresh (never-seen)
 * event id, mirroring the hub's replay cache that burns ids even on failed
 * auth. Auth violations are recorded, not thrown, so a test can make
 * assertions about the whole session at the end.
 *
 * Optionally issues `Mcp-Session-Id` on initialize and answers 404 once the
 * session is expired — the Streamable-HTTP expiry the bridge must survive.
 */
import { verifyEvent } from "nostr-tools/pure";
import { NIP98_KIND, decodeAuthHeader, sha256Hex, tagValue } from "../nip98.js";

export interface StubTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface StubHubOptions {
  label: string;
  tools: StubTool[];
  /** Issue + require Mcp-Session-Id (the real hub door is stateless). */
  sessions?: boolean;
  /** Bind this exact port (default: any free port). */
  port?: number;
  /** Expected signer pubkey (hex); mismatches are recorded as violations. */
  expectPubkey?: string;
  /**
   * Answer a `tools/call` with vault-shaped semantics. Return an MCP tool
   * RESULT (`{ content, isError? }`) to take over the call, or undefined to
   * fall through to the default echo. Used by the `doctor` integration test,
   * which needs a hub that really stores and returns a note.
   */
  handleCall?: (tool: string, args: Record<string, unknown>) => unknown | undefined;
  /**
   * Answer `GET /api/channel-vault?relay=&channel=` the way parachute-hub does
   * (`api-channel-vaults.ts`, hub#947): return a binding for 200
   * `{vault, mode, synced_at}`, or `null` for the route's own 404
   * `{"error":"not_found"}`.
   *
   * LEAVE IT UNSET to model a hub that predates the route — the GET then falls
   * through to the plain 405/404 an older hub gives, which is the case the
   * connector must not read as "this channel is unbound".
   */
  channelVault?: (
    relay: string | null,
    channel: string | null,
  ) => { vault: string; mode?: string; synced_at?: string | null } | null;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
}

export class StubHub {
  readonly authViolations: string[] = [];
  readonly seenEventIds = new Set<string>();
  readonly toolCalls: ToolCallRecord[] = [];
  readonly issuedSessions: string[] = [];
  /** Every HTTP method seen, in order — lets a test assert the session DELETE. */
  readonly methods: string[] = [];
  /** Requests that carried an Authorization header (each must sign fresh). */
  authedRequests = 0;
  /** Every `/api/channel-vault` query, in order. */
  readonly channelVaultQueries: Array<{ relay: string | null; channel: string | null }> = [];

  private readonly liveSessions = new Set<string>();
  private server: ReturnType<typeof Bun.serve>;

  constructor(private readonly opts: StubHubOptions) {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: opts.port ?? 0,
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}/mcp`;
  }

  /** Forget every live session: the next request with an old id gets a 404. */
  expireSessions(): void {
    this.liveSessions.clear();
  }

  stop(): void {
    this.server.stop(true);
  }

  private violation(msg: string): void {
    this.authViolations.push(`[${this.opts.label}] ${msg}`);
  }

  /** NIP-98 checks in the same order as the hub's verifyNostrHttpEvent. */
  private checkAuth(req: Request, body: Uint8Array): void {
    this.authedRequests++;
    const header = req.headers.get("authorization");
    if (!header || !/^Nostr\s+\S+$/i.test(header)) {
      this.violation(`${req.method}: missing/malformed Nostr authorization`);
      return;
    }
    let event: ReturnType<typeof decodeAuthHeader>;
    try {
      event = decodeAuthHeader(header);
    } catch {
      this.violation(`${req.method}: authorization does not decode`);
      return;
    }
    if (!verifyEvent(event)) this.violation(`${req.method}: bad signature`);
    if (event.kind !== NIP98_KIND) this.violation(`${req.method}: kind ${event.kind}`);
    if (this.opts.expectPubkey && event.pubkey !== this.opts.expectPubkey) {
      this.violation(`${req.method}: unexpected signer`);
    }
    // Replay-cache semantics: ids burn on sight, so every request must be a
    // freshly signed event — the retry-with-a-reused-header failure mode.
    if (this.seenEventIds.has(event.id)) {
      this.violation(`${req.method}: event id reused (${event.id.slice(0, 8)}…)`);
    }
    this.seenEventIds.add(event.id);
    if (tagValue(event, "u") !== req.url) {
      this.violation(`${req.method}: u tag ${tagValue(event, "u")} != ${req.url}`);
    }
    if (tagValue(event, "method")?.toUpperCase() !== req.method.toUpperCase()) {
      this.violation(`${req.method}: method tag mismatch`);
    }
    if (!tagValue(event, "nonce")) this.violation(`${req.method}: no nonce tag`);
    const payload = tagValue(event, "payload");
    if (body.byteLength === 0) {
      if (payload) this.violation(`${req.method}: payload tag on empty body`);
    } else if (payload !== sha256Hex(body)) {
      this.violation(`${req.method}: payload hash mismatch`);
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - event.created_at);
    if (skew > 60) this.violation(`${req.method}: created_at skew ${skew}s`);
  }

  private async handle(req: Request): Promise<Response> {
    this.methods.push(req.method);
    const body =
      req.method === "GET" || req.method === "DELETE"
        ? new Uint8Array()
        : new Uint8Array(await req.arrayBuffer());
    this.checkAuth(req, body);

    if (req.method === "DELETE") return new Response(null, { status: 200 });

    // The REST read side, beside the MCP door. Authenticated only (a vault
    // name is not a secret), like the real hub.
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/channel-vault") {
      const relay = url.searchParams.get("relay");
      const channel = url.searchParams.get("channel");
      this.channelVaultQueries.push({ relay, channel });
      if (!this.opts.channelVault) {
        // An older hub has no such route: its dispatch falls through to the
        // generic plain-text 404.
        return new Response("not found", { status: 404 });
      }
      if (!relay || !channel) {
        return Response.json(
          { error: "invalid_request", error_description: "`relay` and `channel` are required" },
          { status: 400 },
        );
      }
      const binding = this.opts.channelVault(relay, channel);
      if (!binding) {
        return Response.json(
          { error: "not_found", error_description: "no vault is attached to that channel" },
          { status: 404 },
        );
      }
      return Response.json(
        {
          vault: binding.vault,
          mode: binding.mode ?? "sync",
          synced_at: binding.synced_at ?? null,
        },
        { status: 200 },
      );
    }

    if (req.method !== "POST") {
      // Mirrors the hub door: no server-initiated SSE stream.
      return new Response(null, { status: 405 });
    }

    const message = JSON.parse(new TextDecoder().decode(body)) as {
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    };

    const headers = new Headers({ "content-type": "application/json" });

    if (this.opts.sessions) {
      if (message.method === "initialize") {
        const id = `sess-${this.issuedSessions.length + 1}`;
        this.issuedSessions.push(id);
        this.liveSessions.add(id);
        headers.set("mcp-session-id", id);
      } else {
        const sess = req.headers.get("mcp-session-id");
        if (!sess || !this.liveSessions.has(sess)) {
          // Streamable HTTP: unknown/expired session → 404, client must
          // re-initialize.
          return new Response("session not found", { status: 404 });
        }
        headers.set("mcp-session-id", sess);
      }
    }

    // Notification (no id) → 202 with no body.
    if (message.id === undefined || message.id === null) {
      return new Response(null, { status: 202, headers });
    }

    const respond = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        status: 200,
        headers,
      });

    switch (message.method) {
      case "initialize":
        return respond({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `stub-${this.opts.label}`, version: "0.0.0" },
        });
      case "tools/list":
        return respond({ tools: this.opts.tools });
      case "tools/call": {
        const tool = String(message.params?.name ?? "");
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        this.toolCalls.push({ tool, args });
        let custom: unknown;
        try {
          custom = this.opts.handleCall?.(tool, args);
        } catch (err) {
          // The real MCP SDK server (protocol.js `_onrequest`) catches ANY
          // exception a request handler throws and turns it into a JSON-RPC
          // PROTOCOL error, not an `isError` tool result and never a crash —
          // that's how a vault-side bug (an uncaught TypeError deep in a tool
          // handler, e.g. surface#236) actually reaches this client. A
          // `handleCall` that throws models that path.
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            }),
            { status: 200, headers },
          );
        }
        if (custom !== undefined) return respond(custom);
        if (!this.opts.tools.some((t) => t.name === tool)) {
          return respond({
            content: [{ type: "text", text: `Unknown tool: ${tool}` }],
            isError: true,
          });
        }
        return respond({
          content: [{ type: "text", text: JSON.stringify({ hub: this.opts.label, tool, args }) }],
        });
      }
      case "ping":
        return respond({});
      default:
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          }),
          { status: 200, headers },
        );
    }
  }
}

/** Grab a free loopback port by binding and immediately releasing it. */
export function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  return port;
}
