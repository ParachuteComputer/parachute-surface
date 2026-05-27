/**
 * Tests for `src/ui-registry.ts` — directory scan + meta validation +
 * mount-path collision resolution.
 *
 * Coverage:
 *   - Empty / missing uisDir → empty result
 *   - One valid UI → registered with absolute paths
 *   - Missing meta.json → skipped (missing-meta)
 *   - Missing dist/index.html → skipped (missing-dist)
 *   - Invalid meta.json JSON → skipped (invalid-meta)
 *   - Schema-invalid meta.json → skipped (invalid-meta)
 *   - Reserved path /surface/admin → skipped (reserved-path)
 *   - Collision: alphabetical-by-name wins, others skipped (collision)
 *   - Files in uis/ (not directories) → silently ignored
 *   - Stable ordering by mount path
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { scanUis } from "../ui-registry.ts";

let uisDir: string;
const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function seedUi(
  name: string,
  meta: Record<string, unknown> | string,
  opts: { skipDist?: boolean; skipMeta?: boolean; indexHtml?: string } = {},
): void {
  const dir = path.join(uisDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!opts.skipMeta) {
    const body = typeof meta === "string" ? meta : JSON.stringify(meta);
    fs.writeFileSync(path.join(dir, "meta.json"), body);
  }
  if (!opts.skipDist) {
    const distDir = path.join(dir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "index.html"), opts.indexHtml ?? "<html></html>");
  }
}

beforeEach(() => {
  uisDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-uis-"));
});

afterEach(() => {
  fs.rmSync(uisDir, { recursive: true, force: true });
});

describe("scanUis — discovery", () => {
  test("missing dir returns empty", () => {
    fs.rmSync(uisDir, { recursive: true, force: true });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("empty dir returns empty", () => {
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("one valid UI", () => {
    seedUi("notes", { name: "notes", displayName: "Notes", path: "/surface/notes" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    const ui = result.registered[0]!;
    expect(ui.dirName).toBe("notes");
    expect(ui.meta.name).toBe("notes");
    expect(ui.distDir).toBe(path.join(uisDir, "notes", "dist"));
    expect(ui.uiDir).toBe(path.join(uisDir, "notes"));
  });

  test("files in uis/ (not directories) are silently ignored", () => {
    fs.writeFileSync(path.join(uisDir, "stray.txt"), "junk");
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe("scanUis — skip-and-warn", () => {
  test("missing meta.json", () => {
    seedUi("notes", "", { skipMeta: true });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("missing-meta");
  });

  test("missing dist/index.html", () => {
    seedUi(
      "notes",
      { name: "notes", displayName: "Notes", path: "/surface/notes" },
      {
        skipDist: true,
      },
    );
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("missing-dist");
  });

  test("malformed meta.json", () => {
    seedUi("notes", "{not json");
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("invalid-meta");
  });

  test("schema-invalid meta.json", () => {
    seedUi("notes", { name: "Notes", displayName: "X", path: "/surface/x" }); // uppercase name
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("invalid-meta");
  });

  test("reserved path /surface/admin", () => {
    seedUi("admin", { name: "admin", displayName: "Admin", path: "/surface/admin" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("reserved-path");
  });
});

describe("scanUis — collision resolution", () => {
  test("alphabetical-by-name wins; loser demoted to collision", () => {
    seedUi("brain-zebra", { name: "brain-zebra", displayName: "Zebra", path: "/surface/brain" });
    seedUi("brain-alpha", { name: "brain-alpha", displayName: "Alpha", path: "/surface/brain" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]!.meta.name).toBe("brain-alpha");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.status).toBe("collision");
    expect(result.skipped[0]!.dirName).toBe("brain-zebra");
  });

  test("three-way collision: alphabetical-by-name wins", () => {
    seedUi("c", { name: "c", displayName: "C", path: "/surface/x" });
    seedUi("a", { name: "a", displayName: "A", path: "/surface/x" });
    seedUi("b", { name: "b", displayName: "B", path: "/surface/x" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(1);
    expect(result.registered[0]!.meta.name).toBe("a");
    expect(result.skipped.map((s) => s.dirName).sort()).toEqual(["b", "c"]);
    for (const s of result.skipped) expect(s.status).toBe("collision");
  });

  test("no collision: different paths", () => {
    seedUi("foo", { name: "foo", displayName: "Foo", path: "/surface/foo" });
    seedUi("bar", { name: "bar", displayName: "Bar", path: "/surface/bar" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });
});

describe("scanUis — ordering", () => {
  test("registered list is sorted by mount path", () => {
    seedUi("zeta", { name: "zeta", displayName: "Z", path: "/surface/zeta" });
    seedUi("alpha", { name: "alpha", displayName: "A", path: "/surface/alpha" });
    seedUi("middle", { name: "middle", displayName: "M", path: "/surface/middle" });
    const result = scanUis({ uisDir, logger: silentLogger });
    expect(result.registered.map((u) => u.meta.path)).toEqual([
      "/surface/alpha",
      "/surface/middle",
      "/surface/zeta",
    ]);
  });
});
