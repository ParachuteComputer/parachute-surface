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
    // Row key is the manifestName from .parachute/module.json — hub looks
    // modules up by manifestName, so registering under the short "app"
    // here would race the hub-installed `parachute-app` row and trip the
    // duplicate-port detector.
    expect(entry.name).toBe("parachute-app");
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

  test("regression: row key matches the manifestName hub installs under (no duplicate `app` row)", () => {
    // Hub's install path writes the services.json row under
    // manifest.manifestName ("parachute-app"). If self-register writes
    // under the short name "app", the file ends up with two rows on the
    // same port — hub's re-read flags it as a duplicate-port collision.
    // This test pins the row key to manifestName so the two paths
    // converge to one row.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-app", // hub-installed row
            port: 1946,
            paths: ["/app"],
            health: "/app/healthz",
            version: "hub-stamped",
          },
        ],
      }),
    );
    selfRegister({
      boundPort: 1946,
      installDir: "/post-install/checkout",
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string; port: number }>;
    };
    expect(raw.services).toHaveLength(1); // not 2
    expect(raw.services[0]?.name).toBe("parachute-app");
    expect(raw.services.find((s) => s.name === "app")).toBeUndefined();
  });
});

describe("selfRegister — subsequent boot (existing entry)", () => {
  test("preserves an operator-set port from services.json", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-app",
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
            name: "parachute-app",
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

describe("selfRegister — invalid-port guard (parachute-app#33 regression)", () => {
  test("refuses to write port=0 (the bootstrap-completion bug)", () => {
    // The bootstrap-completion call used to pass boundPort=0. When the
    // existing services.json row was missing for whatever reason,
    // selfRegister wrote port=0 which corrupted services.json and caused
    // hub to barf on read. The guard now rejects port=0 before writing.
    const result = selfRegister({
      boundPort: 0,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("invalid port 0");
    // services.json should NOT have been written (or should not contain
    // a port=0 entry — same defensive shape).
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(m.services.find((s: { port: number }) => s.port === 0)).toBeUndefined();
    }
  });

  test("refuses to write negative or out-of-range port", () => {
    for (const bad of [-1, 65536, 100000]) {
      const result = selfRegister({
        boundPort: bad,
        installDir: "/x",
        manifestPath,
        logger,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain(`invalid port ${bad}`);
    }
  });

  test("refuses to write non-integer port", () => {
    const result = selfRegister({
      boundPort: 1946.5,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
  });

  test("preserves existing valid port even if boundPort is 0", () => {
    // First write seeds a valid row.
    selfRegister({
      boundPort: 1946,
      installDir: "/x",
      manifestPath,
      logger,
    });
    // Second call with boundPort=0 should use the existing port, NOT trip
    // the guard. (The guard only fires when portToWrite — after the
    // existing?.port ?? boundPort resolution — is invalid.)
    const result = selfRegister({
      boundPort: 0,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.portWritten).toBe(1946);
  });
});

describe("resolveProjectRoot", () => {
  test("returns a directory containing .parachute/module.json", () => {
    const root = resolveProjectRoot();
    expect(fs.existsSync(path.join(root, ".parachute", "module.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
  });
});
