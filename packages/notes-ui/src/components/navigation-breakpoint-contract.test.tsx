import { BottomTabBar } from "@/components/BottomTabBar";
import { Rail } from "@/components/Rail";
import { useVaultStore } from "@/lib/vault/store";
import type { VaultRecord } from "@/lib/vault/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Contract test (notes#147, re-homed to Rail↔BottomTabBar in Phase 3a): the
// primary-navigation surface on desktop (the left Rail) and on mobile+tablet
// (the BottomTabBar) MUST share the same breakpoint and meet without a gap.
// The Rail is `hidden lg:flex` (only visible at >= lg); the BottomTabBar is
// `lg:hidden` (visible until >= lg). At any viewport width exactly one shows.
// The failure mode this guards is one side drifting to `md:` — that leaves the
// 768-1023px band with no primary navigation.
//
// JSDOM can't compute layout, so the assertion is at the class-name level.

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

function seedActiveVault() {
  useVaultStore.setState({
    vaults: { a: makeVault({ id: "a", url: "http://localhost:1940", name: "default" }) },
    activeVaultId: "a",
  });
}

// The Rail reads react-query data (setup-checklist signal), so it needs a
// client in scope. Retry off so the stubbed 200 settles immediately; async +
// act so the settled query doesn't leave a pending state update.
async function renderWithClient(ui: ReactNode): Promise<RenderResult> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let result!: RenderResult;
  await act(async () => {
    result = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return result;
}

describe("Rail + BottomTabBar breakpoint contract (notes#147)", () => {
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
    seedActiveVault();
  });

  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    vi.restoreAllMocks();
  });

  it("Rail shows at lg+ and BottomTabBar hides at lg+ — same gate, opposite direction, no gap", async () => {
    const { container: railContainer } = await renderWithClient(<Rail />);
    const { container: barContainer } = await renderWithClient(<BottomTabBar />);

    // The Rail's root <aside> is `hidden lg:flex` (renders at >= lg).
    const rail = railContainer.querySelector("aside");
    expect(rail, "Rail <aside> must render when a vault is active").not.toBeNull();
    expect(rail?.className).toMatch(/\bhidden\b/);
    expect(rail?.className).toMatch(/\blg:flex\b/);

    // BottomTabBar's primary nav: `lg:hidden` (renders at < lg).
    const bar = barContainer.querySelector('nav[aria-label="Primary"]');
    expect(bar, "BottomTabBar primary nav must exist when a vault is active").not.toBeNull();
    expect(bar?.className).toMatch(/\blg:hidden\b/);

    // The hard contract: neither side may use `md:` for the visibility gate.
    expect(rail?.className).not.toMatch(/\bmd:flex\b/);
    expect(rail?.className).not.toMatch(/\bmd:hidden\b/);
    expect(bar?.className).not.toMatch(/\bmd:hidden\b/);
    expect(bar?.className).not.toMatch(/\bmd:flex\b/);
  });

  it("Rail renders nothing with no active vault (the no-vault desktop view is full-width Landing)", async () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    const { container } = await renderWithClient(<Rail />);
    expect(container.querySelector("aside")).toBeNull();
  });
});
