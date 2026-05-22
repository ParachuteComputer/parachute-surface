#!/usr/bin/env bun
/**
 * `parachute-app` CLI — Phase 1.2.
 *
 * App is the UI host module for custom Parachute UIs. It supervises a
 * directory of pre-built static bundles (each with a `meta.json`) and
 * serves them under the hub origin.
 *
 * Phase 1.2 (this release): admin verbs (`add`/`remove`/`list`/`reload`)
 * call the running daemon's HTTP admin endpoints. Operator must have
 * `parachute-app serve` running locally; the CLI is a thin HTTP client
 * over that, the same pattern hub's `parachute auth approve-client` etc.
 * use. Dev mode (`dev`) lands in Phase 1.3.
 *
 * Design:
 *   parachute.computer/design/2026-05-21-parachute-apps-design.md
 */

import pkg from "../package.json" with { type: "json" };
import { DEFAULT_PORT, serve } from "../src/index.ts";
import { readOperatorToken } from "../src/operator-token.ts";

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`parachute-app — UI host module for custom Parachute UIs

Usage:
  parachute-app serve                        Start the daemon
  parachute-app add <source> [flags]         Register a new UI
                                             <source>: local path OR npm spec (@scope/pkg[@version])
                                             flags: --name <n> --path </app/n> [--display <d>]
                                                    [--scopes <s1,s2>] [--force]
  parachute-app remove <name>                Unregister a UI + revoke its OAuth client
  parachute-app list                         List installed UIs with status + OAuth state
  parachute-app reload <name>                Refresh a UI's bundle (no daemon restart)
  parachute-app dev <name>                   Enable dev mode for <name> (no-cache + SSE reload)
  parachute-app dev <name> --off             Disable dev mode for <name>
  parachute-app dev <name> --trigger         Broadcast a reload event to connected tabs
  parachute-app dev list                     List UIs currently in dev mode
  parachute-app --help, -h                   Show this help
  parachute-app --version, -v                Print version and exit

Environment:
  PARACHUTE_APP_URL   Override the daemon URL (default http://127.0.0.1:1946).
  PARACHUTE_HUB_TOKEN Operator bearer used for admin endpoint auth.
                      Falls back to ~/.parachute/operator.token.

\`serve\` behavior:
  Reads $PARACHUTE_HOME/app/config.json (or built-in defaults).
  Scans $PARACHUTE_HOME/app/uis/ for declared UIs; each subdir needs
  a meta.json + dist/index.html. Mounts each UI at its declared path
  under /app/<name>/. Admin endpoints + admin SPA under /app/admin/
  are served by the same daemon.

\`dev\` behavior:
  Dev mode is process-local — a daemon restart resets every UI to
  production cache headers. While on, every response from the UI is
  no-cache, no-store, must-revalidate (overrides the immutable default
  for hashed assets); index.html gets a small EventSource shim that
  reloads the tab on a \`--trigger\` event. Phase 2 will wire an
  automatic file-watcher in place of the manual trigger.

Design:
  https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md
`);
}

function daemonUrl(): string {
  const base = process.env.PARACHUTE_APP_URL?.replace(/\/$/, "");
  if (base && base.length > 0) return base;
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

/** Source the same operator bearer the daemon uses for outbound DCR calls. */
function bearerToken(): string | undefined {
  return readOperatorToken();
}

/** Headers for an authenticated call to the daemon. */
function authHeaders(): Record<string, string> {
  const t = bearerToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/**
 * Pretty-printer for the API responses. Keeps the surface human-skimmable
 * without paying the wcwidth/table overhead of a "real" CLI library.
 */
function printJson(payload: unknown): void {
  // Default to the compact pretty-print; operators wanting the raw JSON
  // can pipe through `jq` against `curl`.
  console.log(JSON.stringify(payload, null, 2));
}

async function callDaemon(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `${daemonUrl()}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    console.error(`Couldn't reach the daemon at ${url}: ${(e as Error).message}`);
    console.error("Is `parachute-app serve` running?");
    process.exit(2);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Parse a `--flag value` style arg list into a key→value map. */
function parseFlags(rest: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function runAdd(rest: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(rest);
  if (positionals.length === 0) {
    console.error("add: missing <source> (local path or npm spec)");
    console.error("Run `parachute-app --help` for usage.");
    process.exit(1);
  }
  const body: Record<string, unknown> = { source: positionals[0] };
  if (typeof flags.name === "string") body.name = flags.name;
  if (typeof flags.path === "string") body.path = flags.path;
  if (typeof flags.display === "string") body.displayName = flags.display;
  if (typeof flags.tagline === "string") body.tagline = flags.tagline;
  if (typeof flags.scopes === "string") {
    body.scopes_required = flags.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (flags.force === true) body.force = true;
  const { status, body: resBody } = await callDaemon("POST", "/app/add", body);
  if (status >= 200 && status < 300) {
    const r = resBody as {
      ui?: { name?: string; path?: string };
      oauth_client_id?: string;
      oauth_status?: string;
      warning?: string;
    };
    if (r.ui) {
      console.log(`Added ${r.ui.name} at ${r.ui.path}`);
    }
    if (r.oauth_client_id) {
      console.log(
        `  oauth client_id: ${r.oauth_client_id}${r.oauth_status ? ` (${r.oauth_status})` : ""}`,
      );
    }
    if (r.warning) {
      console.log(`  warning: ${r.warning}`);
    }
    return;
  }
  console.error(`add failed (HTTP ${status}):`);
  printJson(resBody);
  process.exit(1);
}

async function runRemove(rest: string[]): Promise<void> {
  const name = rest[0];
  if (!name) {
    console.error("remove: missing <name>");
    process.exit(1);
  }
  const { status, body } = await callDaemon("DELETE", `/app/${encodeURIComponent(name)}`);
  if (status >= 200 && status < 300) {
    console.log(`Removed ${name}`);
    return;
  }
  console.error(`remove failed (HTTP ${status}):`);
  printJson(body);
  process.exit(1);
}

async function runList(): Promise<void> {
  const { status, body } = await callDaemon("GET", "/app/list");
  if (status >= 200 && status < 300) {
    const r = body as {
      uis?: Array<{
        name: string;
        path: string;
        displayName: string;
        version?: string;
        oauthClientId?: string;
      }>;
      skipped?: Array<{ dirName: string; status: string; reason: string }>;
    };
    const uis = r.uis ?? [];
    if (uis.length === 0) {
      console.log("(no UIs installed)");
    } else {
      for (const u of uis) {
        const oauth = u.oauthClientId ? ` oauth=${u.oauthClientId}` : "";
        const ver = u.version ? ` v${u.version}` : "";
        console.log(`  ${u.path}  ${u.displayName} (${u.name})${ver}${oauth}`);
      }
    }
    const skipped = r.skipped ?? [];
    if (skipped.length > 0) {
      console.log("");
      console.log("Skipped:");
      for (const s of skipped) {
        console.log(`  ${s.dirName}  ${s.status}: ${s.reason}`);
      }
    }
    return;
  }
  console.error(`list failed (HTTP ${status}):`);
  printJson(body);
  process.exit(1);
}

async function runReload(rest: string[]): Promise<void> {
  const name = rest[0];
  if (!name) {
    console.error("reload: missing <name>");
    process.exit(1);
  }
  const { status, body } = await callDaemon("POST", `/app/${encodeURIComponent(name)}/reload`);
  if (status >= 200 && status < 300) {
    console.log(`Reloaded ${name}`);
    return;
  }
  console.error(`reload failed (HTTP ${status}):`);
  printJson(body);
  process.exit(1);
}

/**
 * Phase 1.3 `dev` verb — enable / disable / trigger / list.
 *
 * Sub-shape (matches the design doc operator flow):
 *   parachute-app dev <name>             # enable (idempotent)
 *   parachute-app dev <name> --off       # disable
 *   parachute-app dev <name> --trigger   # broadcast reload event
 *   parachute-app dev list               # show UIs currently in dev mode
 */
async function runDev(rest: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(rest);
  const sub = positionals[0];

  // `dev list` (no other args).
  if (sub === "list") {
    const { status, body } = await callDaemon("GET", "/app/dev/list");
    if (status >= 200 && status < 300) {
      const r = body as {
        uis?: Array<{ name: string; enabled: boolean; enabledAt: number; subscribers: number }>;
      };
      const uis = r.uis ?? [];
      if (uis.length === 0) {
        console.log("(no UIs in dev mode)");
      } else {
        for (const u of uis) {
          const since = u.enabledAt > 0 ? new Date(u.enabledAt).toISOString() : "—";
          console.log(
            `  ${u.name}  enabled=${u.enabled}  since=${since}  subscribers=${u.subscribers}`,
          );
        }
      }
      return;
    }
    console.error(`dev list failed (HTTP ${status}):`);
    printJson(body);
    process.exit(1);
  }

  if (!sub) {
    console.error("dev: missing <name> (or `list`)");
    console.error("Run `parachute-app --help` for usage.");
    process.exit(1);
  }

  const name = sub;
  const off = flags.off === true;
  const trigger = flags.trigger === true;

  if (off && trigger) {
    console.error("dev: --off and --trigger are mutually exclusive");
    process.exit(1);
  }

  if (off) {
    const { status, body } = await callDaemon(
      "POST",
      `/app/${encodeURIComponent(name)}/dev/disable`,
    );
    if (status >= 200 && status < 300) {
      const r = body as { was_on?: boolean };
      console.log(`Dev mode OFF for ${name}${r.was_on === false ? " (was already off)" : ""}`);
      return;
    }
    console.error(`dev --off failed (HTTP ${status}):`);
    printJson(body);
    process.exit(1);
  }

  if (trigger) {
    const { status, body } = await callDaemon(
      "POST",
      `/app/${encodeURIComponent(name)}/dev/trigger`,
    );
    if (status >= 200 && status < 300) {
      const r = body as { notified?: number };
      console.log(`Reload broadcast for ${name}: notified ${r.notified ?? 0} client(s)`);
      return;
    }
    console.error(`dev --trigger failed (HTTP ${status}):`);
    printJson(body);
    process.exit(1);
  }

  // Default sub-verb: enable dev mode.
  const { status, body } = await callDaemon("POST", `/app/${encodeURIComponent(name)}/dev/enable`);
  if (status >= 200 && status < 300) {
    console.log(`Dev mode ON for ${name}`);
    console.log("  Edit, build, then run:");
    console.log(`  parachute-app dev ${name} --trigger`);
    console.log(`  parachute-app dev ${name} --off   # when done`);
    return;
  }
  console.error(`dev failed (HTTP ${status}):`);
  printJson(body);
  process.exit(1);
}

async function runServe(): Promise<void> {
  const handle = serve();
  // Wire signals so SIGINT/SIGTERM gracefully drain.
  const onSignal = async (sig: NodeJS.Signals) => {
    console.log(`[app] received ${sig}; stopping`);
    try {
      await handle.stop();
    } catch (e) {
      console.error(`[app] error during shutdown: ${(e as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void onSignal("SIGINT"));
  process.on("SIGTERM", () => void onSignal("SIGTERM"));
  // Hold the event loop until a signal arrives. The HTTP server keeps the
  // loop alive on its own, but we await a never-resolving promise as
  // belt-and-braces — if the server crashes silently we want the process
  // to stay up long enough for the supervisor to notice via /healthz.
  await new Promise<void>(() => {
    // intentionally never resolves
  });
}

async function main(): Promise<void> {
  const rest = args.slice(1);
  switch (command) {
    case "--version":
    case "-v":
      console.log(pkg.version);
      return;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return;

    case "serve":
      await runServe();
      return;

    case "add":
      await runAdd(rest);
      return;

    case "remove":
      await runRemove(rest);
      return;

    case "list":
      await runList();
      return;

    case "reload":
      await runReload(rest);
      return;

    case "dev":
      await runDev(rest);
      return;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run `parachute-app --help` for usage.");
      process.exit(1);
  }
}

await main();
