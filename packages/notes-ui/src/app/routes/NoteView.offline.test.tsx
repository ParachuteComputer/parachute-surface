import { NoteView } from "@/app/routes/NoteView";
import { useVaultStore } from "@/lib/vault/store";
import type { Note } from "@/lib/vault/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX 2 (error-over-data) for the single-note route: a failed background
// refetch must not blank the note you're reading. When the note query is in
// an error state but still holds the note, NoteView renders it (under a quiet
// offline ribbon) rather than the error block; the error block only shows when
// there's genuinely no note to show. We assert the rendering contract by
// driving `useNote` into the exact `{ isError, data }` combinations.
const { mockUseNote } = vi.hoisted(() => ({ mockUseNote: vi.fn() }));

vi.mock("@/lib/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault")>();
  return { ...actual, useNote: () => mockUseNote() };
});

const KEPT_NOTE: Note = {
  id: "abc-123",
  path: "Canon/Kept",
  createdAt: "2026-04-16T00:00:00Z",
  content: "# Kept Note\n\nStill readable offline.",
  tags: [],
  links: [],
  attachments: [],
};

function seedStore() {
  useVaultStore.setState({
    vaults: {
      dev: {
        id: "dev",
        url: "http://localhost:1940",
        name: "dev",
        issuer: "http://localhost:1940",
        clientId: "client-test",
        scope: "full",
        addedAt: "2026-04-18T00:00:00.000Z",
        lastUsedAt: "2026-04-18T00:00:00.000Z",
      },
    },
    activeVaultId: "dev",
  });
}

function Wrapper({ children }: { children: ReactNode }) {
  // NoteBody renders PinArchive/Delete buttons (useMutation) and the graph, so
  // a QueryClient must be present even though the note itself is a mocked hook.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/n/:id" element={<NoteView />} />
        <Route path="*" element={<div>Other</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

describe("NoteView — error-over-data rendering (FIX 2)", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
    // Any stray query from NoteBody's graph settles to empty rather than
    // hitting the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => [], text: async () => "" }) as Response,
      ),
    );
    mockUseNote.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("keeps the note on screen (under an offline ribbon) when errored but data is cached", () => {
    mockUseNote.mockReturnValue({
      data: KEPT_NOTE,
      isPending: false,
      isError: true,
      error: new Error("offline"),
      refetch: vi.fn(),
    });
    renderAt("/n/abc-123");

    expect(screen.getByRole("heading", { level: 1, name: "Kept Note" })).toBeInTheDocument();
    expect(screen.getByText("Still readable offline.")).toBeInTheDocument();
    expect(screen.queryByText(/could not load note/i)).toBeNull();
    expect(screen.getByText(/showing what's saved/i)).toBeInTheDocument();
  });

  it("shows the error block (no ribbon) when errored with no cached data", () => {
    mockUseNote.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("offline"),
      refetch: vi.fn(),
    });
    renderAt("/n/abc-123");

    expect(screen.getByText(/could not load note/i)).toBeInTheDocument();
    expect(screen.queryByText(/showing what's saved/i)).toBeNull();
  });
});
