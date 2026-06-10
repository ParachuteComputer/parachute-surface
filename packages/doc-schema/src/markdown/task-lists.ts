/**
 * GFM task lists for markdown-it, AST-shaped for the ProseMirror parser.
 *
 * markdown-it has no native task-list support and the popular
 * `markdown-it-task-lists` plugin is renderer-oriented (it injects
 * `html_inline` checkbox tokens — useless for building a document tree). This
 * core rule rewrites the token stream instead:
 *
 * - a `bullet_list` whose direct items ALL begin with `[ ] ` / `[x] ` becomes
 *   `taskList_open … taskList_close`;
 * - each of its `list_item`s becomes `taskItem_open` (with a `checked` attr)
 *   and the marker text is stripped from the inline content.
 *
 * Mixed lists (only some items carry the marker) are left untouched — the
 * `[ ]` stays literal text and round-trips byte-stably (the serializer
 * re-escapes it). That keeps the rule total and unambiguous; it mirrors the
 * schema's constraint that a taskList contains only taskItems.
 */
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const TASK_MARKER = /^\[( |x|X)\] /;
const CHECKED_MARKER = /^\[[xX]\] /;

/** Index of the token closing the open token at `openIdx`, by nesting depth. */
function findClose(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let k = openIdx; k < tokens.length; k++) {
    depth += tokens[k]?.nesting ?? 0;
    if (depth === 0) return k;
  }
  return tokens.length - 1;
}

/** Direct `list_item_open` children of the list spanning (openIdx, closeIdx). */
function directItems(tokens: Token[], openIdx: number, closeIdx: number): number[] {
  const openLevel = tokens[openIdx]?.level ?? 0;
  const items: number[] = [];
  for (let k = openIdx + 1; k < closeIdx; k++) {
    const tok = tokens[k];
    if (tok && tok.type === "list_item_open" && tok.level === openLevel + 1) items.push(k);
  }
  return items;
}

/**
 * The first inline token of the item's leading paragraph, or null when the
 * item doesn't start with a paragraph (e.g. it opens with a nested list).
 */
function leadingInline(tokens: Token[], itemIdx: number): Token | null {
  const para = tokens[itemIdx + 1];
  const inline = tokens[itemIdx + 2];
  if (!para || para.type !== "paragraph_open") return null;
  if (!inline || inline.type !== "inline") return null;
  return inline;
}

function isTaskItem(tokens: Token[], itemIdx: number): boolean {
  const inline = leadingInline(tokens, itemIdx);
  const first = inline?.children?.[0];
  // The marker must be literal text — `[x](url)` parses as a link token and
  // is therefore never mistaken for a checkbox.
  return Boolean(first && first.type === "text" && TASK_MARKER.test(first.content));
}

export function taskListPlugin(md: MarkdownIt): void {
  // Pushed to the end of the core chain: runs after `inline` and `text_join`,
  // so inline children are fully parsed and adjacent text tokens are merged.
  md.core.ruler.push("parachute_task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      if (!open || open.type !== "bullet_list_open") continue;
      const closeIdx = findClose(tokens, i);
      const items = directItems(tokens, i, closeIdx);
      if (items.length === 0) continue;
      if (!items.every((j) => isTaskItem(tokens, j))) continue;

      open.type = "taskList_open";
      const close = tokens[closeIdx];
      if (close) close.type = "taskList_close";

      for (const j of items) {
        const itemOpen = tokens[j];
        const itemClose = tokens[findClose(tokens, j)];
        const inline = leadingInline(tokens, j);
        const first = inline?.children?.[0];
        if (!itemOpen || !itemClose || !inline || !first) continue; // unreachable per isTaskItem
        const checked = CHECKED_MARKER.test(first.content);
        first.content = first.content.slice(4);
        inline.content = inline.content.slice(4);
        itemOpen.type = "taskItem_open";
        itemOpen.attrSet("checked", String(checked));
        itemClose.type = "taskItem_close";
      }
    }
    return true;
  });
}
