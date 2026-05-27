/**
 * Tests for `src/dev-injection.ts` — Phase 1.3 HTML script injection.
 *
 * Coverage:
 *   - Happy path: inject before </head>
 *   - Idempotent: re-injecting against an injected document is a no-op
 *   - Fallback 1: no </head> → before first <script>
 *   - Fallback 2: no </head> + no <script> → after <body>
 *   - Fallback 3: malformed doc → append, fallback flag set
 *   - The endpoint string is JSON-escaped (defense-in-depth)
 *   - The marker id is what callers expect
 */

import { describe, expect, test } from "bun:test";

import {
  DEV_RELOAD_SCRIPT_ID,
  buildDevReloadScript,
  injectDevReloadScript,
} from "../dev-injection.ts";

describe("buildDevReloadScript", () => {
  test("includes the marker id + escapes the endpoint", () => {
    const s = buildDevReloadScript("/surface/notes/_dev/reload");
    expect(s).toContain(`id="${DEV_RELOAD_SCRIPT_ID}"`);
    expect(s).toContain('"/surface/notes/_dev/reload"');
    expect(s).toContain("EventSource");
    expect(s).toContain("reload");
  });

  test("escapes a hostile endpoint string", () => {
    // Mount paths are PATH_PATTERN-constrained, but defense-in-depth still
    // applies — JSON.stringify makes embedded quotes safe. The hostile
    // closing-quote shouldn't break out of the EventSource(...) literal.
    const s = buildDevReloadScript('");alert(1);//');
    // Confirm the closing quote is escaped (preceded by a backslash inside
    // the JS string literal).
    expect(s).toContain('"\\");alert(1);//"');
    // And `alert(1)` is not an executable expression outside a string —
    // the closing `"` after `EventSource(` is the one from JSON.stringify,
    // not the operator-provided one.
    expect(s).toContain('new EventSource("\\");alert(1);//");');
  });
});

describe("injectDevReloadScript", () => {
  test("happy path: inserts before </head>", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    const r = injectDevReloadScript(html, "/surface/notes/_dev/reload");
    expect(r.injected).toBe(true);
    expect(r.fallback).toBeUndefined();
    expect(r.html).toContain(`id="${DEV_RELOAD_SCRIPT_ID}"`);
    // The script lands BEFORE </head>, not after.
    const scriptIdx = r.html.indexOf(`id="${DEV_RELOAD_SCRIPT_ID}"`);
    const headCloseIdx = r.html.toLowerCase().indexOf("</head>");
    expect(scriptIdx).toBeLessThan(headCloseIdx);
  });

  test("idempotent — second pass is a no-op", () => {
    const html = "<!doctype html><html><head></head></html>";
    const r1 = injectDevReloadScript(html, "/surface/n/_dev/reload");
    expect(r1.injected).toBe(true);
    const r2 = injectDevReloadScript(r1.html, "/surface/n/_dev/reload");
    expect(r2.injected).toBe(false);
    expect(r2.html).toBe(r1.html);
  });

  test("idempotent across endpoint changes (marker-based, not endpoint-based)", () => {
    // If someone re-renders with a different endpoint we still skip — the
    // marker id is the dedup signal. Edge case but worth pinning down.
    const html = "<!doctype html><html><head></head></html>";
    const r1 = injectDevReloadScript(html, "/surface/n/_dev/reload");
    const r2 = injectDevReloadScript(r1.html, "/surface/other/_dev/reload");
    expect(r2.injected).toBe(false);
  });

  test("case-insensitive </head> match", () => {
    const html = "<!doctype html><html><HEAD></HEAD><BODY></BODY></html>";
    const r = injectDevReloadScript(html, "/surface/n/_dev/reload");
    expect(r.injected).toBe(true);
    expect(r.fallback).toBeUndefined();
  });

  test("fallback 1: no </head> but a <script> tag → before-script", () => {
    const html = `<!doctype html><html><script src="x.js"></script><body></body></html>`;
    const r = injectDevReloadScript(html, "/surface/n/_dev/reload");
    expect(r.injected).toBe(true);
    expect(r.fallback).toBe("before-script");
    const ourScriptIdx = r.html.indexOf(`id="${DEV_RELOAD_SCRIPT_ID}"`);
    const userScriptIdx = r.html.indexOf("x.js");
    expect(ourScriptIdx).toBeLessThan(userScriptIdx);
  });

  test("fallback 2: no </head> no <script>, <body> only → after-body", () => {
    const html = "<!doctype html><html><body>hi</body></html>";
    const r = injectDevReloadScript(html, "/surface/n/_dev/reload");
    expect(r.injected).toBe(true);
    expect(r.fallback).toBe("after-body");
    const ourScriptIdx = r.html.indexOf(`id="${DEV_RELOAD_SCRIPT_ID}"`);
    const bodyOpenIdx = r.html.indexOf("<body>");
    expect(ourScriptIdx).toBeGreaterThan(bodyOpenIdx);
  });

  test("fallback 3: no structure at all → append", () => {
    const html = "just text";
    const r = injectDevReloadScript(html, "/surface/n/_dev/reload");
    expect(r.injected).toBe(true);
    expect(r.fallback).toBe("append");
    expect(r.html.startsWith("just text")).toBe(true);
    expect(r.html).toContain(`id="${DEV_RELOAD_SCRIPT_ID}"`);
  });

  test("preserves the original document around the insertion point", () => {
    const html = `<!doctype html><html><head><title>Notes</title></head><body><div id="app"></div></body></html>`;
    const r = injectDevReloadScript(html, "/surface/notes/_dev/reload");
    expect(r.html).toContain("<title>Notes</title>");
    expect(r.html).toContain(`<div id="app"></div>`);
    expect(r.html).toContain("</body></html>");
  });
});
