import { AddVault } from "@/app/routes/AddVault";
import { loadPendingOAuth } from "@/lib/vault/storage";
import { useVaultStore } from "@/lib/vault/store";
import { vaultIdFromUrl } from "@/lib/vault/url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Stub fetch through discovery + DCR so the real beginOAuth reaches
// savePendingOAuth. Shared by the redirect-plumbing (notes#63) and the
// ?add= deep-link suites.
function mockDiscoveryAndDcr() {
  const impl = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return {
        ok: true,
        status: 200,
        json: async () => validMetadata,
        text: async () => JSON.stringify(validMetadata),
      } as Response;
    }
    if (url.endsWith("/oauth/register")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ client_id: "test-client" }),
        text: async () => "",
      } as Response;
    }
    // Origin-probe + anything else: harmless empty 200.
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

// Echoes the router's live location so tests can assert the ?add= param
// was stripped from history (replace) once consumed.
function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{location.pathname + location.search}</div>;
}

function renderAddVault(initialPath = "/add") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/add"
          element={
            <>
              <AddVault />
              <LocationEcho />
            </>
          }
        />
        <Route path="/" element={<div>Today timeline</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AddVault URL prefill", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("prefills the URL input from ?url= regardless of probe outcome", async () => {
    mockFetchOnce({ throwNetwork: true });
    renderAddVault("/add?url=http%3A%2F%2Fvault.example%3A1940");
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    expect(input.value).toBe("http://vault.example:1940");
  });

  it("prefills the URL input with the detected origin when the probe succeeds", async () => {
    mockFetchOnce({ json: validMetadata });
    renderAddVault();
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(window.location.origin));
  });

  it("leaves the URL input empty when the probe fails", async () => {
    const fetchImpl = mockFetchOnce({ throwNetwork: true });
    renderAddVault();
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    // Wait for the probe to settle — fetchImpl should have been called.
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(input.value).toBe("");
  });
});

// Aaron hit "Cannot read properties of undefined (reading 'digest')" on
// fresh-install testing when serving Notes from a non-HTTPS / non-localhost
// origin. The defensive check in `pkce.ts` now throws
// `InsecureContextError` up front, and AddVault must render the dedicated
// banner (distinct colour + structured remediations) rather than the
// generic "Connection failed" red strip — that's what tells the operator
// the failure mode is "your browser refuses Web Crypto here," not "your
// hub is down."
// notes#63 — the hub `/account` "Import notes" deep-link forwards a
// first-time user through `/add?url=…&redirect=/import`. AddVault must pass
// that sanitized `redirect` into beginOAuth so it round-trips on the pending
// OAuth state (sessionStorage) and OAuthCallback can land the user on
// /import post-connect. A missing or off-origin `redirect` must not persist.
//
// Asserted via the observable end-to-end outcome (the persisted
// PendingOAuthState) rather than a spy: stub fetch through discovery + DCR so
// the real beginOAuth reaches savePendingOAuth, then read it back.
describe("AddVault post-connect redirect plumbing (notes#63)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    // AddVault calls window.location.assign after beginOAuth succeeds;
    // jsdom's default throws "Not implemented: navigation".
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("persists a safe redirect from ?redirect= onto the pending OAuth state", async () => {
    mockDiscoveryAndDcr();
    renderAddVault("/add?url=http%3A%2F%2Fhub.example&redirect=%2Fimport");
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    expect(input.value).toBe("http://hub.example");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(loadPendingOAuth()?.redirect).toBe("/import");
    });
  });

  it("omits redirect from the pending state when ?redirect= is off-origin", async () => {
    mockDiscoveryAndDcr();
    renderAddVault("/add?url=http%3A%2F%2Fhub.example&redirect=https%3A%2F%2Fevil.example");
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      // The flow ran (pending state exists) but the off-origin redirect was
      // sanitized away — never persisted.
      expect(loadPendingOAuth()).not.toBeNull();
    });
    expect(loadPendingOAuth()?.redirect).toBeUndefined();
  });

  it("omits redirect from the pending state for the `/\\` backslash-authority bypass", async () => {
    // `%2F%5Cevil.com` decodes to `/\evil.com`, which the WHATWG URL parser
    // resolves to `http://evil.com/`. Must be sanitized away just like `//`.
    mockDiscoveryAndDcr();
    renderAddVault("/add?url=http%3A%2F%2Fhub.example&redirect=%2F%5Cevil.com");
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(loadPendingOAuth()).not.toBeNull();
    });
    expect(loadPendingOAuth()?.redirect).toBeUndefined();
  });
});

describe("AddVault insecure-context handling", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("renders the insecure-context banner instead of the generic error when crypto.subtle is undefined", async () => {
    // Stub fetch so discovery returns valid AS metadata + DCR succeeds —
    // beginOAuth has to get past discovery and registration before it
    // calls `deriveCodeChallenge`, which is where the PKCE defensive
    // check fires. The origin-probe fetch on mount uses the same impl
    // and is harmless against a metadata-shaped response.
    const fetchImpl = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return {
          ok: true,
          status: 200,
          json: async () => validMetadata,
          text: async () => JSON.stringify(validMetadata),
        } as Response;
      }
      if (url.endsWith("/oauth/register")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ client_id: "test-client" }),
          text: async () => "",
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchImpl);

    // Simulate a non-secure-context browser: crypto exists for
    // `getRandomValues` (verifier + state still need entropy) but
    // `subtle` is missing entirely — exactly the W3C secure-context
    // gating Aaron hit at `http://192.168.1.10:1939`.
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView | null>(buf: T): T => {
        if (buf && "length" in buf) {
          const view = buf as unknown as Uint8Array;
          for (let i = 0; i < view.length; i++) view[i] = (i * 7) & 0xff;
        }
        return buf;
      },
    });

    renderAddVault();
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://192.168.1.10:1939" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    // The distinct banner appears with both remediation paths.
    const banner = await screen.findByTestId("insecure-context-banner");
    expect(banner).toHaveTextContent(/Insecure context/i);
    expect(banner).toHaveTextContent(/HTTPS or accessed at/i);
    expect(banner).toHaveTextContent(/localhost/i);
    expect(banner).toHaveTextContent(/Tailscale Serve|Cloudflare Tunnel|reverse proxy/i);
    // Make sure we did NOT fall through to the generic "Cannot read
    // properties of undefined" surfaced by the cryptic error — the
    // banner is the only message the user should see.
    expect(banner.textContent).not.toMatch(/Cannot read properties of undefined/i);
  });
});

// The cloud console links `notes.parachute.computer/?add=<encoded vault URL>`
// so "Open in Notes" drops the user straight into the consent flow instead of
// making them re-paste the vault URL. NotesIndex forwards `/?add=…` here;
// AddVault owns the handling: strip-from-history first (so refresh/back never
// re-triggers), http(s)-scheme guard, already-connected short-circuit, then
// the same connect path as the form submit.
describe("AddVault ?add= connect deep link", () => {
  const cloudVaultUrl = "https://u.parachute.computer/vault/aaron";

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    // AddVault calls window.location.assign after beginOAuth succeeds;
    // jsdom's default throws "Not implemented: navigation".
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("prefills the field and auto-begins OAuth for a valid ?add= URL", async () => {
    mockDiscoveryAndDcr();
    renderAddVault(`/add?add=${encodeURIComponent(cloudVaultUrl)}`);

    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalledTimes(1);
    });
    const assigned = new URL(vi.mocked(window.location.assign).mock.calls[0]?.[0] as string);
    expect(assigned.origin + assigned.pathname).toBe("http://localhost:1940/oauth/authorize");
    // The /vault/<name> path derives the consent `vault=` hint (see
    // vaultNameFromUrl) so the user never re-types the name free-text.
    expect(assigned.searchParams.get("vault")).toBe("aaron");
    // Same code path as the form submit — pending state persisted.
    expect(loadPendingOAuth()?.issuerUrl).toBe(cloudVaultUrl);
    const input = screen.getByLabelText(/vault address/i) as HTMLInputElement;
    expect(input.value).toBe(cloudVaultUrl);
  });

  it("strips ?add= from history (replace) so refresh doesn't re-trigger", async () => {
    mockDiscoveryAndDcr();
    renderAddVault(`/add?add=${encodeURIComponent(cloudVaultUrl)}&redirect=%2Fimport`);

    await waitFor(() => {
      // `add` gone, companions like `redirect` survive.
      expect(screen.getByTestId("location-echo").textContent).toBe("/add?redirect=%2Fimport");
    });
    // Flush the in-flight auto-begin before the test ends — a dangling
    // beginOAuth promise would otherwise resolve into the NEXT test's
    // freshly-stubbed window.location.assign spy.
    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalled();
    });
  });

  it("never auto-begins OAuth for a non-http(s) ?add= value", async () => {
    mockDiscoveryAndDcr();
    renderAddVault(`/add?add=${encodeURIComponent("javascript:alert(1)")}`);

    // Param consumed + stripped…
    await waitFor(() => {
      expect(screen.getByTestId("location-echo").textContent).toBe("/add");
    });
    // …but no OAuth begun.
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(loadPendingOAuth()).toBeNull();
  });

  it("requires an explicit scheme — a bare hostname never auto-begins", async () => {
    mockDiscoveryAndDcr();
    renderAddVault(`/add?add=${encodeURIComponent("u.parachute.computer/vault/aaron")}`);

    await waitFor(() => {
      expect(screen.getByTestId("location-echo").textContent).toBe("/add");
    });
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(loadPendingOAuth()).toBeNull();
  });

  it("switches to an already-connected vault instead of re-running OAuth", async () => {
    mockDiscoveryAndDcr();
    const id = vaultIdFromUrl(cloudVaultUrl);
    useVaultStore.setState({
      vaults: {
        [id]: {
          id,
          url: cloudVaultUrl,
          name: "aaron",
          issuer: "https://u.parachute.computer",
          tokenEndpoint: "https://u.parachute.computer/oauth/token",
          clientId: "client-123",
          scope: "vault:read vault:write",
          addedAt: "2026-07-01T00:00:00.000Z",
          lastUsedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      activeVaultId: null,
    });

    renderAddVault(`/add?add=${encodeURIComponent(cloudVaultUrl)}`);

    // Lands on the index route (the connected vault's home), no OAuth.
    expect(await screen.findByText("Today timeline")).toBeInTheDocument();
    expect(useVaultStore.getState().activeVaultId).toBe(id);
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(loadPendingOAuth()).toBeNull();
  });
});
