/**
 * P2 — SurfaceStateStore: per-surface SQLite keyed blob store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { removeSurfaceState, stateStorePathFor, surfaceConfigPathFor } from "../host-context.ts";
import { SurfaceStateStore } from "../surface-state-store.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpStateDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "surface-state-"));
  tmpdirs.push(d);
  return d;
}

describe("SurfaceStateStore", () => {
  test("put/get round-trips bytes + metadata", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    const blob = new Uint8Array([1, 2, 3, 255]);
    store.put("doc:abc", blob, { sourceVersion: "2026-06-09T10:00:00.000Z", dirty: true });
    const entry = store.get("doc:abc");
    expect(entry).not.toBeNull();
    expect([...entry!.blob]).toEqual([1, 2, 3, 255]);
    // sourceVersion is the vault updatedAt STRING VERBATIM (design §9).
    expect(entry!.sourceVersion).toBe("2026-06-09T10:00:00.000Z");
    expect(entry!.dirty).toBe(true);
    expect(entry!.updatedAt).toMatch(/^\d{4}-/);
    store.close();
  });

  test("string puts are UTF-8 encoded; defaults are clean (not-dirty, null version)", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    store.put("k", "héllo");
    const entry = store.get("k");
    expect(new TextDecoder().decode(entry!.blob)).toBe("héllo");
    expect(entry!.sourceVersion).toBeNull();
    expect(entry!.dirty).toBe(false);
    store.close();
  });

  test("put replaces the WHOLE entry (omitted options reset, not preserve)", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    store.put("k", "v1", { sourceVersion: "s1", dirty: true });
    store.put("k", "v2");
    const entry = store.get("k");
    expect(entry!.sourceVersion).toBeNull();
    expect(entry!.dirty).toBe(false);
    store.close();
  });

  test("delete + miss semantics", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    expect(store.get("missing")).toBeNull();
    expect(store.delete("missing")).toBe(false);
    store.put("k", "v");
    expect(store.delete("k")).toBe(true);
    expect(store.get("k")).toBeNull();
    store.close();
  });

  test("list returns metadata only, key-ordered", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    store.put("b", "2", { dirty: true });
    store.put("a", "1", { sourceVersion: "v0" });
    const rows = store.list();
    expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
    expect(rows[0]!.sourceVersion).toBe("v0");
    expect(rows[1]!.dirty).toBe(true);
    expect("blob" in rows[0]!).toBe(false);
    store.close();
  });

  test("state survives close + reopen (file-backed)", () => {
    const dir = tmpStateDir();
    const file = stateStorePathFor("demo", dir);
    const first = new SurfaceStateStore(file);
    first.put("persist", "yes");
    first.close();
    const second = new SurfaceStateStore(file);
    expect(new TextDecoder().decode(second.get("persist")!.blob)).toBe("yes");
    second.close();
  });

  test("operations on a closed store throw a clear error", () => {
    const store = new SurfaceStateStore(stateStorePathFor("demo", tmpStateDir()));
    store.close();
    expect(() => store.put("k", "v")).toThrow(/closed/);
    expect(() => store.get("k")).toThrow(/closed/);
    store.close(); // idempotent
  });

  test("removeSurfaceState deletes the store file (+ sidecars) and config", () => {
    const dir = tmpStateDir();
    const store = new SurfaceStateStore(stateStorePathFor("gone", dir));
    store.put("k", "v");
    store.close();
    expect(existsSync(stateStorePathFor("gone", dir))).toBe(true);
    removeSurfaceState("gone", dir);
    expect(existsSync(stateStorePathFor("gone", dir))).toBe(false);
    expect(existsSync(surfaceConfigPathFor("gone", dir))).toBe(false);
    removeSurfaceState("gone", dir); // idempotent
  });
});
