import { useVaultStore } from "@/lib/vault/store";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, RouteFallback } from "./App";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 })),
  );
}

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    // BrowserRouter is mounted with basename="/notes" (BASE_URL from Vite).
    // Tests simulate the external mount by placing the browser under /notes/.
    window.history.replaceState({}, "", "/notes/");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the Parachute wordmark and the connect CTA when no vaults exist", async () => {
    render(<App />);
    expect(screen.getByRole("link", { name: /^parachute$/i })).toBeInTheDocument();
    // Home holds back the CTA until the origin probe settles to avoid
    // flashing "Connect a vault" before swapping to "Looks like there's a
    // vault at …". Wait for the probe to resolve before asserting the CTA.
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /connect a vault/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/no vault connected/i)).toBeInTheDocument();
  });

  it("resolves the root list view at external /notes/ without double-prefixing", () => {
    render(<App />);
    // Regression guard against the /notes/notes bug: with basename="/notes"
    // stripping the external prefix, the internal path is "/" and the index
    // dispatcher (Home for no vault) renders. The URL must stay /notes/, not
    // become /notes/notes.
    expect(screen.getByRole("link", { name: /^parachute$/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/notes/");
  });

  it("resolves NoteView at external /notes/n/<id>", () => {
    window.history.replaceState({}, "", "/notes/n/some-id");
    render(<App />);
    // With no vault the NoteView route redirects internally to "/" (basename
    // strips /notes). The critical regression guard: the external URL must
    // sit under /notes, never /notes/notes.
    expect(window.location.pathname.startsWith("/notes")).toBe(true);
    expect(window.location.pathname.startsWith("/notes/notes")).toBe(false);
  });

  it("catch-all redirects to the root list, not /notes/notes", () => {
    window.history.replaceState({}, "", "/notes/some-unknown-internal-path");
    render(<App />);
    // The `*` route navigates to internal `/`. With basename=/notes this is
    // external /notes (with or without trailing slash — both resolve the root
    // list). The bug Aaron hit (/notes/notes) would surface here if basename
    // and route paths disagreed. Routes are lazy now, so the redirect chain
    // (`/:id` → NoteView → "/") settles across a Suspense boundary instead of
    // synchronously — wait for the URL to land.
    return waitFor(() => {
      expect(window.location.pathname).toMatch(/^\/notes\/?$/);
    });
  });

  it("forwards a root-path ?add= deep link to /add, preserving companions (cloud console link)", async () => {
    // The cloud console links the origin root — `/?add=<encoded vault URL>`.
    // NotesIndex must forward to /add with the full search string; AddVault
    // then consumes ?add= (stripping it from history) while ?redirect=
    // survives. This is the headline path for "Open in Notes".
    window.history.replaceState(
      {},
      "",
      "/notes/?add=https%3A%2F%2Fu.parachute.computer%2Fvault%2Faaron&redirect=%2Fimport",
    );
    render(<App />);

    // Lands on the connect screen (lazy route), field prefilled from the
    // forwarded ?add= value.
    expect(await screen.findByRole("heading", { name: /connect a vault/i })).toBeInTheDocument();
    expect((screen.getByLabelText(/vault address/i) as HTMLInputElement).value).toBe(
      "https://u.parachute.computer/vault/aaron",
    );
    // ?add= consumed + stripped; ?redirect= preserved. External URL sits
    // under the /notes mount (basename applied — never /notes/notes).
    await waitFor(() => {
      expect(window.location.pathname).toBe("/notes/add");
      expect(window.location.search).toBe("?redirect=%2Fimport");
    });
  });

  it("clamps horizontal overflow at the shell so a stray wide descendant can't scroll the viewport", () => {
    render(<App />);
    // Belt-and-suspenders against mobile overflow regressions. If any
    // descendant (a long unbreakable path, a rogue min-width, a missing
    // min-w-0 in a deep flex chain) ever exceeds the viewport width, the
    // shell clips it to the viewport instead of turning the whole page into
    // a horizontal scroller. jsdom doesn't compute layout, so this is a
    // class-presence check, not a measured scrollWidth assertion — the
    // manual-testing steps live in the PR body.
    const shell = screen.getByRole("link", { name: /^parachute$/i }).closest("div.min-h-dvh");
    expect(shell).not.toBeNull();
    expect(shell?.className).toMatch(/\boverflow-x-hidden\b/);
  });

  it("RouteFallback exposes role=status with aria-live=polite and visible text (#100)", () => {
    // Smoke test for the a11y contract of the Suspense fallback (#99/#100).
    // `<output>` carries an implicit role="status"; we layer on an explicit
    // `aria-live="polite"` because NVDA on Windows has historically
    // inconsistent support for the implicit form. If either the role or the
    // live-region attribute regresses, screen-reader users would lose the
    // "the app is working on it" announcement during a slow lazy-chunk
    // fetch — silent loading is the failure mode this guards against.
    render(<RouteFallback />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/loading/i);
  });

  it("RouteFallback is mounted while a lazy route resolves (#100)", async () => {
    // Companion check: the contract above only matters if the App actually
    // hands rendering to RouteFallback during a lazy-route transition.
    // /settings is route-split (lazy import in App.tsx), so the very first
    // synchronous render at /notes/settings paints the fallback before the
    // chunk's promise settles. Wait for the lazy chunk to land afterwards
    // to keep the test isolated from later assertions.
    useVaultStore.setState({
      vaults: {
        v1: {
          id: "v1",
          url: "http://localhost:1940",
          name: "default",
          issuer: "http://localhost:1940",
          clientId: "c",
          scope: "full",
          addedAt: "2026-04-29T00:00:00.000Z",
          lastUsedAt: "2026-04-29T00:00:00.000Z",
        },
      },
      activeVaultId: "v1",
    });
    window.history.replaceState({}, "", "/notes/settings");
    render(<App />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/loading/i);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: /settings/i })).toBeInTheDocument();
    });
  });

  it("static route /settings wins over the dynamic /:id deep-link shim", () => {
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
    window.history.replaceState({}, "", "/notes/settings");
    render(<App />);
    // Regression guard against future route-table accidents: RR7's ranked
    // routing must hold `/settings` (and every other named static route)
    // above the `/:id` pre-#49 bookmark shim. If this ever fails, the shim
    // would start swallowing real internal pages.
    return waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: /settings/i })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/notes/settings");
    });
  });

  it("bare-path note that spells a ceremony word still resolves under the /notes mount (no false-bail, #189)", async () => {
    // Mount-awareness guard: `/notes/login` is NOT the origin ceremony
    // `/login`, so the bare-path shim keeps redirecting it to the canonical
    // note route. A mount-blind guard that bailed on the bare segment `login`
    // would wrongly stop resolving a note literally named `login` on every
    // self-hosted (`/notes`, `/surface/<slug>`) surface. A vault is set so
    // NoteView holds the URL instead of bouncing to the connect screen.
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
    window.history.replaceState({}, "", "/notes/login");
    render(<App />);
    return waitFor(() => {
      expect(window.location.pathname).toBe("/notes/n/login");
    });
  });
});
