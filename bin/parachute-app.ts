#!/usr/bin/env bun
/**
 * `parachute-app` CLI — Phase 1.1.
 *
 * App is the UI host module for custom Parachute UIs. It supervises a
 * directory of pre-built static bundles (each with a `meta.json`) and
 * serves them under the hub origin.
 *
 * Phase 1.1 (this release): real `serve` daemon. Scans
 * `$PARACHUTE_HOME/app/uis/`, mounts each declared UI at its declared
 * path, serves the bundle with smart cache headers + SPA-routing
 * fallback, self-registers into `~/.parachute/services.json`. Admin
 * verbs (`add`/`remove`/`list`/`reload`) land in Phase 1.2; dev mode
 * lands in Phase 1.3.
 *
 * Design:
 *   parachute.computer/design/2026-05-21-parachute-apps-design.md
 */

import pkg from "../package.json" with { type: "json" };
import { serve } from "../src/index.ts";

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`parachute-app — UI host module for custom Parachute UIs

Usage:
  parachute-app serve                        Start the daemon (Phase 1.1)
  parachute-app add <source> --name <name> --path <path>
                                             Register a new UI (Phase 1.2+)
  parachute-app remove <name>                Unregister a UI (Phase 1.2+)
  parachute-app list                         List installed UIs (Phase 1.2+)
  parachute-app reload <name>                Refresh a UI's bundle (Phase 1.2+)
  parachute-app dev <name> [--off]           Dev mode with live reload (Phase 1.3+)
  parachute-app --help, -h                   Show this help
  parachute-app --version, -v                Print version and exit

\`serve\` behavior:
  Reads $PARACHUTE_HOME/app/config.json (or built-in defaults).
  Scans $PARACHUTE_HOME/app/uis/ for declared UIs; each subdir needs
  a meta.json + dist/index.html. Mounts each UI at its declared path
  under /app/<name>/. Smart cache headers per design doc section 18:
  index.html no-cache, content-hashed assets immutable, SW no-cache.
  Listens on 127.0.0.1:1946 by default; hub forwards /app/* via its
  reverse proxy.

Design:
  https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md
`);
}

function stub(phase: string): void {
  console.log(
    `Phase ${phase} — not yet implemented. Run \`parachute-app --help\` for current capabilities.`,
  );
  process.exit(0);
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
    case "remove":
    case "list":
    case "reload":
      stub("1.2");
      return;

    case "dev":
      stub("1.3");
      return;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run `parachute-app --help` for usage.");
      process.exit(1);
  }
}

await main();
