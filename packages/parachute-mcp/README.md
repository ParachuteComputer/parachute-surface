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

The same binary also has a **CLI face** (`tools`, `call`, `http`) for agents
that shell out rather than run an MCP client — same config, same key, same
signing. See [CLI use](#cli-use-non-mcp-agents).

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
VERSION=0.1.0
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

### Buzz agents (zero-config key)

Under Buzz, `buzz-acp` injects the agent's own bech32 nsec as `BUZZ_PRIVATE_KEY`
into every MCP subprocess it launches. `parachute-mcp` reads it as a fallback
key source, so a Buzz agent needs **no key file at all** — just a hub URL:

```sh
parachute-mcp https://uni.taildf9ce2.ts.net/mcp
```

The key is read from the env value in memory and only ever surfaced as its
npub. This is per-agent (each agent's own injected key), so it avoids the
shared-key foot-gun of a global `PARACHUTE_NSEC_FILE`. Non-Buzz harnesses keep
using a key file. Precedence is always: config `keyFile` → `PARACHUTE_NSEC_FILE`
(a path, overrides `keyFile`) → `BUZZ_PRIVATE_KEY` (a value, used only when no
key file is resolved).

### Claude Code / claude-agent-sdk

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

(`claude mcp add parachute -- parachute-mcp` does the same from the CLI; in
the agent SDK this is an `McpStdioServerConfig`.)

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.parachute]
command = "parachute-mcp"
args = []
env = { "PARACHUTE_MCP_CONFIG" = "/home/me/.config/parachute/mcp.json" }
```

### Grok / Cursor / anything stdio

Any client that can spawn a stdio MCP server works the same way: command
`parachute-mcp`, optional `--config <path>` arg or `PARACHUTE_MCP_CONFIG` /
`PARACHUTE_NSEC_FILE` env.

## CLI use (non-MCP agents)

Not every agent runs an MCP client — plenty of them just *shell out*. Those
agents were re-implementing NIP-98 signing to reach the same hubs (a Python
port, a shell wrapper), which means the rules that actually matter — a fresh
nonce per request, `u` equal to the exact URL, a `payload` tag if and only if
there is a body — get re-derived per agent, and get them subtly wrong.

So the same binary has a CLI face. Same config file, same key resolution, same
signing code; three one-shot subcommands instead of a stdio server:

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

### Common flags

`--config <path>` and `--timeout <seconds>` work on all three subcommands, and
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
with a content-free `timed out after Ns`.

### Exit codes

Every subcommand uses the same contract:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | usage or configuration error (bad flags, no key, unknown hub or tool) |
| `2` | network / transport failure, a **timeout**, or an HTTP response `>= 300` that is not an auth failure (redirects are deliberately not followed) |
| `3` | authentication rejected by the hub (HTTP `401` / `403`) |
| `4` | the tool ran and returned an error result (`isError`) |

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
| `hubs[].alias` | Namespace prefix. Letters/digits/`_`/`-`, must start and end alphanumeric, no `__` — so `<alias>__<tool>` routes unambiguously and stays a valid MCP tool name (SEP-986: `^[A-Za-z0-9._-]{1,128}$`). |
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
