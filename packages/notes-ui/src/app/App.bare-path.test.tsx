import { useVaultStore } from "@/lib/vault/store";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Force the Phase-1 same-origin deploy shape: the SPA served at the ROOT mount
// (basename ""), where a bare-path bookmark IS the origin-absolute path — so a
// ceremony-word note (`/login`) collides with the real server ceremony that the
// service worker forwards past the SPA. The default App.test harness runs under
// the legacy `/notes` mount, where no such collision exists; this file pins the
// root-mount behaviour that #189 is about. The mock covers both base-url
// exports the render tree touches.
vi.mock("@/lib/base-url", () => ({
  detectMountBase: () => "",
  detectMountBaseWithSlash: () => "/",
}));

// Imported after the mock so App's BrowserRouter picks up basename "".
import { App } from "./App";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 })),
  );
}

describe("App — bare-path note shim at the root mount (#189, Phase 1)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does NOT redirect a ceremony-word bare path to a /n/<id> note", async () => {
    // A hard nav to `/login` at this origin is owned by the auth ceremony (the
    // SW forwards it there). Client-side, the bare-path shim must agree and
    // NOT claim it as a note — it bails to the index rather than /n/login, so
    // the SPA never paints a note that shadows the ceremony.
    window.history.replaceState({}, "", "/login");
    render(<App />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(window.location.pathname).not.toBe("/n/login");
  });

  it("still redirects an ordinary bare-path note to the canonical /n/<id>", async () => {
    // The legacy pre-`/n/` bookmark shim survives for every non-ceremony bare
    // path. A vault is set so NoteView holds the URL at /n/MyNote instead of
    // bouncing to the connect screen.
    useVaultStore.setState({
      vaults: {
        v1: {
          id: "v1",
          url: "http://localhost:1940",
          name: "default",
          issuer: "http://localhost:1940",
          clientId: "c",
          scope: "full",
          addedAt: "2026-04-20T00:00:00.000Z",
          lastUsedAt: "2026-04-20T00:00:00.000Z",
        },
      },
      activeVaultId: "v1",
    });
    window.history.replaceState({}, "", "/MyNote");
    render(<App />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/n/MyNote");
    });
  });
});
