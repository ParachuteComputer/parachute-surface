import { NeighborhoodGraph } from "@/components/NeighborhoodGraph";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the force graph lib — jsdom has no canvas, and we only care about
// the data/click wiring, not the actual rendering.
interface MockGraphData {
  nodes: Array<{ id: string; isAnchor?: boolean }>;
  links: Array<{ source: string; target: string; rel?: string }>;
}

vi.mock("react-force-graph-2d", () => ({
  default: (props: {
    graphData: MockGraphData;
    onNodeClick: (n: { id: string }) => void;
  }) => (
    <div data-testid="mock-force-graph">
      <span data-testid="node-count">{props.graphData.nodes.length}</span>
      <span data-testid="link-count">{props.graphData.links.length}</span>
      <ul>
        {props.graphData.nodes.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => props.onNodeClick(n)}>
              {n.id}
              {n.isAnchor ? " (anchor)" : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}));

// jsdom doesn't implement ResizeObserver.
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    class MockResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
});

function seedActiveVault() {
  useVaultStore.setState({
    vaults: {
      v1: {
        id: "v1",
        url: "http://localhost:1940",
        name: "default",
        issuer: "http://localhost:1940",
        clientId: "c",
        scope: "full",
        addedAt: "2026-04-18T00:00:00.000Z",
        lastUsedAt: "2026-04-18T00:00:00.000Z",
      },
    },
    activeVaultId: "v1",
  });
  // Minimal fake token so useActiveVaultClient returns a client.
  localStorage.setItem(
    "lens:token:v1",
    JSON.stringify({ accessToken: "t", scope: "full", vault: "default" }),
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <MemoryRouter initialEntries={["/n/A"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/n/A" element={children} />
          <Route path="/n/:id" element={<div data-testid="note-route" />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function mockFetchReturning(byId: Record<string, unknown>) {
  const impl = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const params = new URL(url).searchParams;
    const id = params.get("id") ?? "";
    const body = byId[id] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => "",
    } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

describe("NeighborhoodGraph", () => {
  beforeEach(() => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    localStorage.clear();
  });

  const anchor = {
    id: "A",
    path: "notes/A",
    createdAt: "2026-04-18T00:00:00.000Z",
    links: [
      { sourceId: "A", targetId: "B", relationship: "wikilink" },
      { sourceId: "C", targetId: "A", relationship: "wikilink" },
    ],
  };

  it("renders the graph with anchor and 1-hop neighbors at the default depth", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: { id: "B", path: "notes/B", createdAt: "2026-04-18T00:00:00.000Z" },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );

    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("3"));
    expect(screen.getByTestId("link-count").textContent).toBe("2");
    expect(screen.getByRole("button", { name: /A \(anchor\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^B$/ })).toBeInTheDocument();
  });

  it("shows the empty state when the note has no neighbors", async () => {
    seedActiveVault();
    mockFetchReturning({});
    render(
      <Wrap>
        <NeighborhoodGraph anchor={{ ...anchor, links: [] }} />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByText(/no neighbors yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId("mock-force-graph")).not.toBeInTheDocument();
  });

  it("clicking a graph node opens a preview (not a hard navigation), and Open note navigates", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: {
        id: "B",
        path: "notes/B",
        content: "# B\n\nBody of note B here.",
        tags: ["topic"],
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    const btn = await screen.findByRole("button", { name: /^B$/ });
    await act(async () => {
      fireEvent.click(btn);
    });

    // A preview appears (no navigation yet), with the lazily-fetched snippet.
    const preview = await screen.findByRole("dialog", { name: /note preview/i });
    expect(screen.queryByTestId("note-route")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(within(preview).getByText(/body of note b here/i)).toBeInTheDocument(),
    );

    // "Open note" is the navigation.
    await act(async () => {
      fireEvent.click(within(preview).getByRole("link", { name: /open note/i }));
    });
    await waitFor(() => expect(screen.getByTestId("note-route")).toBeInTheDocument());
  });

  it("expands to 2-hop neighbors when Hops is raised", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: {
        id: "B",
        path: "notes/B",
        createdAt: "2026-04-18T00:00:00.000Z",
        links: [{ sourceId: "B", targetId: "D", relationship: "wikilink" }],
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
      D: { id: "D", path: "notes/D", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("3"));

    const depth2 = screen.getByRole("button", { name: "2" });
    await act(async () => {
      fireEvent.click(depth2);
    });
    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("4"));
  });

  it("collapses and re-expands via the header toggle", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: { id: "B", path: "notes/B", createdAt: "2026-04-18T00:00:00.000Z" },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    await screen.findByTestId("mock-force-graph");
    const toggle = screen.getByRole("button", { name: /Neighborhood/ });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByTestId("mock-force-graph")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /hops/i })).not.toBeInTheDocument();
  });

  it("opens the preview from the keyboard-accessible neighbor list", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: {
        id: "B",
        path: "notes/B",
        content: "Snippet for B.",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    // The list button carries a distinct "Preview <leaf>" name (the graph node
    // button is just "B") — this is the no-mouse path into the preview.
    const listBtn = await screen.findByRole("button", { name: /^preview b$/i });
    await act(async () => {
      fireEvent.click(listBtn);
    });
    expect(await screen.findByRole("dialog", { name: /note preview/i })).toBeInTheDocument();
  });

  it("dismisses the preview on Escape", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: {
        id: "B",
        path: "notes/B",
        content: "Snippet for B.",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    const btn = await screen.findByRole("button", { name: /^B$/ });
    await act(async () => {
      fireEvent.click(btn);
    });
    const preview = await screen.findByRole("dialog", { name: /note preview/i });
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /note preview/i })).not.toBeInTheDocument(),
    );
  });

  it("lazily fetches the preview note once, on demand", async () => {
    seedActiveVault();
    const fetchImpl = mockFetchReturning({
      // Distinct H1 title vs body so the snippet text is unambiguous.
      B: {
        id: "B",
        path: "notes/B",
        content: "# Note B\n\nThe body of B here.",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    const idOf = (call: unknown[]) => {
      const input = call[0];
      const url = typeof input === "string" ? input : (input as Request).url;
      return new URL(url).searchParams.get("id");
    };
    const bCalls = () => fetchImpl.mock.calls.filter((c) => idOf(c) === "B").length;

    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    const btn = await screen.findByRole("button", { name: /^B$/ });
    const afterLoad = bCalls(); // the neighborhood expansion fetched B once

    // The snippet is NOT fetched until the preview opens (lazy).
    await act(async () => {
      fireEvent.click(btn);
    });
    const preview = await screen.findByRole("dialog", { name: /note preview/i });
    await waitFor(() =>
      expect(within(preview).getByText(/the body of b here/i)).toBeInTheDocument(),
    );
    // Exactly one on-demand fetch for the snippet — not the whole graph, and
    // not per-render.
    expect(bCalls()).toBe(afterLoad + 1);
  });

  it("closes the preview when a depth change drops the node, and doesn't resurrect it", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: {
        id: "B",
        path: "notes/B",
        createdAt: "2026-04-18T00:00:00.000Z",
        links: [{ sourceId: "B", targetId: "D", relationship: "wikilink" }],
      },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
      D: {
        id: "D",
        path: "notes/D",
        content: "# Note D\n\nBody of D.",
        createdAt: "2026-04-18T00:00:00.000Z",
      },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("3"));

    // Raise to depth 2 so the 2-hop node D exists, then preview it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2" }));
    });
    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("4"));
    const dNode = await screen.findByRole("button", { name: /^D$/ });
    await act(async () => {
      fireEvent.click(dNode);
    });
    expect(await screen.findByRole("dialog", { name: /note preview/i })).toBeInTheDocument();

    // Lower depth → D drops out → the preview closes.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "1" }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /note preview/i })).not.toBeInTheDocument(),
    );

    // Raise depth back → D returns, but the stale selection was cleared, so the
    // card does NOT re-open unbidden.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "2" }));
    });
    await waitFor(() => expect(screen.getByTestId("node-count").textContent).toBe("4"));
    expect(screen.queryByRole("dialog", { name: /note preview/i })).not.toBeInTheDocument();
  });

  it("returns focus to the opening neighbor button on Escape", async () => {
    seedActiveVault();
    mockFetchReturning({
      B: { id: "B", path: "notes/B", createdAt: "2026-04-18T00:00:00.000Z" },
      C: { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" },
    });
    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    const listBtn = await screen.findByRole("button", { name: /^preview b$/i });
    listBtn.focus();
    await act(async () => {
      fireEvent.click(listBtn);
    });
    const preview = await screen.findByRole("dialog", { name: /note preview/i });
    fireEvent.keyDown(preview, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /note preview/i })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(listBtn);
  });

  it("shows an honest error line when the preview note fails to load", async () => {
    seedActiveVault();
    // B loads for the neighborhood expansion, but the preview's own fetch (the
    // second GET for B) fails.
    let bCalls = 0;
    const impl = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const id = new URL(url).searchParams.get("id") ?? "";
      if (id === "B") {
        bCalls += 1;
        if (bCalls === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "B", path: "notes/B", createdAt: "2026-04-18T00:00:00.000Z" }),
            text: async () => "",
          } as Response;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "boom" }),
          text: async () => "",
        } as Response;
      }
      const body =
        id === "C" ? { id: "C", path: "notes/C", createdAt: "2026-04-18T00:00:00.000Z" } : [];
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", impl);

    render(
      <Wrap>
        <NeighborhoodGraph anchor={anchor} />
      </Wrap>,
    );
    const btn = await screen.findByRole("button", { name: /^B$/ });
    await act(async () => {
      fireEvent.click(btn);
    });
    const preview = await screen.findByRole("dialog", { name: /note preview/i });
    await waitFor(() =>
      expect(within(preview).getByText(/couldn't load preview/i)).toBeInTheDocument(),
    );
  });
});
