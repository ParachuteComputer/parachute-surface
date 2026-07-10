import { Rail } from "@/components/Rail";
import { useVaultStore } from "@/lib/vault/store";
import type { VaultRecord } from "@/lib/vault/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeVault(partial: Partial<VaultRecord> & Pick<VaultRecord, "id" | "url">): VaultRecord {
  return {
    name: "default",
    issuer: partial.url,
    clientId: "client-test",
    scope: "full",
    addedAt: "2026-04-22T00:00:00.000Z",
    lastUsedAt: "2026-04-22T00:00:00.000Z",
    ...partial,
  };
}

// Async so the setup-checklist query settles inside act() — the Rail reads
// react-query data, so a bare render leaves a pending state update.
async function renderRail(path = "/"): Promise<RenderResult> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let result!: RenderResult;
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Rail />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return result;
}

function seedVaults(entries: Record<string, VaultRecord>) {
  const first = Object.keys(entries)[0] ?? null;
  useVaultStore.setState({ vaults: entries, activeVaultId: first });
}

describe("Rail (desktop spine, Phase 3a)", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ notes: [], vaults: [], services: [] }),
        }) as Response,
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    vi.restoreAllMocks();
  });

  it("renders nothing with no active vault", async () => {
    const { container } = await renderRail();
    expect(container.querySelector("aside")).toBeNull();
  });

  it("is a desktop-only spine (hidden lg:flex)", async () => {
    seedVaults({ a: makeVault({ id: "a", url: "http://localhost:1940", name: "gardening" }) });
    const { container } = await renderRail();
    const aside = container.querySelector("aside");
    expect(aside?.className).toMatch(/\bhidden\b/);
    expect(aside?.className).toMatch(/\blg:flex\b/);
  });

  it("leads with the vault switcher and lists the Your-notes rooms + Settings", async () => {
    seedVaults({ a: makeVault({ id: "a", url: "http://localhost:1940", name: "gardening" }) });
    await renderRail();
    expect(screen.getByRole("button", { name: /active vault: gardening/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^today$/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /^all notes$/i })).toHaveAttribute("href", "/all");
    expect(screen.getByRole("link", { name: /^tags$/i })).toHaveAttribute("href", "/tags");
    expect(screen.getByRole("link", { name: /^settings$/i })).toHaveAttribute("href", "/settings");
  });

  it("hides the Map row until it's earned (one vault, no linked notes)", async () => {
    seedVaults({ a: makeVault({ id: "a", url: "http://localhost:1940", name: "gardening" }) });
    await renderRail();
    expect(screen.queryByRole("link", { name: /^map$/i })).toBeNull();
  });

  it("shows the Map row once earned (≥2 vaults)", async () => {
    seedVaults({
      a: makeVault({ id: "a", url: "http://localhost:1940", name: "gardening" }),
      b: makeVault({ id: "b", url: "http://localhost:1941", name: "journal" }),
    });
    await renderRail();
    expect(screen.getByRole("link", { name: /^map$/i })).toHaveAttribute("href", "/graph");
  });
});
