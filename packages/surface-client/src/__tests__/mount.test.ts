/**
 * Tests for `mount.ts` — runtime tenancy contract consumer helpers.
 *
 * Each helper has its own describe block. Tests pass minimal Document
 * stubs (just enough `querySelector` to satisfy the lookups) rather
 * than spinning a full jsdom — the helpers are intentionally narrow
 * (read one tag, return a string) and a stub captures the entire
 * contract surface.
 *
 * Coverage shape mirrors the four helpers' decision branches:
 *
 *   - getMountBase  → present / trailing-slash / absent / empty /
 *                     non-absolute / null doc / doc without querySelector
 *   - getTenantId   → /surface/<slug> shapes (single + multi-char-slug) +
 *                     legacy /notes (null) + multi-segment (null) +
 *                     missing mount (null)
 *   - getHubOrigin  → present + absent + trimmed
 *   - getVaultUrl   → cross-origin (case 1) + same-origin (case 2) +
 *                     no-origin (case 3) + missing meta (case 4) +
 *                     trailing-slash tolerance on origin
 */

import { describe, expect, test } from "bun:test";

import { getHubOrigin, getMountBase, getTenantId, getVaultUrl } from "../mount.ts";

/**
 * Minimal Document stub: a map of meta-name → content. Returns a fake
 * `HTMLMetaElement` (just enough for the `.content` access path) when
 * the selector matches a known tag, `null` otherwise.
 *
 * Selectors we recognise are exactly `meta[name="<name>"]` — the only
 * shape `readMetaContent` emits. Anything else returns null, which is
 * also the right answer for "the helper asked for a tag we don't have."
 */
function makeDoc(tags: Record<string, string>): Document {
  return {
    querySelector(selector: string): HTMLMetaElement | null {
      // Extract name from `meta[name="<name>"]`. Single-quoted variants
      // not needed — the production code emits double-quoted.
      const match = /^meta\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return null;
      const name = match[1];
      if (name === undefined) return null;
      const content = tags[name];
      if (content === undefined) return null;
      return { content } as unknown as HTMLMetaElement;
    },
  } as unknown as Document;
}

describe("getMountBase", () => {
  test("reads <meta name=parachute-mount> content", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/notes" });
    expect(getMountBase({ doc })).toBe("/surface/notes");
  });

  test("strips trailing slash if present (tolerant of host variants)", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/notes/" });
    expect(getMountBase({ doc })).toBe("/surface/notes");
  });

  test("returns null when the meta tag is absent", () => {
    const doc = makeDoc({});
    expect(getMountBase({ doc })).toBeNull();
  });

  test("returns null on empty content", () => {
    const doc = makeDoc({ "parachute-mount": "" });
    expect(getMountBase({ doc })).toBeNull();
  });

  test("returns null on whitespace-only content", () => {
    const doc = makeDoc({ "parachute-mount": "   " });
    expect(getMountBase({ doc })).toBeNull();
  });

  test("returns null on content that doesn't start with /", () => {
    // Malformed by the contract — `parachute-mount` is always an
    // absolute path. Guard against accidental `app/notes` (no leading
    // slash) so router basenames don't silently misbehave.
    const doc = makeDoc({ "parachute-mount": "app/notes" });
    expect(getMountBase({ doc })).toBeNull();
  });

  test("returns null on bare '/' (not a valid mount)", () => {
    // Bare "/" would silently mis-configure a React Router basename.
    // The contract requires /surface/<slug> or a legacy mount like /notes.
    const doc = makeDoc({ "parachute-mount": "/" });
    expect(getMountBase({ doc })).toBeNull();
  });

  test("doc=null returns null", () => {
    expect(getMountBase({ doc: null })).toBeNull();
  });

  test("doc without querySelector returns null", () => {
    // Defensive: some test harnesses pass `{}` as a doc; the helper
    // must not crash on the missing method.
    const broken = {} as Document;
    expect(getMountBase({ doc: broken })).toBeNull();
  });

  test("preserves multi-char slug names", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/my-notes" });
    expect(getMountBase({ doc })).toBe("/surface/my-notes");
  });
});

describe("getTenantId", () => {
  test("/surface/notes → 'notes'", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/notes" });
    expect(getTenantId({ doc })).toBe("notes");
  });

  test("/surface/my-notes → 'my-notes' (hyphens allowed)", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/my-notes" });
    expect(getTenantId({ doc })).toBe("my-notes");
  });

  test("/surface/notes_v2 → 'notes_v2' (underscores allowed)", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/notes_v2" });
    expect(getTenantId({ doc })).toBe("notes_v2");
  });

  test("/notes → null (legacy mount, no tenant id)", () => {
    const doc = makeDoc({ "parachute-mount": "/notes" });
    expect(getTenantId({ doc })).toBeNull();
  });

  test("/surface/foo/bar → null (multi-segment, not the tenant pattern)", () => {
    const doc = makeDoc({ "parachute-mount": "/surface/foo/bar" });
    expect(getTenantId({ doc })).toBeNull();
  });

  test("/surface → null (missing tenant segment)", () => {
    const doc = makeDoc({ "parachute-mount": "/surface" });
    expect(getTenantId({ doc })).toBeNull();
  });

  test("no mount tag → null", () => {
    const doc = makeDoc({});
    expect(getTenantId({ doc })).toBeNull();
  });

  test("/surface/Notes (uppercase) → null (slug grammar is lowercase)", () => {
    // Matches parachute-surface's PATH_PATTERN: `[a-z0-9][a-z0-9_-]*`.
    // Uppercase wouldn't survive validation on the producer side, but
    // the consumer also rejects it for symmetry.
    const doc = makeDoc({ "parachute-mount": "/surface/Notes" });
    expect(getTenantId({ doc })).toBeNull();
  });
});

describe("getHubOrigin", () => {
  test("reads <meta name=parachute-hub>", () => {
    const doc = makeDoc({ "parachute-hub": "http://127.0.0.1:1939" });
    expect(getHubOrigin({ doc })).toBe("http://127.0.0.1:1939");
  });

  test("returns null when absent", () => {
    const doc = makeDoc({});
    expect(getHubOrigin({ doc })).toBeNull();
  });

  test("trims whitespace", () => {
    const doc = makeDoc({ "parachute-hub": "  https://hub.example.com  " });
    expect(getHubOrigin({ doc })).toBe("https://hub.example.com");
  });

  test("doc=null returns null", () => {
    expect(getHubOrigin({ doc: null })).toBeNull();
  });
});

describe("getVaultUrl", () => {
  test("case 2 (same-origin): vault meta + explicit origin → joined URL", () => {
    const doc = makeDoc({ "parachute-vault": "/vault/default" });
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBe(
      "https://hub.example.com/vault/default",
    );
  });

  test("case 1 (cross-origin): vault + vault-origin → uses vault-origin", () => {
    const doc = makeDoc({
      "parachute-vault": "/vault/default",
      "parachute-vault-origin": "https://vault.example.com",
    });
    // The browser origin is irrelevant when vault-origin is present.
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBe(
      "https://vault.example.com/vault/default",
    );
  });

  test("case 4 (no meta): returns null even with origin set", () => {
    const doc = makeDoc({});
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBeNull();
  });

  test("case 3 (no origin): returns path only, no leading-slash drift", () => {
    // SSR / non-DOM context: vault meta is present but there's no
    // browser origin to join against. Returning the path lets
    // same-origin fetches succeed (fetch resolves relative URLs
    // against the document); cross-origin SSR callers must supply
    // an explicit `origin`.
    const doc = makeDoc({ "parachute-vault": "/vault/default" });
    expect(getVaultUrl({ doc, origin: undefined as unknown as string })).toBe("/vault/default");
  });

  test("tolerates trailing slash on origin (joinOriginAndPath strips it)", () => {
    const doc = makeDoc({ "parachute-vault": "/vault/default" });
    expect(getVaultUrl({ doc, origin: "https://hub.example.com/" })).toBe(
      "https://hub.example.com/vault/default",
    );
  });

  test("tolerates trailing slash on vault-origin", () => {
    const doc = makeDoc({
      "parachute-vault": "/vault/default",
      "parachute-vault-origin": "https://vault.example.com/",
    });
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBe(
      "https://vault.example.com/vault/default",
    );
  });

  test("vault-origin without vault meta → null (vault-origin alone is meaningless)", () => {
    // Cross-origin requires BOTH tags — the origin tells you where,
    // the path tells you which vault. Origin alone is unactionable.
    const doc = makeDoc({ "parachute-vault-origin": "https://vault.example.com" });
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBeNull();
  });

  test("custom vault name (/vault/my-vault) resolves correctly", () => {
    const doc = makeDoc({ "parachute-vault": "/vault/my-vault" });
    expect(getVaultUrl({ doc, origin: "https://hub.example.com" })).toBe(
      "https://hub.example.com/vault/my-vault",
    );
  });
});
