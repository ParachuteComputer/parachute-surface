/**
 * @openparachute/mcp — programmatic surface.
 *
 * The shipped artifact is the `parachute-mcp` bin (src/cli.ts); these exports
 * exist for tests and for embedding the bridge in another process.
 */
export { ParachuteBridge, type BridgeStartReport, type Log } from "./bridge.js";
export {
  defaultConfigPath,
  expandTilde,
  isValidAlias,
  resolveConfig,
  resolveKeySource,
  type HubEntry,
  type ResolvedConfig,
} from "./config.js";
export { loadKey, loadKeyValue, parseSecretKey, type LoadedKey } from "./key.js";
export {
  NIP98_KIND,
  buildAuthEvent,
  decodeAuthHeader,
  sha256Hex,
  signAuthHeader,
  tagValue,
} from "./nip98.js";
export { createBridgeServer } from "./server.js";
export { makeSigningFetch } from "./signing-fetch.js";
export { PARACHUTE_MCP_VERSION } from "./version.js";
