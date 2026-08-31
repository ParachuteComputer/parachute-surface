/**
 * The stdio-facing MCP server: a thin shell over ParachuteBridge. Tools only
 * in v1 — resources/prompts passthrough is a README TODO.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ParachuteBridge } from "./bridge.js";
import { PARACHUTE_MCP_VERSION } from "./version.js";

export function createBridgeServer(bridge: ParachuteBridge): Server {
  const server = new Server(
    { name: "parachute-mcp", version: PARACHUTE_MCP_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await bridge.listTools(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    bridge.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  return server;
}
