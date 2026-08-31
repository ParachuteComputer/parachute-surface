/**
 * parseArgs unit tests. Importing cli.ts is safe: main() only runs when the
 * file is the process entry point (invokedAsEntry guard), never on import.
 */
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../cli.js";

describe("parseArgs", () => {
  test("no args → no config, no url, no flags", () => {
    expect(parseArgs([])).toEqual({ version: false, help: false });
  });

  test("--version / -v and --help / -h", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("--config takes the next argv entry", () => {
    expect(parseArgs(["--config", "/etc/p/mcp.json"]).config).toBe("/etc/p/mcp.json");
  });

  test("--config=path form", () => {
    expect(parseArgs(["--config=~/mcp.json"]).config).toBe("~/mcp.json");
  });

  test("--config with no value is an error", () => {
    expect(() => parseArgs(["--config"])).toThrow(/--config needs a path/);
  });

  test("a positional hub URL is captured", () => {
    expect(parseArgs(["https://hub.example.test/mcp"]).url).toBe("https://hub.example.test/mcp");
  });

  test("two positionals are an error", () => {
    expect(() => parseArgs(["https://a.test/mcp", "https://b.test/mcp"])).toThrow(
      /at most one positional/,
    );
  });

  test("unknown flags are an error, not silently swallowed", () => {
    expect(() => parseArgs(["--nsec", "nope"])).toThrow(/unknown flag --nsec/);
  });

  test("flags and positional combine", () => {
    const parsed = parseArgs(["--config", "c.json", "https://hub.example.test/mcp", "-v"]);
    expect(parsed).toEqual({
      config: "c.json",
      url: "https://hub.example.test/mcp",
      version: true,
      help: false,
    });
  });
});
