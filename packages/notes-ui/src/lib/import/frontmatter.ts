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

const FRONTMATTER_OPEN = /^---\r?\n/;

/**
 * Strip frontmatter from a markdown source and parse the YAML block.
 * Returns `{ data: {}, content: raw }` when the source doesn't open with
 * a `---` fence — i.e. plain markdown passes through unchanged.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!FRONTMATTER_OPEN.test(raw)) return { data: {}, content: raw };
  // Strip the opening fence + its newline before searching for the close
  // — otherwise a frontmatter block that opens *and* closes with `---`
  // at the very top would falsely match index 0.
  const afterOpen = raw.replace(FRONTMATTER_OPEN, "");
  const closeIdx = afterOpen.search(/\r?\n---\r?\n|\r?\n---$/);
  if (closeIdx === -1) {
    // Unclosed frontmatter — treat the whole thing as content rather than
    // silently swallowing the file. Better to import a slightly-ugly note
    // than to lose it.
    return { data: {}, content: raw };
  }
  const yamlBlock = afterOpen.slice(0, closeIdx);
  // Skip past the closing fence + its trailing newline (if any). The
  // search regex captures `\n---\n` or `\n---$`, both end at index
  // closeIdx; the close fence itself is 3 chars (`---`) plus the
  // leading newline (1-2 chars depending on line endings).
  const afterClose = afterOpen.slice(closeIdx).replace(/^\r?\n---\r?\n?/, "");
  return { data: parseBlock(yamlBlock), content: afterClose };
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
