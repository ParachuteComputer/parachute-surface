/**
 * Comment anchors — W3C TextQuoteSelector over the shared schema.
 *
 * The lossiness contract's hard rule: comment anchors ride selector METADATA
 * (in the `#comments` overlay doc / note metadata), never document content.
 * The schema deliberately has no comment mark or node, so a doc round-trips
 * through markdown without any anchor artifact — and an anchor survives that
 * round-trip because it re-resolves against the text, not against positions.
 *
 * https://www.w3.org/TR/annotation-model/#text-quote-selector
 */
import type { Node } from "prosemirror-model";

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  /** The selected text itself. */
  exact: string;
  /** Up to `contextLength` characters immediately before the selection. */
  prefix?: string;
  /** Up to `contextLength` characters immediately after the selection. */
  suffix?: string;
}

const DEFAULT_CONTEXT_LENGTH = 32;

interface TextIndex {
  /** The document's text: text nodes joined, blocks separated by "\n". */
  text: string;
  /** toPos[i] = the ProseMirror position of text[i]. */
  toPos: number[];
}

function buildTextIndex(doc: Node): TextIndex {
  let text = "";
  const toPos: number[] = [];
  let pastFirstBlock = false;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (pastFirstBlock) {
        text += "\n";
        toPos.push(pos); // the boundary maps to the block's opening position
      }
      pastFirstBlock = true;
      return true;
    }
    if (node.isText) {
      const t = node.text ?? "";
      for (let i = 0; i < t.length; i++) toPos.push(pos + i);
      text += t;
      return false;
    }
    if (node.type.name === "hardBreak") {
      text += "\n";
      toPos.push(pos);
      return false;
    }
    if (node.isLeaf && node.isInline) {
      text += "￼"; // object replacement char for atoms (e.g. image)
      toPos.push(pos);
      return false;
    }
    return true;
  });
  return { text, toPos };
}

/**
 * Build a selector for the doc range [from, to) (ProseMirror positions).
 * Returns null when the range contains no visible text.
 */
export function createTextQuoteSelector(
  doc: Node,
  from: number,
  to: number,
  contextLength = DEFAULT_CONTEXT_LENGTH,
): TextQuoteSelector | null {
  const { text, toPos } = buildTextIndex(doc);
  let start = -1;
  let end = -1;
  for (let i = 0; i < toPos.length; i++) {
    const pos = toPos[i] ?? -1;
    if (pos >= from && start === -1) start = i;
    if (pos < to) end = i + 1;
    if (pos >= to) break;
  }
  if (start === -1 || end <= start) return null;
  const selector: TextQuoteSelector = {
    type: "TextQuoteSelector",
    exact: text.slice(start, end),
  };
  const prefix = text.slice(Math.max(0, start - contextLength), start);
  const suffix = text.slice(end, end + contextLength);
  if (prefix) selector.prefix = prefix;
  if (suffix) selector.suffix = suffix;
  return selector;
}

/**
 * Resolve a selector back to ProseMirror positions. Multiple occurrences of
 * `exact` are disambiguated by prefix/suffix context (both > prefix > suffix
 * > first occurrence). Returns null when `exact` does not occur.
 */
export function resolveTextQuoteSelector(
  doc: Node,
  selector: TextQuoteSelector,
): { from: number; to: number } | null {
  if (!selector.exact) return null;
  const { text, toPos } = buildTextIndex(doc);
  let best: { start: number; score: number } | null = null;
  let at = text.indexOf(selector.exact);
  while (at !== -1) {
    let score = 0;
    if (selector.prefix && text.slice(0, at).endsWith(selector.prefix)) score += 2;
    if (selector.suffix && text.slice(at + selector.exact.length).startsWith(selector.suffix)) {
      score += 1;
    }
    if (!best || score > best.score) best = { start: at, score };
    at = text.indexOf(selector.exact, at + 1);
  }
  if (!best) return null;
  const startPos = toPos[best.start];
  const endPos = toPos[best.start + selector.exact.length - 1];
  if (startPos === undefined || endPos === undefined) return null;
  return { from: startPos, to: endPos + 1 };
}
