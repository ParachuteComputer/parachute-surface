/**
 * Tests for the Add route — form submission shape + success path.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Add } from "./Add.tsx";

const realFetch = globalThis.fetch;

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
      <Add />
    </MemoryRouter>,
  );
}

describe("Add", () => {
  test("submitting calls POST /app/add with the right body shape", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = vi.fn((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            ui: { name: "myui", path: "/app/myui", displayName: "My UI" },
            oauth_client_id: "client_myui",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    });
    globalThis.fetch = fakeFetch as unknown as typeof fetch;

    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/^\/abs\/path/), "/tmp/my-ui");
    await userEvent.type(screen.getByPlaceholderText("my-ui"), "myui");
    await userEvent.type(screen.getByPlaceholderText("/app/my-ui"), "/app/myui");
    await userEvent.type(screen.getByPlaceholderText("My UI"), "My UI");
    await userEvent.type(
      screen.getByPlaceholderText(/vault:\*:read, vault:\*:write/),
      "vault:default:read, vault:default:write",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add UI" }));

    await waitFor(() => {
      expect(capturedInit).toBeDefined();
    });
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.source).toBe("/tmp/my-ui");
    expect(body.name).toBe("myui");
    expect(body.path).toBe("/app/myui");
    expect(body.displayName).toBe("My UI");
    expect(body.scopes_required).toEqual(["vault:default:read", "vault:default:write"]);
    expect(await screen.findByText(/Added myui/)).toBeInTheDocument();
    expect(screen.getByText(/client_myui/)).toBeInTheDocument();
  });

  test("error from /app/add surfaces inline", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "name_exists", message: 'UI named "x" exists' }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;
    renderWithRouter();
    await userEvent.type(screen.getByLabelText(/Source/), "/tmp/foo");
    await userEvent.click(screen.getByRole("button", { name: "Add UI" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 409");
  });
});
