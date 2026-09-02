/**
 * Key loading. All keys are throwaways generated in-test with nostr-tools —
 * never a real key, and error paths must never echo file contents.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { loadKey, loadKeyValue, parseSecretKey } from "../key.js";

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const dir = mkdtempSync(join(tmpdir(), "parachute-mcp-key-test-"));
const nsecPath = join(dir, "throwaway.nsec");
writeFileSync(nsecPath, `${nsecEncode(sk)}\n`, { mode: 0o600 });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseSecretKey", () => {
  test("accepts nsec1...", () => {
    expect(parseSecretKey(nsecEncode(sk))).toEqual(sk);
  });

  test("accepts 64-char hex (either case)", () => {
    const hex = Buffer.from(sk).toString("hex");
    expect(parseSecretKey(hex)).toEqual(sk);
    expect(parseSecretKey(hex.toUpperCase())).toEqual(sk);
  });

  test("rejects garbage without echoing it", () => {
    try {
      parseSecretKey("nsec1-definitely-not-valid-bech32");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("definitely-not-valid");
    }
  });
});

describe("loadKey", () => {
  test("loads an nsec file and derives pubkey + npub", () => {
    const k = loadKey(nsecPath);
    expect(k.pubkey).toBe(pubkey);
    expect(k.npub).toBe(npubEncode(pubkey));
    expect(k.sk).toEqual(sk);
  });

  test("loads a hex key file", () => {
    const hexPath = join(dir, "throwaway.hex");
    writeFileSync(hexPath, `${Buffer.from(sk).toString("hex")}\n`, { mode: 0o600 });
    expect(loadKey(hexPath).pubkey).toBe(pubkey);
  });

  test("a missing file reports the path and errno code, not contents", () => {
    const missing = join(dir, "nope.nsec");
    expect(() => loadKey(missing)).toThrow(/cannot read key file .*nope\.nsec: ENOENT/);
  });

  test("errors never echo key material", () => {
    const bad = join(dir, "bad.nsec");
    writeFileSync(bad, "totally-not-a-key");
    try {
      loadKey(bad);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("totally-not-a-key");
    }
  });
});

describe("loadKeyValue (BUZZ_PRIVATE_KEY in-memory nsec value)", () => {
  test("loads an nsec value and derives pubkey + npub — no file touched", () => {
    const k = loadKeyValue(nsecEncode(sk));
    expect(k.pubkey).toBe(pubkey);
    expect(k.npub).toBe(npubEncode(pubkey));
    expect(k.sk).toEqual(sk);
  });

  test("a malformed value errors content-free — never echoes the value", () => {
    const poison = "nsec1-obviously-not-valid-bech32-secret";
    try {
      loadKeyValue(poison);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(poison);
      expect(msg).not.toContain("obviously-not-valid");
    }
  });
});
