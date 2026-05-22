/**
 * Tests for `src/operator-token.ts` — operator-bearer sourcing for outbound
 * DCR calls.
 *
 * Coverage:
 *   - env var wins over file
 *   - file read when env absent
 *   - missing file → undefined (no throw)
 *   - empty file → undefined
 *   - group/world-readable file refuses to load (Unix only)
 *   - resolveOperatorTokenPath honors PARACHUTE_HOME + HOME
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readOperatorToken, resolveOperatorTokenPath } from "../operator-token.ts";

let tmp: string;
let tokenPath: string;
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-optoken-"));
  tokenPath = path.join(tmp, "operator.token");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveOperatorTokenPath", () => {
  test("PARACHUTE_HOME wins", () => {
    const p = resolveOperatorTokenPath({ PARACHUTE_HOME: "/tmp/foo" });
    expect(p).toBe("/tmp/foo/operator.token");
  });
  test("falls back to HOME/.parachute", () => {
    const p = resolveOperatorTokenPath({ HOME: "/tmp/jay", PARACHUTE_HOME: undefined });
    expect(p).toBe("/tmp/jay/.parachute/operator.token");
  });
});

describe("readOperatorToken", () => {
  test("env var wins over file", () => {
    fs.writeFileSync(tokenPath, "file-token");
    fs.chmodSync(tokenPath, 0o600);
    const out = readOperatorToken({
      env: { PARACHUTE_HUB_TOKEN: "env-token" },
      tokenPath,
      logger: silentLogger,
    });
    expect(out).toBe("env-token");
  });

  test("trims whitespace on env var", () => {
    const out = readOperatorToken({
      env: { PARACHUTE_HUB_TOKEN: "  env-token  \n" },
      tokenPath: "/nonexistent",
      logger: silentLogger,
    });
    expect(out).toBe("env-token");
  });

  test("reads file when env absent + mode 0600", () => {
    fs.writeFileSync(tokenPath, "file-token\n");
    fs.chmodSync(tokenPath, 0o600);
    const out = readOperatorToken({ env: {}, tokenPath, logger: silentLogger });
    expect(out).toBe("file-token");
  });

  test("missing file → undefined", () => {
    const out = readOperatorToken({ env: {}, tokenPath: "/nonexistent", logger: silentLogger });
    expect(out).toBeUndefined();
  });

  test("empty file → undefined", () => {
    fs.writeFileSync(tokenPath, "");
    fs.chmodSync(tokenPath, 0o600);
    const out = readOperatorToken({ env: {}, tokenPath, logger: silentLogger });
    expect(out).toBeUndefined();
  });

  test("group-readable file refuses to load (Unix only)", () => {
    if (process.platform === "win32") return;
    fs.writeFileSync(tokenPath, "leak-able");
    fs.chmodSync(tokenPath, 0o640);
    const warnings: string[] = [];
    const logger = {
      ...silentLogger,
      warn: (s: string) => warnings.push(s),
    };
    const out = readOperatorToken({ env: {}, tokenPath, logger });
    expect(out).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("group/world-readable");
  });
});
