import { TagSchemaEditor, _internals } from "@/components/TagSchemaEditor";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The schema editor talks to vault's GET/PUT `/api/tags/:name`. These tests
// exercise the form behavior (load → edit → save) by stubbing fetch at the
// network boundary and inspecting the request shapes.

interface FetchEntry {
  status?: number;
  body: unknown;
}
type FetchMap = Record<string, FetchEntry | FetchEntry[]>;

function installFetch(map: FetchMap) {
  const cursors = new Map<string, number>();
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
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
        text: async () => "",
      } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", impl);
  return { impl, calls };
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
        addedAt: "2026-04-18T00:00:00.000Z",
        lastUsedAt: "2026-04-18T00:00:00.000Z",
      },
    },
    activeVaultId: "v1",
  });
  localStorage.setItem(
    "lens:token:v1",
    JSON.stringify({ accessToken: "t", scope: "full", vault: "default" }),
  );
}

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("TagSchemaEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the current schema and seeds form fields", async () => {
    installFetch({
      "/api/tags/project": {
        body: {
          name: "project",
          count: 3,
          description: "A unit of work.",
          fields: { status: { type: "string" }, due: { type: "date" } },
          parent_names: ["area"],
          relationships: null,
        },
      },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="project" onClose={() => {}} />
      </Wrap>,
    );
    await waitFor(() => {
      expect((screen.getByLabelText(/tag description/i) as HTMLInputElement).value).toBe(
        "A unit of work.",
      );
    });
    // Two field rows seeded — `status` + `due`.
    const fieldRows = screen.getAllByLabelText(/field name/i);
    expect(fieldRows.length).toBe(2);
    const values = (fieldRows as HTMLInputElement[]).map((el) => el.value).sort();
    expect(values).toEqual(["due", "status"]);
    expect((screen.getByLabelText(/parent tags/i) as HTMLInputElement).value).toBe("area");
  });

  it("treats a 404 (no schema yet) as an empty starting form", async () => {
    installFetch({
      "/api/tags/blank": { status: 404, body: null },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="blank" onClose={() => {}} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/no fields declared yet/i)).toBeInTheDocument();
    });
    expect((screen.getByLabelText(/tag description/i) as HTMLInputElement).value).toBe("");
  });

  it("adding a field surfaces the existing-notes warning", async () => {
    installFetch({
      "/api/tags/idea": {
        body: {
          name: "idea",
          count: 5,
          description: null,
          fields: null,
          parent_names: null,
          relationships: null,
        },
      },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="idea" onClose={() => {}} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/no fields declared yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/doesn't retroactively update notes/i)).toBeNull();

    fireEvent.click(screen.getByText(/add field/i));
    const row = await screen.findByLabelText(/field name/i);
    fireEvent.change(row, { target: { value: "summary" } });
    // Warning surfaces because the on-vault shape (no fields) is now diff
    // from the form state (one field).
    expect(await screen.findByText(/doesn't retroactively update notes/i)).toBeInTheDocument();
  });

  it("description-only edits don't fire the existing-notes warning", async () => {
    installFetch({
      "/api/tags/idea": {
        body: {
          name: "idea",
          count: 5,
          description: "old",
          fields: null,
          parent_names: null,
          relationships: null,
        },
      },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="idea" onClose={() => {}} />
      </Wrap>,
    );
    await waitFor(() => {
      expect((screen.getByLabelText(/tag description/i) as HTMLInputElement).value).toBe("old");
    });
    fireEvent.change(screen.getByLabelText(/tag description/i), {
      target: { value: "new description" },
    });
    // Field shape hasn't changed; warning stays hidden. Vault still touches
    // the row, but there's no shape diff to caution about.
    expect(screen.queryByText(/doesn't retroactively update notes/i)).toBeNull();
  });

  it("saves a new field via PUT with merge-on-write semantics", async () => {
    const onClose = vi.fn();
    const { calls } = installFetch({
      "/api/tags/idea": [
        {
          body: {
            name: "idea",
            count: 5,
            description: null,
            fields: null,
            parent_names: null,
            relationships: null,
          },
        },
        // Subsequent reads after invalidation
        {
          body: {
            name: "idea",
            count: 5,
            description: null,
            fields: { status: { type: "string" } },
            parent_names: null,
            relationships: null,
          },
        },
      ],
      "PUT /api/tags/idea": {
        body: {
          name: "idea",
          count: 5,
          description: null,
          fields: { status: { type: "string" } },
          parent_names: null,
          relationships: null,
        },
      },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="idea" onClose={onClose} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/no fields declared yet/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/add field/i));
    const nameInput = await screen.findByLabelText(/field name/i);
    fireEvent.change(nameInput, { target: { value: "status" } });

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      description: null,
      parent_names: null,
      fields: { status: { type: "string" } },
    });
  });

  it("rejects duplicate field names client-side before any PUT fires", async () => {
    const { calls } = installFetch({
      "/api/tags/x": {
        body: {
          name: "x",
          count: 0,
          description: null,
          fields: null,
          parent_names: null,
          relationships: null,
        },
      },
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="x" onClose={() => {}} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(screen.getByText(/no fields declared yet/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/add field/i));
    fireEvent.click(screen.getByText(/add field/i));
    const rows = await screen.findAllByLabelText(/field name/i);
    fireEvent.change(rows[0]!, { target: { value: "dup" } });
    fireEvent.change(rows[1]!, { target: { value: "dup" } });
    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));
    // The warning + dup-error are both role=alert; the dup-error is the
    // one carrying the "Duplicate field name" string, so target on the
    // text directly.
    expect(await screen.findByText(/duplicate field name/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("removing a field issues a null-fields wipe then re-PUT — vault's only delete path", async () => {
    const onClose = vi.fn();
    const { calls } = installFetch({
      "/api/tags/idea": {
        body: {
          name: "idea",
          count: 5,
          description: "old",
          fields: { status: { type: "string" }, due: { type: "date" } },
          parent_names: null,
          relationships: null,
        },
      },
      "PUT /api/tags/idea": [
        // wipe
        {
          body: {
            name: "idea",
            count: 5,
            description: "old",
            fields: null,
            parent_names: null,
            relationships: null,
          },
        },
        // rewrite
        {
          body: {
            name: "idea",
            count: 5,
            description: "old",
            fields: { status: { type: "string" } },
            parent_names: null,
            relationships: null,
          },
        },
      ],
    });
    render(
      <Wrap>
        <TagSchemaEditor tagName="idea" onClose={onClose} />
      </Wrap>,
    );
    // Seeded with two fields.
    await waitFor(() => {
      expect(screen.getAllByLabelText(/field name/i).length).toBe(2);
    });
    // Remove the `due` row.
    const removeBtns = screen.getAllByLabelText(/remove field/i);
    const dueIdx = (screen.getAllByLabelText(/field name/i) as HTMLInputElement[]).findIndex(
      (el) => el.value === "due",
    );
    fireEvent.click(removeBtns[dueIdx]!);

    fireEvent.click(screen.getByRole("button", { name: /save schema/i }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(2);
    expect((puts[0]!.body as { fields: unknown }).fields).toBeNull();
    expect((puts[1]!.body as { fields: Record<string, unknown> }).fields).toEqual({
      status: { type: "string" },
    });
  });
});

describe("TagSchemaEditor _internals", () => {
  it("sameFields treats empty + null as equivalent", () => {
    expect(_internals.sameFields(null, {})).toBe(true);
    expect(_internals.sameFields(undefined, null)).toBe(true);
  });

  it("sameFields catches a type change on an existing key", () => {
    expect(_internals.sameFields({ foo: { type: "string" } }, { foo: { type: "number" } })).toBe(
      false,
    );
  });

  it("rowsToFieldsMap drops blank-name rows", () => {
    expect(
      _internals.rowsToFieldsMap([
        { rowId: "1", name: "", type: "string" },
        { rowId: "2", name: "ok", type: "number" },
      ]),
    ).toEqual({ ok: { type: "number" } });
  });
});
