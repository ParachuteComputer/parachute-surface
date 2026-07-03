import { NoteNew } from "@/app/routes/NoteNew";
import { type LensDB, openLensDB } from "@/lib/sync/db";
import { listPending } from "@/lib/sync/queue";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault/store";
import type { Note } from "@/lib/vault/types";
import { SyncProvider } from "@/providers/SyncProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      const { value, onChange, onPasteFile } = props;
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

// schema-ensure fires real vault calls (audit GET + create PUT) against the
// active vault. The tests here mock fetch but don't enumerate those calls;
// stub the module to a no-op (schema-ensure has its own focused tests).
vi.mock("@/lib/vault/schema-ensure", () => ({
  ensureNotesSchema: vi.fn(async () => {}),
}));

// Audio-recording stubs — only the voice tests actually trigger these, but
// the module mock has to be top-level. Mirrors the pattern Capture.test.tsx
// used pre-unification.
interface FakeController {
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<{ data: ArrayBuffer; mimeType: string; durationMs: number }>;
  cancel: () => void;
  state: "idle" | "recording" | "paused" | "stopped";
  mimeType: string;
}

const fakeState = {
  controller: null as FakeController | null,
  requestMic: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
  pickResult: "audio/webm;codecs=opus" as string | null,
};

vi.mock("@/lib/capture/recorder", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/capture/recorder")>("@/lib/capture/recorder");
  return {
    ...actual,
    pickMimeType: () => fakeState.pickResult,
    requestMic: () => fakeState.requestMic(),
    createRecorder: (opts: { mimeType: string }) => {
      const c: FakeController = {
        state: "idle",
        mimeType: opts.mimeType,
        start() {
          this.state = "recording";
        },
        pause() {
          this.state = "paused";
        },
        resume() {
          this.state = "recording";
        },
        async stop() {
          this.state = "stopped";
          return {
            data: new Uint8Array([10, 20, 30]).buffer,
            mimeType: opts.mimeType,
            durationMs: 4_200,
          };
        },
        cancel() {
          this.state = "stopped";
        },
      };
      fakeState.controller = c;
      return c;
    },
  };
});

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
        text: async () => hit.text ?? "",
      } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

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

async function freshDb(): Promise<LensDB> {
  indexedDB.deleteDatabase("parachute-lens");
  return openLensDB();
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <QueryClientProvider client={client}>
      <SyncProvider>{children}</SyncProvider>
    </QueryClientProvider>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/new" element={<NoteNew />} />
        <Route path="/n/:id" element={<div>NoteViewPage</div>} />
        <Route path="/" element={<div>NotesListPage</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  );
}

describe("NoteNew route — unified create surface", () => {
  beforeEach(async () => {
    const db = await freshDb();
    db.close();
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedStore();
    fakeState.controller = null;
    fakeState.pickResult = "audio/webm;codecs=opus";
    fakeState.requestMic = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    vi.spyOn(window, "confirm").mockImplementation(() => true);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:fake"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("Title field is visible up front, no Summary field present", async () => {
    installFetch({});
    renderAt("/new");

    // Title visible — Aaron's "we shouldn't hide away Title".
    expect(screen.getByLabelText(/note path/i)).toBeInTheDocument();
    // Path defaults to a quickPath() value so the operator sees a real
    // sample they can override or accept.
    expect((screen.getByLabelText(/note path/i) as HTMLInputElement).value).toMatch(
      /^Notes\/\d{4}\/\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}$/,
    );
    // Summary surface gone per Aaron's "don't include Summary on every note".
    expect(screen.queryByLabelText(/summary/i)).toBeNull();
  });

  it("Create is disabled until content (or audio) is present", async () => {
    installFetch({});
    renderAt("/new");

    const create = screen.getByRole("button", { name: /^create$/i });
    expect(create).toBeDisabled(); // path is pre-filled, but no body yet

    fireEvent.change(screen.getByTestId("cm-editor"), { target: { value: "# hello" } });
    expect(create).not.toBeDisabled();
  });

  it("happy path: POSTs payload without summary metadata and navigates to /n/<new-id>", async () => {
    const fetchImpl = installFetch({
      "POST /api/notes": {
        status: 201,
        body: {
          id: "new-note-id",
          path: "Projects/README",
          createdAt: "2026-04-18T12:00:00Z",
          content: "# hi",
          tags: ["docs"],
        },
      },
    });

    renderAt("/new");

    fireEvent.change(screen.getByLabelText(/note path/i), {
      target: { value: "Projects/README" },
    });
    const tagInput = screen.getByLabelText(/add tag/i);
    fireEvent.change(tagInput, { target: { value: "docs" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(screen.getByTestId("cm-editor"), { target: { value: "# hi" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("NoteViewPage")).toBeInTheDocument();
    });

    const postCall = fetchImpl.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    // A typed note through this surface is a capture: the capture role tag
    // (default `capture`) leads the tag list and `metadata.source` records
    // HOW it arrived. No `metadata.summary` — Summary field is gone from
    // this surface.
    expect(body).toEqual({
      content: "# hi",
      path: "Projects/README",
      metadata: { source: "text" },
      tags: ["capture", "docs"],
    });

    // The quiet lazy-ensure fired for the active vault (fire-and-forget —
    // it must never gate the save).
    const { ensureNotesSchema } = await import("@/lib/vault/schema-ensure");
    expect(vi.mocked(ensureNotesSchema)).toHaveBeenCalledWith("dev", expect.anything());

    expect(useToastStore.getState().toasts[0]?.message).toContain("Created");
  });

  it("extracts #hashtags from body content alongside explicit tag chips", async () => {
    const fetchImpl = installFetch({
      "POST /api/notes": {
        status: 201,
        body: {
          id: "n",
          path: "Notes/test",
          createdAt: "2026-05-27T12:00:00Z",
          content: "got an #idea",
          tags: ["idea", "docs"],
        },
      },
    });
    renderAt("/new");

    const tagInput = screen.getByLabelText(/add tag/i);
    fireEvent.change(tagInput, { target: { value: "docs" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    fireEvent.change(screen.getByTestId("cm-editor"), { target: { value: "got an #idea" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("NoteViewPage")).toBeInTheDocument();
    });
    const post = fetchImpl.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(new Set(body.tags)).toEqual(new Set(["capture", "docs", "idea"]));
  });

  it("drop file → uploads, inserts image markdown, stages for link-on-create", async () => {
    installFetch({});
    const xhrs = installXhr();
    renderAt("/new");

    const dropZone = screen.getByTestId("cm-editor").closest("div.relative");
    expect(dropZone).not.toBeNull();

    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
      dropEffect: "copy",
    } as unknown as DataTransfer;

    fireEvent.drop(dropZone!, { dataTransfer });

    await waitFor(() => {
      expect(xhrs.length).toBe(1);
    });
    expect(xhrs[0]!.url).toBe("http://localhost:1940/api/storage/upload");
    expect(xhrs[0]!.method).toBe("POST");

    await act(async () => {
      xhrs[0]!.resolve(
        201,
        JSON.stringify({ path: "2026-04-18/shot.png", size: 3, mimeType: "image/png" }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect((screen.getByTestId("cm-editor") as HTMLTextAreaElement).value).toContain(
        "![shot.png](/api/storage/2026-04-18/shot.png)",
      );
    });
    expect(await screen.findByText("staged")).toBeInTheDocument();
  });

  it("paste image triggers upload through onPasteFile", async () => {
    installFetch({});
    const xhrs = installXhr();
    renderAt("/new");

    await act(async () => {
      fireEvent.click(screen.getByTestId("cm-paste-image"));
    });

    await waitFor(() => {
      expect(xhrs.length).toBe(1);
    });
    expect(xhrs[0]!.url).toBe("http://localhost:1940/api/storage/upload");
    expect((xhrs[0]!.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("oversized file is rejected before any upload fires", async () => {
    installFetch({});
    const xhrs = installXhr();
    renderAt("/new");

    const big = new File([new Uint8Array([1])], "huge.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 200 * 1024 * 1024 });

    const dropZone = screen.getByTestId("cm-editor").closest("div.relative");
    const dataTransfer = {
      files: [big],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;

    fireEvent.drop(dropZone!, { dataTransfer });

    // No upload attempted; an error toast was pushed.
    expect(xhrs.length).toBe(0);
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => /too large/i.test(t.message))).toBe(true);
    });
  });

  it("happy path on /new: create succeeds and staged attachments get linked", async () => {
    const fetchImpl = installFetch({
      "POST /api/notes/new-id/attachments": {
        status: 201,
        body: {
          id: "att-1",
          noteId: "new-id",
          path: "2026-04-18/shot.png",
          mimeType: "image/png",
        },
      },
      "POST /api/notes": {
        status: 201,
        body: {
          id: "new-id",
          path: "Projects/README",
          createdAt: "2026-04-18T12:00:00Z",
          content: "ok",
          tags: [],
        },
      },
    });
    const xhrs = installXhr();
    renderAt("/new");

    // Drop first so we have something staged.
    const dropZone = screen.getByTestId("cm-editor").closest("div.relative");
    const file = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file" }],
      types: ["Files"],
    } as unknown as DataTransfer;
    fireEvent.drop(dropZone!, { dataTransfer });
    await waitFor(() => expect(xhrs.length).toBe(1));
    await act(async () => {
      xhrs[0]!.resolve(
        201,
        JSON.stringify({ path: "2026-04-18/shot.png", size: 1, mimeType: "image/png" }),
      );
    });
    await waitFor(() => expect(screen.getByText("staged")).toBeInTheDocument());

    // Now fill path + content and create.
    fireEvent.change(screen.getByLabelText(/note path/i), {
      target: { value: "Projects/README" },
    });
    fireEvent.change(screen.getByTestId("cm-editor"), { target: { value: "# hi" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });

    await waitFor(() => {
      expect(screen.getByText("NoteViewPage")).toBeInTheDocument();
    });

    const linkCall = fetchImpl.mock.calls.find(([url, init]) => {
      const u = typeof url === "string" ? url : url.toString();
      return (
        u.includes("/api/notes/new-id/attachments") &&
        (init as RequestInit | undefined)?.method === "POST"
      );
    });
    expect(linkCall).toBeDefined();
    expect(JSON.parse((linkCall![1] as RequestInit).body as string)).toEqual({
      path: "2026-04-18/shot.png",
      mimeType: "image/png",
    });
  });

  it("duplicate path: error is visible and content/path are preserved", async () => {
    installFetch({
      "POST /api/notes": {
        status: 500,
        body: null,
        text: '{"error":"Internal server error"}',
      },
    });

    renderAt("/new");

    fireEvent.change(screen.getByLabelText(/note path/i), { target: { value: "dup" } });
    fireEvent.change(screen.getByTestId("cm-editor"), { target: { value: "keep me" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/500|path is taken/i);
    expect((screen.getByLabelText(/note path/i) as HTMLInputElement).value).toBe("dup");
    expect((screen.getByTestId("cm-editor") as HTMLTextAreaElement).value).toBe("keep me");
  });
});

describe("NoteNew — voice affordance", () => {
  let restoreOnline: (() => void) | null = null;

  beforeEach(async () => {
    const db = await freshDb();
    db.close();
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedStore();
    fakeState.controller = null;
    fakeState.pickResult = "audio/webm;codecs=opus";
    fakeState.requestMic = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
    vi.spyOn(window, "confirm").mockImplementation(() => true);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:fake"),
        revokeObjectURL: vi.fn(),
      }),
    );
    // The audio path uses the sync queue, which is the offline-only path.
    // Force navigator.onLine to false so the route doesn't try a live POST.
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    restoreOnline = () => {
      if (desc) Object.defineProperty(navigator, "onLine", desc);
    };
  });

  afterEach(() => {
    restoreOnline?.();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function releasePointer() {
    window.dispatchEvent(new Event("pointerup"));
  }

  it("shows a Record button on the unified surface", async () => {
    installFetch({});
    renderAt("/new");
    expect(await screen.findByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
  });

  it("hold-press → release captures audio and enables Save", async () => {
    installFetch({});
    renderAt("/new");

    const recordBtn = await screen.findByRole("button", { name: /record voice memo/i });
    await act(async () => {
      fireEvent.pointerDown(recordBtn);
      await Promise.resolve();
    });
    // Mid-recording: a Stop button shows up.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
    });
    await act(async () => {
      releasePointer();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    // Audio is now staged: the audio preview appears.
    await waitFor(() => {
      expect(screen.getByText(/recorded\s+/i)).toBeInTheDocument();
    });
    // Create button enables even without typed content because audio
    // satisfies the "body" half of the validity check.
    expect(screen.getByRole("button", { name: /^create$/i })).not.toBeDisabled();
  });

  it("keyboard activation (click) on Stop ends recording — no-pointer path", async () => {
    // Regression for the a11y bug where Stop had only onPointerDown:
    // keyboard (Space/Enter) on a <button> dispatches `click` with no
    // pointer events, so an onPointerDown-only handler is unreachable
    // from the keyboard. The Stop button keeps both handlers; this
    // exercises the click-only path explicitly.
    installFetch({});
    renderAt("/new");

    const recordBtn = await screen.findByRole("button", { name: /record voice memo/i });
    await act(async () => {
      fireEvent.click(recordBtn);
      await Promise.resolve();
    });
    const stopBtn = await screen.findByRole("button", { name: /stop/i });
    await act(async () => {
      fireEvent.click(stopBtn);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText(/recorded\s+/i)).toBeInTheDocument();
    });
  });

  it("voice + Create → enqueues create-note + upload-attachment + link-attachment{transcribe}", async () => {
    installFetch({});
    renderAt("/new");

    const recordBtn = await screen.findByRole("button", { name: /record voice memo/i });
    await act(async () => {
      fireEvent.pointerDown(recordBtn);
      await Promise.resolve();
    });
    await act(async () => {
      releasePointer();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText(/recorded\s+/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });

    // Navigated away — open the queue and inspect what we enqueued.
    await waitFor(() => {
      expect(screen.getByText("NoteViewPage")).toBeInTheDocument();
    });
    const db = await openLensDB();
    const pending = await listPending(db, "dev");
    db.close();
    const kinds = pending.map((p) => p.mutation.kind).sort();
    expect(kinds).toEqual(["create-note", "link-attachment", "upload-attachment"]);
    const link = pending.find((p) => p.mutation.kind === "link-attachment");
    expect(link).toBeDefined();
    if (link && link.mutation.kind === "link-attachment") {
      expect(link.mutation.transcribe).toBe(true);
    }
    // Voice capture carries the capture role tag (default `capture`) +
    // `metadata.source: "voice"` — the how-it-arrived axis lives in
    // metadata, not tag identity.
    const create = pending.find((p) => p.mutation.kind === "create-note");
    expect(create).toBeDefined();
    if (create && create.mutation.kind === "create-note") {
      expect(create.mutation.payload.tags).toContain("capture");
      expect(create.mutation.payload.metadata).toEqual({ source: "voice" });
    }
  });

  it("seeds the optimistic note into the query cache so /n/<localId> lands on a readable note [FIX 3]", async () => {
    installFetch({});
    // Non-zero gcTime: the seeded /n/<localId> query has no observer here (the
    // route is a stub), so gcTime:0 would garbage-collect it before we inspect.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    render(
      <QueryClientProvider client={qc}>
        <SyncProvider>
          <MemoryRouter initialEntries={["/new"]}>
            <Routes>
              <Route path="/new" element={<NoteNew />} />
              <Route path="/n/:id" element={<div>NoteViewPage</div>} />
              <Route path="/" element={<div>NotesListPage</div>} />
            </Routes>
          </MemoryRouter>
        </SyncProvider>
      </QueryClientProvider>,
    );

    const recordBtn = await screen.findByRole("button", { name: /record voice memo/i });
    await act(async () => {
      fireEvent.pointerDown(recordBtn);
      await Promise.resolve();
    });
    await act(async () => {
      releasePointer();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText(/recorded\s+/i)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    });
    await waitFor(() => {
      expect(screen.getByText("NoteViewPage")).toBeInTheDocument();
    });

    // The audio path seeds an optimistic note into the cache keyed by its local
    // id (mirroring the text path) so NoteView can render it immediately rather
    // than 404ing on getNote(localId).
    const seeded = qc
      .getQueryCache()
      .findAll({ queryKey: ["note", "dev"] })
      .map((q) => q.state.data as Note | undefined)
      .find((d) => typeof d?.content === "string" && d.content.includes("Transcript pending"));
    expect(seeded).toBeDefined();
    expect(seeded?.metadata).toEqual({ source: "voice" });
    expect(seeded?.id.startsWith("local-")).toBe(true);
  });

  it("discard audio reverts the panel to idle", async () => {
    installFetch({});
    renderAt("/new");

    const recordBtn = await screen.findByRole("button", { name: /record voice memo/i });
    await act(async () => {
      fireEvent.pointerDown(recordBtn);
      await Promise.resolve();
    });
    await act(async () => {
      releasePointer();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.getByText(/recorded\s+/i)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    });
    expect(screen.queryByText(/recorded\s+/i)).toBeNull();
    expect(screen.getByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
  });
});
