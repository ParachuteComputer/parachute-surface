/**
 * Tests for `src/self-register.ts` — services.json self-registration on
 * `parachute-app serve` boot. Mirrors runner's coverage shape.
 *
 * Coverage:
 *   - First boot: stamps port + installDir + version + paths + health + displayName
 *   - Subsequent boot: preserves an operator-set port unchanged
 *   - Hub-stamped fields (e.g. uiUrl, managementUrl) survive the merge
 *   - extraFields are stamped onto the row (Phase 1.2 hook)
 *   - Malformed services.json → {ok:false} + log, no throw
 *   - resolveProjectRoot points at the package root
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveProjectRoot, selfRegister } from "../self-register.ts";

interface CapturedLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  warnings: string[];
  logs: string[];
  errors: string[];
}

function makeLogger(): CapturedLogger {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
    logs,
    warnings,
    errors,
  };
}

let tmpDir: string;
let manifestPath: string;
let logger: CapturedLogger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-self-register-"));
  manifestPath = path.join(tmpDir, "services.json");
  logger = makeLogger();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("selfRegister — first boot", () => {
  test("writes a fresh services.json with our entry", () => {
    const result = selfRegister({
      boundPort: 1946,
      installDir: "/Users/x/parachute-app",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(false);
    expect(result.portWritten).toBe(1946);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services).toHaveLength(1);
    const entry = raw.services[0]!;
    expect(entry.name).toBe("app");
    expect(entry.port).toBe(1946);
    expect(entry.paths).toEqual(["/app", "/.parachute"]);
    expect(entry.health).toBe("/app/healthz");
    expect(entry.installDir).toBe("/Users/x/parachute-app");
    expect(entry.displayName).toBe("App");
    expect(typeof entry.version).toBe("string");
  });

  test("logs a single info-level line on success", () => {
    selfRegister({
      boundPort: 1946,
      installDir: "/abs",
      manifestPath,
      logger,
    });
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]).toContain("self-registered");
    expect(logger.warnings).toHaveLength(0);
  });
});

describe("selfRegister — subsequent boot (existing entry)", () => {
  test("preserves an operator-set port from services.json", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "app",
            port: 1948, // operator-set
            paths: ["/app"],
            health: "/app/healthz",
            version: "old",
            installDir: "/old/dir",
          },
        ],
      }),
    );
    const result = selfRegister({
      boundPort: 1946, // first-run fallback we'd use absent the existing row
      installDir: "/new/dir",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(true);
    expect(result.portWritten).toBe(1948); // not 1946

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    const entry = raw.services[0]!;
    expect(entry.port).toBe(1948);
    expect(entry.installDir).toBe("/new/dir"); // we re-stamp installDir
  });

  test("hub-stamped fields survive the merge", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "app",
            port: 1946,
            paths: ["/app"],
            health: "/app/healthz",
            version: "old",
            uiUrl: "/app/admin/", // hub-stamped
            managementUrl: "/app/admin/",
          },
        ],
      }),
    );
    selfRegister({
      boundPort: 1946,
      installDir: "/new/dir",
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    const entry = raw.services[0]!;
    expect(entry.uiUrl).toBe("/app/admin/");
    expect(entry.managementUrl).toBe("/app/admin/");
  });
});

describe("selfRegister — extraFields (Phase 1.2 hook)", () => {
  test("uis map is stamped onto the row", () => {
    selfRegister({
      boundPort: 1946,
      installDir: "/x",
      manifestPath,
      logger,
      extraFields: {
        uis: {
          notes: { displayName: "Notes", path: "/app/notes" },
        },
      },
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    const entry = raw.services[0]!;
    expect(entry.uis).toEqual({
      notes: { displayName: "Notes", path: "/app/notes" },
    });
  });
});

describe("selfRegister — best-effort", () => {
  test("malformed services.json → {ok:false} with warning", () => {
    fs.writeFileSync(manifestPath, "{not json");
    const result = selfRegister({
      boundPort: 1946,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("skipped self-register");
  });

  test("malformed services.json (missing services array) → {ok:false}", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ wrong: "shape" }));
    const result = selfRegister({
      boundPort: 1946,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveProjectRoot", () => {
  test("returns a directory containing .parachute/module.json", () => {
    const root = resolveProjectRoot();
    expect(fs.existsSync(path.join(root, ".parachute", "module.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
  });
});
