import { Header } from "@/components/Header";
import { useVaultStore } from "@/lib/vault/store";
import type { VaultRecord } from "@/lib/vault/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeVault(partial: Partial<VaultRecord> & Pick<VaultRecord, "id" | "url">): VaultRecord {
  return {
    name: "",
    issuer: partial.url,
    clientId: "client-test",
    scope: "full",
    addedAt: "2026-04-18T00:00:00.000Z",
    lastUsedAt: "2026-04-18T00:00:00.000Z",
    ...partial,
  };
}

function renderHeader() {
  return render(
    <MemoryRouter>
      <Header />
    </MemoryRouter>,
  );
}

function seedVault() {
  useVaultStore.setState({
    vaults: { a: makeVault({ id: "a", url: "http://localhost:1940", name: "default" }) },
    activeVaultId: "a",
  });
}

describe("Header vault label fallback", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    // Stub fetch so the popover's well-known fetcher doesn't escape into a
    // real network call during component render.
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ vaults: [], services: [] }),
        }) as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    vi.restoreAllMocks();
  });

  it("renders the vault name when present", () => {
    useVaultStore.setState({
      vaults: { a: makeVault({ id: "a", url: "http://localhost:1940", name: "default" }) },
      activeVaultId: "a",
    });
    renderHeader();
    expect(screen.getByRole("button", { name: /active vault: default/i })).toBeInTheDocument();
  });

  it("falls back to the URL host when name is empty", () => {
    useVaultStore.setState({
      vaults: { a: makeVault({ id: "a", url: "https://vault.example.com:8443/api", name: "" }) },
      activeVaultId: "a",
    });
    renderHeader();
    expect(
      screen.getByRole("button", { name: /active vault: vault\.example\.com:8443/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the raw URL when both name and URL are unparseable", () => {
    useVaultStore.setState({
      vaults: { a: makeVault({ id: "a", url: "not a url", name: "" }) },
      activeVaultId: "a",
    });
    renderHeader();
    expect(screen.getByRole("button", { name: /active vault: not a url/i })).toBeInTheDocument();
  });
});

// Phase 3a: the header is now the mobile/tablet top bar only — the desktop
// spine moved to the left Rail. The bar leads with the vault switcher (the
// identity spine, D6), and Settings + the secondary destinations live one tap
// off in the ⋯ menu now that the bottom bar is the 4-slot D6 set.
describe("Header mobile shell (Phase 3a)", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ vaults: [], services: [] }),
        }) as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    vi.restoreAllMocks();
  });

  it("is a mobile-only top bar (lg:hidden) — the Rail is the desktop spine", () => {
    seedVault();
    const { container } = renderHeader();
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.className).toContain("lg:hidden");
  });

  it("leads with the vault switcher when a vault is connected", () => {
    seedVault();
    renderHeader();
    expect(screen.getByRole("button", { name: /active vault: default/i })).toBeInTheDocument();
  });

  it("shows the Parachute wordmark and the connect state when no vault", () => {
    renderHeader();
    expect(screen.getByRole("link", { name: /^parachute$/i })).toBeInTheDocument();
    expect(screen.getByText(/no vault connected/i)).toBeInTheDocument();
  });

  it("opens the ⋯ menu to Settings and the secondary destinations", () => {
    seedVault();
    renderHeader();
    const menuButton = screen.getByRole("button", { name: /open menu/i });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(menuButton);
    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    const menu = document.getElementById("mobile-menu");
    expect(menu).not.toBeNull();
    const panel = within(menu as HTMLElement);
    expect(panel.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
    expect(panel.getByRole("link", { name: /connect your ai/i })).toHaveAttribute(
      "href",
      "/connect",
    );
    expect(panel.getByRole("link", { name: /^map$/i })).toHaveAttribute("href", "/graph");
    expect(panel.getByRole("link", { name: /activity/i })).toHaveAttribute("href", "/activity");
    expect(panel.getByRole("link", { name: /calendar/i })).toHaveAttribute("href", "/calendar");
    expect(panel.getByRole("link", { name: /import/i })).toHaveAttribute("href", "/import");
  });
});
