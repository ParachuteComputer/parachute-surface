#!/usr/bin/env bun
/**
 * `parachute-app` CLI — Phase 1.0 scaffold.
 *
 * App is the UI host module for custom Parachute UIs. It supervises a
 * directory of pre-built static bundles (each with a `meta.json`) and
 * serves them under the hub origin.
 *
 * Phase 1.0 (this release): module-protocol skeleton, stub bin, library
 * surface. No UI hosting, no admin endpoints, no OAuth DCR — those land
 * in Phase 1.1+. See `parachute-app --help` for the full verb plan and
 * the design doc for the architecture.
 *
 * Design:
 *   parachute.computer/design/2026-05-21-parachute-apps-design.md
 */

import pkg from "../package.json" with { type: "json" };

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`parachute-app — UI host module for custom Parachute UIs

Usage:
  parachute-app serve                        Start the daemon (Phase 1.1+)
  parachute-app add <source> --name <name> --path <path>
                                             Register a new UI (Phase 1.2+)
  parachute-app remove <name>                Unregister a UI (Phase 1.2+)
  parachute-app list                         List installed UIs (Phase 1.2+)
  parachute-app reload <name>                Refresh a UI's bundle (Phase 1.2+)
  parachute-app dev <name> [--off]           Dev mode with live reload (Phase 1.3+)
  parachute-app --help, -h                   Show this help
  parachute-app --version                    Print version and exit

Status:
  Phase 1.0 — initial scaffold. The bin + library surface exist as stubs;
  no subcommand is functional yet. See the design doc for what each
  phase ships.

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

function main(): void {
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
      stub("1.1");
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

main();
