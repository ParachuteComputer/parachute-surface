/**
 * Tests for the Modules route — list rendering, empty state, reload + remove
 * actions invoke the API helpers.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Modules } from "./Modules.tsx";

const realFetch = globalThis.fetch;

function withFetchMock(handler: typeof fetch) {
  globalThis.fetch = handler as typeof fetch;
}

beforeEach(() => {
  localStorage.setItem("parachute_operator_token", "test-token");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <Modules />
    </MemoryRouter>,
  );
}

describe("Modules", () => {
  test("renders empty state when no UIs", async () => {
    withFetchMock(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ uis: [], skipped: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    renderWithRouter();
    expect(await screen.findByText(/No UIs installed yet/)).toBeInTheDocument();
  });

  test("renders rows for installed UIs", async () => {
    withFetchMock(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              uis: [
                {
                  name: "notes",
                  dirName: "notes",
                  displayName: "Notes",
                  path: "/app/notes",
                  version: "0.1.0",
                  scopes_required: ["vault:*:read", "vault:*:write"],
                  pwa: true,
                  public: false,
                  status: "active",
                  oauthClientId: "client_notes",
                  oauthStatus: "approved",
                },
              ],
              skipped: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    renderWithRouter();
    expect(await screen.findByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("/app/notes")).toBeInTheDocument();
    expect(screen.getByText(/client_notes/)).toBeInTheDocument();
    expect(screen.getByText("PWA")).toBeInTheDocument();
  });

  test("error surfaces an alert", async () => {
    withFetchMock(
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "unauthorized", message: "no token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    renderWithRouter();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 401");
  });

  test("Reload button triggers POST /app/<name>/reload", async () => {
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      callLog.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "POST" && url.endsWith("/reload")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/app/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const reloadBtn = await screen.findByRole("button", { name: /Reload/ });
    await userEvent.click(reloadBtn);
    await waitFor(() => {
      const reloadCall = callLog.find((c) => c.url.endsWith("/reload"));
      expect(reloadCall).toBeTruthy();
      expect(reloadCall?.method).toBe("POST");
    });
  });

  test("Remove button triggers DELETE after confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      callLog.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, removed: "alpha" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/app/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const removeBtn = await screen.findByRole("button", { name: /Remove/ });
    await userEvent.click(removeBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const del = callLog.find((c) => c.method === "DELETE");
      expect(del).toBeTruthy();
      expect(del?.url).toContain("/app/alpha");
    });
  });
});
