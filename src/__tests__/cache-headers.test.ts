/**
 * Tests for `src/cache-headers.ts` — smart cache header selector.
 *
 * Coverage (matches design doc section 18):
 *   - index.html → no-cache, no-store, must-revalidate
 *   - Content-hashed asset → public, max-age=31536000, immutable
 *   - Non-hashed asset → public, max-age=3600
 *   - PWA SW file (when meta opts in) → no-cache
 *   - Hash detector rejects short hashes (Vite's default ≥8)
 *   - Hash detector accepts middle-of-filename hashes
 */

import { describe, expect, test } from "bun:test";

import { cacheHeadersFor, looksContentHashed } from "../cache-headers.ts";
import type { UiMeta } from "../meta-schema.ts";

const minimalMeta: UiMeta = {
  name: "x",
  displayName: "X",
  path: "/app/x",
  scopes_required: ["vault:read"],
  pwa: false,
  public: false,
};

describe("cacheHeadersFor", () => {
  test("index.html → no-cache, no-store, must-revalidate", () => {
    expect(cacheHeadersFor("index.html", minimalMeta)).toEqual({
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
  });

  test("content-hashed JS → immutable", () => {
    expect(cacheHeadersFor("app.a3b9f2c1.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  test("content-hashed CSS → immutable", () => {
    expect(cacheHeadersFor("style.deadbeef12345.css", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  test("hash with hyphen separator → immutable", () => {
    expect(cacheHeadersFor("chunk-a3b9f2c1.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  test("non-hashed asset → 1-hour cache", () => {
    expect(cacheHeadersFor("icon.svg", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
    expect(cacheHeadersFor("logo.png", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
    expect(cacheHeadersFor("app.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
  });

  test("short hash (<8 chars) → 1-hour cache (conservative)", () => {
    expect(cacheHeadersFor("vendor-1234.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
    expect(cacheHeadersFor("app-abcdef.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
  });

  test("PWA service worker → no-cache when meta opts in", () => {
    const meta: UiMeta = { ...minimalMeta, pwa: true, pwa_service_worker: "sw.js" };
    expect(cacheHeadersFor("sw.js", meta)).toEqual({ "Cache-Control": "no-cache" });
  });

  test("SW filename not opted in → falls through to normal rules", () => {
    // meta.pwa false → sw.js should be treated as a normal asset (1h cache).
    expect(cacheHeadersFor("sw.js", minimalMeta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
  });

  test("PWA opt-in with different filename — that filename gets no-cache, not random others", () => {
    const meta: UiMeta = {
      ...minimalMeta,
      pwa: true,
      pwa_service_worker: "service-worker.js",
    };
    expect(cacheHeadersFor("service-worker.js", meta)).toEqual({ "Cache-Control": "no-cache" });
    // A different file isn't accidentally no-cached.
    expect(cacheHeadersFor("app.js", meta)).toEqual({
      "Cache-Control": "public, max-age=3600",
    });
  });

  test("meta-less call (admin endpoints) still serves rules", () => {
    expect(cacheHeadersFor("index.html")).toEqual({
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    expect(cacheHeadersFor("app.a3b9f2c1.js")).toEqual({
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });
});

describe("looksContentHashed", () => {
  test("8+ char hex hashes pass", () => {
    expect(looksContentHashed("app.a3b9f2c1.js")).toBe(true);
    expect(looksContentHashed("style.deadbeefcafebabe.css")).toBe(true);
    expect(looksContentHashed("chunk-a3b9f2c1.js")).toBe(true);
  });

  test("short hashes fail", () => {
    expect(looksContentHashed("vendor-1234.js")).toBe(false);
    expect(looksContentHashed("app-abc.js")).toBe(false);
  });

  test("date-like filenames fail (not hex when long)", () => {
    expect(looksContentHashed("app-2024.js")).toBe(false);
  });

  test("plain filenames fail", () => {
    expect(looksContentHashed("app.js")).toBe(false);
    expect(looksContentHashed("icon.svg")).toBe(false);
  });
});
