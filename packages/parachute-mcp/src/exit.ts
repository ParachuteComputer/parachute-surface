/**
 * The exit-code contract, and the error classes that map onto it.
 *
 * Split out of commands.ts so `doctor.ts` can share it without importing the
 * CLI runner (which imports `doctor.ts` back — an ES-module cycle that works
 * right up until someone reorders a top-level `const`). commands.ts re-exports
 * everything here, so `import { EXIT } from "./commands.js"` keeps working.
 *
 * Agents branch on these codes, so they are part of the published contract and
 * are documented in `--help` and the README.
 */
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const EXIT = {
  ok: 0,
  /** Bad arguments, bad config, no key, unknown hub/tool name. */
  usage: 1,
  /** Could not reach the hub, or an HTTP >= 400 that is not an auth failure. */
  transport: 2,
  /** The hub rejected the signature or the key (HTTP 401 / 403). */
  auth: 3,
  /** The tool ran and returned an error (`isError`, or a JSON-RPC error). */
  toolError: 4,
} as const;

/** Anything the user could fix by typing a different command line. Exit 1. */
export class UsageError extends Error {}

/**
 * A hub that accepts the connection and then never answers. Without this every
 * subcommand hangs forever, which for an agent is worse than an error: the
 * shell-out never returns and the turn stalls with no diagnostic at all.
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    // Content-free by construction — no URL, no arguments, nothing to leak.
    // One decimal, not a whole second: `--timeout 0.3` used to report "timed
    // out after 0s", which reads as a bug in the tool rather than as the
    // sub-second budget the caller actually asked for.
    super(`timed out after ${(ms / 1000).toFixed(1)}s`);
  }
}

/** HTTP status behind a transport error, if it carries one. */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof StreamableHTTPError && typeof err.code === "number") return err.code;
  // Fallback for SDK paths that surface the status only in the message.
  const match = /\bHTTP (\d{3})\b/.exec(err instanceof Error ? err.message : "");
  return match ? Number(match[1]) : undefined;
}

export function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** Map any thrown value to this CLI's exit-code contract. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof UsageError) return EXIT.usage;
  return isAuthStatus(httpStatusOf(err)) ? EXIT.auth : EXIT.transport;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
