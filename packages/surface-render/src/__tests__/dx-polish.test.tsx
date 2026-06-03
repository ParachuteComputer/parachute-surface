import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type BlobCapableClient, useVaultFetchBlob } from "../embed/index.js";
import { MarkdownView } from "../markdown/MarkdownView.js";
import {
  INERT,
  type WikilinkResolver,
  resolvedLink,
  unresolvedLink,
} from "../markdown/remark-wikilinks.js";
import { NoteRenderer } from "../note/NoteRenderer.js";

// ── Item 1: resolver helpers ────────────────────────────────────────────────
describe("wikilink resolver helpers", () => {
  it("unresolvedLink builds a navigable {exists:false} target", () => {
    expect(unresolvedLink("/n/Foo")).toEqual({ href: "/n/Foo", exists: false });
  });
  it("resolvedLink builds a live {exists:true} target", () => {
    expect(resolvedLink("/n/abc")).toEqual({ href: "/n/abc", exists: true });
  });
  it("INERT is null (the no-link sentinel)", () => {
    expect(INERT).toBeNull();
  });

  it("unresolvedLink renders a clickable dashed link (not an inert span)", () => {
    const resolve: WikilinkResolver = (t) =>
      t === "Real" ? resolvedLink("/n/real") : unresolvedLink(`/n/${t}`);
    render(<MarkdownView content="A [[Ghost]] link." resolve={resolve} />);
    const link = screen.getByRole("link", { name: "Ghost" });
    expect(link).toHaveAttribute("href", "/n/Ghost");
    expect(link.className).toContain("wikilink-unresolved");
  });

  it("INERT (null) renders an inert span with no anchor", () => {
    const resolve: WikilinkResolver = (t) => (t === "Real" ? resolvedLink("/n/real") : INERT);
    render(<MarkdownView content="A [[Ghost]] link." resolve={resolve} />);
    const ghost = screen.getByText("Ghost");
    expect(ghost.tagName.toLowerCase()).toBe("span");
    expect(screen.queryByRole("link", { name: "Ghost" })).toBeNull();
  });
});

// ── Item 2: useVaultFetchBlob hook ──────────────────────────────────────────
describe("useVaultFetchBlob", () => {
  it("adapts a fetchAttachmentBlob client to a FetchBlob", async () => {
    const client: BlobCapableClient = { fetchAttachmentBlob: vi.fn(async () => new Blob(["a"])) };
    const { result } = renderHook(() => useVaultFetchBlob(client));
    expect(typeof result.current).toBe("function");
    await result.current?.("/api/storage/x.png");
    expect(client.fetchAttachmentBlob).toHaveBeenCalledWith("/api/storage/x.png");
  });

  it("returns undefined (not null) for a blob-incapable client", () => {
    const { result } = renderHook(() => useVaultFetchBlob({}));
    expect(result.current).toBeUndefined();
  });

  it("returns undefined for a null client (signed out)", () => {
    const { result } = renderHook(() => useVaultFetchBlob(null));
    expect(result.current).toBeUndefined();
  });

  it("is memoized — stable identity across re-renders for the same client", () => {
    const client: BlobCapableClient = { fetchAttachmentBlob: vi.fn(async () => new Blob()) };
    const { result, rerender } = renderHook(() => useVaultFetchBlob(client));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

// ── Item 3: unified highlight covers markdown fenced code ───────────────────
describe("unified highlight (markdown fenced code)", () => {
  const markStub = (code: string, lang: string) => `<span data-hl="${lang}">${code}</span>`;

  it("colors fenced code via the highlight hook with hljs language-X markup", () => {
    const { container } = render(
      <MarkdownView content={"```ts\nconst x = 1;\n```"} highlight={markStub} />,
    );
    const code = container.querySelector("code.hljs.language-ts");
    expect(code).not.toBeNull();
    expect(code?.querySelector("span[data-hl='ts']")).not.toBeNull();
    // Same markup shape as <CodeRenderer>: the <code> sits inside a <pre>.
    expect(container.querySelector("pre > code.hljs.language-ts")).not.toBeNull();
  });

  it("leaves inline code untouched when highlight is set", () => {
    const { container } = render(<MarkdownView content={"a `inline` b"} highlight={markStub} />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.className).not.toContain("hljs");
    expect(code?.textContent).toBe("inline");
  });

  it("NoteRenderer threads highlight into the markdown branch", () => {
    const { container } = render(
      <NoteRenderer note={{ path: "n.md", content: "```js\n1;\n```" }} highlight={markStub} />,
    );
    expect(container.querySelector("code.hljs.language-js span[data-hl='js']")).not.toBeNull();
  });

  it("without highlight, fenced code is left for the rehype path (backward-compatible)", () => {
    // No `highlight` and no rehype plugin: plain code element, no hljs class
    // injected by us, no dangerouslySetInnerHTML — same as before this change.
    const { container } = render(<MarkdownView content={"```ts\nx\n```"} />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.className).toContain("language-ts");
    expect(code?.className).not.toContain("hljs");
  });

  it("a components.code override still wins over the highlight override", () => {
    const { container } = render(
      <MarkdownView
        content={"```ts\nx\n```"}
        highlight={markStub}
        components={{ code: ({ children }) => <code data-testid="ov">{children}</code> }}
      />,
    );
    expect(container.querySelector("code[data-testid='ov']")).not.toBeNull();
    expect(container.querySelector("code.hljs")).toBeNull();
  });
});
