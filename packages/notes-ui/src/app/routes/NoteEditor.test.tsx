import { NoteEditor } from "@/app/routes/NoteEditor";
import { loadDraft, saveDraft } from "@/lib/drafts/store";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Swap CodeMirror out for a plain textarea so tests can drive onChange without
// wrangling CM6 inside jsdom.
vi.mock("@/components/CodeMirrorEditor", async () => {
  const React = await import("react");
  return {
    CodeMirrorEditor: React.forwardRef(function MockCodeMirrorEditor(
      props: {
        value: string;
        onChange(next: string): void;
        onSave?(): void;
        onCancel?(): void;
        onPasteFile?(files: File[]): boolean;
      },
      ref: React.Ref<{ insertAtCursor(s: string): void; focus(): void }>,
    ) {
      const { value, onChange, onSave, onPasteFile } = props;
      React.useImperativeHandle(
        ref,
        () => ({
          insertAtCursor(s: string) {
            onChange(value + s);
          },
          focus() {},
        }),
        [value, onChange],
      );
      return (
        <>
          <textarea
            data-testid="cm-editor"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {/* Stand-in for the ⌘S keybinding — CodeMirror wires it to onSave.
              Label deliberately avoids the word "save" so it doesn't collide
              with getByRole({ name: /save/i }) lookups for the real button. */}
          <button type="button" data-testid="cm-save" onClick={() => onSave?.()}>
            mock keyboard commit
          </button>
          <button
            type="button"
            data-testid="cm-paste-image"
            onClick={() => {
              const f = new File([new Uint8Array([1, 2])], "pasted.png", { type: "image/png" });
              onPasteFile?.([f]);
            }}
          >
            mock paste
          </button>
        </>
      );
    }),
  };
});

class FakeXhrUpload {
  onprogress: ((e: ProgressEvent) => void) | null = null;
}

class FakeXhr {
  method = "";
  url = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  upload = new FakeXhrUpload();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  resolve(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

function installXhr(): FakeXhr[] {
  const xhrs: FakeXhr[] = [];
  vi.stubGlobal(
    "XMLHttpRequest",
    // biome-ignore lint/complexity/useArrowFunction: must be `new`-able
    function () {
      const x = new FakeXhr();
      xhrs.push(x);
      return x;
    } as unknown as typeof XMLHttpRequest,
  );
  return xhrs;
}

interface FetchEntry {
  status?: number;
  body: unknown;
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
        text: async () => "",
      } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
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

// The read-view stand-in echoes its id so tests can assert *which* note we
// landed on after a save (the id shifts when a path edit renames the note).
function NoteViewProbe() {
  const { id } = useParams<{ id: string }>();
  return <div>NoteViewPage:{id}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/n/:id/edit" element={<NoteEditor />} />
        <Route path="/n/:id" element={<NoteViewProbe />} />
        <Route path="/" element={<div>NotesListPage</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

const baseNote = {
  id: "abc-123",
  path: "Canon/Aaron",
  createdAt: "2026-04-16T00:00:00Z",
  updatedAt: "2026-04-17T00:00:00Z",
  content: "# hi\n\nbody",
  tags: ["canon"],
  links: [],
  attachments: [],
};

describe("NoteEditor route", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedStore();
    // jsdom doesn't implement confirm; default it to true so paths that gate
    // on user approval proceed.
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the editor seeded from the note and shows Save disabled until dirty", async () => {
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    expect(cm.value).toBe(baseNote.content);
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
    expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();
  });

  it("marks dirty on typing, saves with if_updated_at and changed fields, clears dirty on success", async () => {
    const updated = {
      ...baseNote,
      content: "# hi\n\nbody more",
      tags: ["canon", "draft"],
      updatedAt: "2026-04-18T09:00:00Z",
    };
    const fetchImpl = installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": { body: updated },
    });

    renderAt("/n/abc-123/edit");
    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;

    fireEvent.change(cm, { target: { value: "# hi\n\nbody more" } });

    const tagInput = screen.getByLabelText(/add tag/i) as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: "draft" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();

    const save = screen.getByRole("button", { name: /save/i });
    expect(save).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(save);
    });

    // A successful save leaves the editor and lands on the note's read view.
    await waitFor(() => {
      expect(screen.getByText("NoteViewPage:abc-123")).toBeInTheDocument();
    });
    expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();

    const patchCall = fetchImpl.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body.content).toBe("# hi\n\nbody more");
    expect(body.if_updated_at).toBe(baseNote.updatedAt);
    expect(body.tags).toEqual({ add: ["draft"], remove: [] });
    expect(body.path).toBeUndefined();
  });

  it("after a rename save, lands on the new note id's view", async () => {
    const renamed = {
      ...baseNote,
      id: "canon-aaron-v2",
      path: "Canon/Aaron-v2",
      updatedAt: "2026-04-18T09:00:00Z",
    };
    installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": { body: renamed },
    });

    renderAt("/n/abc-123/edit");
    const pathInput = (await screen.findByLabelText(/note path/i)) as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: "Canon/Aaron-v2" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("NoteViewPage:canon-aaron-v2")).toBeInTheDocument();
    });
  });

  it("⌘S is a checkpoint save — commits but stays in the editor", async () => {
    const updated = {
      ...baseNote,
      content: "# hi\n\nbody more",
      updatedAt: "2026-04-18T09:00:00Z",
    };
    const fetchImpl = installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": { body: updated },
    });

    renderAt("/n/abc-123/edit");
    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "# hi\n\nbody more" } });
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("cm-save"));
    });

    // The save committed (dirty cleared)…
    await waitFor(() => {
      expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();
    });
    const patchCall = fetchImpl.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    // …but we're still in the editor, NOT bounced to the read view.
    expect(screen.getByTestId("cm-editor")).toBeInTheDocument();
    expect(screen.queryByText(/NoteViewPage/)).not.toBeInTheDocument();
  });

  it("disables Save (button + ⌘S) while an attachment upload is in flight", async () => {
    const fetchImpl = installFetch({
      "GET /api/notes": { body: baseNote },
      "POST /api/notes/abc-123/attachments": {
        status: 201,
        body: {
          id: "att-1",
          noteId: "abc-123",
          path: "2026-04-18/shot.png",
          mimeType: "image/png",
        },
      },
      "PATCH /api/notes/": { body: { ...baseNote, content: "# hi\n\nbody typed" } },
    });
    const xhrs = installXhr();
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    // Dirty the note so Save would be enabled on its own merits.
    fireEvent.change(cm, { target: { value: "# hi\n\nbody typed" } });
    expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();

    // Kick off an upload — it stays "uploading" until we resolve the xhr.
    const dropZone = cm.closest("div.relative");
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    fireEvent.drop(dropZone!, {
      dataTransfer: {
        files: [file],
        items: [{ kind: "file" }],
        types: ["Files"],
      } as unknown as DataTransfer,
    });
    await waitFor(() => expect(xhrs.length).toBe(1));

    // Button is disabled with an explanatory label…
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /waiting for upload/i })).toBeDisabled();
    });
    // …and the ⌘S path is guarded too — firing it fires no PATCH.
    await act(async () => {
      fireEvent.click(screen.getByTestId("cm-save"));
    });
    expect(
      fetchImpl.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);

    // Once the upload (and its link) complete, Save frees up again.
    await act(async () => {
      xhrs[0]!.resolve(
        201,
        JSON.stringify({ path: "2026-04-18/shot.png", size: 3, mimeType: "image/png" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^save$/i })).not.toBeDisabled();
    });
  });

  it("Revert resets draft back to baseline and clears dirty", async () => {
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "changed" } });
    expect(screen.getByText(/unsaved/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    });
    expect(cm.value).toBe(baseNote.content);
    expect(screen.queryByText(/unsaved/i)).not.toBeInTheDocument();
  });

  it("shows the conflict banner when the server returns 409", async () => {
    installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": {
        status: 409,
        body: {
          message: "Note was modified",
          current_updated_at: "2026-04-18T10:00:00Z",
          expected_updated_at: baseNote.updatedAt,
        },
      },
    });

    renderAt("/n/abc-123/edit");
    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "stale edit" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });

    expect(await screen.findByText(/edited elsewhere/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload latest/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep editing/i })).toBeInTheDocument();
    // Draft is preserved — user keeps their unsaved content.
    expect(cm.value).toBe("stale edit");
  });

  it("path edit surfaces the rename warning", async () => {
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    const pathInput = (await screen.findByLabelText(/note path/i)) as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: "Canon/Aaron-v2" } });
    expect(screen.getByText(/renaming moves the note/i)).toBeInTheDocument();
  });

  it("drop file → uploads, inserts markdown, and links to the existing note", async () => {
    const fetchImpl = installFetch({
      "GET /api/notes": { body: baseNote },
      "POST /api/notes/abc-123/attachments": {
        status: 201,
        body: {
          id: "att-1",
          noteId: "abc-123",
          path: "2026-04-18/shot.png",
          mimeType: "image/png",
        },
      },
    });
    const xhrs = installXhr();
    renderAt("/n/abc-123/edit");

    const cm = await screen.findByTestId("cm-editor");
    const dropZone = cm.closest("div.relative");
    expect(dropZone).not.toBeNull();

    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
      dropEffect: "copy",
    } as unknown as DataTransfer;

    fireEvent.drop(dropZone!, { dataTransfer });

    await waitFor(() => expect(xhrs.length).toBe(1));
    expect(xhrs[0]!.url).toBe("http://localhost:1940/api/storage/upload");

    await act(async () => {
      xhrs[0]!.resolve(
        201,
        JSON.stringify({ path: "2026-04-18/shot.png", size: 3, mimeType: "image/png" }),
      );
    });

    await waitFor(() => {
      expect((cm as HTMLTextAreaElement).value).toContain(
        "![shot.png](/api/storage/2026-04-18/shot.png)",
      );
    });

    await waitFor(() => {
      const linkCall = fetchImpl.mock.calls.find(([url, init]) => {
        const u = typeof url === "string" ? url : url.toString();
        return (
          u.includes("/api/notes/abc-123/attachments") &&
          (init as RequestInit | undefined)?.method === "POST"
        );
      });
      expect(linkCall).toBeDefined();
    });
  });

  it("oversized file is rejected before any upload fires", async () => {
    installFetch({ "GET /api/notes": { body: baseNote } });
    const xhrs = installXhr();
    renderAt("/n/abc-123/edit");

    const cm = await screen.findByTestId("cm-editor");
    const dropZone = cm.closest("div.relative");

    const big = new File([new Uint8Array([1])], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 200 * 1024 * 1024 });

    const dataTransfer = {
      files: [big],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;
    fireEvent.drop(dropZone!, { dataTransfer });

    expect(xhrs.length).toBe(0);
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => /too large/i.test(t.message))).toBe(true);
    });
  });
});

describe("NoteEditor — local draft persistence (notes#175)", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedStore();
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("offers to restore a draft that differs from the server note (without auto-applying)", async () => {
    saveDraft("dev", "abc-123", {
      content: "MY UNSAVED EDITS",
      path: baseNote.path,
      tags: baseNote.tags,
    });
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    // Server copy is authoritative — the editor shows it, not the draft.
    expect(cm.value).toBe(baseNote.content);
    expect(screen.getByTestId("draft-offer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^restore$/i }));
    expect((screen.getByTestId("cm-editor") as HTMLTextAreaElement).value).toBe("MY UNSAVED EDITS");
    expect(screen.queryByTestId("draft-offer")).not.toBeInTheDocument();
  });

  it("does not offer a draft identical to the server note", async () => {
    saveDraft("dev", "abc-123", {
      content: baseNote.content,
      path: baseNote.path,
      tags: baseNote.tags,
    });
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    await screen.findByTestId("cm-editor");
    expect(screen.queryByTestId("draft-offer")).not.toBeInTheDocument();
  });

  it("discards the offered draft, clearing it from storage", async () => {
    saveDraft("dev", "abc-123", { content: "junk", path: baseNote.path, tags: baseNote.tags });
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    await screen.findByTestId("cm-editor");
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(screen.queryByTestId("draft-offer")).not.toBeInTheDocument();
    expect(loadDraft("dev", "abc-123")).toBeNull();
  });

  it("clears the draft on a successful save", async () => {
    // Seed a pre-existing draft, then make a real edit and save.
    saveDraft("dev", "abc-123", { content: "old", path: baseNote.path, tags: baseNote.tags });
    const updated = { ...baseNote, content: "# hi\n\nedited", updatedAt: "2026-04-18T09:00:00Z" };
    installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": { body: updated },
    });
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "# hi\n\nedited" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });
    await waitFor(() => expect(screen.getByText("NoteViewPage:abc-123")).toBeInTheDocument());
    expect(loadDraft("dev", "abc-123")).toBeNull();
  });

  it("clears the draft when Cancel is confirmed as discard (F3a)", async () => {
    saveDraft("dev", "abc-123", { content: "junk", path: baseNote.path, tags: baseNote.tags });
    installFetch({ "/api/notes": { body: baseNote } });
    renderAt("/n/abc-123/edit");

    await screen.findByTestId("cm-editor");
    // confirm() is mocked to true in beforeEach → the user chose "discard".
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(loadDraft("dev", "abc-123")).toBeNull();
  });

  it("clears the draft when the conflict banner's 'Reload latest' is chosen (F3b)", async () => {
    // clearDraft runs synchronously BEFORE window.location.reload() in the
    // onReload handler; jsdom's real reload is a harmless no-op, so asserting the
    // draft is gone after the click verifies the clear-before-reload ordering
    // (can't spy on the non-configurable location.reload).
    saveDraft("dev", "abc-123", { content: "pre", path: baseNote.path, tags: baseNote.tags });
    installFetch({
      "GET /api/notes": { body: baseNote },
      "PATCH /api/notes/": {
        status: 409,
        body: { error: "conflict", current_updated_at: "2026-04-18T10:00:00Z" },
      },
    });
    renderAt("/n/abc-123/edit");

    const cm = (await screen.findByTestId("cm-editor")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "my edit" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });
    const reloadBtn = await screen.findByRole("button", { name: /reload latest/i });
    fireEvent.click(reloadBtn);
    expect(loadDraft("dev", "abc-123")).toBeNull();
  });
});
