/**
 * The lossiness contract, test-pinned (design doc trust decision §8):
 * headings, lists, task lists, and code blocks SURVIVE round-trips with
 * structure and attributes intact; comment anchors ride TextQuoteSelector
 * METADATA, never content — the schema has no comment vocabulary at all.
 */
import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc, markdownToDocJSON, schema } from "../index";

describe("survivors keep their structure", () => {
  test("headings keep level", () => {
    for (let level = 1; level <= 6; level++) {
      const doc = markdownToDoc(`${"#".repeat(level)} Title`);
      const h = doc.child(0);
      expect(h.type.name).toBe("heading");
      expect(h.attrs.level).toBe(level);
    }
  });

  test("task items keep checked state", () => {
    const json = markdownToDocJSON("- [ ] open\n- [x] done");
    const list = json.content?.[0] as {
      type: string;
      content: { type: string; attrs: { checked: boolean } }[];
    };
    expect(list.type).toBe("taskList");
    expect(list.content.map((i) => [i.type, i.attrs.checked])).toEqual([
      ["taskItem", false],
      ["taskItem", true],
    ]);
  });

  test("code blocks keep language", () => {
    const doc = markdownToDoc("```python\nprint(1)\n```");
    const code = doc.child(0);
    expect(code.type.name).toBe("codeBlock");
    expect(code.attrs.language).toBe("python");
    expect(code.textContent).toBe("print(1)");
  });

  test("code block content is NEVER escaped or marked", () => {
    const gnarly = "x = a[0] * b[1] # [[not a wikilink]] **not bold**";
    const md = `\`\`\`\n${gnarly}\n\`\`\``;
    const doc = markdownToDoc(md);
    expect(doc.child(0).textContent).toBe(gnarly);
    expect(docToMarkdown(doc)).toBe(md);
  });

  test("ordered list keeps start", () => {
    const doc = markdownToDoc("5. five\n6. six");
    expect(doc.child(0).attrs.start).toBe(5);
  });

  test("link keeps href and title", () => {
    const doc = markdownToDoc('[text](https://example.com "hover")');
    const mark = doc.child(0).child(0).marks[0];
    expect(mark?.type.name).toBe("link");
    expect(mark?.attrs.href).toBe("https://example.com");
    expect(mark?.attrs.title).toBe("hover");
  });
});

describe("comment anchors are metadata, not content", () => {
  test("the schema has NO comment vocabulary", () => {
    expect(schema.marks.comment).toBeUndefined();
    expect(schema.nodes.comment).toBeUndefined();
    expect(
      Object.keys(schema.nodes)
        .concat(Object.keys(schema.marks))
        .filter((n) => /comment|annotation|anchor/i.test(n)),
    ).toEqual([]);
  });

  test("markdown emission carries no anchor artifact", () => {
    // An anchored doc is just a doc — anchors live beside it (see anchors.ts).
    const md = "An anchored sentence lives here.";
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });
});

describe("documented canonicalizations (lossy in FORM, not in structure)", () => {
  test("setext headings become ATX", () => {
    expect(docToMarkdown(markdownToDoc("Title\n====="))).toBe("# Title");
  });

  test("* bullets become -", () => {
    expect(docToMarkdown(markdownToDoc("* a\n* b"))).toBe("- a\n- b");
  });

  test("underscore emphasis becomes asterisk", () => {
    expect(docToMarkdown(markdownToDoc("_i_ and __b__"))).toBe("*i* and **b**");
  });

  test("soft line breaks join with a space", () => {
    expect(docToMarkdown(markdownToDoc("one\ntwo"))).toBe("one two");
  });

  test("raw HTML stays literal text (html: false)", () => {
    const doc = markdownToDoc("before <em>raw</em> after");
    expect(doc.child(0).textContent).toBe("before <em>raw</em> after");
    // and no italic mark was conjured from the tag
    let marked = false;
    doc.descendants((n) => {
      if (n.marks.length > 0) marked = true;
    });
    expect(marked).toBe(false);
  });
});
