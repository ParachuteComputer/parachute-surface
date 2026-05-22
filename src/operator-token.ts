/**
 * Operator bearer sourcing for outbound calls from parachute-app to hub.
 *
 * The DCR registration flow (`POST /oauth/register` on hub) needs an operator
 * bearer in the `Authorization` header. Per hub's `handleRegister`:
 *
 *   - No bearer → client lands `pending`; an operator has to click approve.
 *   - Operator bearer carrying `hub:admin` scope → client lands `approved`.
 *
 * Apps wants approved (so a `parachute-app add` is one command, not "add
 * then go click approve in hub admin"). The bearer source mirrors what every
 * other operator-side caller uses:
 *
 *   1. `PARACHUTE_HUB_TOKEN` env var (highest priority, transient/CI use)
 *   2. `~/.parachute/operator.token` file (canonical persistent location)
 *
 * Both are operator-controlled. App never *generates* an operator token; it
 * only reads one the operator (or hub install path) wrote. The file mode is
 * verified — group/world-readable files refuse to load so a typo'd `chmod`
 * doesn't leak the token via a backup directory.
 *
 * Missing token → undefined, not an error. The caller decides whether that's
 * fatal (DCR auto-register on `parachute-app add` with `auto_register_oauth_clients=true`)
 * or fine (the `parachute-app list` path needs no outbound calls).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolve the canonical operator-token path. Honors `PARACHUTE_HOME` for
 * sandbox + Render deployments (matches the convention every committed-core
 * module follows).
 */
export function resolveOperatorTokenPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "operator.token");
}

export type ReadOperatorTokenOpts = {
  /** Override env (tests). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override file location (tests). Defaults to `resolveOperatorTokenPath`. */
  tokenPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Read the operator bearer.
 *
 * Priority order:
 *   1. `env.PARACHUTE_HUB_TOKEN` — env-var override (CI + transient flows)
 *   2. The on-disk file at `resolveOperatorTokenPath(env)`
 *
 * Returns `undefined` when nothing's available. Logs a warn if the file
 * exists but is group/world-readable (mode-bit defense — the operator
 * mistyped `chmod` and we refuse to load the token).
 */
export function readOperatorToken(opts: ReadOperatorTokenOpts = {}): string | undefined {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;

  const fromEnv = env.PARACHUTE_HUB_TOKEN?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const tokenPath = opts.tokenPath ?? resolveOperatorTokenPath(env);
  if (!existsSync(tokenPath)) return undefined;

  try {
    const st = statSync(tokenPath);
    // Posix mode check — refuse to load a token a backup tool might happen
    // to slurp from a group/world-readable file. The expected mode is 0o600
    // (owner-rw only). On Windows the mode bits are meaningless so we skip
    // the check there. `process.platform` is the canonical detector.
    if (process.platform !== "win32") {
      const groupOrWorldReadable = (st.mode & 0o077) !== 0;
      if (groupOrWorldReadable) {
        logger.warn(
          `[app] refusing to load operator token at ${tokenPath}: file is group/world-readable (mode ${(st.mode & 0o777).toString(8)}); chmod 600 to fix`,
        );
        return undefined;
      }
    }
    const body = readFileSync(tokenPath, "utf8").trim();
    if (body.length === 0) return undefined;
    return body;
  } catch (e) {
    logger.warn(`[app] failed to read operator token at ${tokenPath}: ${(e as Error).message}`);
    return undefined;
  }
}
