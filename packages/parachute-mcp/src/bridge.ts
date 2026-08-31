/**
 * The bridge core: one MCP *client* per configured hub (Streamable HTTP,
 * NIP-98-signing fetch), aggregated behind one MCP *server* surface.
 *
 * - Single hub → tool names pass through unchanged.
 * - Multiple hubs → names are namespaced `<alias>__<tool>` and calls are
 *   routed by prefix. Namespaced names stay inside the MCP tool-name format
 *   (SEP-986: `^[A-Za-z0-9._-]{1,128}$`) because aliases are validated in
 *   config.ts to contain no `__` and no leading/trailing `_`.
 * - A hub that is down does NOT kill the bridge: startup logs the failure to
 *   stderr and carries on with the hubs that answered; every later
 *   tools/list / tools/call retries the dead hub lazily.
 * - Streamable-HTTP session expiry (HTTP 404 against a live session, per the
 *   MCP spec's "the client MUST start a new session") → re-initialize and
 *   retry ONCE. The fresh attempt signs fresh NIP-98 events by construction.
 *
 * Descriptions and input schemas are passed through verbatim (the SDK's
 * result schemas are passthrough, so extra fields like annotations survive).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HubEntry } from "./config.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

const NAMESPACE_SEP = "__";

/** Stderr-only logger — stdout is the MCP wire and must stay clean. */
export type Log = (msg: string) => void;

function isSessionExpiry(err: unknown): boolean {
  // MCP Streamable HTTP: a server that no longer recognizes the session id
  // answers 404 and the client MUST re-initialize. (The Parachute hub door is
  // stateless and never issues a session, so against it this never fires —
  // it matters for other Streamable-HTTP hubs behind this bridge.)
  return err instanceof StreamableHTTPError && err.code === 404;
}

class HubConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    readonly alias: string,
    readonly url: string,
    private readonly signingFetch: FetchLike,
    private readonly log: Log,
  ) {}

  get connected(): boolean {
    return this.client !== null;
  }

  /** Connect (or return the live connection). Coalesces concurrent attempts. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const attempt = (async () => {
      const client = new Client({ name: "parachute-mcp", version: PARACHUTE_MCP_VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        fetch: this.signingFetch,
      });
      try {
        await client.connect(transport);
      } catch (err) {
        await client.close().catch(() => {});
        throw err;
      }
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      this.client = client;
      return client;
    })();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      this.connecting = null;
    }
  }

  /** Drop the current connection so the next use re-initializes. */
  async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => {});
  }

  /**
   * Run `fn` against a connected client; on session expiry, re-initialize
   * and retry exactly once.
   */
  async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } catch (err) {
      if (!isSessionExpiry(err)) throw err;
      this.log(`hub "${this.alias}": session expired (404) — re-initializing and retrying once`);
      await this.reset();
      return await fn(await this.connect());
    }
  }
}

export interface BridgeStartReport {
  connected: string[];
  failed: string[];
}

export class ParachuteBridge {
  private readonly hubs: HubConnection[];
  private readonly log: Log;

  constructor(hubs: HubEntry[], signingFetch: FetchLike, log: Log = () => {}) {
    if (hubs.length === 0) throw new Error("parachute-mcp: no hubs configured");
    this.log = log;
    this.hubs = hubs.map((h) => new HubConnection(h.alias, h.url, signingFetch, log));
  }

  /** Namespacing is on only when more than one hub is configured. */
  get namespaced(): boolean {
    return this.hubs.length > 1;
  }

  get aliases(): string[] {
    return this.hubs.map((h) => h.alias);
  }

  /**
   * Connect to every hub. A hub that is down is reported and left for lazy
   * retry — it never throws, and never kills the hubs that did connect.
   */
  async start(): Promise<BridgeStartReport> {
    const report: BridgeStartReport = { connected: [], failed: [] };
    await Promise.all(
      this.hubs.map(async (hub) => {
        try {
          await hub.connect();
          report.connected.push(hub.alias);
        } catch (err) {
          report.failed.push(hub.alias);
          this.log(
            `hub "${hub.alias}" (${hub.url}) unreachable at startup — will retry on use: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
    return report;
  }

  /**
   * Aggregate tools/list across hubs. A hub that fails to answer is skipped
   * (logged to stderr) rather than failing the whole list; the attempt itself
   * was its lazy reconnect.
   */
  async listTools(): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const hub of this.hubs) {
      let tools: Tool[];
      try {
        tools = await hub.withClient(async (client) => (await client.listTools()).tools);
      } catch (err) {
        this.log(
          `hub "${hub.alias}": tools/list failed — omitting its tools: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const tool of tools) {
        out.push(
          this.namespaced ? { ...tool, name: `${hub.alias}${NAMESPACE_SEP}${tool.name}` } : tool,
        );
      }
    }
    return out;
  }

  /** Route a (possibly namespaced) tool name to its hub + bare tool name. */
  resolve(name: string): { hub: HubConnection; toolName: string } {
    if (!this.namespaced) {
      const hub = this.hubs[0];
      if (!hub) throw new Error("parachute-mcp: no hubs configured");
      return { hub, toolName: name };
    }
    for (const hub of this.hubs) {
      const prefix = `${hub.alias}${NAMESPACE_SEP}`;
      if (name.startsWith(prefix)) return { hub, toolName: name.slice(prefix.length) };
    }
    throw new Error(
      `unknown tool "${name}": expected <alias>${NAMESPACE_SEP}<tool> with alias one of ${this.aliases.map((a) => `"${a}"`).join(", ")}`,
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const { hub, toolName } = this.resolve(name);
    return (await hub.withClient((client) =>
      client.callTool({ name: toolName, arguments: args }),
    )) as CallToolResult;
  }

  /** Close every live hub connection (bridge shutdown). */
  async close(): Promise<void> {
    await Promise.all(this.hubs.map((hub) => hub.reset()));
  }
}
