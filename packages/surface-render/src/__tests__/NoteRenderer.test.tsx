import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteRenderer } from "../note/NoteRenderer.js";
import { extensionOf, formatForPath } from "../note/format.js";

describe("formatForPath", () => {
  it("defaults to markdown for no-extension / .md / .mdx / .markdown", () => {
    expect(formatForPath(undefined)).toBe("markdown");
    expect(formatForPath("daily/note")).toBe("markdown");
    expect(formatForPath("a.md")).toBe("markdown");
    expect(formatForPath("a.mdx")).toBe("markdown");
    expect(formatForPath("a.markdown")).toBe("markdown");
  });
  it("maps data + code extensions", () => {
    expect(formatForPath("data.csv")).toBe("csv");
    expect(formatForPath("conf.json")).toBe("json");
    expect(formatForPath("conf.yaml")).toBe("yaml");
    expect(formatForPath("conf.yml")).toBe("yaml");
    expect(formatForPath("src/x.ts")).toBe("code");
    expect(formatForPath("weird.xyz")).toBe("plain");
  });
  it("extensionOf ignores dots in directory segments", () => {
    expect(extensionOf("a.b/c")).toBe("");
    expect(extensionOf("a/b.ts")).toBe("ts");
  });
});

describe("NoteRenderer dispatch", () => {
  it("renders markdown by default and flows the resolver through", () => {
    render(
      <NoteRenderer
        note={{ path: "n.md", content: "See [[X]]." }}
        resolve={(t) => (t === "X" ? { href: "/n/x", exists: true } : null)}
      />,
    );
    expect(screen.getByRole("link", { name: "X" })).toHaveAttribute("href", "/n/x");
  });
  it("dispatches .csv to the table renderer", () => {
    render(<NoteRenderer note={{ path: "d.csv", content: "h\nv" }} />);
    expect(screen.getByRole("columnheader", { name: "h" })).toBeInTheDocument();
  });
  it("honors a per-format override", () => {
    render(
      <NoteRenderer
        note={{ path: "d.csv", content: "h\nv" }}
        overrides={{ csv: ({ content }) => <pre data-testid="ov">{content}</pre> }}
      />,
    );
    expect(screen.getByTestId("ov")).toHaveTextContent("h v");
  });
  it("dispatches .json to pretty-printed code", () => {
    const { container } = render(<NoteRenderer note={{ path: "c.json", content: '{"a":1}' }} />);
    expect(container.querySelector("code.language-json")?.textContent).toContain('"a": 1');
  });
});
