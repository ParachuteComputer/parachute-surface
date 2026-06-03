import type { Root } from "mdast";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { type WikilinkResolver, remarkWikilinks } from "../markdown/remark-wikilinks.js";

// A resolver in the new {href, exists} contract. notes-ui-style: /n/<id>.
function notesResolver(map: Record<string, string>): WikilinkResolver {
  return (target) => {
    const id = map[target];
    if (id) return { href: `/n/${encodeURIComponent(id)}`, exists: true };
    return null;
  };
}

// my-vault-ui-style: entity paths via an index, unresolved → null.
function entityResolver(index: Record<string, string>): WikilinkResolver {
  return (target) => {
    const slug = index[target];
    if (slug) return { href: `/entity/${slug}`, exists: true };
    return null;
  };
}

function processToTree(md: string, resolve: WikilinkResolver): Root {
  const tree = unified().use(remarkParse).use(remarkWikilinks, { resolve }).parse(md);
  return unified().use(remarkWikilinks, { resolve }).runSync(tree) as Root;
}

interface NodeLike {
  type: string;
  url?: string;
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: NodeLike[];
}

function flatten(node: NodeLike, acc: NodeLike[] = []): NodeLike[] {
  acc.push(node);
  for (const child of node.children ?? []) flatten(child, acc);
  return acc;
}

describe("remarkWikilinks ({href, exists} resolver — decision D)", () => {
  it("emits a resolved link with the surface-chosen href (notes-ui /n/<id> space)", () => {
    const tree = processToTree("See [[Canon/Uni]].", notesResolver({ "Canon/Uni": "abc-123" }));
    const links = flatten(tree as unknown as NodeLike).filter((n) => n.type === "link");
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe("/n/abc-123");
    const cls = links[0]?.data?.hProperties?.className as string;
    expect(cls).toContain("wikilink-resolved");
    expect(links[0]?.children?.[0]?.value).toBe("Canon/Uni");
  });

  it("emits a resolved link in a DIFFERENT url space (my-vault-ui /entity/<slug>)", () => {
    const tree = processToTree("See [[Acme Corp]].", entityResolver({ "Acme Corp": "acme-corp" }));
    const links = flatten(tree as unknown as NodeLike).filter((n) => n.type === "link");
    expect(links[0]?.url).toBe("/entity/acme-corp");
    const cls = links[0]?.data?.hProperties?.className as string;
    expect(cls).toContain("wikilink-resolved");
  });

  it("renders unresolved (resolver returns null) as inert styled text, not a link", () => {
    const tree = processToTree("Orphan [[Missing/Note]].", notesResolver({}));
    const nodes = flatten(tree as unknown as NodeLike);
    // No link node for the unresolved target.
    expect(nodes.some((n) => n.type === "link")).toBe(false);
    const span = nodes.find((n) => n.data?.hName === "span");
    expect(span).toBeDefined();
    const cls = span?.data?.hProperties?.className as string;
    expect(cls).toContain("wikilink-unresolved");
    expect(span?.value).toBe("Missing/Note");
  });

  it("honors the display alias form [[target|Display]]", () => {
    const tree = processToTree(
      "Read [[Canon/Uni|the Uni canon]].",
      notesResolver({ "Canon/Uni": "uni-id" }),
    );
    const link = flatten(tree as unknown as NodeLike).find((n) => n.type === "link");
    expect(link?.children?.[0]?.value).toBe("the Uni canon");
    expect(link?.url).toBe("/n/uni-id");
  });

  it("carries data-wikilink-target on resolved + unresolved", () => {
    const tree = processToTree("[[A]] and [[B]].", notesResolver({ A: "a-id" }));
    const nodes = flatten(tree as unknown as NodeLike);
    const link = nodes.find((n) => n.type === "link");
    expect(link?.data?.hProperties?.["data-wikilink-target"]).toBe("A");
    const span = nodes.find((n) => n.data?.hName === "span");
    expect(span?.data?.hProperties?.["data-wikilink-target"]).toBe("B");
  });

  it("does not touch [[target]] inside fenced code blocks", async () => {
    const md = "```\n[[Canon/Uni]]\n```\n";
    const out = await unified()
      .use(remarkParse)
      .use(remarkWikilinks, { resolve: notesResolver({ "Canon/Uni": "x" }) })
      .use(remarkStringify)
      .process(md);
    expect(String(out)).toContain("[[Canon/Uni]]");
  });

  it("does not touch [[target]] inside inline code", async () => {
    const md = "Literal: `[[Canon/Uni]]`.";
    const out = await unified()
      .use(remarkParse)
      .use(remarkWikilinks, { resolve: notesResolver({ "Canon/Uni": "x" }) })
      .use(remarkStringify)
      .process(md);
    expect(String(out)).toContain("`[[Canon/Uni]]`");
  });

  it("handles multiple wikilinks in one paragraph, mixed resolved/unresolved", () => {
    const tree = processToTree("[[A]], [[B]], and [[C]].", notesResolver({ A: "a-id", C: "c-id" }));
    const nodes = flatten(tree as unknown as NodeLike);
    const links = nodes.filter((n) => n.type === "link");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.url)).toEqual(["/n/a-id", "/n/c-id"]);
    // B is unresolved → a styled span, not a link.
    expect(nodes.filter((n) => n.data?.hName === "span")).toHaveLength(1);
  });
});
