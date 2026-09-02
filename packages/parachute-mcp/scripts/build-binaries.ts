#!/usr/bin/env bun
/**
 * Cross-compile `parachute-mcp` to single-file executables with
 * `bun build --compile`.
 *
 * Why: the package's normal shape (npm + a Node `bin`) assumes two things a
 * hardened agent sandbox may not have — a Node runtime, and egress to the npm
 * registry. A single static binary needs neither: `curl` it in, `chmod +x`,
 * point the MCP config at its ABSOLUTE PATH, done. (Never `npx` in an agent's
 * MCP config: harnesses that connect their MCP servers eagerly at boot turn a
 * registry hiccup into a crash-loop.)
 *
 * Entry point is `dist/cli.js`, not `src/cli.ts`, deliberately: that is the
 * exact file the npm `bin` shim executes, so the binary and the published
 * package run the same bytes, tsc-checked. `bun run build` is invoked first
 * (its `prebuild` regenerates `src/version.ts` from package.json), which is
 * also how the version gets EMBEDDED — `--version` prints the constant that
 * was compiled in, with no package.json to read at runtime.
 *
 * Output: release/parachute-mcp-<version>-<os>-<arch> plus a SHA256SUMS file
 * (the naming the README's install one-liner and the release workflow both
 * assume). `release/` is gitignored — binaries are release assets, never
 * commits.
 *
 * Usage:
 *   bun scripts/build-binaries.ts               # every target
 *   bun scripts/build-binaries.ts darwin-arm64  # just one (local smoke test)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `bun build --compile` cross-compiles every one of these from a single
 * runner — the release job does not need a matrix, and there is no
 * per-platform toolchain to keep alive.
 */
const TARGETS = [
  { name: "linux-x64", bunTarget: "bun-linux-x64" },
  { name: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64" },
] as const;

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with exit code ${code}`);
  }
}

const requested = process.argv.slice(2);
const targets = TARGETS.filter((t) => requested.length === 0 || requested.includes(t.name));
if (targets.length === 0) {
  console.error(
    `no such target: ${requested.join(", ")}. Known: ${TARGETS.map((t) => t.name).join(", ")}`,
  );
  process.exit(2);
}

const pkg = (await Bun.file(join(pkgRoot, "package.json")).json()) as { version: string };
const version = pkg.version;

// Build dist/ first: `prebuild` regenerates src/version.ts from package.json,
// so the version compiled into the binary cannot drift from the package's.
console.log(`building dist/ (tsc) for @openparachute/mcp@${version}`);
await run(["bun", "run", "build"], pkgRoot);

const entry = join(pkgRoot, "dist", "cli.js");
if (!(await Bun.file(entry).exists())) {
  throw new Error(`entry ${entry} does not exist after \`bun run build\``);
}

const outDir = join(pkgRoot, "release");
// Full-target runs start clean: a stale binary from a previous version would
// otherwise be hashed into SHA256SUMS and uploaded as if it were current.
if (requested.length === 0) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const built: string[] = [];
for (const target of targets) {
  const name = `parachute-mcp-${version}-${target.name}`;
  const outfile = join(outDir, name);
  console.log(`compiling ${target.bunTarget} → release/${name}`);
  await run(
    [
      "bun",
      "build",
      "--compile",
      // A compiled Bun binary autoloads `.env` AND `bunfig.toml` from the
      // PROCESS CWD by default (both default to true). That is a key-resolution
      // hole this package must not have: a `.env` sitting in whatever directory
      // the harness happens to launch from could set PARACHUTE_NSEC_FILE and
      // redirect which key the bridge signs with — behaviour the Node path
      // (`node dist/cli.js`) does not have at all. Config and key still come
      // only from explicit flags/env/config file. (tsconfig/package.json
      // autoload already default to false.)
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      `--target=${target.bunTarget}`,
      entry,
      "--outfile",
      outfile,
    ],
    pkgRoot,
  );
  built.push(name);
}

// One SHA256SUMS covering everything currently in release/, in the
// `sha256sum -c` / `shasum -a 256 -c` format the README documents.
const lines: string[] = [];
for (const file of readdirSync(outDir).sort()) {
  if (file === "SHA256SUMS") continue;
  const bytes = await Bun.file(join(outDir, file)).arrayBuffer();
  const digest = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  lines.push(`${digest}  ${file}`);
}
await Bun.write(join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);

console.log(`\nbuilt ${built.length} binary(ies) in release/:`);
for (const line of lines) console.log(`  ${line}`);
