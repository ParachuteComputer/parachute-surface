/**
 * Smoke tests for the App shell + the C4 sign-in banner states:
 *   - silent mint succeeds → zero-paste, no banner
 *   - silent mint succeeds + legacy localStorage token → "no longer needed" hint
 *   - silent mint fails (no hub / no session) → sign-in banner with the
 *     pasted-token path collapsed behind the advanced disclosure
 *   - silent mint fails + legacy token present → collapsed "Token configured"
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { App } from "./App.tsx";
import { MINT_PATH, clearSessionToken } from "./lib/auth.ts";

const realFetch = globalThis.fetch;

/** Stub fetch: route the hub mint path separately from the data endpoints. */
function stubFetch(mint: () => Response) {
  globalThis.fetch = vi.fn((url: string) => {
    if (url === MINT_PATH) return Promise.resolve(mint());
    return Promise.resolve(new Response(JSON.stringify({ uis: [], skipped: [] }), { status: 200 }));
  }) as unknown as typeof fetch;
}

function mintOk(): Response {
  return new Response(
    JSON.stringify({
      token: "session-jwt",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      scopes: ["surface:admin"],
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  localStorage.clear();
  clearSessionToken();
  stubFetch(() => new Response("{}", { status: 404 }));
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
    // Canonical brand-line per design-system.md §7: mark + wordmark +
    // `surface` chip (post app→surface rename — the chip text lagged the
    // rename until boundary C4; this test pinned the renamed expectation).
    // The wordmark + chip live inside the heading; the inlined SVG mark
    // carries aria-hidden because the link's aria-label is the accessible
    // name.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(/Parachute/);
    expect(heading).toHaveTextContent(/surface/);
    expect(screen.getByRole("link", { name: "Parachute · surface" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add UI" })).toBeInTheDocument();
  });
});

describe("sign-in banner (boundary C4)", () => {
  test("silent mint fails + no legacy token → sign-in banner with collapsed paste fallback", async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Sign in to manage UIs/)).toBeInTheDocument();
    // Hub sign-in is the headline path…
    expect(screen.getByRole("link", { name: /Sign in to the hub/ })).toBeInTheDocument();
    // …and the pasted-token path survives as the advanced fallback.
    expect(screen.getByText(/Advanced: paste an operator token/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Operator bearer token/)).toBeInTheDocument();
  });

  test("silent mint succeeds → zero-paste, no banner, no localStorage write", async () => {
    stubFetch(mintOk);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Sign in to manage UIs/)).not.toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Operator bearer token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Token configured/)).not.toBeInTheDocument();
    // The session path never persists the token.
    expect(localStorage.getItem("parachute_operator_token")).toBeNull();
  });

  test("silent mint succeeds + legacy token present → 'no longer needed' hint", async () => {
    localStorage.setItem("parachute_operator_token", "tok");
    stubFetch(mintOk);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/pasted token stored in this browser is no longer needed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear stored token/ })).toBeInTheDocument();
  });

  test("silent mint fails + legacy token present → collapsed 'Token configured' (still honored)", async () => {
    localStorage.setItem("parachute_operator_token", "tok");
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Token configured/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to manage UIs/)).not.toBeInTheDocument();
  });
});
