/**
 * Tests for `vault-id.ts` — URL → storage-key reduction + normalization.
 *
 * Mirrors notes' equivalent (vault/url.test.ts) coverage, plus a few
 * extra round-trip + drift cases that prompted notes#149.
 */

import { describe, expect, test } from "bun:test";

import { normalizeVaultUrl, vaultIdFromUrl } from "../vault-id.ts";

describe("vaultIdFromUrl", () => {
  test("strips https scheme", () => {
    expect(vaultIdFromUrl("https://example.com/vault/default")).toBe("example.com_vault_default");
  });

  test("strips http scheme", () => {
    expect(vaultIdFromUrl("http://127.0.0.1:1940/vault/default")).toBe(
      "127.0.0.1_1940_vault_default",
    );
  });

  test("collapses runs of non-word chars to single underscore", () => {
    expect(vaultIdFromUrl("https://example.com//vault///gitcoin")).toBe(
      "example.com_vault_gitcoin",
    );
  });

  test("preserves dots + dashes", () => {
    expect(vaultIdFromUrl("https://my-vault.example.com/vault/default")).toBe(
      "my-vault.example.com_vault_default",
    );
  });

  test("trailing slash maps to trailing underscore", () => {
    expect(vaultIdFromUrl("https://example.com/vault/")).toBe("example.com_vault_");
  });

  test("idempotent on a pre-stripped id (no scheme)", () => {
    expect(vaultIdFromUrl("example.com_vault_default")).toBe("example.com_vault_default");
  });
});

describe("normalizeVaultUrl", () => {
  test("rejects empty input", () => {
    expect(() => normalizeVaultUrl("")).toThrow();
    expect(() => normalizeVaultUrl("   ")).toThrow();
  });

  test("rejects scheme-less garbage", () => {
    // `javascript:alert(1)` looks scheme-less to the regex (no `http://`),
    // gets prepended with `https://`, then `new URL` rejects the result.
    // Whichever way the regex parses it, the function must not return a
    // non-http(s) URL.
    expect(() => normalizeVaultUrl("not a url")).toThrow();
  });

  test("adds https scheme when missing", () => {
    expect(normalizeVaultUrl("example.com/vault/default")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("preserves explicit http", () => {
    expect(normalizeVaultUrl("http://127.0.0.1:1940/vault/default")).toBe(
      "http://127.0.0.1:1940/vault/default",
    );
  });

  test("strips trailing slash", () => {
    expect(normalizeVaultUrl("https://example.com/vault/default/")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("strips /api suffix", () => {
    expect(normalizeVaultUrl("https://example.com/vault/default/api")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("strips /mcp suffix", () => {
    expect(normalizeVaultUrl("https://example.com/vault/default/mcp")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("strips well-known suffix", () => {
    expect(
      normalizeVaultUrl("https://example.com/vault/default/.well-known/oauth-authorization-server"),
    ).toBe("https://example.com/vault/default");
  });

  test("lowercases host", () => {
    expect(normalizeVaultUrl("https://EXAMPLE.COM/vault/default")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("drops query + fragment", () => {
    expect(normalizeVaultUrl("https://example.com/vault/default?x=1#h")).toBe(
      "https://example.com/vault/default",
    );
  });

  test("URL-drift round-trip stays sticky", () => {
    // The notes#149 fix: same operator pastes URL with vs. without
    // trailing slash on second visit — id must match.
    const a = vaultIdFromUrl(normalizeVaultUrl("https://example.com/vault/default/"));
    const b = vaultIdFromUrl(normalizeVaultUrl("example.com/vault/default"));
    expect(a).toBe(b);
  });
});
