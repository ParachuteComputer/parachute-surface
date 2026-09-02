# Changelog — @openparachute/mcp

## Unreleased

- **Single-file executables.** `bun run build:binaries`
  (`scripts/build-binaries.ts`) cross-compiles `dist/cli.js` with
  `bun build --compile` for linux-x64, linux-arm64, darwin-arm64 and
  darwin-x64, emitting `release/parachute-mcp-<version>-<os>-<arch>` plus a
  `SHA256SUMS` file. The version is compiled in (the script runs the package
  build first, whose `prebuild` regenerates `src/version.ts`), so
  `--version` prints the package version with nothing to read at runtime.
  Motivation: agent sandboxes with no Node runtime and no npm egress, where an
  `npx` MCP command turns every boot into a registry call — one hiccup and the
  harness crash-loops.
- The compile disables Bun's `.env` and `bunfig.toml` autoload
  (`--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`). Both
  default to ON for standalone binaries and read the **process cwd**, so a
  `.env` in whatever directory a harness launched from could set
  `PARACHUTE_NSEC_FILE` and redirect which key the bridge signs with — a hole
  the Node path does not have. Explicit env vars, `--config` and the config
  file are unaffected.
- `release.yml`: `release-mcp-binaries` builds those binaries (all targets from
  one Linux runner, then executes the linux-x64 one and asserts on the version
  it prints) and attaches them to the GitHub Release for `mcp-v<version>`, on
  the tag path and on the publish-on-merge path alike.
- `release.yml`: `publish-mcp-npm` publishes `@openparachute/mcp` to npm via
  OIDC trusted publishing, mirroring the sibling packages (version-matches-tag
  guard, `workspace:`/`link:` protocol guard, dist-tag from the version being
  published). `mcp-v` is now wired into `plan` / `tag-record`, so a version
  bump on `main` cuts the tag like every other package.
- `invokedAsEntry()` no longer answers "not the entry point" inside a compiled
  binary: `bun build --compile` runs from a virtual filesystem (`/$bunfs/…`)
  where `realpathSync` throws for both sides of the comparison, so the binary
  booted, matched nothing, and exited 0 in silence. It now falls back to
  comparing the unresolved paths.

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
- Global flags may go **before or after** the subcommand
  (`parachute-mcp --config c.json tools`, the `git -C` / `docker --host`
  convention), including `--config` and `--timeout`.
- `--timeout <seconds>` (default 60) bounds every request — MCP connect,
  `tools/list`, `tools/call`, the session `DELETE`, and the `http` fetch —
  and exits `2` with a content-free `timed out after Ns`. Without it a hub that
  accepts the connection and never answers hangs the command forever.
- `http`: a `3xx` exits `2` rather than `0`-with-an-empty-body (redirects are
  not followed, so the request was not fulfilled). An invalid `-H` field name
  is a usage error (exit 1) instead of a `TypeError` surfacing as exit 2.
- `tools`: when every hub fails, stdout stays empty instead of printing `[]` —
  which a JSON-consuming agent would read as "this hub has no tools" rather
  than "the hub is unreachable".
- A closed stdout pipe (`parachute-mcp tools | head -1`) exits 0 instead of
  printing an EPIPE stack trace.
- Bridge mode is unchanged — the subcommands are dispatched only when the first
  non-flag argument is `tools`, `call` or `http`, and no hub URL can be one of
  those words. `--version` is unchanged; `--help` gains the subcommands and
  exit codes.

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
