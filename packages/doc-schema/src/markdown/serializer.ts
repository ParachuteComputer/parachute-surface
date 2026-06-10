/**
 * doc → markdown, over the shared schema.
 *
 * Adapted from prosemirror-markdown's defaultMarkdownSerializer (which
 * targets its snake_case schema) with two deliberate divergences:
 *
 * - **Wikilinks survive verbatim.** prosemirror-markdown escapes `[` and `]`
 *   in text, which would corrupt `[[wikilinks]]` into `\[\[wikilinks\]\]`.
 *   The text handler below splits text on the wikilink pattern and writes
 *   wikilink spans unescaped while everything around them keeps the normal
 *   escaping (so literal brackets like `array[0]` still escape correctly and
 *   never turn into links on re-parse).
 *
 * - **Lists serialize tight** (`tightLists: true` is applied by
 *   `docToMarkdown`). The schema has no per-list `tight` attr (TipTap
 *   doesn't), and notes are overwhelmingly written tight — loose-by-default
 *   would rewrite `- a\n- b` into `- a\n\n- b` on every save.
 */
import { MarkdownSerializer, type MarkdownSerializerState } from "prosemirror-markdown";
import type { Mark, Node } from "prosemirror-model";

/**
 * The wikilink pattern the serializer protects from escaping: `[[target]]`
 * or `[[target|alias]]` — no nested brackets, no newlines.
 */
export const WIKILINK_PATTERN = /\[\[[^[\]\n]+\]\]/g;

/**
 * prosemirror-markdown's default serializer threads an `inAutolink` flag
 * through the state at runtime without declaring it in the public types;
 * this codec does the same, typed once here.
 */
const autolink = (state: MarkdownSerializerState): { inAutolink?: boolean } =>
  state as unknown as { inAutolink?: boolean };

function writeTextPreservingWikilinks(state: MarkdownSerializerState, text: string): void {
  WIKILINK_PATTERN.lastIndex = 0;
  let last = 0;
  for (const match of text.matchAll(WIKILINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) state.text(text.slice(last, index), true);
    state.text(match[0], false); // verbatim — no escaping inside [[...]]
    last = index + match[0].length;
  }
  if (last < text.length) state.text(text.slice(last), true);
}

// Ported from prosemirror-markdown (not exported there): pick a backtick
// fence longer than any run inside the inline-code text.
function backticksFor(node: Node, side: -1 | 1): string {
  const ticks = /`+/g;
  let len = 0;
  if (node.isText) {
    let m = ticks.exec(node.text ?? "");
    while (m) {
      len = Math.max(len, m[0].length);
      m = ticks.exec(node.text ?? "");
    }
  }
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

// Ported from prosemirror-markdown (not exported there): a link whose text is
// exactly its href serializes as an autolink `<https://…>`.
function isPlainURL(link: Mark, parent: Node, index: number): boolean {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (
    !content.isText ||
    content.text !== link.attrs.href ||
    content.marks[content.marks.length - 1] !== link
  ) {
    return false;
  }
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}

export const serializer = new MarkdownSerializer(
  {
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    codeBlock(state, node) {
      // Fence must outrun any backtick run inside the code
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : "```";
      state.write(`${fence}${node.attrs.language || ""}\n`);
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${state.repeat("#", node.attrs.level)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    horizontalRule(state, node) {
      state.write("---");
      state.closeBlock(node);
    },
    bulletList(state, node) {
      state.renderList(node, "  ", () => "- ");
    },
    orderedList(state, node) {
      const start = node.attrs.start || 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxW + 2);
      state.renderList(node, space, (i) => {
        const nStr = String(start + i);
        return `${state.repeat(" ", maxW - nStr.length) + nStr}. `;
      });
    },
    listItem(state, node) {
      state.renderContent(node);
    },
    taskList(state, node) {
      state.renderList(node, "  ", (i) => (node.child(i).attrs.checked ? "- [x] " : "- [ ] "));
    },
    taskItem(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    image(state, node) {
      state.write(
        `![${state.esc(node.attrs.alt || "")}](${node.attrs.src.replace(/[()]/g, "\\$&")}${
          node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : ""
        })`,
      );
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state, node) {
      if (autolink(state).inAutolink) {
        state.text(node.text ?? "", false);
      } else {
        writeTextPreservingWikilinks(state, node.text ?? "");
      }
    },
  },
  {
    italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    link: {
      open(state, mark, parent, index) {
        autolink(state).inAutolink = isPlainURL(mark, parent, index);
        return autolink(state).inAutolink ? "<" : "[";
      },
      close(state, mark, _parent, _index) {
        const { inAutolink } = autolink(state);
        autolink(state).inAutolink = undefined;
        return inAutolink
          ? ">"
          : `](${mark.attrs.href.replace(/[()"]/g, "\\$&")}${
              mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : ""
            })`;
      },
      mixable: true,
    },
    code: {
      open(_state, _mark, parent, index) {
        return backticksFor(parent.child(index), -1);
      },
      close(_state, _mark, parent, index) {
        return backticksFor(parent.child(index - 1), 1);
      },
      escape: false,
    },
  },
);
