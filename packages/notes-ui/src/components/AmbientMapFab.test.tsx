import { AmbientMapFab } from "@/components/AmbientMapFab";
import { useVaultStore } from "@/lib/vault/store";
import type { VaultRecord } from "@/lib/vault/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function makeVault(id: string, url: string): VaultRecord {
  return {
    id,
    url,
    name: "gardening",
    issuer: url,
    clientId: "c",
    scope: "full",
    addedAt: "2026-04-22T00:00:00.000Z",
    lastUsedAt: "2026-04-22T00:00:00.000Z",
  };
}

function renderFab(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AmbientMapFab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AmbientMapFab", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });
  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("renders nothing with no active vault", () => {
    const { container } = renderFab();
    expect(container.querySelector("a")).toBeNull();
  });

  it("opens the graph when a vault is active and the Map is unearned", () => {
    useVaultStore.setState({
      vaults: { a: makeVault("a", "http://localhost:1940") },
      activeVaultId: "a",
    });
    renderFab("/");
    const fab = screen.getByRole("link", { name: /open the relational map/i });
    expect(fab).toHaveAttribute("href", "/graph");
    // Unearned → visible on desktop too (no lg:hidden — there's no rail row).
    expect(fab.className).not.toMatch(/\blg:hidden\b/);
  });

  it("is hidden on the graph route itself", () => {
    useVaultStore.setState({
      vaults: { a: makeVault("a", "http://localhost:1940") },
      activeVaultId: "a",
    });
    const { container } = renderFab("/graph");
    expect(container.querySelector("a")).toBeNull();
  });

  it("steps back to lg:hidden once the Map is earned (rail carries it on desktop)", () => {
    useVaultStore.setState({
      vaults: {
        a: makeVault("a", "http://localhost:1940"),
        b: makeVault("b", "http://localhost:1941"),
      },
      activeVaultId: "a",
    });
    renderFab("/");
    const fab = screen.getByRole("link", { name: /open the relational map/i });
    expect(fab.className).toMatch(/\blg:hidden\b/);
  });
});
