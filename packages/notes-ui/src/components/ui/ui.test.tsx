import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("Skeleton", () => {
  it("carries the .skeleton class so reduced-motion + theming apply", () => {
    const { container } = render(<Skeleton className="h-4 w-1/3" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("skeleton");
    expect(el.className).toContain("h-4");
    expect(el).toHaveAttribute("aria-hidden", "true");
  });

  it("applies explicit width/height as inline style", () => {
    const { container } = render(<Skeleton width="60%" height="0.75rem" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe("60%");
    expect(el.style.height).toBe("0.75rem");
  });

  it("omits inline style entirely when no dimensions are given", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("style")).toBeNull();
  });
});

describe("EmptyState", () => {
  it("renders title, description, and action slot", () => {
    render(
      <EmptyState
        title="No notes yet"
        description="Create one to get started."
        action={<button type="button">Create</button>}
      />,
    );
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("uses the shared .card surface and omits absent slots", () => {
    const { container } = render(<EmptyState title="Empty" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("card");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ErrorState", () => {
  it("renders title + message and wires a retry button", () => {
    const retry = vi.fn();
    render(<ErrorState title="Could not load" message="network down" retry={retry} />);
    expect(screen.getByText("Could not load")).toBeInTheDocument();
    expect(screen.getByText("network down")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(btn);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("uses semantic danger tokens (not hardcoded red literals)", () => {
    const { container } = render(<ErrorState title="Boom" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("color-danger-border");
    expect(root.className).toContain("color-danger-soft");
    // No raw Tailwind red-* literal should leak back in.
    expect(root.className).not.toMatch(/\bred-\d/);
  });

  it("renders an arbitrary action node alongside retry", () => {
    render(<ErrorState title="Session expired" action={<a href="/add">Reconnect</a>} />);
    expect(screen.getByRole("link", { name: "Reconnect" })).toBeInTheDocument();
  });
});
