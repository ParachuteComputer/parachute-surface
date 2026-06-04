import { describe, expect, test } from "bun:test";

import {
  type PebblePayload,
  type QuickLog,
  buildReturnUrl,
  escapeAttr,
  escapeHtml,
  parseCurrent,
  parseQuickLogsText,
  quickLogsToText,
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
