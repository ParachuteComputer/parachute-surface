/**
 * Schema parity — the contract that makes "one schema, two faces" true.
 *
 * The codec's hand-built schema (src/schema.ts, prosemirror-model only) and
 * the schema TipTap compiles from `docSchemaExtensions` must be structurally
 * identical: same node/mark names, same content expressions, same groups,
 * same attributes with the same defaults, same mark rank order. Node type
 * names and attrs are PERSISTED inside collaborative Y.Docs — drift here is
 * data corruption, so this suite is the tripwire for any change to either
 * side.
 */
import { describe, expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import type { MarkType, NodeType } from "prosemirror-model";
import { markdownToDocJSON, schema } from "../index";
import { docSchemaExtensions } from "../tiptap/index";

const tiptapSchema = getSchema(docSchemaExtensions);

const attrDefaults = (type: NodeType | MarkType) =>
  Object.fromEntries(
    Object.entries(type.spec.attrs ?? {}).map(([name, spec]) => [name, spec.default ?? null]),
  );

describe("codec schema ≡ TipTap-compiled schema", () => {
  test("same node names", () => {
    expect(Object.keys(tiptapSchema.nodes).sort()).toEqual(Object.keys(schema.nodes).sort());
  });

  test("same mark names IN THE SAME RANK ORDER", () => {
    // Mark order defines rank (serialization nesting); Link's priority 1000
    // hoists it first in TipTap, mirrored in the codec schema.
    expect(Object.keys(tiptapSchema.marks)).toEqual(Object.keys(schema.marks));
  });

  for (const name of Object.keys(schema.nodes)) {
    test(`node ${name}: content, group, inline, attrs`, () => {
      const codec = schema.nodes[name];
      const tiptap = tiptapSchema.nodes[name];
      if (!codec || !tiptap) throw new Error(`node ${name} missing on one side`);
      expect(tiptap.spec.content ?? "").toBe(codec.spec.content ?? "");
      expect(tiptap.spec.group ?? "").toBe(codec.spec.group ?? "");
      expect(tiptap.isInline).toBe(codec.isInline);
      expect(attrDefaults(tiptap)).toEqual(attrDefaults(codec));
    });
  }

  for (const name of Object.keys(schema.marks)) {
    test(`mark ${name}: attrs`, () => {
      const codec = schema.marks[name];
      const tiptap = tiptapSchema.marks[name];
      if (!codec || !tiptap) throw new Error(`mark ${name} missing on one side`);
      expect(attrDefaults(tiptap)).toEqual(attrDefaults(codec));
    });
  }

  test("top node is doc on both sides", () => {
    expect(schema.topNodeType.name).toBe("doc");
    expect(tiptapSchema.topNodeType.name).toBe("doc");
  });
});

describe("cross-schema interop", () => {
  test("codec-produced JSON rehydrates under the TipTap schema unchanged", async () => {
    const { Node } = await import("prosemirror-model");
    const json = markdownToDocJSON(
      "# Title\n\n- [x] a task with **bold**, [[wiki]] and [link](https://x.y)\n\n```ts\ncode\n```",
    );
    const viaTipTap = Node.fromJSON(tiptapSchema, json);
    expect(JSON.stringify(viaTipTap.toJSON())).toBe(JSON.stringify(json));
  });
});
