import type { Note, NoteSummary } from "@/lib/vault/types";

// Human-readable title for a note, shared by every surface that renders a note
// in a list or header (Notes rows, the Today timeline, QuickSwitch results).
// The mono path stays as dim metadata beside the title, never the headline —
// this helper is what makes the headline human.
//
// Resolution order (matches the Layer-1 redesign spec):
//   1. the content's leading `# H1` (when the first non-blank line is one);
//   2. else the first non-empty line of content (leading `#`s stripped),
//      truncated;
//   3. else the path leaf (last segment, `.md` stripped);
//   4. else the id.
//
// List rows and the timeline fetch notes WITHOUT content, so they fall straight
// to the path leaf — the filename is the human title there. QuickSwitch loads
// content, so it gets the richer H1/first-line title (which also lets search
// match on a heading the path doesn't carry).

const MAX_TITLE_LEN = 120;

type TitleSource = Pick<Note, "id" | "path" | "content"> | NoteSummary;

export function noteTitle(note: TitleSource): string {
  const content = (note as { content?: string }).content;
  if (typeof content === "string") {
    const fromContent = titleFromContent(content);
    if (fromContent) return fromContent;
  }
  if (note.path) {
    const leaf = pathLeaf(note.path);
    if (leaf) return leaf;
  }
  return note.id;
}

// The text of a leading ATX H1 (`# Heading`) when the FIRST non-blank line is
// one, else null. Deliberately strict-first-line so it stays in lockstep with
// `stripLeadingH1`: a header derived from `leadingH1` is exactly the line the
// body strips, so a note is never titled by an H1 that still renders in its
// body (a buried `# …` or one inside a fenced code block is not a title).
// A single `#` + whitespace only; `##`+ are lower headings, not the title.
export function leadingH1(content: string | undefined | null): string | null {
  if (!content) return null;
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  const first = lines[i];
  if (first === undefined) return null;
  const m = first.match(/^#\s+(.+?)\s*$/);
  return m?.[1] ?? null;
}

// Remove a single leading H1 line (and the blank lines around it) so a note
// whose first line is `# Title` doesn't render the title twice when the title
// is promoted to a page header. Only touches a true leading H1.
export function stripLeadingH1(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  if (i < lines.length && /^#\s+\S/.test(lines[i] ?? "")) {
    lines.splice(0, i + 1);
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    return lines.join("\n");
  }
  return content;
}

// Last path segment without its `.md` extension.
export function pathLeaf(path: string): string {
  const segments = path.split("/");
  const last = segments[segments.length - 1] ?? path;
  return last.replace(/\.md$/i, "");
}

function titleFromContent(content: string): string | null {
  const h1 = leadingH1(content);
  if (h1) return truncateTitle(h1);
  for (const line of content.split("\n")) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (trimmed.length > 0) return truncateTitle(trimmed);
  }
  return null;
}

function truncateTitle(s: string): string {
  if (s.length <= MAX_TITLE_LEN) return s;
  return `${s.slice(0, MAX_TITLE_LEN - 1).trimEnd()}…`;
}
