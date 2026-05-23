/**
 * Tests for `src/tenancy-injection.ts` — runtime tenancy contract injection.
 *
 * The contract lives in
 * `parachute-patterns/patterns/runtime-tenancy-contract.md`. parachute-app
 * implements the producer side (this module); `@openparachute/app-client`
 * (parachute-app#22) consumes via typed helpers.
 *
 * Coverage:
 *   - Happy path: <base href>, <meta name="parachute-mount">, <meta name="parachute-hub">
 *     all injected immediately after <head>
 *   - Idempotency: re-injecting against a document that already declares
 *     `parachute-mount` is a no-op
 *   - Malformed document: missing <head> → skip + return raw + skipped="no-head"
 *   - <head> with attributes (lang, dir) still matches
 *   - HTML attribute escaping is correct for `&`, `<`, `>`, `"`
 *   - Custom mount slug (e.g. `/app/my-notes`) injects correct base + mount
 *   - Hub origin variants (loopback, https) round-trip through escaping
 */

import { describe, expect, test } from "bun:test";

import { escapeHtmlAttr, injectTenancyContract } from "../tenancy-injection.ts";

describe("escapeHtmlAttr", () => {
  test("escapes `&` first to avoid double-escaping", () => {
    expect(escapeHtmlAttr("a&b")).toBe("a&amp;b");
    expect(escapeHtmlAttr("&amp;")).toBe("&amp;amp;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtmlAttr('a"b')).toBe("a&quot;b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtmlAttr("<x>")).toBe("&lt;x&gt;");
  });

  test("passes through safe ASCII", () => {
    expect(escapeHtmlAttr("/app/notes")).toBe("/app/notes");
    expect(escapeHtmlAttr("https://parachute.example.com")).toBe("https://parachute.example.com");
  });
});

describe("injectTenancyContract — happy path", () => {
  test("injects <base href> + meta tags into <head>", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(true);
    expect(r.skipped).toBeUndefined();
    expect(r.html).toContain('<base href="/app/notes/">');
    expect(r.html).toContain('<meta name="parachute-mount" content="/app/notes">');
    expect(r.html).toContain('<meta name="parachute-hub" content="http://127.0.0.1:1939">');
  });

  test("inserts AFTER <head> opening tag (so injected <base> wins over any later <base>)", () => {
    const html = "<!doctype html><html><head><title>t</title></head><body></body></html>";
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    // Injected <base> should appear before <title>
    const baseIdx = r.html.indexOf("<base ");
    const titleIdx = r.html.indexOf("<title>");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(baseIdx).toBeLessThan(titleIdx);
  });

  test("<head> with attributes still matches (e.g. <head lang=en>)", () => {
    const html = `<html><head lang="en"><title>x</title></head></html>`;
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(true);
    expect(r.html).toContain('<base href="/app/notes/">');
    // Original attribute is preserved.
    expect(r.html).toContain('<head lang="en">');
  });

  test("custom mount slug — base href and mount meta both use it", () => {
    const html = "<html><head></head></html>";
    const r = injectTenancyContract(html, "/app/my-notes", "http://127.0.0.1:1939");
    expect(r.html).toContain('<base href="/app/my-notes/">');
    expect(r.html).toContain('<meta name="parachute-mount" content="/app/my-notes">');
  });

  test("hub origin can be https + non-loopback", () => {
    const html = "<html><head></head></html>";
    const r = injectTenancyContract(html, "/app/notes", "https://parachute.example.com");
    expect(r.html).toContain('<meta name="parachute-hub" content="https://parachute.example.com">');
  });
});

describe("injectTenancyContract — idempotency", () => {
  test("skips if `parachute-mount` meta is already present", () => {
    const html = `<html><head>
      <meta name="parachute-mount" content="/app/notes">
    </head></html>`;
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(false);
    expect(r.skipped).toBe("already-present");
    expect(r.html).toBe(html);
  });

  test("idempotent across two injection passes (real-world: re-serve)", () => {
    const html = "<html><head></head></html>";
    const first = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(first.injected).toBe(true);
    const second = injectTenancyContract(first.html, "/app/notes", "http://127.0.0.1:1939");
    expect(second.injected).toBe(false);
    expect(second.skipped).toBe("already-present");
    expect(second.html).toBe(first.html);
  });

  test("single-quoted attribute still triggers idempotency", () => {
    // Some templating systems emit single quotes — defense in depth.
    const html = `<html><head><meta name='parachute-mount' content='/app/notes'></head></html>`;
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(false);
    expect(r.skipped).toBe("already-present");
  });
});

describe("injectTenancyContract — malformed input", () => {
  test("no <head> → skip + skipped='no-head' + html unchanged", () => {
    const html = "<html><body>no head here</body></html>";
    const r = injectTenancyContract(html, "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(false);
    expect(r.skipped).toBe("no-head");
    expect(r.html).toBe(html);
  });

  test("empty string → skip", () => {
    const r = injectTenancyContract("", "/app/notes", "http://127.0.0.1:1939");
    expect(r.injected).toBe(false);
    expect(r.skipped).toBe("no-head");
  });
});

describe("injectTenancyContract — HTML escaping", () => {
  test("ampersand in hub origin is escaped", () => {
    // Mount paths are PATH_PATTERN-constrained so they can't contain `&`, but
    // hub origin is operator-configurable — defense in depth.
    const html = "<html><head></head></html>";
    const r = injectTenancyContract(html, "/app/notes", "http://h?a=1&b=2");
    expect(r.html).toContain('content="http://h?a=1&amp;b=2"');
    expect(r.html).not.toContain("a=1&b=2");
  });

  test("less-than / greater-than in hub origin are escaped", () => {
    const html = "<html><head></head></html>";
    const r = injectTenancyContract(html, "/app/notes", "http://h<x>");
    expect(r.html).toContain('content="http://h&lt;x&gt;"');
  });

  test("double-quote in hub origin is escaped (defense in depth)", () => {
    const html = "<html><head></head></html>";
    const r = injectTenancyContract(html, "/app/notes", 'http://h"break');
    // Should not break out of the attribute literal.
    expect(r.html).toContain('content="http://h&quot;break"');
    // The literal closing-quote-then-break sequence must not appear unescaped.
    expect(r.html).not.toContain('"http://h"break"');
  });
});
