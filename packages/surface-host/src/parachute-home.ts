/**
 * Resolve the shared Parachute state root.
 *
 * All surface-host paths go through this function so the test suite has one
 * enforceable boundary between fixtures and an operator's live install.
 */

import * as os from "node:os";
import * as path from "node:path";

export function resolveParachuteHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const realHome = path.join(os.homedir(), ".parachute");
  const resolved = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");

  // bunfig.toml's preload is cwd-sensitive. If somebody invokes a test by
  // path from outside the repo, the preload may never run; fail here instead
  // of letting a shipped path helper fall through to the live install.
  if (
    process.env.NODE_ENV === "test" &&
    (resolved === realHome || resolved.startsWith(`${realHome}${path.sep}`))
  ) {
    throw new Error(
      `[parachute-surface] refusing to resolve test state inside the live install at ${realHome}; set PARACHUTE_HOME to a temporary directory (the repo test preload does this automatically)`,
    );
  }

  return resolved;
}
