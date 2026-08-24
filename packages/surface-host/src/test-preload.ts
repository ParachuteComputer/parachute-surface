/**
 * Test-process safety boundary.
 *
 * Override inherited credentials unconditionally: on a developer box those
 * variables commonly point at the live Parachute install. `serve()` starts a
 * credential-renewal sweep immediately, so merely reading an inherited home
 * can overwrite/delete real credentials and contact the live hub.
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const realHome = join(homedir(), ".parachute");
const testHome = mkdtempSync(join(tmpdir(), "parachute-surface-test-home-"));

if (testHome === realHome || testHome.startsWith(`${realHome}${sep}`)) {
  throw new Error(
    `[surface test preload] refusing to run: temporary test home ${testHome} is inside ` +
      `the live install at ${realHome}; check TMPDIR`,
  );
}

process.env.PARACHUTE_HOME = testHome;
// An inherited bearer would bypass the on-disk isolation and can authorize
// outbound calls to a live hub. Tests that need a token inject one explicitly.
process.env.PARACHUTE_HUB_TOKEN = "";

// Bun test does not reliably dispatch process exit hooks, so do not promise
// cleanup that will not run. The OS reaps these small temp directories.
