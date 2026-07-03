import { Notes } from "@/app/routes/Notes";
import { useVaultStore } from "@/lib/vault/store";
import type { Note } from "@/lib/vault/types";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX 2 (error-over-data) for the list route: a failed background refetch must
// not blank the list you're reading. When the notes query is errored but still
// holds the last-loaded list, Notes renders it (under a quiet offline ribbon)
// rather than the error block; the error block only shows when there's
// genuinely no cached list. We assert the rendering contract by driving
// `useNotes` into the exact `{ isError, data }` combinations — the surrounding
// hooks are mocked to benign values so the route renders without a network.
const { mockUseNotes } = vi.hoisted(() => ({ mockUseNotes: vi.fn() }));

vi.mock("@/lib/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault")>();
  return {
    ...actual,
    useNotes: () => mockUseNotes(),
    useTags: () => ({ data: [], isPending: false }),
    useTagRoles: () => ({
      roles: {
        pinned: "pinned",
        archived: "archived",
        captureText: "capture",
        captureVoice: "capture",
        view: "UI/Views/",
      },
      setRoles: vi.fn(),
    }),
    usePinnedTags: () => ({ pinnedTags: [] }),
    useNotesForPathTree: () => ({ data: [], isLoading: false }),
    useUpdateNote: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock("@/lib/saved-views/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/saved-views/queries")>();
  return {
    ...actual,
    useSavedViews: () => ({ data: [], isPending: false, error: null }),
    useSaveView: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRenameView: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateView: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeleteView: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

vi.mock("@/lib/path-tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-tree")>();
  return { ...actual, usePathTreeMode: () => ({ mode: "never", setMode: vi.fn() }) };
});

const KEPT_NOTE: Note = {
  id: "n1",
  path: "Projects/kept",
  preview: "Saved locally.",
  tags: [],
  createdAt: "2026-04-18T10:00:00Z",
  updatedAt: "2026-04-18T11:00:00Z",
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

function renderNotes() {
  return render(
    <BrowserRouter>
      <Notes />
    </BrowserRouter>,
  );
}

describe("Notes — error-over-data rendering (FIX 2)", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
    window.history.replaceState({}, "", "/");
    mockUseNotes.mockReset();
  });
  afterEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  it("keeps the list on screen (under an offline ribbon) when errored but data is cached", () => {
    mockUseNotes.mockReturnValue({
      data: [KEPT_NOTE],
      isPending: false,
      isError: true,
      error: new Error("offline"),
      isFetching: false,
      refetch: vi.fn(),
    });
    renderNotes();

    expect(screen.getByText("Projects/kept")).toBeInTheDocument();
    expect(screen.queryByText(/could not load notes/i)).toBeNull();
    expect(screen.getByText(/showing what's saved/i)).toBeInTheDocument();
  });

  it("shows the error block (no ribbon) when errored with no cached data", () => {
    mockUseNotes.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("offline"),
      isFetching: false,
      refetch: vi.fn(),
    });
    renderNotes();

    expect(screen.getByText(/could not load notes/i)).toBeInTheDocument();
    expect(screen.queryByText(/showing what's saved/i)).toBeNull();
  });
});
