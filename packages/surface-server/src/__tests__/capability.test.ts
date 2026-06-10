import { describe, expect, test } from "bun:test";
import { newSecret, newTokenId, signToken, verifyToken } from "../auth/capability.ts";

describe("capability token core", () => {
  const secret = newSecret();

  test("sign → verify roundtrip for both kinds", () => {
    for (const kind of ["cap", "lnk"] as const) {
      const id = newTokenId();
      const token = signToken(secret, kind, id);
      expect(token.startsWith(`${kind}_`)).toBe(true);
      expect(verifyToken(secret, token)).toEqual({ kind, id });
    }
  });

  test("tampered id fails", () => {
    const token = signToken(secret, "cap", newTokenId());
    const [head, sig] = token.split(".");
    expect(verifyToken(secret, `cap_${newTokenId()}.${sig}`)).toBeNull();
    expect(verifyToken(secret, `${head}.${sig}x`)).toBeNull();
  });

  test("kind swap fails (HMAC binds the kind)", () => {
    const id = newTokenId();
    const token = signToken(secret, "cap", id);
    const swapped = token.replace(/^cap_/, "lnk_");
    expect(verifyToken(secret, swapped)).toBeNull();
  });

  test("wrong secret fails", () => {
    const token = signToken(secret, "cap", newTokenId());
    expect(verifyToken(newSecret(), token)).toBeNull();
  });

  test("malformed shapes fail without throwing", () => {
    for (const bad of [
      "",
      "cap_",
      "cap_abc",
      "nope_abc.def",
      "cap_abc.def.ghi",
      "cap_abc.!!!",
      "Bearer cap_abc.def",
    ]) {
      expect(verifyToken(secret, bad)).toBeNull();
    }
  });

  test("token ids are unique and url-safe", () => {
    const ids = new Set(Array.from({ length: 64 }, () => newTokenId()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
