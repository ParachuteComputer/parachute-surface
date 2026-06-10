/**
 * markdown → doc, over the shared schema.
 *
 * Tokenizer: markdown-it in commonmark mode with HTML disabled (raw HTML
 * stays literal text — there is no HTML in the persistence format), GFM
 * strikethrough enabled, and the task-list core rule. Every token the
 * tokenizer can emit is mapped below; the prosemirror-markdown default token
 * map targets its own snake_case schema, so this map re-targets the TipTap
 * names the shared schema uses.
 */
import MarkdownIt from "markdown-it";
import { MarkdownParser } from "prosemirror-markdown";
import { schema } from "../schema";
import { taskListPlugin } from "./task-lists";

export const tokenizer: MarkdownIt = (() => {
  const md = new MarkdownIt("commonmark", { html: false });
  md.enable("strikethrough");
  md.use(taskListPlugin);
  return md;
})();

export const parser = new MarkdownParser(schema, tokenizer, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (tok) => ({ start: +(tok.attrGet("start") ?? "1") || 1 }),
  },
  taskList: { block: "taskList" },
  taskItem: {
    block: "taskItem",
    getAttrs: (tok) => ({ checked: tok.attrGet("checked") === "true" }),
  },
  heading: { block: "heading", getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    // fence info strings may carry extras ("ts title=x") — language is word 1
    getAttrs: (tok) => ({ language: tok.info.trim().split(/\s+/)[0] || null }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  image: {
    node: "image",
    getAttrs: (tok) => ({
      src: tok.attrGet("src"),
      title: tok.attrGet("title") || null,
      alt: tok.children?.[0]?.content || null,
    }),
  },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  s: { mark: "strike" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
    }),
  },
  code_inline: { mark: "code", noCloseToken: true },
});
