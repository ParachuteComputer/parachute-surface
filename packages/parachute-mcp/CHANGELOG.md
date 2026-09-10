# Changelog — @openparachute/mcp

## [0.2.0-rc.3] - 2026-09-05

- **`channel-context` no longer needs to be told its vault.** `append` and
  `init` accept `--vault` as before, but without it they ask the hub which
  vault backs this `(relay, channel)` pair — `GET /api/channel-vault`,
  NIP-98-signed with the agent's own key, the same signing path every other
  hub call takes. Relay comes from `--relay` / `$BUZZ_RELAY_URL`, channel from
  `--channel` / `$BUZZ_CHANNEL_ID` / `$BUZZ_GIT_ORIGIN_CHANNEL_ID` (buzz-acp
  sets the last on stream channels). Until now the binding was a fact the hub
  already owned and every agent had to be told out of band and repeat on every
  invocation; one wrong name and the turn appended to the wrong vault. An
  explicit `--vault` still wins and makes **no** hub call. `read` never needed
  one and still asks nothing (`query-notes` fans out across every reachable
  vault, and the channel path is unique).
- An unbound channel is exit `1` naming both fixes — the hub-side
  `parachute vault attach-channel --relay <host> --channel <uuid> --vault
  <name>`, or passing `--vault` yourself — and it is raised **before** the MCP
  session opens and before stdin is read, so an unattached channel costs
  nothing and loses no entry.
- The route's two 404s are kept apart on purpose. `{"error":"not_found"}` from
  the route itself means "this channel is unbound"; a hub's generic plain-text
  404 means "this hub predates the route". Conflating them would send an
  operator to an attach command their hub does not have. `channel-vault.ts`
  never throws — every outcome, including a dead network, is a variant of
  `ChannelVaultLookup`, because its loudest caller is `doctor`, whose whole
  contract is that a diagnostic step does not crash the diagnosis.
- **`doctor` gains a fifth step, `channel`**, beside `key|hub|vaults|write`,
  with `--relay` / `--channel` flags. Bound → `PASS` naming the vault, the
  binding's mode (`sync`/`frozen`) and its sync age. No channel id, an unbound
  channel, a hub that predates the route, or a failed lookup → `SKIP` with the
  next thing to do. It can **never FAIL**: exit `0` still means exactly the
  four access checks it always did, because the binding is the hub operator's
  to create and nothing the agent can do would turn a red step green.
- **Namespaced tool names now respect SEP-986's 128-character cap.** In
  multi-hub mode a tool whose `<alias>__<tool>` name would exceed 128
  characters is omitted from `tools/list` with a stderr diagnostic naming the
  hub and the tool, instead of being advertised under a name the format does
  not allow. Nothing is renamed — single-hub mode passes names through
  unchanged, and every namespaced name that already fit is untouched. The
  remedy for an omitted tool is a shorter hub alias. Applies to both the
  bridge and `parachute-mcp tools`.
- **`call update-note` and `call delete-note` resolve a path-only argument.**
  Both tools' `id` parameter is documented id-**or**-path, and the
  `channel-context` convention already relies on it, but the raw `call`
  pass-through never made the substitution — so `{"path": …}` with no `id`
  reached the hub with `id` unset and came back as the hub's unstructured
  `Error: undefined is not an object (evaluating 'idOrPath.match')` fallback.
  `runCall` now maps `path` → `id` for those two tools only, and only when
  `id` is absent, so `update-note`'s separate `path`-as-rename semantics stay
  intact when a caller passes both. Deliberately NOT extended to
  `query-notes`'s top-level `id`: an absent `id` there selects a different
  LIST mode, not "no target". `query-notes`'s `near.note_id` and `find-path`'s
  `source`/`target` share the contract under other key names and are out of
  reach of a `path`-keyed substitution.
- **`call` classifies tool errors instead of falling through.** `runCall` had
  no catch around `session.callTool`, so a JSON-RPC error out of `tools/call`
  (a hub that throws rather than answering with `isError`) reached `runCli`'s
  generic classifier and exited `2` — the transport code — for what is a
  tool failure. It now goes through `classifyError` like `doctor` and
  `channel-context`, so the same shape of failure gets the same exit `4`.
- README: the binary-install recipes point at `mcp-v0.2.0-rc.2`, the first
  version to ship single-file executables (`0.1.0` shipped none). This release
  supersedes them — `mcp-v0.2.0-rc.3` carries the same four executables plus
  `SHA256SUMS`.

## [0.2.0-rc.2] - 2026-09-02

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
- **`parachute-mcp channel-context <read|append|init>`** — shared per-channel
  memory for several agents answering in one Buzz channel. One append-only note
  per channel, `Channels/<relay-host>/<channel-uuid>`: `read` prints the last
  `--tail` bytes (default 8000) and exits `0` on a channel with no note yet, so
  a first turn is not a failure; `append` takes the entry from STDIN only (never
  argv), adds exactly one leading newline, and creates-then-retries against a
  missing note; `init` writes the runbook header, the channel-log tag and
  `relay`/`channel_id` metadata, treating a `path_conflict` as SUCCESS so two
  agents opening the same channel in the same second both end up with the note.
  Path derives from `--relay`/`$BUZZ_RELAY_URL` and `--channel`/`$BUZZ_CHANNEL_ID`;
  a channel id that could climb out of `Channels/` is refused, not normalized.
  Append is atomic in the vault, which is what makes the convention concurrency-
  safe. No new auth code — the existing config, key resolution and NIP-98 signing
  are wired in.
- `channel-context read` asks for 3 bytes of slack: the vault aligns
  `content_offset` DOWN to a codepoint boundary, so a window of exactly `tail`
  from an offset landing mid-character dropped the note's NEWEST 1–3 bytes.
  `relayHostOf` now lower-cases — hostnames are case-insensitive but vault paths
  are not, and `WSS://…` created a second note beside the first, after which the
  vault answers either path with `ambiguous_path` and the whole channel is
  poisoned.
- **Release path: the single-file binaries are built BEFORE the npm publish.**
  They used to be built after `publish-mcp-npm` and after `tag-record` cut the
  tag, so a compile failure left the version on npm and the tag in git with a
  Release carrying no assets — and the README's `curl`-the-asset sandbox install
  404s for that version. `build-mcp-binaries` now compiles all four targets,
  executes the linux-x64 one and asserts on the version it prints, and uploads
  them plus `SHA256SUMS` as a workflow artifact; `publish-mcp-npm` `needs:` it,
  and `release-mcp-binaries` only downloads and attaches. The build job holds
  `contents: read` only; the OIDC `id-token: write` publish is untouched.
  (Closes #229.)
- `STABLE_PROMOTION_ALLOWED_PATHS` gains `packages/parachute-mcp` — without it
  the three files an `0.2.0-rc.N` → `0.2.0` suffix-drop must touch all read as
  new code, and the first stable mcp release would have been refused. A drift
  test pins the allow-list to `SURFACE_NPM_TAG_PREFIX` so the next package added
  cannot repeat it. (Closes #231.)

## [0.2.0-rc.1] - 2026-09-02

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
