/**
 * Copy rich-notes-kit into surface-render, unchanged:
 *   <kit>/src/*.js, src/types/*.js → src/rich/kit/
 *   <kit>/src/index.d.ts           → src/rich/kit/index.d.ts (the kit's types)
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
pairs.push([join(kitRoot, "src/index.d.ts"), join(pkg, "src/rich/kit/index.d.ts")]);
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
// Files here the kit no longer has.
const expected = new Set(pairs.map(([, to]) => to));
for (const dir of ["src/rich/kit", "src/rich/kit/types", "src/rich/vendor"]) {
  for (const f of readdirSync(join(pkg, dir), { withFileTypes: true })) {
    const p = join(pkg, dir, f.name);
    if (f.isFile() && !expected.has(p)) stale.push(`${p} (not in the kit)`);
  }
}
const sha = execFileSync("git", ["-C", kitRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["-C", kitRoot, "status", "--porcelain", "--", "src", "vendor"], {
  encoding: "utf8",
}).trim();
const md = join(pkg, "src/rich/VENDORED.md");
if (check) {
  if (!readFileSync(md, "utf8").includes(`Kit commit: \`${sha}\``)) {
    stale.push(`${md} (records another kit commit than ${sha.slice(0, 7)})`);
  }
  if (dirty) stale.push(`${kitRoot} has uncommitted changes in src/ or vendor/`);
  if (stale.length) {
    console.error(`vendored rich-notes-kit differs from ${kitRoot}:\n  ${stale.join("\n  ")}`);
    process.exit(1);
  }
  console.log("vendored rich-notes-kit matches the kit checkout");
  process.exit(0);
}
if (dirty) {
  console.error("the kit checkout has uncommitted changes in src/ or vendor/; commit them first");
  process.exit(1);
}
for (const s of stale) console.error(`remove by hand: ${s}`);
const old = readFileSync(md, "utf8");
writeFileSync(md, old.replace(/^Kit commit: `[0-9a-f]+`$/m, `Kit commit: \`${sha}\``));
console.log(`synced ${pairs.length} files from rich-notes-kit ${sha.slice(0, 7)}`);
