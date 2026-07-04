import { NoteNew } from "@/app/routes/NoteNew";
import { type LensDB, openLensDB } from "@/lib/sync/db";
import { listPending } from "@/lib/sync/queue";
import { useToastStore } from "@/lib/toast/store";
import { useVaultReachabilityStore } from "@/lib/vault/reachability-store";
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

  it("field absent on BOTH doors (older vault) → mic stays (back-compat pinned)", async () => {
    // Old self-host vault: /api/vault answers 200 WITHOUT `transcription`
    // and the bare landing answers 200 without it either. Absent ≠ disabled
    // — the mic must render exactly as today (do NOT regress existing
    // self-host voice users).
    const bare = "http://localhost:1940";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const jsonRes = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;
      if (url.includes("/api/vault")) return jsonRes({ name: "dev", description: "" });
      if (url === bare || url === `${bare}/`) {
        return jsonRes({ name: "dev", description: "", createdAt: "2026-01-01", stats: {} });
      }
      return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchImpl);
    renderAt("/new");

    // Wait until the fallback landing probe has fired and settled…
    await waitFor(() => {
      expect(
        fetchImpl.mock.calls.some(([input]) => {
          const u = typeof input === "string" ? input : input.toString();
          return u === bare || u === `${bare}/`;
        }),
      ).toBe(true);
    });
    // …then the mic is still there and no gate copy rendered.
    expect(screen.getByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
    expect(screen.queryByTestId("voice-unavailable")).toBeNull();
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

// Launch-audit P0-3: the mic gates on the vault's DECLARED transcription
// capability. Explicit `enabled: false` hides the recorder (free cloud tier,
// self-host without a provider); `enabled: true` or an ABSENT field keeps it
// (absent = older vault that predates the flag — back-compat, pinned above).
// The two doors declare the flag in different places: self-host on
// `GET /api/vault` (vault#529), cloud on the bare landing `GET <vaultUrl>`
// (cloud#56) — both are exercised here.
describe("NoteNew — transcription capability gate", () => {
  beforeEach(async () => {
    const db = await freshDb();
    db.close();
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    // The failure-mode cases below report `unreachable` into the module-level
    // reachability store — reset so cases don't leak state into each other.
    useVaultReachabilityStore.setState({ byVault: {} });
    seedStore();
    fakeState.controller = null;
    fakeState.pickResult = "audio/webm;codecs=opus";
    fakeState.requestMic = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const BARE = "http://localhost:1940";

  /** Fetch stub with exact control over /api/vault vs the bare landing —
   *  installFetch's substring matcher can't express "the bare URL only"
   *  (every request URL contains it as a prefix). `landingFailure` makes the
   *  bare-landing probe fail in a specific way (fail-open pinning). */
  function installDoorFetch(opts: {
    apiVault: Record<string, unknown>;
    landing?: Record<string, unknown>;
    landingFailure?: "reject" | "malformed" | number;
  }) {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const jsonRes = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;
      if (url.includes("/api/vault")) return jsonRes(opts.apiVault);
      if (url === BARE || url === `${BARE}/`) {
        if (opts.landingFailure === "reject") throw new TypeError("network down");
        if (opts.landingFailure === "malformed") {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("Unexpected token < in JSON");
            },
            text: async () => "<html>not json</html>",
          } as unknown as Response;
        }
        if (typeof opts.landingFailure === "number") {
          const status = opts.landingFailure;
          return {
            ok: status < 400,
            status,
            json: async () => ({ error: "nope" }),
            text: async () => JSON.stringify({ error: "nope" }),
          } as Response;
        }
        if (opts.landing) return jsonRes(opts.landing);
        return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
      }
      return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchImpl);
    return fetchImpl;
  }

  function landingCalls(fetchImpl: ReturnType<typeof installDoorFetch>) {
    return fetchImpl.mock.calls.filter(([input]) => {
      const u = typeof input === "string" ? input : String(input);
      return u === BARE || u === `${BARE}/`;
    });
  }

  it("self-host door: /api/vault declares enabled:false → recorder hidden, quiet line shown", async () => {
    const fetchImpl = installDoorFetch({
      apiVault: { name: "dev", description: "", transcription: { enabled: false } },
    });
    renderAt("/new");

    const note = await screen.findByTestId("voice-unavailable");
    // Self-host shape has no minutes meter → the neutral copy, not plan copy.
    expect(note).toHaveTextContent(/isn't enabled on this vault/i);
    expect(screen.queryByRole("button", { name: /record voice memo/i })).toBeNull();
    // /api/vault answered the question — the landing probe must not fire.
    expect(landingCalls(fetchImpl).length).toBe(0);
  });

  it("cloud door: /api/vault lacks the field, bare landing declares enabled:false → recorder hidden, Voice-plan line", async () => {
    installDoorFetch({
      apiVault: { name: "dev", description: "" },
      landing: { name: "dev", transcription: { enabled: false, minutes_remaining: 0 } },
    });
    renderAt("/new");

    const note = await screen.findByTestId("voice-unavailable");
    // Metered shape (minutes_remaining present) = the cloud plan gate.
    expect(note).toHaveTextContent(/comes with the voice plan/i);
    expect(screen.queryByRole("button", { name: /record voice memo/i })).toBeNull();
  });

  it("enabled:true on /api/vault → recorder shows, no gate copy, no landing probe", async () => {
    const fetchImpl = installDoorFetch({
      apiVault: {
        name: "dev",
        description: "",
        transcription: { enabled: true, provider: "scribe-http" },
      },
    });
    renderAt("/new");

    expect(await screen.findByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
    // Give the queries a beat to settle, then pin: no gate copy, no probe.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("voice-unavailable")).toBeNull();
    expect(landingCalls(fetchImpl).length).toBe(0);
  });

  it("cloud Voice tier: landing declares enabled:true → recorder shows", async () => {
    const fetchImpl = installDoorFetch({
      apiVault: { name: "dev", description: "" },
      landing: { name: "dev", transcription: { enabled: true, minutes_remaining: 600 } },
    });
    renderAt("/new");

    // Wait for the landing probe to resolve so the assertion is post-gate.
    await waitFor(() => {
      expect(landingCalls(fetchImpl).length).toBeGreaterThan(0);
    });
    expect(screen.getByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
    expect(screen.queryByTestId("voice-unavailable")).toBeNull();
  });

  // Fail-open pin (launch-safety posture): when /api/vault answers WITHOUT
  // the field and the bare-landing probe then FAILS — for any reason — the
  // capability stays undefined and the mic must render exactly as today.
  // Failure must never masquerade as "disabled". The 401 case specifically
  // pins that a scope-mismatched token can't hide the mic (the client's
  // single refresh-and-retry resolves null here — seeded token has no
  // refreshToken — then throws VaultAuthError, which react-query absorbs).
  it.each([
    ["network error (fetch rejects)", "reject"],
    ["server error (500)", 500],
    ["auth mismatch (401)", 401],
    ["malformed JSON (200 non-JSON body)", "malformed"],
  ] as const)(
    "landing probe fails — %s → fail-open: recorder stays, no gate copy, no crash",
    async (_label, failure) => {
      const fetchImpl = installDoorFetch({
        apiVault: { name: "dev", description: "" },
        landingFailure: failure,
      });
      renderAt("/new");

      // The probe must have actually fired (a vacuous pass here would just
      // be the loading state) and settled…
      await waitFor(() => {
        expect(landingCalls(fetchImpl).length).toBeGreaterThan(0);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // …and the mic is still there, with no gate copy.
      expect(screen.getByRole("button", { name: /record voice memo/i })).toBeInTheDocument();
      expect(screen.queryByTestId("voice-unavailable")).toBeNull();
    },
  );
});
