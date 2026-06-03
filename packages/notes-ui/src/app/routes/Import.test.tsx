import { Import } from "@/app/routes/Import";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FetchEntry {
  status?: number;
  body: unknown;
  text?: string;
}
type FetchMap = Record<string, FetchEntry | FetchEntry[]>;

function installFetch(map: FetchMap) {
  const cursors = new Map<string, number>();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    for (const matcher of Object.keys(map)) {
      const [wantMethod, wantFragment] = matcher.includes(" ")
        ? matcher.split(" ", 2)
        : ["GET", matcher];
      if (method !== wantMethod) continue;
      if (!url.includes(wantFragment!)) continue;
      const entry = map[matcher]!;
      const list = Array.isArray(entry) ? entry : [entry];
      const idx = Math.min(cursors.get(matcher) ?? 0, list.length - 1);
      cursors.set(matcher, idx + 1);
      const hit = list[idx]!;
      return {
        ok: (hit.status ?? 200) < 400,
        status: hit.status ?? 200,
        json: async () => hit.body,
        text: async () => hit.text ?? JSON.stringify(hit.body),
        headers: new Headers(),
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => null,
      text: async () => "",
      headers: new Headers(),
    } as unknown as Response;
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderRoute(initialPath = "/import") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/import" element={<Import />} />
        <Route path="/" element={<div>HomePage</div>} />
        {/* The connect-flow target — render its search string so the
            forwarding test can assert the url + redirect params survived. */}
        <Route path="/add" element={<AddVaultProbe />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

// Lightweight stand-in for the real AddVault route. Exposes the live search
// params as data-attributes so the forwarding test can assert the deep-link
// `?url=` + post-connect `redirect=` rode through intact, without dragging in
// AddVault's OAuth/probe machinery.
function AddVaultProbe() {
  const [params] = useSearchParams();
  return (
    <div
      data-testid="add-vault-page"
      data-url={params.get("url") ?? ""}
      data-redirect={params.get("redirect") ?? ""}
    >
      AddVaultPage
    </div>
  );
}

describe("Import route", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the picker initially with the active vault name", () => {
    renderRoute();
    expect(screen.getByText(/Import notes into/i)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText(/Drop a file here/i)).toBeInTheDocument();
    // The "Choose files" affordance is a `<label>` wrapping a hidden file
    // input — not a button. The file input itself is the accessible
    // control here.
    expect(document.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("redirects home when no vault is active and no ?url= is present", () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    renderRoute();
    expect(screen.getByText("HomePage")).toBeInTheDocument();
  });

  // notes#63 — the hub `/account` "Import notes" deep-link is
  // `/import?url=<hubOrigin>/vault/<name>`. A first-time user (no vault yet)
  // must not lose the param: forward into the connect flow carrying the url
  // AND a post-connect redirect back to /import, rather than silently
  // bouncing to the home screen.
  it("forwards ?url= into /add (with redirect=/import) when no vault is active", () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    renderRoute("/import?url=https%3A%2F%2Fhub.example%2Fvault%2Fdefault");
    const addPage = screen.getByTestId("add-vault-page");
    expect(addPage).toBeInTheDocument();
    // The hub origin/vault URL rode through to /add's ?url= intact…
    expect(addPage).toHaveAttribute("data-url", "https://hub.example/vault/default");
    // …alongside the post-connect redirect that lands the user back on import.
    expect(addPage).toHaveAttribute("data-redirect", "/import");
    // Must NOT have fallen through to the home screen (the pre-fix behavior).
    expect(screen.queryByText("HomePage")).not.toBeInTheDocument();
  });

  it("renders the import picker (not the connect flow) when a vault IS connected, even with ?url=", () => {
    // Already-connected path is unchanged: the deep-link still lands on the
    // import surface for the active vault, ignoring ?url=.
    renderRoute("/import?url=https%3A%2F%2Fhub.example%2Fvault%2Fdefault");
    expect(screen.getByText(/Import notes into/i)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.queryByTestId("add-vault-page")).not.toBeInTheDocument();
  });

  it("parses loose markdown, shows dry-run, then imports on confirm", async () => {
    const fetchImpl = installFetch({
      "POST /api/notes": [
        { status: 201, body: { id: "n1", path: "alpha" } },
        { status: 201, body: { id: "n2", path: "beta" } },
      ],
    });

    renderRoute();

    // Select two markdown files via the hidden input.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(["---\ntags: [work]\n---\nalpha body"], "alpha.md", { type: "text/markdown" }),
      new File(["beta body with #idea"], "beta.md", { type: "text/markdown" }),
    ];
    await act(async () => {
      Object.defineProperty(input, "files", { value: files, configurable: true });
      fireEvent.change(input);
    });

    // Dry-run review shows the count + tags. The number is in a `<strong>`
    // and the surrounding copy is in a sibling, so the matcher has to span
    // multiple elements — use a normalizer over the full container text.
    await waitFor(() => {
      const heading = screen.getByText(/Dry run/i);
      const card = heading.closest("div");
      expect(card?.textContent?.replace(/\s+/g, " ")).toMatch(/2 notes will be created/i);
    });
    // Format badge surfaces the detected source kind.
    expect(screen.getAllByText(/loose markdown/i).length).toBeGreaterThan(0);
    // Both tags should surface in the preview.
    expect(screen.getByText(/#work/)).toBeInTheDocument();
    expect(screen.getByText(/#idea/)).toBeInTheDocument();

    // Confirm.
    const confirmBtn = screen.getByRole("button", { name: /Run import/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Final report: 2 created.
    await waitFor(() => {
      expect(screen.getByText(/Import complete/i)).toBeInTheDocument();
    });
    const summaryHeading = screen.getByText(/Import complete/i);
    const summaryCard = summaryHeading.closest("div");
    expect(summaryCard?.textContent?.replace(/\s+/g, " ")).toMatch(/2 notes created/i);

    // Verify two POST /api/notes calls happened with the right payloads.
    const postCalls = fetchImpl.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(2);
    const bodies = postCalls
      .map(([, init]) => init as RequestInit | undefined)
      .map((init) => (typeof init?.body === "string" ? JSON.parse(init.body) : null));
    expect(bodies[0]).toMatchObject({ path: "alpha", tags: ["work"] });
    expect(bodies[1]).toMatchObject({ path: "beta", tags: ["idea"] });
  });

  it("routes 409 conflicts into the skipped bucket, surfaces the count", async () => {
    installFetch({
      "POST /api/notes": [
        { status: 201, body: { id: "n1", path: "ok" } },
        { status: 409, body: { error: "path_conflict", path: "dup", message: "already exists" } },
      ],
    });

    renderRoute();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const files = [
      new File(["ok body"], "ok.md", { type: "text/markdown" }),
      new File(["dup body"], "dup.md", { type: "text/markdown" }),
    ];
    await act(async () => {
      Object.defineProperty(input, "files", { value: files, configurable: true });
      fireEvent.change(input);
    });
    await waitFor(() => screen.getByRole("button", { name: /Run import/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Run import/i }));
    });
    await waitFor(() => screen.getByText(/Import complete/i));

    // 1 created, 1 skipped, 0 errored — matches the conflict semantics.
    // Normalize whitespace across the summary card so the matchers don't
    // care how each count is sliced across `<span>` / `<li>` boundaries.
    const summaryHeading = screen.getByText(/Import complete/i);
    const summaryCard = summaryHeading.closest("div");
    const normalized = summaryCard?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toMatch(/1 notes created/i);
    expect(normalized).toMatch(/1 notes skipped/i);
    expect(normalized).toMatch(/0 notes errored/i);
  });
});
