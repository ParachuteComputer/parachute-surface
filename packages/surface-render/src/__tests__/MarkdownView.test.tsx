import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../markdown/MarkdownView.js";
import type { LinkComponent } from "../markdown/MarkdownView.js";
import type { WikilinkResolver } from "../markdown/remark-wikilinks.js";

const resolve: WikilinkResolver = (target) =>
  target === "Known" ? { href: "/n/known-id", exists: true } : null;

describe("MarkdownView", () => {
  it("renders GFM markdown (headings, emphasis)", () => {
    render(<MarkdownView content={"# Title\n\nSome **bold** text."} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  it("wraps output in the default prose-note container", () => {
    const { container } = render(<MarkdownView content="hi" />);
    expect(container.querySelector(".prose-note")).not.toBeNull();
  });

  it("renders resolved wikilinks via the surface linkComponent with the chosen href", () => {
    const LinkComp: LinkComponent = ({ href, className, children }) => (
      <a data-testid="surface-link" href={href} data-href={href} className={className}>
        {children}
      </a>
    );
    render(<MarkdownView content="See [[Known]]." resolve={resolve} linkComponent={LinkComp} />);
    const link = screen.getByTestId("surface-link");
    expect(link).toHaveAttribute("data-href", "/n/known-id");
    expect(link.className).toContain("wikilink-resolved");
  });

  it("renders unresolved wikilinks as inert styled text (no anchor)", () => {
    render(<MarkdownView content="A [[Ghost]] link." resolve={resolve} />);
    const ghost = screen.getByText("Ghost");
    expect(ghost.tagName.toLowerCase()).toBe("span");
    expect(ghost.className).toContain("wikilink-unresolved");
  });

  it("routes /api/storage images through an auth'd fetchBlob", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    render(<MarkdownView content={"![pic](/api/storage/img.png)"} fetchBlob={fetchBlob} />);
    // VaultImage fires the auth'd fetch for storage URLs.
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledWith("/api/storage/img.png"));
  });

  it("applies per-element component overrides", () => {
    render(
      <MarkdownView
        content="# Custom"
        components={{ h1: ({ children }) => <h1 data-testid="ov">{children}</h1> }}
      />,
    );
    expect(screen.getByTestId("ov")).toHaveTextContent("Custom");
  });

  it("default link component opens external links in a new tab", () => {
    render(<MarkdownView content="[ext](https://example.com)" />);
    const a = screen.getByRole("link", { name: "ext" });
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  describe("breaks (single-newline soft breaks)", () => {
    it("renders a single internal newline as a visible <br> by default", () => {
      const { container } = render(<MarkdownView content={"Line one\nLine two"} />);
      const p = container.querySelector("p");
      const br = p?.querySelectorAll("br");
      expect(br).toHaveLength(1);
      // mdast-util-to-hast's break handler emits `<br>` followed by a "\n"
      // text node (the canonical CommonMark `<br />\n` HTML output) — the
      // literal `\n` in textContent is expected; browsers collapse it visually.
      expect(p?.textContent).toBe("Line one\nLine two");
      expect(p?.children[0]?.tagName.toLowerCase()).toBe("br");
    });

    it("still separates paragraphs on a blank line", () => {
      const { container } = render(<MarkdownView content={"Para one\n\nPara two"} />);
      const paragraphs = container.querySelectorAll("p");
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]?.textContent).toBe("Para one");
      expect(paragraphs[1]?.textContent).toBe("Para two");
      expect(container.querySelectorAll("br")).toHaveLength(0);
    });

    it("collapses a single newline to a space when breaks={false} (strict CommonMark)", () => {
      const { container } = render(<MarkdownView content={"Line one\nLine two"} breaks={false} />);
      const p = container.querySelector("p");
      expect(p?.querySelectorAll("br")).toHaveLength(0);
      expect(p?.textContent).toBe("Line one\nLine two");
    });

    it("trailing-two-spaces hard breaks still work with breaks={false}", () => {
      const { container } = render(
        <MarkdownView content={"Line one  \nLine two"} breaks={false} />,
      );
      const p = container.querySelector("p");
      expect(p?.querySelectorAll("br")).toHaveLength(1);
    });

    it("backslash hard breaks still work with breaks={false}", () => {
      const { container } = render(
        <MarkdownView content={"Line one\\\nLine two"} breaks={false} />,
      );
      const p = container.querySelector("p");
      expect(p?.querySelectorAll("br")).toHaveLength(1);
    });

    it("does not double newlines inside fenced code blocks", () => {
      const { container } = render(<MarkdownView content={"```\nfirst\nsecond\nthird\n```"} />);
      const code = container.querySelector("pre code");
      expect(code?.querySelectorAll("br")).toHaveLength(0);
      expect(code?.textContent).toBe("first\nsecond\nthird\n");
    });

    it("does not affect inline code spans", () => {
      const { container } = render(<MarkdownView content={"See `a\nb` here."} />);
      // Inline code cannot span a literal newline in CommonMark — the newline
      // there is treated as a space inside the code span, not a break.
      const code = container.querySelector("code");
      expect(code?.querySelectorAll("br")).toHaveLength(0);
      expect(code?.textContent).toBe("a b");
    });

    it("still renders a break inside a wikilink-adjacent text run", () => {
      render(<MarkdownView content={"before\nSee [[Known]] after"} resolve={resolve} />);
      expect(screen.getByText("Known")).toBeInTheDocument();
      const p = screen.getByText("Known").closest("p");
      expect(p?.querySelectorAll("br")).toHaveLength(1);
    });
  });
});
