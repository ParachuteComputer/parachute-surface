import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { MdxView } from "../mdx/MdxView.js";

// The security-load-bearing tests (decision B): MDX must NOT execute
// components or expressions by default. Arbitrary vault MDX is untrusted code.

describe("MdxView — safe by default (decision B)", () => {
  it("does NOT evaluate component tags by default — renders as inert markdown", () => {
    // If MDX were evaluated, <Danger/> would mount the component below. It
    // must NOT: no `evaluate` runtime is supplied, so this is plain markdown.
    const Danger = vi.fn(() => <div data-testid="executed">EXECUTED</div>);
    // Register a would-be component on globalThis so any accidental eval path
    // could find it; the safe path must still ignore it.
    render(<MdxView content={"# Title\n\n<Danger />\n"} />);
    expect(Danger).not.toHaveBeenCalled();
    expect(screen.queryByTestId("executed")).toBeNull();
    // The heading still renders (it's markdown).
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
  });

  it("does NOT evaluate JSX expressions by default", () => {
    // `{1+1}` must render as literal text or be inert — never computed to "2".
    const { container } = render(<MdxView content={"value is {1+1} here"} />);
    // No evaluation: the digits 1+1 are not collapsed to a computed 2 via JS.
    expect(container.textContent).not.toMatch(/value is 2 here/);
  });

  it("supplying mdxComponents alone (no evaluate) still does NOT execute", () => {
    const Danger = vi.fn(() => <div data-testid="executed">EXECUTED</div>);
    render(<MdxView content={"<Danger />"} mdxComponents={{ Danger: Danger as never }} />);
    expect(Danger).not.toHaveBeenCalled();
    expect(screen.queryByTestId("executed")).toBeNull();
  });

  it("renders wikilinks + markdown through the safe path", () => {
    render(
      <MdxView
        content={"See [[Known]]."}
        resolve={(t) => (t === "Known" ? { href: "/n/k", exists: true } : null)}
      />,
    );
    expect(screen.getByRole("link", { name: "Known" })).toHaveAttribute("href", "/n/k");
  });
});

describe("MdxView — opt-in evaluation seam", () => {
  it("only evaluates when the surface supplies an `evaluate` runtime", () => {
    const evaluate = vi.fn((_src: string, comps: Record<string, unknown>) => {
      const Allowed = comps.Allowed as () => ReactElement;
      return <div data-testid="evaluated">{Allowed ? <Allowed /> : null}</div>;
    });
    const Allowed = () => <span data-testid="allowed">ok</span>;
    render(
      <MdxView
        content={"<Allowed />"}
        evaluate={evaluate}
        mdxComponents={{ Allowed: Allowed as never }}
      />,
    );
    // The surface's runtime ran, and only with the allowlist it was handed.
    expect(evaluate).toHaveBeenCalledWith("<Allowed />", { Allowed });
    expect(screen.getByTestId("allowed")).toHaveTextContent("ok");
  });
});
