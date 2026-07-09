import { Home } from "@/app/routes/Home";
import { loadChecklistState } from "@/lib/home/checklist";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  path: string;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  preview?: string;
}

function installFetch(notes: Row[]) {
  const impl = vi.fn<typeof fetch>(async () => {
    return { ok: true, status: 200, json: async () => notes, text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function seedStore() {
  useVaultStore.setState({
    vaults: {
      v1: {
        id: "v1",
        url: "http://localhost:1940",
        name: "default",
        issuer: "http://localhost:1940",
        clientId: "c",
        scope: "full",
        addedAt: "2026-07-01T00:00:00.000Z",
        lastUsedAt: "2026-07-01T00:00:00.000Z",
      },
    },
    activeVaultId: "v1",
  });
  localStorage.setItem(
    "lens:token:v1",
    JSON.stringify({ accessToken: "t", scope: "full", vault: "default" }),
  );
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <MemoryRouter initialEntries={["/"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/" element={children} />
          <Route path="/all" element={<LocationSpy />} />
          <Route path="/new" element={<LocationSpy />} />
          <Route path="/connect" element={<LocationSpy />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const SEED_ONLY: Row[] = [
  {
    id: "g1",
    path: "Welcome to your vault 🪂",
    tags: ["guide"],
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
  },
];

const WITH_USER_NOTE: Row[] = [
  ...SEED_ONLY,
  {
    id: "u1",
    path: "My first thought",
    preview: "Something I wrote.",
    tags: ["capture"],
    createdAt: "2026-07-02T09:00:00.000Z",
    updatedAt: "2026-07-02T09:00:00.000Z",
  },
];

function checklistDetails(): HTMLDetailsElement {
  const section = screen.getByRole("region", { name: /setup checklist/i });
  const details = section.querySelector("details");
  if (!details) throw new Error("checklist details not found");
  return details as HTMLDetailsElement;
}

describe("Home — guided front door", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    localStorage.clear();
  });

  it("greets a fresh vault warmly and expands the checklist", async () => {
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    // Fresh = no user-authored note yet → warm welcome + expanded checklist.
    expect(await screen.findByText(/welcome aboard/i)).toBeInTheDocument();
    expect(checklistDetails().open).toBe(true);
    // The vault name rides the eyebrow.
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("goes quiet for a returning vault: no welcome fanfare, checklist collapsed", async () => {
    installFetch(WITH_USER_NOTE);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    // Wait for the user note to land in the recent timeline, then assert the
    // quiet header.
    expect(await screen.findByText("My first thought")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: /^home$/i })).toBeInTheDocument();
    expect(screen.queryByText(/welcome aboard/i)).not.toBeInTheDocument();
    // Checklist still present (connect/import pending) but collapsed.
    expect(checklistDetails().open).toBe(false);
  });

  it("shows the four quick actions and recent notes (seed guides count)", async () => {
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    await screen.findByText(/welcome aboard/i);
    const quickNav = screen.getByRole("navigation", { name: /quick actions/i });
    expect(within(quickNav).getByText(/write a note/i)).toBeInTheDocument();
    expect(within(quickNav).getByText(/connect your ai/i)).toBeInTheDocument();
    expect(within(quickNav).getByText(/bring your notes over/i)).toBeInTheDocument();
    // Seed guide shows in Recent (it's a real note).
    expect(screen.getByText(/welcome to your vault/i)).toBeInTheDocument();
  });

  it("hides the install affordance where the platform can't install", async () => {
    // jsdom: not standalone, no beforeinstallprompt, non-iOS UA → unsupported.
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    await screen.findByText(/welcome aboard/i);
    expect(screen.queryByText(/install the app/i)).not.toBeInTheDocument();
  });

  it("persists a manual checklist tick per vault", async () => {
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    await screen.findByText(/welcome aboard/i);
    const connectBox = screen.getByLabelText(/mark "connect your ai" done/i);
    fireEvent.click(connectBox);
    await waitFor(() => expect(loadChecklistState("v1").overrides.connect).toBe(true));
  });

  it("dismisses the whole checklist and remembers it", async () => {
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    await screen.findByText(/welcome aboard/i);
    fireEvent.click(screen.getByRole("button", { name: /^dismiss$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /setup checklist/i })).not.toBeInTheDocument(),
    );
    expect(loadChecklistState("v1").dismissed).toBe(true);
  });

  it("search deep-links into the full notes list", async () => {
    installFetch(SEED_ONLY);
    render(
      <Wrap>
        <Home />
      </Wrap>,
    );
    await screen.findByText(/welcome aboard/i);
    fireEvent.change(screen.getByLabelText(/search your notes/i), {
      target: { value: "budget" },
    });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/all?search=budget"),
    );
  });
});
