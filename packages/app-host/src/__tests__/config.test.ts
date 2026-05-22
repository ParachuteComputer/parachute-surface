/**
 * Tests for `src/config.ts` — app config loading.
 *
 * Coverage:
 *   - Missing file → built-in defaults (no throw)
 *   - Valid + complete config → roundtrips
 *   - Partial config → defaults fill in absent fields
 *   - Malformed JSON → ConfigError
 *   - Wrong-typed field → ConfigError
 *   - Bad URL → ConfigError
 *   - resolveConfigPath honors PARACHUTE_HOME
 *   - resolveUisDir honors PARACHUTE_HOME
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ConfigError,
  DEFAULTS,
  loadConfig,
  resolveConfigPath,
  resolveUisDir,
  validateConfig,
} from "../config.ts";

let tmpDir: string;
let configPath: string;

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-config-"));
  configPath = path.join(tmpDir, "app", "config.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig — defaults", () => {
  test("missing file returns defaults", () => {
    const cfg = loadConfig({ configPath, logger: silentLogger });
    expect(cfg.hub_url).toBe(DEFAULTS.hub_url);
    expect(cfg.auto_register_oauth_clients).toBe(DEFAULTS.auto_register_oauth_clients);
    expect(cfg.disabled).toBe(DEFAULTS.disabled);
    expect(cfg.default_scope_required).toEqual([...DEFAULTS.default_scope_required]);
    expect(cfg.dev_mode_allowed).toBe(DEFAULTS.dev_mode_allowed);
  });

  test("defaults array is a fresh copy", () => {
    const cfg = loadConfig({ configPath, logger: silentLogger });
    cfg.default_scope_required.push("vault:write");
    const cfg2 = loadConfig({ configPath, logger: silentLogger });
    expect(cfg2.default_scope_required).toEqual([...DEFAULTS.default_scope_required]);
  });
});

describe("loadConfig — valid", () => {
  test("complete config", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hub_url: "http://localhost:1939",
        auto_register_oauth_clients: false,
        disabled: true,
        default_scope_required: ["vault:read", "vault:write"],
        dev_mode_allowed: false,
      }),
    );
    const cfg = loadConfig({ configPath, logger: silentLogger });
    expect(cfg.hub_url).toBe("http://localhost:1939");
    expect(cfg.auto_register_oauth_clients).toBe(false);
    expect(cfg.disabled).toBe(true);
    expect(cfg.default_scope_required).toEqual(["vault:read", "vault:write"]);
    expect(cfg.dev_mode_allowed).toBe(false);
  });

  test("partial config fills defaults", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ disabled: true }));
    const cfg = loadConfig({ configPath, logger: silentLogger });
    expect(cfg.disabled).toBe(true);
    expect(cfg.hub_url).toBe(DEFAULTS.hub_url);
    expect(cfg.dev_mode_allowed).toBe(DEFAULTS.dev_mode_allowed);
  });

  test("hub_url with trailing slash stripped", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hub_url: "http://x/" }));
    const cfg = loadConfig({ configPath, logger: silentLogger });
    expect(cfg.hub_url).toBe("http://x");
  });
});

describe("loadConfig — invalid", () => {
  test("malformed JSON", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{not json");
    expect(() => loadConfig({ configPath, logger: silentLogger })).toThrow(ConfigError);
  });

  test("root must be object", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "[]");
    expect(() => loadConfig({ configPath, logger: silentLogger })).toThrow(ConfigError);
  });

  test("hub_url wrong type", () => {
    expect(() => validateConfig({ hub_url: 1939 })).toThrow(ConfigError);
  });

  test("hub_url empty string", () => {
    expect(() => validateConfig({ hub_url: "" })).toThrow(ConfigError);
  });

  test("hub_url bad URL", () => {
    expect(() => validateConfig({ hub_url: "not a url" })).toThrow(ConfigError);
  });

  test("disabled wrong type", () => {
    expect(() => validateConfig({ disabled: "yes" })).toThrow(ConfigError);
  });

  test("default_scope_required must be array", () => {
    expect(() => validateConfig({ default_scope_required: "vault:read" })).toThrow(ConfigError);
  });

  test("default_scope_required elements must be non-empty strings", () => {
    expect(() => validateConfig({ default_scope_required: [""] })).toThrow(ConfigError);
    expect(() => validateConfig({ default_scope_required: [123] })).toThrow(ConfigError);
  });
});

describe("resolveConfigPath / resolveUisDir", () => {
  test("PARACHUTE_HOME overrides parent", () => {
    const env = { PARACHUTE_HOME: "/custom/.parachute" };
    expect(resolveConfigPath(env)).toBe("/custom/.parachute/app/config.json");
    expect(resolveUisDir(env)).toBe("/custom/.parachute/app/uis");
  });

  test("HOME drives default when PARACHUTE_HOME absent", () => {
    const env = { HOME: "/home/test" };
    expect(resolveConfigPath(env)).toBe("/home/test/.parachute/app/config.json");
    expect(resolveUisDir(env)).toBe("/home/test/.parachute/app/uis");
  });
});
