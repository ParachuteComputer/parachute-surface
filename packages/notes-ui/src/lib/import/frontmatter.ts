/**
 * Tiny YAML frontmatter parser for the import path.
 *
 * Why not pull in `gray-matter` / `js-yaml`? The import surface only
 * needs to read the shapes Obsidian and similar tools emit:
 *
 *   - Scalars: `id: abc123`, `path: Projects/Foo`
 *   - Quoted strings: `title: "Hello, world"` / `'single'`
 *   - Inline arrays: `tags: [a, b, c]`
 *   - Block arrays: `tags:\n  - a\n  - b`
 *   - ISO dates: `created_at: 2024-05-01T10:00:00Z`
 *   - Numbers + booleans + nulls
 *
 * That's a 100-line subset of YAML, not the 8000-line spec. We pay the
 * cost of writing it ourselves to keep the bundle slim — no extra dep,
 * no surprise behavior on anchors/refs/multi-doc streams that the import
 * UX can't surface usefully anyway.
 *
 * Out of scope: nested objects deeper than one level (Obsidian doesn't
 * use them in frontmatter), folded strings (`>`), literal blocks (`|`),
 * tag aliases / anchors. If we encounter a key whose value we can't
 * confidently parse, we fall back to the raw string — the import path
 * stores it as a metadata bag value either way, so a string is harmless.
 */

export interface ParsedFrontmatter {
  /** Parsed key/value bag. `{}` when no frontmatter block was found. */
  data: Record<string, unknown>;
  /** Body content with the frontmatter block (and trailing newline) removed. */
  content: string;
}

/**
 * Strip frontmatter from a markdown source and parse the YAML block.
 * Returns `{ data: {}, content: raw }` when the source doesn't open with
 * a `---` fence — i.e. plain markdown passes through unchanged.
 *
 * Algorithm (kept byte-for-byte identical to the vault CLI's
 * `parseFrontmatter` so the two importers never diverge — see the
 * Obsidian alignment contract §1.1):
 *
 *   1. Strip a leading UTF-8 BOM (U+FEFF). Without this a BOM-prefixed
 *      file silently loses its frontmatter — the opening `﻿---`
 *      doesn't match an exact-`---` line. (Headline W1 fix.)
 *   2. Split on /\r?\n/ (CRLF-aware) into lines.
 *   3. If line[0] is not EXACTLY `---` → no frontmatter; return the
 *      BOM-stripped source as content.
 *   4. The closing fence is the FIRST subsequent line that is EXACTLY
 *      `---` — not `----`, not `---more`, not `  ---`. This line-scan
 *      replaces the older close regex; the regex already rejected
 *      `----`/`---more` correctly, but the line-scan removes any drift
 *      risk against the CLI on pathological "open, then `----`, then a
 *      real `---` close later" inputs.
 *   5. No exact-`---` close → unclosed; return the whole BOM-stripped
 *      source as content (never swallow the file).
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // 1. Strip a leading UTF-8 BOM before any fence matching.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // 2. CRLF-aware line split.
  const lines = source.split(/\r?\n/);

  // 3. Opening fence must be EXACTLY `---`.
  if (lines[0] !== "---") return { data: {}, content: source };

  // 4. Closing fence = first subsequent line that is EXACTLY `---`.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeIdx = i;
      break;
    }
  }

  // 5. Unclosed — treat the whole thing as content rather than silently
  // swallowing the file. Better to import a slightly-ugly note than lose it.
  if (closeIdx === -1) return { data: {}, content: source };

  const yamlBlock = lines.slice(1, closeIdx).join("\n");
  const body = lines.slice(closeIdx + 1).join("\n");
  return { data: parseBlock(yamlBlock), content: body };
}

function parseBlock(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const match = line.match(/^([\w][\w.-]*)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const key = match[1] as string;
    const valueText = (match[2] ?? "").trim();

    if (valueText === "") {
      // Block-form value: peek ahead. If the next non-blank line starts
      // with `- `, parse a block array. Otherwise emit the key with an
      // empty string — we don't support nested objects in v1 (no
      // Obsidian shape needs them).
      //
      // Don't gate on `indent > 0` — Obsidian's Properties panel emits
      // zero-indented block arrays for tags / aliases, e.g.
      //   tags:
      //   - work
      //   - idea
      // Gating on indent previously silently dropped these into an
      // empty-string value, which `mergeTags` then dissolved with no
      // error surfaced — note created without tags. Reviewer fold on #47.
      const peek = peekNextNonBlank(lines, i + 1);
      if (peek?.line.trimStart().startsWith("- ")) {
        const { items, consumed } = parseBlockArray(lines, i + 1, peek.indent);
        out[key] = items;
        i = i + 1 + consumed;
      } else {
        out[key] = "";
        i++;
      }
    } else {
      out[key] = parseScalarOrInline(valueText);
      i++;
    }
  }
  return out;
}

function parseBlockArray(
  lines: string[],
  start: number,
  arrayIndent: number,
): { items: unknown[]; consumed: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const indent = countLeadingSpaces(line);
    if (indent < arrayIndent) break;
    if (!line.slice(indent).startsWith("- ")) break;
    const after = line.slice(indent + 2).trim();
    items.push(parseScalarOrInline(after));
    i++;
  }
  return { items, consumed: i - start };
}

function peekNextNonBlank(lines: string[], from: number): { line: string; indent: number } | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    return { line, indent: countLeadingSpaces(line) };
  }
  return null;
}

function countLeadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

/**
 * Parse a scalar or inline-array value. Order matters: try array first
 * (cheapest distinguishing prefix `[`), then quoted strings, then
 * type-detected literals (booleans, null, numbers, ISO dates), falling
 * back to a trimmed raw string.
 */
function parseScalarOrInline(text: string): unknown {
  if (text.length === 0) return "";
  // Inline array: `[a, b, "c d"]`. We don't support nested arrays in
  // frontmatter — none of the Obsidian / loose-markdown sources we care
  // about emit them.
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitInlineArray(inner).map((item) => parseScalarOrInline(item.trim()));
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  // Number — integer or float, no scientific notation in the test corpus.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}

/**
 * Split an inline-array body on top-level commas, respecting quoted
 * strings. `a, b, "c, d"` → `["a", "b", "\"c, d\""]`.
 */
function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out;
}
