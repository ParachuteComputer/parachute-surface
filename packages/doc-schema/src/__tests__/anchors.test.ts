/**
 * TextQuoteSelector anchors: created from doc positions, resolved back by
 * quote + context, and — the load-bearing property — they SURVIVE the
 * markdown round-trip, because they re-anchor against text rather than
 * riding the content.
 */
import { describe, expect, test } from "bun:test";
import {
  createTextQuoteSelector,
  docToMarkdown,
  markdownToDoc,
  resolveTextQuoteSelector,
} from "../index";

const doc = markdownToDoc(
  "# Title\n\nThe quick brown fox jumps over the lazy dog.\n\nThe quick brown cat sleeps.",
);

/** Find the doc range of a substring via the resolver itself (exact-only). */
const rangeOf = (exact: string) =>
  resolveTextQuoteSelector(doc, { type: "TextQuoteSelector", exact });

describe("create + resolve", () => {
  test("round-trips a simple range", () => {
    const range = rangeOf("brown fox");
    expect(range).not.toBeNull();
    if (!range) return;
    const sel = createTextQuoteSelector(doc, range.from, range.to);
    expect(sel?.exact).toBe("brown fox");
    expect(resolveTextQuoteSelector(doc, sel ?? { type: "TextQuoteSelector", exact: "" })).toEqual(
      range,
    );
  });

  test("prefix/suffix disambiguate repeated text", () => {
    // "The quick brown " appears twice; context picks the second occurrence.
    const sel = {
      type: "TextQuoteSelector" as const,
      exact: "The quick brown",
      suffix: " cat",
    };
    const range = resolveTextQuoteSelector(doc, sel);
    const first = rangeOf("The quick brown");
    expect(range).not.toBeNull();
    expect(first).not.toBeNull();
    expect(range?.from).toBeGreaterThan(first?.from ?? Number.POSITIVE_INFINITY);
  });

  test("missing text resolves to null", () => {
    expect(resolveTextQuoteSelector(doc, { type: "TextQuoteSelector", exact: "zebra" })).toBeNull();
    expect(resolveTextQuoteSelector(doc, { type: "TextQuoteSelector", exact: "" })).toBeNull();
  });

  test("empty range yields no selector", () => {
    expect(createTextQuoteSelector(doc, 1, 1)).toBeNull();
  });
});

describe("anchors survive the markdown round-trip", () => {
  test("selector created on the original resolves on the re-parsed doc", () => {
    const range = rangeOf("lazy dog");
    expect(range).not.toBeNull();
    if (!range) return;
    const sel = createTextQuoteSelector(doc, range.from, range.to);
    expect(sel).not.toBeNull();
    if (!sel) return;
    const reparsed = markdownToDoc(docToMarkdown(doc));
    const resolved = resolveTextQuoteSelector(reparsed, sel);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(reparsed.textBetween(resolved.from, resolved.to)).toBe("lazy dog");
  });
});
