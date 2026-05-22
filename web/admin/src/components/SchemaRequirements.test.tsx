/**
 * Tests for the `SchemaRequirements` component (patterns#57 Phase 2.0).
 *
 * Behavior under test:
 *   - returns null when no schema declared
 *   - empty-but-declared schema renders summary line ("none declared")
 *   - non-empty schema renders summary line with counts
 *   - non-empty schema's <details> can be expanded to show tags + fields
 *   - compact mode hides descriptions
 *   - defaultExpanded=true opens by default
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";

import { SchemaRequirements } from "./SchemaRequirements.tsx";
import type { RequiredSchemaDeclaration } from "../lib/api.ts";

describe("SchemaRequirements", () => {
  test("renders nothing when schema is undefined", () => {
    const { container } = render(<SchemaRequirements schema={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders 'none declared (empty)' when schema is {}", () => {
    render(<SchemaRequirements schema={{}} />);
    expect(screen.getByText(/none declared \(empty\)/i)).toBeInTheDocument();
  });

  test("renders summary line with counts", () => {
    const schema: RequiredSchemaDeclaration = {
      tags: [
        {
          name: "capture",
          description: "Quick captures",
          fields: {
            source: { type: "string", required: true },
            count: { type: "number" },
          },
        },
        { name: "pinned" },
      ],
    };
    render(<SchemaRequirements schema={schema} />);
    expect(screen.getByText(/2 tags, 2 fields/)).toBeInTheDocument();
  });

  test("expand shows tag names + field rows", async () => {
    const schema: RequiredSchemaDeclaration = {
      tags: [
        {
          name: "capture",
          description: "Quick captures from voice or text",
          fields: {
            source: { type: "string", required: true, description: "Where it came from" },
          },
        },
      ],
    };
    render(<SchemaRequirements schema={schema} />);

    // Click the summary to expand
    const summary = screen.getByText(/1 tag, 1 field/);
    await userEvent.click(summary);

    expect(screen.getByText("capture")).toBeInTheDocument();
    expect(screen.getByText(/Quick captures from voice or text/)).toBeInTheDocument();
    expect(screen.getByText("source")).toBeInTheDocument();
    expect(screen.getByText("string")).toBeInTheDocument();
    expect(screen.getByText(/Where it came from/)).toBeInTheDocument();
  });

  test("defaultExpanded=true opens the details element", () => {
    const schema: RequiredSchemaDeclaration = {
      tags: [{ name: "capture" }],
    };
    const { container } = render(
      <SchemaRequirements schema={schema} defaultExpanded={true} />,
    );
    const details = container.querySelector("details");
    expect(details).toHaveAttribute("open");
  });

  test("compact mode hides description column", async () => {
    const schema: RequiredSchemaDeclaration = {
      tags: [
        {
          name: "capture",
          description: "should-not-show",
          fields: {
            source: { type: "string", description: "hidden-in-compact" },
          },
        },
      ],
    };
    render(<SchemaRequirements schema={schema} compact={true} defaultExpanded={true} />);
    // Tag description suppressed
    expect(screen.queryByText(/should-not-show/)).toBeNull();
    // Field description column header absent — only Field, Type, Required visible
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).not.toContain("Description");
    expect(screen.queryByText(/hidden-in-compact/)).toBeNull();
  });

  test("Phase 2.1 note rendered", () => {
    render(<SchemaRequirements schema={{ tags: [{ name: "x" }] }} defaultExpanded={true} />);
    expect(screen.getByText(/Phase 2\.1\+/)).toBeInTheDocument();
  });
});
