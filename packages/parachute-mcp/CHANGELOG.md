# Changelog — @openparachute/mcp

## [0.2.0-rc.1] - 2026-09-02

- **`parachute-mcp doctor`** — one command that proves a harness has working
  Parachute access, and names the layer that broke when it doesn't. Four
  checks in dependency order, each PASS/FAIL/SKIP with a one-line reason,
  stopping at the first hard failure: `key` (resolve the signing key exactly as
  bridge mode does; prints the npub, never the secret and never the key file's
  path), `hub` (NIP-98-signed `initialize` + `tools/list`, reporting the tool
  count and the server identity), `vaults` (`list-vaults` — names plus whether
  the grant covers all of the hub's vaults or a listed subset), and `write` (a
  real create → byte-exact read-back → delete round-trip). The exit code alone
  says which layer failed: `1` no key/config, `2` hub unreachable, `3`
  signature rejected, `4` the hub is fine but the grant is not. `--json` emits
  one object with per-step results. Motivation: those four failures are
  indistinguishable from the outside, and the first symptom of any of them used
  to be a tool call failing deep inside a turn.
- The write probe writes **only** under `.parachute/doctor/`, to a path
  namespaced by the caller's npub prefix and a timestamp, re-checked against
  that prefix immediately before the create AND before the delete. Cleanup runs
  even when the read-back fails; a door with no `delete-note` gets the note
  relabelled "doctor probe, safe to delete" and the step says so rather than
  claiming it tidied up. It only runs with `--vault <name>` or when exactly one
  vault is reachable — never guessing which of several vaults to write to.
- The write probe lives under `.doctor/`, NOT `.parachute/` — the latter is the
  vault's own metadata namespace, and a commit touching only that prefix is
  treated as metadata-only and skipped (`shouldCommit`, `parachute_meta_only`),
  so a probe filed there would be invisible to the export path it rides on.
- A create that TIMES OUT (or fails at the transport) sweeps the probe path
  before reporting: the hub may have committed the note and lost the answer, so
  an unknown state must not be allowed to leave litter. A refusal (exit 4) is a
  decision, not an unknown, and is left alone — a delete against a read-only
  grant would only add a second, misleading error. A create failure carries
  `details.path` so a `--json` consumer can locate any orphan.
- Zero reachable vaults is a FAIL with exit `4`, not a pass with a caveat: exit
  `0` is documented to mean the grant reaches a vault, and a key that
  authenticates and can reach nothing has not got working access.
- `TimeoutError` prints one decimal — `--timeout 0.3` reported "timed out after
  0s", which reads as a bug in the tool rather than the budget that was asked
  for.
- `doctor` checks one hub at a time: several configured and no `--hub` exits `1`
  naming the aliases rather than silently picking one.
- The exit-code contract moved to `src/exit.ts` so `doctor.ts` can share it
  without an import cycle through the CLI runner. `commands.ts` re-exports
  `EXIT`, `UsageError`, `TimeoutError` and `exitCodeForError` unchanged.
- README: a new **"Onboarding by harness"** section with a wiring recipe for
  Claude Code (`claude mcp add` / `.mcp.json`), claude-agent-acp / buzz-host
  agents (key injected as `BUZZ_PRIVATE_KEY`, so the entry is just the binary
  and a hub URL), Codex, Grok CLI, Hermes (including the `platform_toolsets`
  trap — a connected server whose `mcp-parachute` toolset is not listed for the
  platform is invisible to the agent talking there), OpenClaw / shell-only
  agents, and sandboxes with no Node. Every recipe ends the same way: run
  `parachute-mcp doctor` and expect exit `0`. The per-harness snippets that
  were scattered through Quickstart now live there only.

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
