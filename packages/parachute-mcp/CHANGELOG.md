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
