/**
 * Build the pebble-config bundle.
 *
 * Deliberately tiny — no Vite/React. We bundle the single TS entry with
 * `Bun.build` (inlining `@openparachute/surface-client`) and copy the static
 * shell next to it. Everything in `dist/` is referenced with RELATIVE `./`
 * URLs so the surface-host's injected `<base href="/surface/pebble-config/">`
 * resolves assets correctly at whatever mount the operator runs.
 *
 * Output layout (flat — matches the relative refs in `src/index.html`):
 *   dist/index.html
 *   dist/main.js
 *   dist/style.css
 *   dist/icon.svg
 */

import { copyFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// 1. Bundle the TS entry → dist/main.js (surface-client inlined).
const result = await Bun.build({
  entrypoints: [path.join(srcDir, "main.ts")],
  outdir: distDir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[dir]/[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("pebble-config build failed");
}

// 2. Copy the static shell + assets verbatim.
for (const file of ["index.html", "style.css", "icon.svg"]) {
  await copyFile(path.join(srcDir, file), path.join(distDir, file));
}

console.log(`[pebble-config] built ${result.outputs.length} JS file(s) → ${distDir}`);
