import { NoteView } from "@/app/routes/NoteView";
import { type LensDB, openLensDB } from "@/lib/sync/db";
import { newLocalId, recordIdMap } from "@/lib/sync/id-map";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FIX 3 uses `useSync().db` to resolve a local id via the id-map. Mock the
// provider so the id-map test can hand `useNote` a db it fully controls
// (deterministic — no async provider bootstrap). The default `db: null` matches
// the un-wrapped context default the other describes already run against, so
// real-id tests are unaffected.
const { syncState } = vi.hoisted(() => ({ syncState: { db: null as LensDB | null } }));
vi.mock("@/providers/SyncProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/providers/SyncProvider")>();
  return {
    ...actual,
    useSync: () => ({
      db: syncState.db,
      blobStore: null,
      engine: null,
      isOnline: true,
      isDraining: false,
      lastSyncedAt: null,
    }),
  };
});

interface FetchMap {
  [urlMatcher: string]: { status?: number; body: unknown };
}

function installFetch(map: FetchMap) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const matcher of Object.keys(map)) {
      if (url.includes(matcher)) {
        const entry = map[matcher];
        return {
          ok: (entry.status ?? 200) < 400,
          status: entry.status ?? 200,
          json: async () => entry.body,
          text: async () => "",
          blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        } as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => null,
      text: async () => "",
    } as Response;
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

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
  localStorage.setItem(
    "lens:token:dev",
    JSON.stringify({ accessToken: "pvt_abc", scope: "full", vault: "default" }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/n/:id" element={<NoteView />} />
        <Route path="/" element={<div>NotesListPage</div>} />
        <Route path="/add" element={<div>AddVaultPage</div>} />
        <Route path="*" element={<div>Other</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

describe("NoteView route", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders markdown content, metadata, tags, and back link", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "abc-123",
          path: "Canon/Aaron",
          createdAt: "2026-04-16T04:30:54.177Z",
          updatedAt: "2026-04-17T00:05:07.721Z",
          content: "# Aaron Gabriel\n\nTeacher and builder.",
          metadata: { summary: "Canon note on Aaron." },
          tags: ["canon"],
          links: [],
          attachments: [],
        },
      },
    });

    renderAt("/n/abc-123");

    expect(await screen.findByText("Aaron Gabriel")).toBeInTheDocument();
    expect(screen.getByText("Teacher and builder.")).toBeInTheDocument();
    expect(screen.getByText("Canon note on Aaron.")).toBeInTheDocument();
    // Tag chip links to the filtered list
    const tagChip = screen.getByRole("link", { name: "#canon" });
    expect(tagChip).toHaveAttribute("href", "/all?tag=canon");
    // Back link to / is present
    expect(screen.getByRole("link", { name: /all notes/i })).toBeInTheDocument();
    // Edit placeholder routes to the edit route (PR #5)
    expect(screen.getByRole("link", { name: /edit/i })).toHaveAttribute("href", "/n/abc-123/edit");
  });

  it("titles by the leading H1 and strips it from the body (no double render)", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "lead",
          path: "Canon/Aaron",
          createdAt: "2026-04-16T00:00:00Z",
          content: "# Aaron Gabriel\n\nTeacher and builder.",
          tags: [],
          links: [],
          attachments: [],
        },
      },
    });
    renderAt("/n/lead");
    // The leading H1 becomes the page title …
    expect(
      await screen.findByRole("heading", { level: 1, name: "Aaron Gabriel" }),
    ).toBeInTheDocument();
    // … and appears exactly once (stripped from the rendered body).
    expect(screen.getAllByText("Aaron Gabriel")).toHaveLength(1);
    expect(screen.getByText("Teacher and builder.")).toBeInTheDocument();
  });

  it("falls back to the path leaf for a buried H1 and leaves it in the body", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "buried",
          path: "Canon/Aaron",
          createdAt: "2026-04-16T00:00:00Z",
          // The H1 isn't the leading line, so it is NOT the title — and must
          // still render in the body (regression guard for the strip/derive
          // mismatch the reviewer caught).
          content: "Some intro paragraph.\n\n# Buried Title\n\nMore body.",
          tags: [],
          links: [],
          attachments: [],
        },
      },
    });
    renderAt("/n/buried");
    // Header falls back to the path leaf, not the buried heading.
    expect(await screen.findByRole("heading", { level: 1, name: "Aaron" })).toBeInTheDocument();
    // The buried H1 renders once (in the body), never promoted to the title.
    expect(screen.getAllByText("Buried Title")).toHaveLength(1);
    expect(screen.getByText("Some intro paragraph.")).toBeInTheDocument();
    expect(screen.getByText("More body.")).toBeInTheDocument();
  });

  it("resolves [[wikilinks]] via the outbound links table and renders as a /n/<id> link", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "me",
          path: "Canon/Aaron",
          createdAt: "2026-04-16T00:00:00Z",
          content: "See [[Canon/Uni]] for more. Also [[Missing/Note]].",
          tags: [],
          links: [
            {
              sourceId: "me",
              targetId: "uni-id",
              relationship: "wikilink",
              targetNote: { id: "uni-id", path: "Canon/Uni" },
            },
          ],
          attachments: [],
        },
      },
    });

    const { container } = renderAt("/n/me");

    // Prefer the in-body wikilink (not the sidebar) via container scoping.
    await screen.findByText(/See/);
    const body = container.querySelector(".prose-note");
    expect(body).not.toBeNull();
    const resolvedLinks = Array.from(
      body!.querySelectorAll<HTMLAnchorElement>("a.wikilink-resolved"),
    );
    expect(resolvedLinks).toHaveLength(1);
    expect(resolvedLinks[0]).toHaveAttribute("href", "/n/uni-id");
    expect(resolvedLinks[0]?.textContent).toBe("Canon/Uni");

    const unresolvedLinks = Array.from(
      body!.querySelectorAll<HTMLAnchorElement>("a.wikilink-unresolved"),
    );
    expect(unresolvedLinks).toHaveLength(1);
    expect(unresolvedLinks[0]).toHaveAttribute("href", "/n/Missing%2FNote");
    expect(unresolvedLinks[0]?.textContent).toBe("Missing/Note");
  });

  it("renders inbound and outbound link panels with peer paths", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "center",
          path: "hub",
          createdAt: "2026-04-16T00:00:00Z",
          content: "Hub.",
          tags: [],
          links: [
            {
              sourceId: "center",
              targetId: "out-1",
              relationship: "wikilink",
              targetNote: { id: "out-1", path: "Outbound/One" },
            },
            {
              sourceId: "in-1",
              targetId: "center",
              relationship: "wikilink",
              sourceNote: { id: "in-1", path: "Inbound/One" },
            },
          ],
          attachments: [],
        },
      },
    });

    renderAt("/n/center");

    expect(await screen.findByRole("heading", { name: /Outbound \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Inbound \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Outbound\/One/ })).toHaveAttribute("href", "/n/out-1");
    expect(screen.getByRole("link", { name: /Inbound\/One/ })).toHaveAttribute("href", "/n/in-1");
  });

  it("renders an inline image attachment (blob-fetched through VaultClient)", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "with-img",
          path: "media",
          createdAt: "2026-04-16T00:00:00Z",
          content: "pic",
          tags: [],
          links: [],
          attachments: [
            {
              id: "att-1",
              filename: "hero.png",
              mimeType: "image/png",
              url: "/attachments/att-1",
              size: 2048,
            },
          ],
        },
      },
      "/attachments/att-1": { body: null },
    });
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:fake-url");
    URL.revokeObjectURL = vi.fn();

    renderAt("/n/with-img");

    const img = (await screen.findByAltText("hero.png")) as HTMLImageElement;
    await waitFor(() => {
      expect(img.src).toContain("blob:fake-url");
    });
    URL.createObjectURL = origCreate;
  });

  it("shows a 404 block when the vault returns no note for the id", async () => {
    installFetch({
      "/api/notes": { body: [] },
    });
    renderAt("/n/nonexistent");
    expect(await screen.findByText(/note not found/i)).toBeInTheDocument();
  });

  it("routes through Reconnect on 401", async () => {
    installFetch({
      "/api/notes": { status: 401, body: null },
    });
    renderAt("/n/any");
    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /reconnect/i })).toHaveAttribute("href", "/add");
  });

  it("clicking Pin PATCHes the note with the pinned role tag", async () => {
    const fetchImpl = installFetch({
      "/api/notes": {
        body: {
          id: "abc-123",
          path: "some/note",
          createdAt: "2026-04-16T04:30:54.177Z",
          updatedAt: "2026-04-17T00:05:07.721Z",
          content: "body",
          tags: [],
          links: [],
          attachments: [],
        },
      },
    });
    renderAt("/n/abc-123");

    const pinBtn = await screen.findByRole("button", { name: /^☆ Pin$/ });
    fireEvent.click(pinBtn);

    await waitFor(() => {
      const patchCall = fetchImpl.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "PATCH";
      });
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.tags).toEqual({ add: ["pinned"] });
    });
  });

  it("shows the Pinned state and Unarchive label based on current tags", async () => {
    installFetch({
      "/api/notes": {
        body: {
          id: "n",
          path: "note",
          createdAt: "2026-04-16T04:30:54.177Z",
          content: "body",
          tags: ["pinned", "archived"],
          links: [],
          attachments: [],
        },
      },
    });
    renderAt("/n/n");

    expect(await screen.findByRole("button", { name: /★ Pinned/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Archived$/ })).toBeInTheDocument();
  });

  it("pressing P toggles the pinned tag", async () => {
    const fetchImpl = installFetch({
      "/api/notes": {
        body: {
          id: "k",
          path: "keyboard",
          createdAt: "2026-04-16T04:30:54.177Z",
          content: "body",
          tags: [],
          links: [],
          attachments: [],
        },
      },
    });
    renderAt("/n/k");

    await screen.findByRole("button", { name: /^☆ Pin$/ });
    fireEvent.keyDown(window, { key: "p" });

    await waitFor(() => {
      const patchCall = fetchImpl.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "PATCH";
      });
      expect(patchCall).toBeDefined();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.tags).toEqual({ add: ["pinned"] });
    });
  });
});

describe("NoteView — offline voice capture (local id → id-map resolution) [FIX 3]", () => {
  let db: LensDB;

  beforeEach(async () => {
    indexedDB.deleteDatabase("parachute-lens");
    db = await openLensDB();
    syncState.db = db;
    localStorage.clear();
    sessionStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    syncState.db = null;
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
  });

  function renderWith(qc: QueryClient, path: string) {
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/n/:id" element={<NoteView />} />
            <Route path="*" element={<div>Other</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("renders the optimistic note for a not-yet-synced local id, then the server note once the id-map fills", async () => {
    const localId = newLocalId();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
    });
    // The capture flow seeds the optimistic note into the cache before it
    // navigates to /n/<localId>. A bare getNote(localId) would 404.
    qc.setQueryData(["note", "dev", localId], {
      id: localId,
      path: "Voice/memo",
      createdAt: "2026-07-03T00:00:00Z",
      updatedAt: "2026-07-03T00:00:00Z",
      content: "_Transcript pending._",
      tags: ["capture"],
      metadata: { source: "voice" },
    });
    // The server route for the eventual real note. It is never hit during the
    // optimistic phase (getNote(localId) is short-circuited to the cached
    // optimistic row); only a resolved id-map fetches it. Installed up front
    // because the vault client binds `fetch` at construction (client.ts:145),
    // so a later re-stub would be invisible to it. Everything else 404s —
    // proving we never fall through to getNote(localId).
    installFetch({
      "id=real-123": {
        body: {
          id: "real-123",
          path: "Voice/memo",
          createdAt: "2026-07-03T00:00:00Z",
          content: "# Memo\n\nThe transcribed text.",
          tags: ["capture"],
          links: [],
          attachments: [],
        },
      },
    });
    renderWith(qc, `/n/${encodeURIComponent(localId)}`);

    // Lands on a readable note, not an error/404 screen.
    expect(await screen.findByRole("heading", { level: 1, name: "memo" })).toBeInTheDocument();
    expect(screen.getByText(/transcript pending/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load note/i)).toBeNull();
    expect(screen.queryByText(/note not found/i)).toBeNull();

    // The create-note row drains: the id-map now maps local → server.
    await recordIdMap(db, localId, "real-123", "dev");

    // A refetch now resolves the id-map and fetches the real note — the view
    // flips from the optimistic row to the server note.
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["note", "dev", localId] });
    });
    expect(await screen.findByText("The transcribed text.")).toBeInTheDocument();
  });
});
