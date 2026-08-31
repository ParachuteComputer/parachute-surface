/**
 * Config resolution for the bridge, in priority order:
 *
 *   1. `--config <path>` CLI flag → JSON file.
 *   2. `PARACHUTE_MCP_CONFIG` env var → JSON file path.
 *   3. `~/.config/parachute/mcp.json`, if it exists.
 *   4. Single-hub quick path with no file: a positional hub-MCP URL plus a
 *      key from `PARACHUTE_NSEC_FILE` (a path) or `BUZZ_PRIVATE_KEY` (a value).
 *
 * The SIGNING KEY is resolved separately (`resolveKeySource`), in its own
 * strict precedence:
 *
 *   1. an explicit key FILE — `PARACHUTE_NSEC_FILE` env (a path) overrides the
 *      config file's `keyFile`. (This env-overrides-config order is preserved
 *      exactly from the original single-source design.)
 *   2. `BUZZ_PRIVATE_KEY` env (a bech32 nsec VALUE, not a path) — used ONLY
 *      when no key file was resolved above.
 *   3. otherwise no key → the caller raises a context-appropriate error.
 *
 * Error messages for a malformed config file name the PATH only, never file
 * contents — a user can point `--config` at the wrong file by accident, and
 * that file could hold a key.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HubEntry {
  /** Namespace prefix when several hubs are bridged (`<alias>__<tool>`). */
  alias: string;
  /** The hub's Streamable-HTTP MCP door, e.g. https://hub.example/mcp. */
  url: string;
}

export interface ResolvedConfig {
  /**
   * Path of the nsec/hex key FILE (already ~-expanded), when a key file was
   * resolved (config `keyFile` or `PARACHUTE_NSEC_FILE`). Mutually exclusive
   * with `keyValue`.
   */
  keyFile?: string;
  /**
   * Inline bech32 nsec VALUE from `BUZZ_PRIVATE_KEY`, used only when no key
   * file was resolved. Held in memory, NEVER logged. See `resolveKeySource`
   * for why reading an env VALUE is a deliberate, per-agent-scoped exception.
   */
  keyValue?: string;
  hubs: HubEntry[];
  /** Where the config came from, for the startup stderr line. */
  source: string;
}

/**
 * Alias grammar: letters, digits, `_` and `-`; must start and end with a
 * letter or digit; no `__` anywhere; at most 64 characters. Three reasons:
 *  - namespaced names must satisfy the MCP tool-name format (SEP-986:
 *    `^[A-Za-z0-9._-]{1,128}$`),
 *  - `__` is the namespace separator, so an alias containing `__` (or ending
 *    in `_`) would make `<alias>__<tool>` ambiguous to route, and
 *  - the 64-char cap keeps `<alias>__` at ≤66 chars, leaving ≥62 for the tool
 *    name so namespacing itself can't push a typical name past SEP-986's 128.
 */
const ALIAS_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

export function isValidAlias(alias: string): boolean {
  return ALIAS_RE.test(alias) && !alias.includes("__");
}

/** Expand a leading `~` / `~/` to the home directory. */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, ".config", "parachute", "mcp.json");
}

function validateHubs(raw: unknown, path: string): HubEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`config file ${path}: "hubs" must be a non-empty array`);
  }
  const hubs: HubEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as { alias?: unknown; url?: unknown };
    if (!entry || typeof entry !== "object") {
      throw new Error(`config file ${path}: hubs[${i}] must be an object`);
    }
    if (typeof entry.alias !== "string" || !isValidAlias(entry.alias)) {
      throw new Error(
        `config file ${path}: hubs[${i}].alias must match ${ALIAS_RE} with no "__" (it becomes a tool-name prefix)`,
      );
    }
    if (seen.has(entry.alias)) {
      throw new Error(`config file ${path}: duplicate hub alias "${entry.alias}"`);
    }
    seen.add(entry.alias);
    hubs.push({ alias: entry.alias, url: validateHubUrl(entry.url, `${path}: hubs[${i}].url`) });
  }
  return hubs;
}

function validateHubUrl(raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new Error(`${what} must be a string`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${what} must be http(s)`);
  }
  return url.href;
}

/**
 * Resolve WHICH signing key to use, in strict precedence (highest first):
 *
 *   1. an explicit key FILE — `PARACHUTE_NSEC_FILE` env (a path) OVERRIDES the
 *      config file's `keyFile`. This env-overrides-config order is preserved
 *      exactly from the original single-source design; do not reorder it.
 *   2. `BUZZ_PRIVATE_KEY` env (a bech32 nsec VALUE, not a path) — used ONLY
 *      when neither key file above is present.
 *   3. otherwise `{}` — the caller raises the "no key" error with a message
 *      appropriate to its context (config file vs. quick path).
 *
 * SECURITY — why reading `BUZZ_PRIVATE_KEY` (an env VALUE) is a deliberate
 * exception to this package's otherwise file-path-only key stance:
 *   (a) For a Buzz agent the key is ALREADY in this subprocess's environment by
 *       Buzz's own design — buzz-acp's `build_mcp_servers` injects
 *       `BUZZ_PRIVATE_KEY` into every MCP subprocess it launches, and the
 *       `buzz` CLI reads the same var — so reading it here adds NO new exposure.
 *   (b) It is PER-AGENT: buzz-acp injects each agent's OWN key, so unlike a
 *       shared `PARACHUTE_NSEC_FILE` it does not create a multi-agent same-key
 *       foot-gun — for the multi-agent case it is strictly SAFER.
 * Non-Buzz harnesses keep pointing at a key FILE and never reach this branch.
 * The value is returned raw and parsed in memory by key.ts; it is NEVER logged.
 */
export function resolveKeySource(
  configKeyFile: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): { keyFile?: string; keyValue?: string } {
  const envKeyFile = env.PARACHUTE_NSEC_FILE;
  if (envKeyFile) return { keyFile: expandTilde(envKeyFile, home) };
  if (typeof configKeyFile === "string" && configKeyFile.length > 0) {
    return { keyFile: expandTilde(configKeyFile, home) };
  }
  const buzzKey = env.BUZZ_PRIVATE_KEY;
  if (buzzKey && buzzKey.length > 0) return { keyValue: buzzKey };
  return {};
}

function readConfigFile(
  path: string,
  env: NodeJS.ProcessEnv,
  home: string,
  source: string,
): ResolvedConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read config file ${path}: ${(e as NodeJS.ErrnoException).code}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately content-free: the named file may hold a key by user error.
    throw new Error(`config file ${path} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must be a JSON object`);
  }
  const obj = parsed as { keyFile?: unknown; hubs?: unknown };
  const hubs = validateHubs(obj.hubs, path);

  const key = resolveKeySource(
    typeof obj.keyFile === "string" ? obj.keyFile : undefined,
    env,
    home,
  );
  if (!key.keyFile && !key.keyValue) {
    throw new Error(
      `config file ${path} has no "keyFile", PARACHUTE_NSEC_FILE is not set, and BUZZ_PRIVATE_KEY is not in the environment — the bridge needs a key to sign with`,
    );
  }
  return { ...key, hubs, source };
}

export function resolveConfig(opts: {
  /** `--config <path>` value, if given. */
  configFlag?: string;
  /** Positional hub-MCP URL, if given. */
  positionalUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests. */
  home?: string;
  /** Stderr sink for the "positional URL ignored" warning. */
  warn?: (msg: string) => void;
}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const warn = opts.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const filePath = opts.configFlag
    ? { path: expandTilde(opts.configFlag, home), source: "--config" }
    : env.PARACHUTE_MCP_CONFIG
      ? { path: expandTilde(env.PARACHUTE_MCP_CONFIG, home), source: "PARACHUTE_MCP_CONFIG" }
      : existsSync(defaultConfigPath(home))
        ? { path: defaultConfigPath(home), source: defaultConfigPath(home) }
        : undefined;

  if (filePath) {
    if (opts.positionalUrl) {
      warn(
        `parachute-mcp: config file (${filePath.source}) takes precedence — ignoring positional URL argument`,
      );
    }
    return readConfigFile(filePath.path, env, home, filePath.source);
  }

  if (opts.positionalUrl) {
    const url = validateHubUrl(opts.positionalUrl, "positional hub URL");
    const key = resolveKeySource(undefined, env, home);
    if (!key.keyFile && !key.keyValue) {
      throw new Error(
        "no config file found — the single-hub quick path needs a key: set " +
          "PARACHUTE_NSEC_FILE (a key file path) or BUZZ_PRIVATE_KEY (an injected " +
          "nsec value, e.g. under buzz-acp)",
      );
    }
    return { ...key, hubs: [{ alias: "hub", url }], source: "positional URL" };
  }

  throw new Error(
    `no configuration: pass --config <path>, set PARACHUTE_MCP_CONFIG, create ${defaultConfigPath(home)}, or run \`parachute-mcp <hub-mcp-url>\` with PARACHUTE_NSEC_FILE (a key file) or BUZZ_PRIVATE_KEY (an injected nsec) set`,
  );
}
