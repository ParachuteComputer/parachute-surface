import { BottomTabBar } from "@/components/BottomTabBar";
import { useQuickSwitchOpen } from "@/lib/quick-switch/open-store";
import { useVaultStore } from "@/lib/vault/store";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function seedVault() {
  useVaultStore.setState({
    vaults: {
      v1: {
        id: "v1",
        url: "http://localhost:1940",
        name: "dev",
        issuer: "http://localhost:1940",
        clientId: "c",
        scope: "full",
        addedAt: "2026-04-22T00:00:00.000Z",
        lastUsedAt: "2026-04-22T00:00:00.000Z",
      },
    },
    activeVaultId: "v1",
  });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BottomTabBar />
    </MemoryRouter>,
  );
}

describe("BottomTabBar (D6 four-slot)", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useQuickSwitchOpen.setState({ open: false });
    seedVault();
  });

  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useQuickSwitchOpen.setState({ open: false });
  });

  it("renders Home · Notes · [+] · Search when a vault is active (D6 slots)", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(within(nav).getByLabelText(/^home$/i)).toBeInTheDocument();
    expect(within(nav).getByLabelText(/^notes$/i)).toBeInTheDocument();
    // The centre capture action (the raised + disc).
    expect(within(nav).getByLabelText(/new note/i)).toBeInTheDocument();
    expect(within(nav).getByLabelText(/search/i)).toBeInTheDocument();
  });

  it("no longer carries Tags or Settings tabs (they moved off the bottom bar)", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(within(nav).queryByLabelText(/^tags$/i)).toBeNull();
    expect(within(nav).queryByLabelText(/^settings$/i)).toBeNull();
  });

  it("does not render when no active vault", () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    renderAt("/");
    expect(screen.queryByRole("navigation", { name: /primary/i })).toBeNull();
  });

  it("is hidden on lg+ viewports via lg:hidden class (matches the Rail's lg:flex gate — notes#147)", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(nav.className).toMatch(/\blg:hidden\b/);
    // Guard against regressing back to `md:hidden` — at 768-1023px that would
    // hide the bar while the Rail (lg:flex) is still hidden too, leaving
    // tablet users with no primary navigation.
    expect(nav.className).not.toMatch(/\bmd:hidden\b/);
  });

  it("marks Home active on / and on a note (/n/:id stays under Home)", () => {
    renderAt("/");
    expect(screen.getByLabelText(/^home$/i)).toHaveAttribute("aria-current", "page");
    renderAt("/n/abc");
    const homes = screen.getAllByLabelText(/^home$/i);
    expect(homes.some((el) => el.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("marks Notes active on /all", () => {
    renderAt("/all");
    expect(screen.getByLabelText(/^notes$/i)).toHaveAttribute("aria-current", "page");
  });

  it("opens the quick-switch via the Search tab", () => {
    renderAt("/");
    expect(useQuickSwitchOpen.getState().open).toBe(false);
    fireEvent.click(screen.getByLabelText(/search/i));
    expect(useQuickSwitchOpen.getState().open).toBe(true);
  });

  it("the centre + navigates to /new (the unified create surface)", () => {
    renderAt("/");
    expect(screen.getByLabelText(/new note/i)).toHaveAttribute("href", "/new");
  });
});
