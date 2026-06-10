/**
 * The isomorphism guarantee, at runtime: a bare Bun process importing the
 * codec entry must never touch document/window — no happy-dom, no shims.
 * The probe subprocess booby-traps the DOM globals BEFORE import and then
 * exercises parse/serialize/anchors; this test is vacuous-proof because the
 * probe prints a sentinel only after real codec work succeeds (a negative
 * scan with a positive control).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("codec entry is DOM-free", () => {
  test("subprocess with booby-trapped DOM globals imports and round-trips", () => {
    const probe = join(import.meta.dir, "no-dom-probe.ts");
    const result = Bun.spawnSync({ cmd: [process.execPath, probe] });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(stderr).toBe("");
    expect(stdout).toContain("NO-DOM-PROBE-OK");
    expect(result.exitCode).toBe(0);
  });

  test("positive control: the trap actually fires", () => {
    // Prove the booby trap detects DOM access — otherwise the probe's green
    // result would be unfalsifiable.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `Object.defineProperty(globalThis, "document", { get() { throw new Error("trapped"); } }); globalThis.document;`,
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("trapped");
  });
});
