/**
 * Copy rich-notes-kit into surface-render, unchanged:
 *   <kit>/src/*.js, src/types/*.js → src/rich/kit/
 *   <kit>/vendor/markdown-it.mjs   → src/rich/vendor/
 *   <kit>/src/kit.css              → rich-notes-kit.css
 * and record the kit commit in src/rich/VENDORED.md.
 *
 *   bun scripts/sync-rich-notes-kit.ts <path-to-rich-notes-kit> [--check]
 *
 * `--check` changes nothing and exits 1 if the vendored copy differs from the
 * kit checkout. The kit's own tests run in the kit's repo; run them there
 * before syncing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [kitRoot, flag] = process.argv.slice(2);
if (!kitRoot || !existsSync(join(kitRoot, "src/index.js"))) {
  console.error("usage: bun scripts/sync-rich-notes-kit.ts <path-to-rich-notes-kit> [--check]");
  process.exit(2);
}
const check = flag === "--check";
const pkg = join(import.meta.dir, "..");

const pairs: [string, string][] = [];
for (const dir of ["src", "src/types"]) {
  for (const f of readdirSync(join(kitRoot, dir)).filter((n) => n.endsWith(".js"))) {
    pairs.push([join(kitRoot, dir, f), join(pkg, "src/rich/kit", dir.slice(4), f)]);
  }
}
pairs.push([join(kitRoot, "vendor/markdown-it.mjs"), join(pkg, "src/rich/vendor/markdown-it.mjs")]);
pairs.push([join(kitRoot, "src/kit.css"), join(pkg, "rich-notes-kit.css")]);

const stale: string[] = [];
for (const [from, to] of pairs) {
  const text = readFileSync(from, "utf8");
  if (check) {
    if (!existsSync(to) || readFileSync(to, "utf8") !== text) stale.push(to);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text);
}
if (check) {
  if (stale.length) {
    console.error(`vendored rich-notes-kit differs from ${kitRoot}:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log("vendored rich-notes-kit matches the kit checkout");
  process.exit(0);
}
const sha = execFileSync("git", ["-C", kitRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const md = join(pkg, "src/rich/VENDORED.md");
const old = readFileSync(md, "utf8");
writeFileSync(md, old.replace(/^Kit commit: `[0-9a-f]+`$/m, `Kit commit: \`${sha}\``));
console.log(`synced ${pairs.length} files from rich-notes-kit ${sha.slice(0, 7)}`);
