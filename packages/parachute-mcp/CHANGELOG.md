# Changelog — @openparachute/mcp

## 0.1.0

Initial release — the official replacement for hand-built per-agent loopback
signing proxies (nip98-proxy shape): a stdio MCP bridge that signs every HTTP
request to a Parachute hub's Streamable-HTTP MCP door as a NIP-98 Nostr auth
event.

- `parachute-mcp` bin: stdio MCP server bridging one or more remote hubs.
- Per-request NIP-98 signing via the SDK transport's custom `fetch` — fresh
  random nonce + fresh `created_at` on EVERY request including retries (the
  hub burns event ids even on failed auth); `u` tag = the exact hub URL.
- One key, many hubs: single hub → tool names pass through unchanged;
  multiple hubs → `<alias>__<tool>` namespacing with prefix routing.
  Descriptions and input schemas pass through verbatim.
- Config: `--config` → `PARACHUTE_MCP_CONFIG` → `~/.config/parachute/mcp.json`
  → single-hub positional-URL quick path; `~` expansion.
- Key resolution: config `keyFile` → `PARACHUTE_NSEC_FILE` (a file path,
  overrides `keyFile`) → `BUZZ_PRIVATE_KEY` (a bech32 nsec *value*, used only
  when no key file is resolved). The `BUZZ_PRIVATE_KEY` fallback is a deliberate
  exception to the file-only stance: `buzz-acp` already injects each agent's own
  key into the MCP subprocess env, so a Buzz agent needs no key file (just a hub
  URL) and it is per-agent (no shared-key foot-gun). Key material is never argv
  and never echoed by error paths.
- Resilience: a hub down at startup is logged (stderr only; stdout is the MCP
  wire) and retried lazily; Streamable-HTTP session expiry (404) →
  re-initialize + retry once.
- `--version`, and a startup stderr line naming the signing npub (never the
  key) and hub aliases.
- Tools only in v1; resources/prompts passthrough is a README TODO.
