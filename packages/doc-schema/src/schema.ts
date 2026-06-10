/**
 * The shared document schema — ONE ProseMirror schema for every rich-text
 * Parachute surface, used identically by the browser editor (TipTap, via
 * `@openparachute/doc-schema/tiptap`) and the server codec (markdown ⇄ doc).
 *
 * This file is hand-built on `prosemirror-model` ONLY so the codec's import
 * graph stays free of TipTap (and of any DOM-typed code). The TipTap
 * extension list in `src/tiptap/index.ts` must compile to a schema that is
 * structurally identical to this one — that equivalence is pinned by
 * `src/__tests__/tiptap-parity.test.ts`. If you change anything here, change
 * the extension list (or its configuration) in the same commit; the parity
 * test is the tripwire.
 *
 * Node and mark NAMES follow TipTap's vocabulary (`bulletList`, `bold`, …),
 * not prosemirror-markdown's (`bullet_list`, `strong`, …), because the names
 * are persisted inside collaborative Y.Docs — the editor and the codec must
 * agree on them byte-for-byte.
 */
import { Schema } from "prosemirror-model";

export const schema = new Schema({
  topNode: "doc",
  nodes: {
    doc: {
      content: "block+",
    },
    paragraph: {
      content: "inline*",
      group: "block",
    },
    text: {
      group: "inline",
    },
    heading: {
      content: "inline*",
      group: "block",
      defining: true,
      attrs: { level: { default: 1 } },
    },
    blockquote: {
      content: "block+",
      group: "block",
      defining: true,
    },
    codeBlock: {
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
    },
    bulletList: {
      content: "listItem+",
      group: "block list",
    },
    orderedList: {
      content: "listItem+",
      group: "block list",
      attrs: { start: { default: 1 }, type: { default: null } },
    },
    listItem: {
      content: "paragraph block*",
      defining: true,
    },
    taskList: {
      content: "taskItem+",
      group: "block list",
    },
    taskItem: {
      // Matches TaskItem.configure({ nested: true }) in the extension list.
      content: "paragraph block*",
      defining: true,
      attrs: { checked: { default: false } },
    },
    horizontalRule: {
      group: "block",
    },
    hardBreak: {
      group: "inline",
      inline: true,
      selectable: false,
      linebreakReplacement: true,
    },
    image: {
      // Matches Image.configure({ inline: true }) in the extension list —
      // markdown images are inline. width/height exist for editor parity;
      // the markdown codec does not serialize them (see README lossiness).
      group: "inline",
      inline: true,
      draggable: true,
      attrs: {
        src: { default: null },
        alt: { default: null },
        title: { default: null },
        width: { default: null },
        height: { default: null },
      },
    },
  },
  // Mark ORDER is load-bearing: it defines mark rank, which orders nested
  // mark serialization. TipTap's Link extension carries priority 1000, so it
  // compiles FIRST regardless of list position — mirrored here and pinned by
  // the parity test: link, bold, code, italic, strike.
  marks: {
    link: {
      inclusive: false,
      // target/rel/class exist for editor parity (neutralized to null in the
      // extension list config); the markdown codec serializes href + title.
      attrs: {
        href: { default: null },
        target: { default: null },
        rel: { default: null },
        class: { default: null },
        title: { default: null },
      },
    },
    bold: {},
    code: {
      code: true,
      excludes: "_",
    },
    italic: {},
    strike: {},
  },
});
