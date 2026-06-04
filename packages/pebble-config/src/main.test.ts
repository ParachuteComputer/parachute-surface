import { describe, expect, test } from "bun:test";

import {
  type DcrCacheStorage,
  type PebblePayload,
  type QuickLog,
  buildReturnUrl,
  dcrCacheKey,
  escapeAttr,
  escapeHtml,
  loadCachedClientId,
  parseCurrent,
  parseQuickLogsText,
  quickLogsToText,
  redirectUriFor,
  saveCachedClientId,
  validateReturnTo,
} from "./main.ts";

describe("parseCurrent", () => {
  test("returns empty config on null / empty / garbage", () => {
    expect(parseCurrent(null)).toEqual({});
    expect(parseCurrent("")).toEqual({});
    expect(parseCurrent("not-json")).toEqual({});
    expect(parseCurrent("[1,2,3]")).toEqual({});
  });

  test("extracts hub, vault, and quicklogs", () => {
    const raw = JSON.stringify({
      hub: "https://hub.example",
      vault: "work",
      quicklogs: [{ label: "Coffee", text: "had a coffee" }],
    });
    expect(parseCurrent(raw)).toEqual({
      hub: "https://hub.example",
      vault: "work",
      quicklogs: [{ label: "Coffee", text: "had a coffee" }],
    });
  });

  test("coerces malformed quicklog entries to empty strings + drops non-objects", () => {
    const raw = JSON.stringify({
      quicklogs: [{ label: 1, text: null }, "nope", { label: "ok" }],
    });
    expect(parseCurrent(raw)).toEqual({
      quicklogs: [
        { label: "", text: "" },
        { label: "ok", text: "" },
      ],
    });
  });

  test("ignores wrong-typed top-level fields", () => {
    const raw = JSON.stringify({ hub: 5, vault: true, quicklogs: "x" });
    expect(parseCurrent(raw)).toEqual({});
  });
});

describe("parseQuickLogsText", () => {
  test("splits `Label | text` per line, trimming whitespace", () => {
    const text = "Coffee | had a coffee\n  Walk |  went for a walk  \n";
    expect(parseQuickLogsText(text)).toEqual([
      { label: "Coffee", text: "had a coffee" },
      { label: "Walk", text: "went for a walk" },
    ]);
  });

  test("a line with no separator becomes label === text", () => {
    expect(parseQuickLogsText("Standup")).toEqual([{ label: "Standup", text: "Standup" }]);
  });

  test("blank lines are dropped", () => {
    expect(parseQuickLogsText("\n\n  \nA | b\n")).toEqual([{ label: "A", text: "b" }]);
  });

  test("text may contain its own pipe — only the first separates", () => {
    expect(parseQuickLogsText("Note | a | b | c")).toEqual([{ label: "Note", text: "a | b | c" }]);
  });
});

describe("quickLogsToText round-trip", () => {
  test("text -> logs -> text is stable for canonical form", () => {
    const canonical = "Coffee | had a coffee\nWalk | went for a walk";
    expect(quickLogsToText(parseQuickLogsText(canonical))).toBe(canonical);
  });

  test("logs -> text -> logs preserves entries", () => {
    const logs: QuickLog[] = [
      { label: "Coffee", text: "had a coffee" },
      { label: "Walk", text: "went for a walk" },
    ];
    expect(parseQuickLogsText(quickLogsToText(logs))).toEqual(logs);
  });
});

describe("buildReturnUrl", () => {
  const payload: PebblePayload = {
    hub: "https://hub.example",
    vault: "default",
    token: "tok",
    refresh_token: "ref",
    token_endpoint: "https://hub.example/oauth/token",
    client_id: "cid",
    quicklogs: [{ label: "A", text: "b" }],
  };

  test("appends URL-encoded JSON to return_to and decodes back to the payload", () => {
    const url = buildReturnUrl("pebblejs://close#", payload);
    expect(url.startsWith("pebblejs://close#")).toBe(true);
    const encoded = url.slice("pebblejs://close#".length);
    expect(JSON.parse(decodeURIComponent(encoded))).toEqual(payload);
  });
});

describe("validateReturnTo", () => {
  test("allows the pebblejs scheme through", () => {
    expect(validateReturnTo("pebblejs://close#")).toBe("pebblejs://close#");
  });

  test("collapses https / garbage / null to the default — the payload carries credentials", () => {
    expect(validateReturnTo("https://evil.example/steal?p=")).toBe("pebblejs://close#");
    expect(validateReturnTo("close#")).toBe("pebblejs://close#");
    expect(validateReturnTo(null)).toBe("pebblejs://close#");
  });
});

describe("escaping", () => {
  test("escapeHtml neutralizes angle brackets + ampersands", () => {
    expect(escapeHtml(`<b>&"</b>`)).toBe(`&lt;b&gt;&amp;"&lt;/b&gt;`);
  });

  test("escapeAttr additionally escapes double quotes", () => {
    expect(escapeAttr(`a"b<c`)).toBe("a&quot;b&lt;c");
  });
});

// The heart of the issue #81 fix: the redirect URI is built from the PAGE'S
// OWN origin (not the daemon's loopback origin), with the standard
// `/oauth/callback` (slash) path that DCR registers — so the hub's exact-match
// validation passes on any remotely-served install. In the Bun test runtime
// there's no `document`, so `getMountBase()` returns null and we fall back to
// the canonical `/surface/pebble-config` mount.
describe("redirectUriFor", () => {
  test("uses the supplied origin + the standard slash callback path", () => {
    expect(redirectUriFor("https://parachute.taildf9ce2.ts.net")).toBe(
      "https://parachute.taildf9ce2.ts.net/surface/pebble-config/oauth/callback",
    );
  });

  test("is origin-agnostic — a Cloudflare origin yields its own callback", () => {
    expect(redirectUriFor("https://hub.example.com")).toBe(
      "https://hub.example.com/surface/pebble-config/oauth/callback",
    );
  });

  test("tolerates a trailing slash on the origin", () => {
    expect(redirectUriFor("https://hub.example.com/")).toBe(
      "https://hub.example.com/surface/pebble-config/oauth/callback",
    );
  });

  test("never spells the callback path with a dash (the old loopback-record bug)", () => {
    expect(redirectUriFor("https://hub.example.com")).not.toContain("oauth-callback");
  });
});

// DCR client_id cache: one client_id per (issuer, redirectUri), re-registered
// when the redirect URI changes (the hub binds client_id to redirect_uri).
describe("DCR client_id cache", () => {
  function makeStore(): DcrCacheStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
    };
  }

  test("round-trips a client_id for a matching (issuer, redirectUri)", () => {
    const store = makeStore();
    const issuer = "https://hub.example.com";
    const redirectUri = "https://hub.example.com/surface/pebble-config/oauth/callback";
    expect(loadCachedClientId(issuer, redirectUri, store)).toBeNull();
    saveCachedClientId(issuer, redirectUri, "client-abc", store);
    expect(loadCachedClientId(issuer, redirectUri, store)).toBe("client-abc");
  });

  test("misses (forces re-registration) when the redirect URI changed", () => {
    const store = makeStore();
    const issuer = "https://hub.example.com";
    saveCachedClientId(issuer, "https://hub.example.com/old/oauth/callback", "client-abc", store);
    expect(
      loadCachedClientId(issuer, "https://hub.example.com/new/oauth/callback", store),
    ).toBeNull();
  });

  test("normalizes the issuer key so trailing-slash variants share one entry", () => {
    expect(dcrCacheKey("https://hub.example.com/")).toBe(dcrCacheKey("https://hub.example.com"));
  });

  test("returns null on a corrupt cache entry rather than throwing", () => {
    const store = makeStore();
    store.map.set(dcrCacheKey("https://hub.example.com"), "{not json");
    expect(
      loadCachedClientId(
        "https://hub.example.com",
        "https://hub.example.com/surface/pebble-config/oauth/callback",
        store,
      ),
    ).toBeNull();
  });
});
