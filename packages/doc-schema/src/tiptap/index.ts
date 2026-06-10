/**
 * The TipTap extension list — the browser-editor face of the shared schema.
 *
 * `getSchema(docSchemaExtensions)` compiles to a schema structurally
 * identical to the hand-built one in `../schema` (pinned by
 * `src/__tests__/tiptap-parity.test.ts`). Surfaces pass this list to their
 * `Editor`/`useEditor` and add BEHAVIOR-only extensions on top (history is
 * deliberately absent here — collaborative docs get undo from Yjs, not from
 * the editor); anything that would CHANGE the schema belongs in this package
 * instead, as a version bump.
 *
 * Browser-only by design: this subpath (`@openparachute/doc-schema/tiptap`)
 * pulls TipTap into the import graph. Servers import the package root and
 * never load this file.
 *
 * Extension versions are EXACT-pinned in package.json: the extension list is
 * a schema definition, and a floating range could silently change the schema
 * out from under persisted docs.
 */
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Image } from "@tiptap/extension-image";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";

/**
 * Mark rank order compiles to: link, bold, code, italic, strike — Link's
 * built-in priority (1000) hoists it ahead of declaration order. `../schema`
 * mirrors that exact order and the parity test pins it.
 */
export const docSchemaExtensions = [
  Document,
  Paragraph,
  Text,
  Heading,
  Blockquote,
  CodeBlock,
  BulletList,
  OrderedList,
  ListItem,
  TaskList,
  // nested: true → content "paragraph block*", matching listItem (and the
  // markdown reality that task items can hold nested lists/blocks).
  TaskItem.configure({ nested: true }),
  HorizontalRule,
  HardBreak,
  // Markdown images are inline.
  Image.configure({ inline: true }),
  Bold,
  Code,
  Italic,
  // Neutralize TipTap's presentational attr defaults (target="_blank",
  // rel="noopener …") — the shared schema keeps the attrs (editor parity)
  // with null defaults; the codec serializes only href + title.
  Link.configure({
    openOnClick: false,
    HTMLAttributes: { target: null, rel: null, class: null },
  }),
  Strike,
];
