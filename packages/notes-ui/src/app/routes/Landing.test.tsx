import { Landing } from "@/app/routes/Landing";
import { resetDoorProbeCache } from "@/lib/vault/probe";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A valid OAuth authorization-server document — what a DOOR (identity/issuer)
// answers at `/.well-known/oauth-authorization-server`. The `issuer` value need
// not equal the probed origin: the probe returns the candidate origin, and
// discovery validates the document's shape (S256, endpoints), not its host.
const validMetadata = {
  issuer: "http://localhost:1940",
  authorization_endpoint: "http://localhost:1940/oauth/authorize",
  token_endpoint: "http://localhost:1940/oauth/token",
  registration_endpoint: "http://localhost:1940/oauth/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["full", "read"],
};

function mockFetchOnce(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  throwNetwork?: boolean;
}) {
  const impl = vi.fn<typeof fetch>(async () => {
    if (response.throwNetwork) throw new Error("network down");
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json,
      text: async () => "",
    } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/add" element={<div>Add form</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Landing (no-vault) door fork", () => {
  beforeEach(() => {
    // The door probe caches per origin for the page session; clear it so each
    // case probes fresh with its own mocked response.
    resetDoorProbeCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetDoorProbeCache();
  });

  it("offers the create/connect fork when a door is serving the origin", async () => {
    mockFetchOnce({ json: validMetadata });
    renderLanding();

    // Primary: "Create your Parachute" is a plain full-page link to the
    // same-origin `/signup` ceremony (not an SPA route).
    const create = await screen.findByRole("link", { name: /create your parachute/i });
    expect(create).toHaveAttribute("href", "/signup");

    // Secondary: "I already have a vault" leads to the connect-by-URL flow.
    expect(screen.getByRole("link", { name: /i already have a vault/i })).toHaveAttribute(
      "href",
      "/add",
    );

    // The misdetection is gone: never present the serving origin as a vault.
    expect(screen.queryByText(/looks like there's a vault/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^connect$/i })).not.toBeInTheDocument();
  });

  it("leads with connect-by-URL and NEVER self-offers when the origin is not a door", async () => {
    // notes.parachute.computer today: a static host, no issuer discovery (404).
    mockFetchOnce({ ok: false, status: 404 });
    renderLanding();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^connect a vault$/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: /^connect a vault$/i })).toHaveAttribute(
      "href",
      "/add",
    );

    // Regression pin (surface#193): the serving origin is never offered as a
    // vault, and the create fork does not appear off a non-door origin.
    expect(screen.queryByText(/looks like there's a vault/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create your parachute/i })).not.toBeInTheDocument();
  });

  it("treats a probe network error as not-a-door (fail-quiet → connect-by-URL)", async () => {
    mockFetchOnce({ throwNetwork: true });
    renderLanding();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^connect a vault$/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /create your parachute/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/looks like there's a vault/i)).not.toBeInTheDocument();
  });

  it("treats invalid issuer metadata as not-a-door", async () => {
    // A 200 that isn't real issuer metadata (no S256) must not count as a door.
    mockFetchOnce({
      json: { ...validMetadata, code_challenge_methods_supported: ["plain"] },
    });
    renderLanding();

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^connect a vault$/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /create your parachute/i })).not.toBeInTheDocument();
  });
});
