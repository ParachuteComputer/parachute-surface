# @openparachute/mcp

A **stdio MCP bridge** to one or more remote Parachute hubs. It connects local
MCP clients that speak stdio (Claude Code / claude-agent-sdk, Codex, Grok,
Cursor…) to a hub's Streamable-HTTP MCP door (`https://<hub>/mcp`), signing
**every** HTTP request with a fresh [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
Nostr auth event.

Why a bridge: no MCP client can do per-request Nostr signing natively — MCP
client auth is OAuth or static headers, and a static header is a *replayed*
header, which the hub rejects (see [Security](#security-notes)). So the bridge
holds the key locally and signs on the way out, the same layering as
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (a stdio bridge doing
OAuth for clients that can't). One bridge process replaces the hand-built
per-agent loopback signing proxies.

The same binary also has a **CLI face** (`doctor`, `tools`, `call`, `http`) for
agents that shell out rather than run an MCP client — same config, same key,
same signing. See [CLI use](#cli-use-non-mcp-agents).

**New harness?** Wire it up with a recipe from
[Onboarding by harness](#onboarding-by-harness), then run `parachute-mcp
doctor` and expect exit `0`. That one command proves the key resolved, the hub
accepts the signature, the grant reaches a vault, and a write round-trips.

```
 MCP client (stdio) ──► parachute-mcp ──► https://hub-a/mcp   (NIP-98 signed)
                              │
                              └────────► https://hub-b/mcp   (same key, own signature)
```

## Install as a single binary (sandboxes, no Node)

Every release also ships **single-file executables** built with
`bun build --compile` — a whole Bun runtime plus the bridge in one static file.
No Node, no `node_modules`, no npm registry: the install is a download.

Two platform caveats, both inherited from Bun's own build targets: the Linux
binaries are **glibc**, not musl (they will not run on stock Alpine — use a
`-slim`/glibc base, or build a musl one yourself with
`bun build --compile --target=bun-linux-x64-musl`), and the x86-64 binary is
Bun's non-baseline build, which requires **AVX2** (2013+ Intel/AMD; on an older
or emulated CPU it dies with SIGILL — rebuild with
`--target=bun-linux-x64-baseline`). The arm64 binaries have neither caveat.

```sh
# pick your platform: linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64
VERSION=0.2.0-rc.2
PLATFORM=linux-x64
curl -fsSL -o /usr/local/bin/parachute-mcp \
  "https://github.com/ParachuteComputer/parachute-surface/releases/download/mcp-v${VERSION}/parachute-mcp-${VERSION}-${PLATFORM}"
chmod +x /usr/local/bin/parachute-mcp
parachute-mcp --version   # → 0.1.0
```

Verify it before you run it — the same release carries a `SHA256SUMS` file:

```sh
curl -fsSL -O "https://github.com/ParachuteComputer/parachute-surface/releases/download/mcp-v${VERSION}/SHA256SUMS"
# compare against the line for the file you downloaded
grep "parachute-mcp-${VERSION}-${PLATFORM}$" SHA256SUMS
sha256sum /usr/local/bin/parachute-mcp     # macOS: shasum -a 256
```

(To check a whole download directory at once: `sha256sum -c SHA256SUMS`, run
where the binaries kept their release filenames.)

### Reference the binary by ABSOLUTE PATH in your MCP config

```json
{
  "mcpServers": {
    "parachute": {
      "command": "/usr/local/bin/parachute-mcp",
      "args": [],
      "env": { "PARACHUTE_MCP_CONFIG": "/home/me/.config/parachute/mcp.json" }
    }
  }
}
```

**Never put `npx` in an agent's MCP config.** A harness that connects its MCP
servers eagerly at boot turns every start into a registry call: offline, rate
limited, or behind a proxy that blocks npm, the server fails to start, the
harness fails to boot, and it retries — a crash-loop whose visible symptom is
"the agent is down", several layers away from the actual cause. An absolute
path to a file on disk cannot do that. A bare `parachute-mcp` (PATH lookup) is
fine interactively but still depends on the environment the harness happens to
hand the subprocess, which is often not your shell's.

Building the binaries yourself (any platform, cross-compiled from one machine):

```sh
bun run build:binaries              # all four targets → release/ + SHA256SUMS
bun run build:binaries darwin-arm64 # just one
```

## Quickstart

Single hub, no config file:

```sh
PARACHUTE_NSEC_FILE=~/.config/parachute/agent.nsec \
  parachute-mcp https://uni.taildf9ce2.ts.net/mcp
```

Several hubs — create `~/.config/parachute/mcp.json` (picked up automatically):

```json
{
  "keyFile": "~/.config/parachute/agent.nsec",
  "hubs": [
    { "alias": "home", "url": "https://uni.taildf9ce2.ts.net/mcp" },
    { "alias": "techne", "url": "https://parachute.techne.coop/mcp" }
  ]
}
```

then just `parachute-mcp`. With one hub configured, tool names pass through
unchanged; with several, tools are namespaced `<alias>__<tool>`
(`home__query-notes`, `techne__create-note`) and calls are routed by prefix.

Per-harness recipes — Claude Code, buzz-host agents, Codex, Grok, Hermes,
shell-only agents, and sandboxes with no Node — are in
[Onboarding by harness](#onboarding-by-harness) below. Each one ends with the
same proof: `parachute-mcp doctor`, exit `0`.

## Onboarding by harness

Getting an agent onto a hub is four separate things that fail silently and look
identical from the outside: the key never resolved; the key resolved but the
hub rejects the signature; the hub accepts the signature but the grant covers
no vault; the grant covers a vault but is read-only. **Every recipe below ends
the same way — run `parachute-mcp doctor` and expect exit `0`.** That is the
proof; the rest is wiring.

```
$ parachute-mcp doctor
PASS  key      signing as npub1abc… (from config "keyFile")
PASS  hub      https://uni.example.ts.net/mcp: initialize + tools/list ok, 21 tools — server parachute-account 0.1.0
PASS  vaults   2 reachable: uni, team (grant covers this listed subset)
PASS  write    uni: created, read back byte-exact, deleted — .doctor/npub1abcdefg-20260902T041500Z
SKIP  channel  doctor: needs a channel — pass --channel <uuid> or set $BUZZ_CHANNEL_ID

PASS — 4/5 checks passed, 1 skipped
$ echo $?
0
```

See [`doctor`](#doctor--prove-the-whole-chain) for what each check does, what
`SKIP` means, and the `--json` shape.

### Claude Code

```sh
claude mcp add parachute -- parachute-mcp
# or, with an explicit config file / key:
claude mcp add parachute --env PARACHUTE_MCP_CONFIG=/home/me/.config/parachute/mcp.json -- parachute-mcp
```

That writes an entry a project `.mcp.json` can also carry directly:

```json
{
  "mcpServers": {
    "parachute": {
      "command": "parachute-mcp",
      "args": [],
      "env": { "PARACHUTE_MCP_CONFIG": "/home/me/.config/parachute/mcp.json" }
    }
  }
}
```

In the agent SDK this is an `McpStdioServerConfig` with the same three fields.
Then: `parachute-mcp doctor` — expect exit `0`.

### claude-agent-acp / buzz-host agents

`buzz-acp` injects the agent's **own** bech32 nsec as `BUZZ_PRIVATE_KEY` into
every MCP subprocess it launches, so there is no key file and no `env` block to
write. The whole entry is the binary and a hub URL:

```json
{
  "mcpServers": {
    "parachute": { "command": "parachute-mcp", "args": ["https://hub.example/mcp"] }
  }
}
```

The key is read from the env value in memory and only ever surfaced as its
npub. Because it is per-agent, this avoids the shared-key foot-gun of a global
`PARACHUTE_NSEC_FILE` — each agent proves its own access. Then:
`parachute-mcp doctor` — expect exit `0`, with the key step reading
`from BUZZ_PRIVATE_KEY (injected nsec value)`.

### Codex

```sh
codex mcp add parachute -- parachute-mcp
```

which lands in `~/.codex/config.toml` as a `[mcp_servers.<name>]` table. Codex
takes `env` as its own sub-table:

```toml
[mcp_servers.parachute]
command = "parachute-mcp"
args = []

[mcp_servers.parachute.env]
PARACHUTE_MCP_CONFIG = "/home/me/.config/parachute/mcp.json"
```

`command` may be an absolute path (`/usr/local/bin/parachute-mcp`), and often
should be — see [the `npx` warning](#reference-the-binary-by-absolute-path-in-your-mcp-config).
Then: `parachute-mcp doctor` — expect exit `0`.

### Grok CLI

`~/.grok/config.toml` uses the same table name as Codex, plus an `enabled`
flag:

```toml
[mcp_servers.parachute]
command = "parachute-mcp"
args = []
enabled = true

[mcp_servers.parachute.env]
PARACHUTE_MCP_CONFIG = "/home/me/.config/parachute/mcp.json"
```

Then: `parachute-mcp doctor` — expect exit `0`.

### Hermes

*(Shape from the [Hermes agent docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
and `cli-config.yaml.example`, not verified against a running Hermes.)*

Hermes config is YAML, and `command` should be an **absolute path** — Hermes
passes only explicitly configured `env` plus a safe baseline to the subprocess,
so it will not inherit your shell's `PATH`:

```yaml
mcp_servers:
  parachute:
    command: /usr/local/bin/parachute-mcp
    args: []
    env:
      PARACHUTE_MCP_CONFIG: /home/me/.config/parachute/mcp.json
    tools:
      include: ["list-vaults", "query-notes", "create-note", "update-note"]
```

**The trap.** Each MCP server becomes a runtime toolset named
`mcp-<server>` — here `mcp-parachute`. If you have set `platform_toolsets` at
all, it *replaces* the defaults for that platform, so the agent talking on that
platform sees the Parachute tools only if the toolset is listed:

```yaml
platform_toolsets:
  cli: [hermes-cli, mcp-parachute]
  telegram: [hermes-telegram, mcp-parachute]
```

Miss that and the server connects fine, `doctor` passes, and the agent still
insists it has no Parachute tools — because on that platform it doesn't. Then:
`parachute-mcp doctor` — expect exit `0` (and check the toolset separately, by
asking the agent to list its tools).

### OpenClaw and other shell-only agents

Agents that shell out rather than run an MCP client use the
[CLI face](#cli-use-non-mcp-agents) — same config, same key, same signing. No
MCP entry at all; just teach the agent three commands:

```sh
parachute-mcp tools --table                       # what can I call?
echo '{"vault":"uni","id":"Projects/README"}' \
  | parachute-mcp call query-notes --args -       # run one
parachute-mcp http GET https://hub.example/api/…  # a signed curl
```

Prefer `--args -` over a JSON positional: a literal lands in this process's
argv, which `ps` shows to every user on the box. Then:
`parachute-mcp doctor` — expect exit `0`.

### Sandboxes with no Node

Download a [single-file binary](#install-as-a-single-binary-sandboxes-no-node)
from the GitHub release `mcp-v<version>`, **verify the checksum**, and point
the harness at the absolute path:

```sh
VERSION=0.2.0-rc.2
PLATFORM=linux-x64
BASE="https://github.com/ParachuteComputer/parachute-surface/releases/download/mcp-v${VERSION}"
curl -fsSL -O "${BASE}/parachute-mcp-${VERSION}-${PLATFORM}"
curl -fsSL -O "${BASE}/SHA256SUMS"
grep "parachute-mcp-${VERSION}-${PLATFORM}$" SHA256SUMS | sha256sum -c -   # macOS: shasum -a 256 -c -
install -m 0755 "parachute-mcp-${VERSION}-${PLATFORM}" /usr/local/bin/parachute-mcp
```

Never put `npx` in an agent's MCP config —
[here is what that costs](#reference-the-binary-by-absolute-path-in-your-mcp-config).
Then: `/usr/local/bin/parachute-mcp doctor` — expect exit `0`.

## CLI use (non-MCP agents)

Not every agent runs an MCP client — plenty of them just *shell out*. Those
agents were re-implementing NIP-98 signing to reach the same hubs (a Python
port, a shell wrapper), which means the rules that actually matter — a fresh
nonce per request, `u` equal to the exact URL, a `payload` tag if and only if
there is a body — get re-derived per agent, and get them subtly wrong.

So the same binary has a CLI face. Same config file, same key resolution, same
signing code; five one-shot subcommands instead of a stdio server:

### `doctor` — prove the whole chain

```sh
parachute-mcp doctor [--hub <alias|url>] [--vault <name>] [--json] [--timeout <s>] \
    [--relay <wss-url>] [--channel <uuid>]
```

Five checks, in dependency order, each `PASS` / `FAIL` / `SKIP` with a one-line
reason. The run **stops at the first hard failure** — reporting "vaults: FAIL"
when the key never loaded is noise, not diagnosis.

| Check | What it proves | How it fails |
|---|---|---|
| `key` | A signing key resolved. Prints the **npub** and which of the three sources supplied it — never the secret, never the key file's path. | No key: `FAIL` with the resolution order, exit `1`. |
| `hub` | A NIP-98-signed `initialize` + `tools/list` against the hub's `/mcp` door. Reports the tool count and the server name/version when the hub sends one. | Unreachable/timeout: exit `2`. Signature rejected (`401`/`403`): exit `3`. |
| `vaults` | `list-vaults` — which vaults this key can reach, and whether the grant covers **all** of the hub's vaults or a listed subset. | Tool error: exit `4`. **Zero reachable vaults is a FAIL, exit `4`** — the key authenticates and can reach nothing, which is not working access. `SKIP` when the door exposes no `list-vaults` (i.e. it is a vault door, not an account door). |
| `write` | A real round-trip: create a note, read it back **byte-exact**, delete it. | Refused / mismatch: exit `4`. |
| `channel` | Which vault backs the Buzz channel this agent answers on, from the hub's `GET /api/channel-vault`. Reports the vault name, the binding's mode (`sync`/`frozen`) and when it last synced. | **Never fails.** `SKIP` when there is no channel id, when the channel has no vault attached (with the attach command to run), when the hub does not serve the route, or when the lookup itself failed. |

The write probe only runs when `--vault <name>` is given, or exactly one vault
is reachable — with several vaults and no `--vault` it `SKIP`s and says which
flag to pass. It writes **only** under `.doctor/`, to a path
namespaced by the caller's npub prefix and a timestamp
(`.doctor/npub1abcdefg-20260902T041500Z`), so two agents doctoring
the same vault in the same second cannot collide. The path is re-checked
against that prefix immediately before the create *and* before the delete. It
is deliberately **not** under `.parachute/`, which is the vault's own metadata
namespace — a commit touching only that prefix is treated as metadata-only and
skipped.
Cleanup runs even when the read-back fails, and after a create that timed out
(the hub may have committed it before the answer was lost), so a failed probe
leaves nothing behind; if the door exposes no `delete-note`, the note is relabelled
"doctor probe, safe to delete" and the step says so rather than claiming it
tidied up.

The `channel` step needs a relay (`--relay`, default `$BUZZ_RELAY_URL`) and a
channel id (`--channel`, default `$BUZZ_CHANNEL_ID`, then
`$BUZZ_GIT_ORIGIN_CHANNEL_ID`), and a hub that serves `GET /api/channel-vault`
— parachute-hub `next` after #947, **unreleased at the time of writing**.
Against an older hub it `SKIP`s saying so, which is deliberately a *different*
message from "this channel has no vault attached": telling an operator to run
an attach command their hub does not have is a worse answer than telling them
to upgrade.

It is also the one step that can never turn a passing `doctor` red. Exit `0`
still means exactly what it always did — a key resolved, the hub accepts it,
the grant reaches a vault, a note round-trips — and the binding is the *hub
operator's* to create, so nothing the agent can do on its own would turn a red
step green.

`doctor` checks **one hub at a time**. With several configured and no `--hub`
it exits `1` naming the aliases, rather than silently picking one — "prove I
have access" has to name which door it proved.

`--json` emits one object on stdout instead of the lines:

```json
{
  "ok": true,
  "exitCode": 0,
  "version": "0.1.0",
  "npub": "npub1…",
  "hub": { "alias": "home", "url": "https://hub.example/mcp" },
  "steps": [
    { "step": "key", "status": "pass", "reason": "signing as npub1… (from config \"keyFile\")",
      "details": { "npub": "npub1…", "source": "config \"keyFile\"" } }
  ],
  "summary": "PASS — 4/5 checks passed, 1 skipped"
}
```

A `SKIP` is not a failure and does not change the exit code: `0` still means
everything that could be checked was checked and worked.

### `tools` — what can I call?

```sh
$ parachute-mcp tools --table
query-notes   Query notes in the vault by tag, text, metadata or graph distance
create-note   Create a new note
vault-info    Full schema + tag projection for this vault
```

Without `--table` it prints JSON (`[{ "name", "description" }, …]`) on stdout.
With several hubs configured and no `--hub`, names are namespaced
`<alias>__<tool>` exactly as the bridge namespaces them, so a name printed here
is a name `call` accepts. `--hub <alias|url>` narrows to one hub (and drops the
namespace).

### `call` — run one tool

**Prefer `--args -`, which reads the JSON object from stdin:**

```sh
$ parachute-mcp call create-note --args - <<'JSON'
{"path": "Notes/From a shell.md", "content": "Quotes \" and $dollars and `ticks` survive."}
JSON
```

Two reasons, and the second is the one that bites:

1. There is no quoting layer to get wrong. For a nested shell — an agent
   running `ssh host "…"`, or a tool call inside a heredoc inside a script —
   getting a JSON literal through intact is genuinely hard.
2. **A positional literal lands in this process's `argv`, which `ps` shows to
   every user on the box.** Tool arguments are not automatically harmless:
   they carry note bodies, tokens, and whatever the agent is working on. This
   is the same exposure that makes `http` refuse a command-line body — the
   difference is only that `call` still *allows* the convenient form.

The positional form is fine for short, non-sensitive arguments:

```sh
$ parachute-mcp call query-notes '{"tag":"guide","limit":2}'
{"notes":[…]}
```

A result that is a single text block is printed as-is; anything else is printed
as the JSON result. A tool that returns `isError` prints its message to
**stderr** and exits `4`, so `set -e` and `if` both do the right thing.

### `http` — a signed curl

For anything the hub serves under Nostr auth that isn't a tool call:

```sh
$ parachute-mcp http GET 'https://uni.example.ts.net/vault/uni/api/notes?tag=guide'
< 200 OK
< content-type: application/json
{"notes":[…]}
```

The response body goes to **stdout**, the status line and headers to **stderr**,
so `parachute-mcp http … | jq .` works unchanged. Request bodies come from
**stdin only**:

```sh
$ jq -n '{path:"Notes/x.md",content:"hi"}' \
    | parachute-mcp http POST https://uni.example.ts.net/vault/uni/api/notes \
        --body - -H 'Content-Type: application/json'
```

There is deliberately no way to pass a body on the command line: argv is
world-readable through `ps`, and bodies to a hub routinely carry secrets. The
NIP-98 `payload` tag is added if and only if the body is non-empty, and
redirects are **not** followed — the signature pins one exact URL, so a
followed redirect would be signed for the wrong target. A `3xx` is reported
as-is (like `curl` without `-L`) and **exits `2`**: the request did not do what
was asked, and an empty body with exit `0` is the worst possible answer for a
caller that branches on the exit code.

### `channel-context` — shared memory across agents

```sh
parachute-mcp channel-context <read|append|init> [--vault <name>] \
    [--relay <wss-url>] [--channel <uuid>] [--tail <bytes>] [--json] [--timeout <s>]
```

Several agents answering in the same Buzz channel each start their turn blind:
they see the relay's message tail and nothing about what the *others* actually
did. The convention that fixes it is one note per channel —
`Channels/<relay-host>/<channel-uuid>` — that every agent reads the tail of
before acting and appends one entry to afterwards. It is safe under concurrency
because `append` is atomic in the vault; a read-modify-write of `content` is
not. This subcommand *is* that convention, so no agent has to re-derive it.

| Action | What it does |
|---|---|
| `read` | print the last `--tail` bytes (default `8000`) of the note. A channel with no note yet prints **nothing** and exits `0` — a first turn is not a failure. |
| `append` | read one entry from **stdin** and append it, with exactly one leading newline. If the note does not exist yet it is created first, so the channel's first turn lands without a separate step. |
| `init` | create the note with its header (`# <relay-host> / <channel-uuid>`), tag `channel-log`, and `relay` / `channel_id` / `summary` metadata. Another agent having created it first is **success**, not an error. |

The path comes from `--relay` (default `$BUZZ_RELAY_URL`, scheme and trailing
slash stripped, **lower-cased** — hostnames are case-insensitive but vault paths
are not, and a second note differing only in case makes the vault answer either
path with `ambiguous_path`) and `--channel` (default `$BUZZ_CHANNEL_ID`, then
`$BUZZ_GIT_ORIGIN_CHANNEL_ID`, which buzz-acp sets on stream channels) — both
already in a Buzz agent's environment, which is what makes this a one-liner
inside a turn. `--json` prints one object: `{exists:false}` for a note that is
not there yet, otherwise `path`, `byteSize`, `updatedAt` and the tail itself.

**`--vault` is optional.** `read` never needs one — `query-notes` fans out
across every vault the key can reach, and the note's path is unique per
channel. `append` and `init` do need one (the hub requires a vault on every
tool except `query-notes`), and without `--vault` they ask the hub which vault
backs this `(relay, channel)` pair: `GET /api/channel-vault`, NIP-98-signed
with the agent's own key, the same signing path every other hub call takes.
Requires a hub that serves that route — parachute-hub `next` after #947,
**unreleased at the time of writing**.

An explicit `--vault` always wins and makes **no** hub call. A channel with no
vault attached is an error (exit `1`) naming both fixes — the hub-side
`parachute vault attach-channel --relay <host> --channel <uuid> --vault <name>`,
or passing `--vault` yourself — raised *before* the MCP session opens and
before stdin is read, so an unattached channel costs nothing and loses no
entry.

```sh
# start of turn: what happened here already?
$ parachute-mcp channel-context read --tail 4000

# end of turn: one entry, from stdin — never argv. The vault comes from
# the channel's binding on the hub.
$ printf '## %s · Nou\n- did: fixed the DNS resolver\n- next: nothing\n' "$(date -u +%FT%RZ)" \
    | parachute-mcp channel-context append

# or name it yourself, which skips the lookup entirely
$ ... | parachute-mcp channel-context append --vault uni
```

`read` fetches the tail as a byte window (`content_offset` / `content_length`),
which the vault aligns to codepoint boundaries — so a `--tail` in bytes never
splits a character, and a long-running channel costs the same to read as a new
one. The request adds 3 bytes of slack, because that alignment moves the window's
START down and a window of exactly `--tail` would then stop short of the note's
end — dropping its newest bytes, the one end a tail read must never lose.

### Common flags

`--config <path>` and `--timeout <seconds>` work on every subcommand, and
may go **before or after** the subcommand — these are the same command:

```sh
$ parachute-mcp --config ~/hubs.json tools
$ parachute-mcp tools --config ~/hubs.json
```

(That is the `git -C dir status` / `docker --host h ps` convention. It is worth
stating because the alternative is nasty: a flag placed before the subcommand
used to fall through to bridge mode, where `tools` was read as a hub URL and
the process sat there having printed nothing, with exit `0`.)

`--timeout` defaults to **60 seconds** and bounds every request — the MCP
connect, `tools/list`, `tools/call`, the session `DELETE`, and the `http`
fetch. Without it, a hub that accepts the connection and then never answers
hangs the command forever, which for an agent is worse than any error: the
shell-out never returns and there is nothing to report. A timeout exits `2`
with a content-free `timed out after Ns` (one decimal, so a sub-second
`--timeout 0.3` reports `0.3s` rather than `0s`).

### Exit codes

Every subcommand uses the same contract:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage or configuration error (bad flags, no key, unknown hub or tool) |
| `2` | network / transport failure, a **timeout**, or an HTTP response `>= 300` that is not an auth failure (redirects are deliberately not followed) |
| `3` | authentication rejected by the hub (HTTP `401` / `403`) |
| `4` | the tool ran and returned an error result (`isError`) |

`doctor` reports the code of the check that failed, so the exit code alone says
*which layer* broke: `1` you have no key or no config, `2` the hub is not
reachable, `3` the hub rejected your signature, `4` the hub is fine but the
grant is not.

`tools` against several hubs still prints the tools of the hubs that answered
and names the ones that did not on stderr, but exits with the worst code seen —
a partial list never masquerades as a complete one. If **every** hub fails it
prints nothing at all on stdout: an empty `[]` there would read to a
JSON-consuming agent as "this hub has no tools" rather than "the hub is
unreachable".

Piping into `head` is safe — a closed pipe (`EPIPE`) exits `0` rather than
printing a stack trace.

## Config reference

Resolution order (first match wins):

1. `--config <path>` — JSON file.
2. `PARACHUTE_MCP_CONFIG` — env var naming a JSON file.
3. `~/.config/parachute/mcp.json`, if it exists.
4. Quick path: `parachute-mcp <hub-mcp-url>` + a key (`PARACHUTE_NSEC_FILE` or `BUZZ_PRIVATE_KEY`).

If a config file resolves *and* a positional URL is given, the file wins and
the bridge says so on stderr.

**Key resolution** is separate, in strict precedence (first wins):

1. config `keyFile`.
2. `PARACHUTE_NSEC_FILE` — a file **path**; overrides `keyFile`.
3. `BUZZ_PRIVATE_KEY` — a bech32 nsec **value** (not a path); used only when no
   key file is resolved. Injected automatically for Buzz agents by `buzz-acp`.

| Field | Meaning |
|---|---|
| `keyFile` | Path to the signing key file (`nsec1…` or 64-char hex, `~` ok). Overridden by `PARACHUTE_NSEC_FILE`; falls back to the `BUZZ_PRIVATE_KEY` value if no key file is set. |
| `hubs[].alias` | Namespace prefix. Letters/digits/`_`/`-`, must start and end alphanumeric, no `__` — so `<alias>__<tool>` routes unambiguously and satisfies the MCP tool-name character grammar. In multi-hub mode, a namespaced name over the 128-character MCP limit is omitted from `tools/list` and the `tools` command with a warning on stderr. |
| `hubs[].url` | The hub's Streamable-HTTP MCP door, e.g. `https://hub.example/mcp` or a vault door `https://hub.example/vault/<name>/mcp`. |

One key signs for every configured hub; the NIP-98 `u` tag is always the
target hub's exact URL.

Flags: `--version`, `--help`. Startup prints (to stderr, never stdout — stdout
is the MCP wire) the version, the signing **npub** (never the key), and the
hub list. A hub that is down at startup is logged and retried lazily on the
next `tools/list` / `tools/call`; it never kills the bridge or the hubs that
did connect. Streamable-HTTP session expiry (HTTP 404 on a live session) is
handled by re-initializing and retrying once.

## Security notes

- **The key stays in memory and is only ever surfaced as its npub.** It is read
  from a file (never argv), held in memory, never logged. Keep the key file
  `chmod 600` and outside any repo. The **one** deliberate exception is
  `BUZZ_PRIVATE_KEY`: a bech32 nsec read from the env *value*, used only as the
  last-resort fallback. That is safe precisely under Buzz — `buzz-acp` already
  injects each agent's own key into this subprocess's environment, so reading
  it adds no new exposure, and because it is per-agent it avoids the shared-key
  risk of a global key file. Non-Buzz harnesses never touch this path.
- **Per-request signing is load-bearing, not paranoia.** The hub's replay
  cache burns each event id on first sight — *including failed auth* — so a
  static `Authorization` header would work exactly once. Every request,
  including byte-identical retries and transport reconnects, gets a fresh
  event.
- **The `nonce` tag is mandatory.** Without it, two identical requests signed
  in the same second produce the same event id and the second is rejected as
  replayed. MCP clients repeat calls; the nonce (plus fresh `created_at`)
  makes every signature unique.
- Config-file parse errors never echo file contents — the classic accident is
  pointing `--config` at the key file itself.

## Scope (v1)

Tools only: `tools/list` and `tools/call` are bridged, with descriptions and
input schemas passed through verbatim. TODO: resources and prompts
passthrough (the hub door currently advertises only tools, so nothing is lost
against Parachute hubs today).

## License

AGPL-3.0.
