/**
 * Config resolution for the bridge, in priority order:
 *
 *   1. `--config <path>` CLI flag → JSON file.
 *   2. `PARACHUTE_MCP_CONFIG` env var → JSON file path.
 *   3. `~/.config/parachute/mcp.json`, if it exists.
 *   4. Single-hub quick path with no file: a positional hub-MCP URL plus
 *      `PARACHUTE_NSEC_FILE` for the key.
 *
 * `PARACHUTE_NSEC_FILE` always overrides the config's `keyFile`. Error
 * messages for a malformed config file name the PATH only, never file
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
  /** Path of the nsec/hex key file (already ~-expanded). */
  keyFile: string;
  hubs: HubEntry[];
  /** Where the config came from, for the startup stderr line. */
  source: string;
}

/**
 * Alias grammar: letters, digits, `_` and `-`; must start and end with a
 * letter or digit; no `__` anywhere. Two reasons:
 *  - namespaced names must satisfy the MCP tool-name format (SEP-986:
 *    `^[A-Za-z0-9._-]{1,128}$`), and
 *  - `__` is the namespace separator, so an alias containing `__` (or ending
 *    in `_`) would make `<alias>__<tool>` ambiguous to route.
 */
const ALIAS_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/;

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

  const envKeyFile = env.PARACHUTE_NSEC_FILE;
  let keyFile: string;
  if (envKeyFile) {
    keyFile = expandTilde(envKeyFile, home);
  } else if (typeof obj.keyFile === "string" && obj.keyFile.length > 0) {
    keyFile = expandTilde(obj.keyFile, home);
  } else {
    throw new Error(
      `config file ${path} has no "keyFile" and PARACHUTE_NSEC_FILE is not set — the bridge needs a key file to sign with`,
    );
  }
  return { keyFile, hubs, source };
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
    const keyFile = env.PARACHUTE_NSEC_FILE;
    if (!keyFile) {
      throw new Error(
        "no config file found — the single-hub quick path needs PARACHUTE_NSEC_FILE " +
          "to point at the key file",
      );
    }
    return {
      keyFile: expandTilde(keyFile, home),
      hubs: [{ alias: "hub", url }],
      source: "positional URL",
    };
  }

  throw new Error(
    `no configuration: pass --config <path>, set PARACHUTE_MCP_CONFIG, create ${defaultConfigPath(home)}, or run \`parachute-mcp <hub-mcp-url>\` with PARACHUTE_NSEC_FILE set`,
  );
}
