/**
 * After `tsc`: put the kit's own type file in place of the one tsc derived
 * from `src/rich/kit/index.js` (all `any`, without the kit's `Note`, `Doc`,
 * `Host`, `Patch`, `Handle`), so `dist/rich/kit-api.d.ts` re-exports real
 * types. The derived source map goes too: it pointed at the JS.
 */
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const pkg = join(import.meta.dir, "..");
copyFileSync(join(pkg, "src/rich/kit/index.d.ts"), join(pkg, "dist/rich/kit/index.d.ts"));
rmSync(join(pkg, "dist/rich/kit/index.d.ts.map"), { force: true });
