/**
 * Smoke tests for the App shell — the header + nav + routes render, and the
 * TokenSetup banner shows when no operator token is configured.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "./App.tsx";

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  // Stub list call to keep the Modules route happy on render.
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 })),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("App shell", () => {
  test("renders header + nav with canonical brand-line", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    // Canonical brand-line per design-system.md §7: mark + wordmark + `app`
    // chip. The wordmark + chip live inside the heading; the inlined SVG
    // mark carries aria-hidden because the link's aria-label is the
    // accessible name.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/Parachute/);
    expect(heading).toHaveTextContent(/app/);
    expect(screen.getByRole("link", { name: "Parachute · app" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add UI" })).toBeInTheDocument();
  });

  test("token setup banner shows when no token", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/Operator bearer token/)).toBeInTheDocument();
  });

  test("token configured banner collapses when token present", () => {
    localStorage.setItem("parachute_operator_token", "tok");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Token configured/)).toBeInTheDocument();
  });
});
