import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, expandTilde, isValidAlias, resolveConfig } from "../config.js";

const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-config-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

const HUBS = [
  { alias: "home", url: "https://hub.example.test/mcp" },
  { alias: "techne", url: "https://parachute.techne.coop/mcp" },
];

describe("expandTilde", () => {
  test("expands ~ and ~/", () => {
    expect(expandTilde("~", "/home/u")).toBe("/home/u");
    expect(expandTilde("~/.config/parachute/agent.nsec", "/home/u")).toBe(
      "/home/u/.config/parachute/agent.nsec",
    );
  });
  test("leaves other paths alone", () => {
    expect(expandTilde("/abs/path", "/home/u")).toBe("/abs/path");
    expect(expandTilde("rel/~path", "/home/u")).toBe("rel/~path");
  });
});

describe("alias grammar (namespace-prefix safety)", () => {
  test("accepts plain aliases", () => {
    for (const a of ["home", "techne", "hub-2", "a", "my_hub", "A9", "x".repeat(64)]) {
      expect(isValidAlias(a)).toBe(true);
    }
  });
  test("rejects aliases that would break <alias>__<tool> routing or SEP-986 names", () => {
    // 65 chars: over the 64 cap that keeps `<alias>__<tool>` under SEP-986's 128.
    for (const a of [
      "",
      "a__b",
      "_a",
      "a_",
      "-a",
      "a-",
      "has space",
      "dot.ted",
      "é",
      "x".repeat(65),
    ]) {
      expect(isValidAlias(a)).toBe(false);
    }
  });
});

describe("precedence", () => {
  const flagPath = writeConfig("flag.json", { keyFile: join(dir, "k1"), hubs: [HUBS[0]] });
  const envPath = writeConfig("env.json", { keyFile: join(dir, "k2"), hubs: [HUBS[1]] });

  test("--config beats PARACHUTE_MCP_CONFIG", () => {
    const cfg = resolveConfig({
      configFlag: flagPath,
      env: { PARACHUTE_MCP_CONFIG: envPath },
      home: dir,
    });
    expect(cfg.hubs).toEqual([HUBS[0]!]);
    expect(cfg.source).toBe("--config");
  });

  test("PARACHUTE_MCP_CONFIG beats the default path", () => {
    const home = join(dir, "home-env");
    mkdirSync(join(home, ".config", "parachute"), { recursive: true });
    writeFileSync(
      defaultConfigPath(home),
      JSON.stringify({ keyFile: join(dir, "k3"), hubs: [HUBS[0]] }),
    );
    const cfg = resolveConfig({ env: { PARACHUTE_MCP_CONFIG: envPath }, home });
    expect(cfg.hubs).toEqual([HUBS[1]!]);
  });

  test("the default path is used when it exists", () => {
    const home = join(dir, "home-default");
    mkdirSync(join(home, ".config", "parachute"), { recursive: true });
    writeFileSync(defaultConfigPath(home), JSON.stringify({ keyFile: "~/agent.nsec", hubs: HUBS }));
    const cfg = resolveConfig({ env: {}, home });
    expect(cfg.hubs).toHaveLength(2);
    expect(cfg.keyFile).toBe(join(home, "agent.nsec")); // tilde-expanded
  });

  test("a config file beats a positional URL, with a warning", () => {
    const warnings: string[] = [];
    const cfg = resolveConfig({
      configFlag: flagPath,
      positionalUrl: "https://elsewhere.example/mcp",
      env: {},
      home: dir,
      warn: (m) => warnings.push(m),
    });
    expect(cfg.hubs).toEqual([HUBS[0]!]);
    expect(warnings.join(" ")).toContain("ignoring positional URL");
  });

  test("positional URL quick path needs PARACHUTE_NSEC_FILE", () => {
    expect(() =>
      resolveConfig({ positionalUrl: "https://hub.example.test/mcp", env: {}, home: dir }),
    ).toThrow(/PARACHUTE_NSEC_FILE/);
    const cfg = resolveConfig({
      positionalUrl: "https://hub.example.test/mcp",
      env: { PARACHUTE_NSEC_FILE: "~/key.nsec" },
      home: dir,
    });
    expect(cfg.hubs).toEqual([{ alias: "hub", url: "https://hub.example.test/mcp" }]);
    expect(cfg.keyFile).toBe(join(dir, "key.nsec"));
  });

  test("nothing configured at all is a clear error", () => {
    expect(() => resolveConfig({ env: {}, home: dir })).toThrow(/no configuration/);
  });
});

describe("key file resolution", () => {
  test("PARACHUTE_NSEC_FILE overrides the config's keyFile", () => {
    const path = writeConfig("keyfile.json", { keyFile: "~/from-config.nsec", hubs: [HUBS[0]] });
    const cfg = resolveConfig({
      configFlag: path,
      env: { PARACHUTE_NSEC_FILE: "~/from-env.nsec" },
      home: dir,
    });
    expect(cfg.keyFile).toBe(join(dir, "from-env.nsec"));
  });

  test("no keyFile and no env var is fatal", () => {
    const path = writeConfig("nokey.json", { hubs: [HUBS[0]] });
    expect(() => resolveConfig({ configFlag: path, env: {}, home: dir })).toThrow(
      /keyFile.*PARACHUTE_NSEC_FILE|PARACHUTE_NSEC_FILE.*keyFile/,
    );
  });
});

describe("BUZZ_PRIVATE_KEY key source (zero-config, e.g. under buzz-acp)", () => {
  // resolveConfig only CARRIES the value; parsing/validation is key.ts's job,
  // so any placeholder string exercises the resolution precedence here.
  const BUZZ = "nsec1buzzplaceholdervalue";

  test("BUZZ_PRIVATE_KEY is used as keyValue when no key file is resolved", () => {
    const path = writeConfig("buzz-nokeyfile.json", { hubs: [HUBS[0]] });
    const cfg = resolveConfig({ configFlag: path, env: { BUZZ_PRIVATE_KEY: BUZZ }, home: dir });
    expect(cfg.keyValue).toBe(BUZZ);
    expect(cfg.keyFile).toBeUndefined();
  });

  test("config keyFile wins over BUZZ_PRIVATE_KEY", () => {
    const path = writeConfig("buzz-vs-keyfile.json", {
      keyFile: "~/from-config.nsec",
      hubs: [HUBS[0]],
    });
    const cfg = resolveConfig({ configFlag: path, env: { BUZZ_PRIVATE_KEY: BUZZ }, home: dir });
    expect(cfg.keyFile).toBe(join(dir, "from-config.nsec"));
    expect(cfg.keyValue).toBeUndefined();
  });

  test("PARACHUTE_NSEC_FILE wins over BUZZ_PRIVATE_KEY", () => {
    const path = writeConfig("buzz-vs-nsecfile.json", { hubs: [HUBS[0]] });
    const cfg = resolveConfig({
      configFlag: path,
      env: { PARACHUTE_NSEC_FILE: "~/from-env.nsec", BUZZ_PRIVATE_KEY: BUZZ },
      home: dir,
    });
    expect(cfg.keyFile).toBe(join(dir, "from-env.nsec"));
    expect(cfg.keyValue).toBeUndefined();
  });

  test("positional quick path accepts BUZZ_PRIVATE_KEY with no PARACHUTE_NSEC_FILE", () => {
    const cfg = resolveConfig({
      positionalUrl: "https://hub.example.test/mcp",
      env: { BUZZ_PRIVATE_KEY: BUZZ },
      home: dir,
    });
    expect(cfg.hubs).toEqual([{ alias: "hub", url: "https://hub.example.test/mcp" }]);
    expect(cfg.keyValue).toBe(BUZZ);
    expect(cfg.keyFile).toBeUndefined();
  });

  test("positional quick path with no key at all names both key sources", () => {
    expect(() =>
      resolveConfig({ positionalUrl: "https://hub.example.test/mcp", env: {}, home: dir }),
    ).toThrow(/PARACHUTE_NSEC_FILE.*BUZZ_PRIVATE_KEY|BUZZ_PRIVATE_KEY.*PARACHUTE_NSEC_FILE/s);
  });

  test("config file with no key of any kind names BUZZ_PRIVATE_KEY too", () => {
    const path = writeConfig("buzz-nokey.json", { hubs: [HUBS[0]] });
    expect(() => resolveConfig({ configFlag: path, env: {}, home: dir })).toThrow(
      /BUZZ_PRIVATE_KEY/,
    );
  });
});

describe("malformed config files", () => {
  test("invalid JSON error names the path, never the contents", () => {
    // The classic user error this guards: pointing --config at the KEY file.
    const secretish = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const path = writeConfig("actually-a-key.json", secretish);
    try {
      resolveConfig({ configFlag: path, env: {}, home: dir });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(path);
      expect(msg).not.toContain(secretish);
      expect(msg).not.toContain("nsec1");
    }
  });

  test("a missing --config file reports path + errno code", () => {
    expect(() =>
      resolveConfig({ configFlag: join(dir, "absent.json"), env: {}, home: dir }),
    ).toThrow(/cannot read config file .*absent\.json: ENOENT/);
  });

  test("hubs must be a non-empty array of {alias, url}", () => {
    for (const hubs of [undefined, [], "x", [{ url: "https://x.test/mcp" }]]) {
      const path = writeConfig("badhubs.json", { keyFile: "~/k", hubs });
      expect(() => resolveConfig({ configFlag: path, env: {}, home: dir })).toThrow();
    }
  });

  test("duplicate aliases are rejected", () => {
    const path = writeConfig("dupe.json", {
      keyFile: "~/k",
      hubs: [HUBS[0], { alias: "home", url: "https://other.test/mcp" }],
    });
    expect(() => resolveConfig({ configFlag: path, env: {}, home: dir })).toThrow(
      /duplicate hub alias/,
    );
  });

  test("non-http(s) hub URLs are rejected", () => {
    const path = writeConfig("ftp.json", {
      keyFile: "~/k",
      hubs: [{ alias: "x", url: "ftp://x.test/mcp" }],
    });
    expect(() => resolveConfig({ configFlag: path, env: {}, home: dir })).toThrow(/http/);
  });
});
