import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeRenderer } from "../formats/CodeRenderer.js";
import { CsvRenderer } from "../formats/CsvRenderer.js";
import { JsonRenderer } from "../formats/JsonRenderer.js";
import { PlainRenderer } from "../formats/PlainRenderer.js";
import { YamlRenderer } from "../formats/YamlRenderer.js";
import { parseCsv } from "../formats/csv.js";
import { escapeHtml, escapeOnlyHighlight } from "../formats/highlight.js";

describe("parseCsv", () => {
  it("parses quoted cells, escaped quotes, and embedded newlines", () => {
    const { rows, truncated } = parseCsv('a,"b,c","d""e"\n1,2,"x\ny"');
    expect(truncated).toBe(false);
    expect(rows[0]).toEqual(["a", "b,c", 'd"e']);
    expect(rows[1]).toEqual(["1", "2", "x\ny"]);
  });
  it("flags an unterminated quote as truncated", () => {
    expect(parseCsv('a,"unterminated').truncated).toBe(true);
  });
});

describe("CsvRenderer", () => {
  it("renders a table with header + body", () => {
    render(<CsvRenderer content={"name,age\nAda,36"} />);
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
  });
});

describe("JsonRenderer", () => {
  it("pretty-prints valid JSON as code", () => {
    const { container } = render(<JsonRenderer content={'{"a":1}'} />);
    expect(container.querySelector("code.language-json")?.textContent).toContain('"a": 1');
  });
  it("falls back to plain text on invalid JSON", () => {
    const { container } = render(<JsonRenderer content={"{not json"} />);
    expect(container.querySelector("code")?.textContent).toBe("{not json");
  });
});

describe("YamlRenderer", () => {
  it("renders YAML as code, bytes as-authored", () => {
    const { container } = render(<YamlRenderer content={"a: 1\nb: 2"} />);
    expect(container.querySelector("code.language-yaml")?.textContent).toBe("a: 1\nb: 2");
  });
});

describe("CodeRenderer + highlight hook", () => {
  it("escapes by default — no live markup from arbitrary code", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeOnlyHighlight("<b>", "ts")).toBe("&lt;b&gt;");
  });
  it("renders escaped code text by default (no injected element)", () => {
    const { container } = render(<CodeRenderer content={"<script>x</script>"} language="ts" />);
    const code = container.querySelector("code");
    expect(code?.querySelector("script")).toBeNull();
    expect(code?.textContent).toBe("<script>x</script>");
  });
  it("uses a supplied highlighter when given one", () => {
    const hl = (c: string) => `<span class="kw">${c}</span>`;
    const { container } = render(<CodeRenderer content="x" language="ts" highlight={hl} />);
    expect(container.querySelector("code .kw")?.textContent).toBe("x");
  });
});

describe("PlainRenderer", () => {
  it("renders raw text in a pre/code block", () => {
    const { container } = render(<PlainRenderer content="just text" />);
    expect(container.querySelector("pre code")?.textContent).toBe("just text");
  });
});
