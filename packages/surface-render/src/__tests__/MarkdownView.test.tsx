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
});
