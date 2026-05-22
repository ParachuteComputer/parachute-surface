/**
 * Config loading for parachute-app.
 *
 * Reads `$PARACHUTE_HOME/app/config.json` (default `~/.parachute/app/config.json`).
 * Validates the shape against the on-disk Draft-07 schema in
 * `.parachute/config/schema`. Missing-file is OK at MVP — app falls through
 * to defaults so a fresh install can `parachute-app serve` without an explicit
 * config step. Malformed JSON or wrong-typed fields are fail-fast.
 *
 * `PARACHUTE_HOME` env var overrides the parent directory — same convention
 * every committed-core module uses (vault, runner, scribe, agent).
 *
 * No secrets live in app's config today, so there's no SecretsStore lift here
 * (in contrast to runner's `vault_token` envelope). `auto_register_oauth_clients`
 * is the closest thing to a credential-adjacent toggle and it lives in plaintext.
 */

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AppConfig = {
  /** Hub origin used for DCR registration in Phase 1.2+. */
  hub_url: string;
  /** Whether `add` triggers automatic DCR registration with hub. */
  auto_register_oauth_clients: boolean;
  /** Global kill switch — daemon stays running but unmounts all UIs. */
  disabled: boolean;
  /** Fallback scopes for UIs whose meta.json omits `scopes_required`. */
  default_scope_required: string[];
  /** Whether `parachute-app dev <name>` is permitted. */
  dev_mode_allowed: boolean;
};

export class ConfigError extends Error {
  override name = "ConfigError" as const;
  readonly path: string;
  constructor(message: string, configPath: string) {
    super(`${message} (config: ${configPath})`);
    this.path = configPath;
  }
}

/**
 * Resolve `$PARACHUTE_HOME/app/config.json`. Honors `PARACHUTE_HOME` so
 * sandboxes + Render deployments can redirect the location.
 *
 * `os.homedir()` is cached at process start on Bun; we prefer the live env var
 * so test-time `HOME=` overrides take effect.
 */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "app", "config.json");
}

/**
 * Resolve `$PARACHUTE_HOME/app/uis/` — the directory app scans for declared
 * hosted UIs. Honors `PARACHUTE_HOME` for tests + sandboxes.
 */
export function resolveUisDir(env: Record<string, string | undefined> = process.env): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "app", "uis");
}

/** Defaults baked into the schema. Kept in sync with `.parachute/config/schema`. */
export const DEFAULTS: AppConfig = {
  hub_url: "http://127.0.0.1:1939",
  auto_register_oauth_clients: true,
  disabled: false,
  default_scope_required: ["vault:read"],
  dev_mode_allowed: true,
};

export type LoadConfigOpts = {
  /** Override the config path (tests). Defaults to `resolveConfigPath()`. */
  configPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Load + validate app config from disk. When the file is absent, returns the
 * built-in defaults (matches scribe's "no-config-yet means no-config-needed"
 * behavior — app's config is all-optional). Malformed JSON or wrong-typed
 * fields are fail-fast with a `ConfigError`.
 */
export function loadConfig(opts: LoadConfigOpts = {}): AppConfig {
  const configPath = opts.configPath ?? resolveConfigPath();
  const logger = opts.logger ?? console;

  if (!existsSync(configPath)) {
    logger.log(`[app] config file not found at ${configPath}; using defaults`);
    return { ...DEFAULTS, default_scope_required: [...DEFAULTS.default_scope_required] };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError("config root must be a JSON object", configPath);
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`failed to parse JSON: ${(e as Error).message}`, configPath);
  }

  return validateConfig(raw, configPath);
}

/**
 * Validate a parsed config object. Exported separately so tests can exercise
 * the shape-validation path without a tempfile round-trip.
 */
export function validateConfig(raw: unknown, configPath = "<inline>"): AppConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config root must be a JSON object", configPath);
  }
  const o = raw as Record<string, unknown>;

  // hub_url — string + uri-ish; default applied when absent.
  let hub_url = DEFAULTS.hub_url;
  if (o.hub_url !== undefined) {
    if (typeof o.hub_url !== "string" || o.hub_url.length === 0) {
      throw new ConfigError("`hub_url` must be a non-empty string", configPath);
    }
    // Soft URI check — fail fast on obvious typos but don't be pedantic.
    try {
      new URL(o.hub_url);
    } catch {
      throw new ConfigError(`\`hub_url\` is not a valid URL: ${o.hub_url}`, configPath);
    }
    hub_url = stripTrailingSlash(o.hub_url);
  }

  // auto_register_oauth_clients — bool; default true.
  let auto_register_oauth_clients = DEFAULTS.auto_register_oauth_clients;
  if (o.auto_register_oauth_clients !== undefined) {
    if (typeof o.auto_register_oauth_clients !== "boolean") {
      throw new ConfigError("`auto_register_oauth_clients` must be a boolean", configPath);
    }
    auto_register_oauth_clients = o.auto_register_oauth_clients;
  }

  // disabled — bool; default false.
  let disabled = DEFAULTS.disabled;
  if (o.disabled !== undefined) {
    if (typeof o.disabled !== "boolean") {
      throw new ConfigError("`disabled` must be a boolean", configPath);
    }
    disabled = o.disabled;
  }

  // default_scope_required — array of non-empty strings; default ["vault:read"].
  let default_scope_required: string[] = [...DEFAULTS.default_scope_required];
  if (o.default_scope_required !== undefined) {
    if (!Array.isArray(o.default_scope_required)) {
      throw new ConfigError("`default_scope_required` must be an array of strings", configPath);
    }
    const items: string[] = [];
    for (let i = 0; i < o.default_scope_required.length; i++) {
      const v = o.default_scope_required[i];
      if (typeof v !== "string" || v.length === 0) {
        throw new ConfigError(
          `\`default_scope_required[${i}]\` must be a non-empty string`,
          configPath,
        );
      }
      items.push(v);
    }
    default_scope_required = items;
  }

  // dev_mode_allowed — bool; default true.
  let dev_mode_allowed = DEFAULTS.dev_mode_allowed;
  if (o.dev_mode_allowed !== undefined) {
    if (typeof o.dev_mode_allowed !== "boolean") {
      throw new ConfigError("`dev_mode_allowed` must be a boolean", configPath);
    }
    dev_mode_allowed = o.dev_mode_allowed;
  }

  return {
    hub_url,
    auto_register_oauth_clients,
    disabled,
    default_scope_required,
    dev_mode_allowed,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
