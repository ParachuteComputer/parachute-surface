# Changelog — @openparachute/mcp

## Unreleased

- **A CLI face on the same binary**, for agents that shell out instead of
  running an MCP client (they were hand-rolling NIP-98 signing — a Python
  re-implementation, a shell wrapper — to reach the same hubs). One artifact
  now serves both shapes, over the same config resolution, the same key
  resolution and the same signing code:
  - `parachute-mcp tools [--hub <alias|url>] [--table]` — list the hubs' tools
    as JSON (name + description) or a compact table. Several hubs and no
    `--hub` → the bridge's `<alias>__<tool>` namespacing, so a name printed
    here is a name `call` accepts.
  - `parachute-mcp call <tool> [<json-args>] [--args -] [--hub <alias|url>]` —
    one signed `tools/call`. A single text result prints as-is, anything else
    as the JSON result. `--args -` reads the arguments from stdin, because
    nested-shell JSON quoting is the most common way an agent's call goes
    wrong.
  - `parachute-mcp http <METHOD> <url> [--body -] [-H 'Name: value']…` — a
    signed curl for hub endpoints that are not tool calls. Response body to
    stdout, status line and headers to stderr. The request body comes from
    **stdin only** (never argv, which `ps` exposes); the `payload` tag is
    present iff the body is non-empty; redirects are not followed, since the
    signature pins one exact URL.
- Exit-code contract shared by all three, documented in `--help` and the
  README: `0` ok, `1` usage/config, `2` network/transport, `3` auth
  (HTTP 401/403), `4` the tool returned `isError`.
- Bridge mode is unchanged — the subcommands are dispatched only when argv[0]
  is `tools`, `call` or `http`, and no hub URL can be one of those words.
  `--version` is unchanged; `--help` gains the subcommands and exit codes.

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
