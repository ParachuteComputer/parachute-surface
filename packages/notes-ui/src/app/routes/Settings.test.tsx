import { Settings } from "@/app/routes/Settings";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault/store";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function seedActiveVault() {
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

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/" element={<div>HomePage</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings route", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedActiveVault();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redirects to / when no active vault", () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    renderSettings();
    expect(screen.getByText("HomePage")).toBeInTheDocument();
  });

  it("does not render a scribe section — transcription is vault-level", () => {
    renderSettings();
    expect(screen.queryByRole("heading", { name: /transcription/i })).not.toBeInTheDocument();
  });

  it("renders tag roles with defaults and saves overrides into the vault-settings cache", async () => {
    renderSettings();
    const section = screen
      .getByRole("heading", { name: /tag roles/i })
      .closest("section") as HTMLElement;
    const pinnedInput = within(section).getByLabelText(/pinned tag role/i);
    expect((pinnedInput as HTMLInputElement).value).toBe("pinned");

    await act(async () => {
      fireEvent.change(pinnedInput, { target: { value: "starred" } });
    });
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: /^save$/i }));
    });
    // Tag roles now live in the vault settings note; localStorage is the
    // write-through cache under the `notes:settings:<vaultId>` key. No
    // active client is mounted in the test, so update() takes the offline
    // path and leaves the change pinned in the cache as a dirtyPatch.
    const stored = JSON.parse(localStorage.getItem("notes:settings:dev") ?? "{}") as {
      settings?: { tagRoles?: { pinned?: string; archived?: string } };
      dirtyPatch?: { tagRoles?: { pinned?: string } } | null;
    };
    expect(stored.settings?.tagRoles?.pinned).toBe("starred");
    expect(stored.settings?.tagRoles?.archived).toBe("archived");
    expect(stored.dirtyPatch?.tagRoles?.pinned).toBe("starred");
  });

  it("renders the path-tree section and persists mode changes", async () => {
    renderSettings();
    const section = screen
      .getByRole("heading", { name: /folder tree/i })
      .closest("section") as HTMLElement;
    const auto = within(section).getByLabelText(/^auto/i) as HTMLInputElement;
    expect(auto.checked).toBe(true);

    const always = within(section).getByLabelText(/^always/i);
    await act(async () => {
      fireEvent.click(always);
    });
    const stored = JSON.parse(localStorage.getItem("lens:path-tree:dev") ?? "{}") as {
      mode?: string;
    };
    expect(stored.mode).toBe("always");
  });

  it("reset-to-defaults writes the defaults back through the cache", async () => {
    // Seed the settings cache directly — simulates a prior non-default
    // selection that rehydrates into the UI on mount.
    localStorage.setItem(
      "notes:settings:dev",
      JSON.stringify({
        settings: {
          schemaVersion: 1,
          tagRoles: {
            pinned: "starred",
            archived: "done",
            captureVoice: "memo",
            captureText: "inbox",
            view: "preset",
          },
        },
        serverSettings: null,
        serverUpdatedAt: null,
        noteExists: false,
        dirtyPatch: {
          tagRoles: {
            pinned: "starred",
            archived: "done",
            captureVoice: "memo",
            captureText: "inbox",
            view: "preset",
          },
        },
      }),
    );
    renderSettings();
    const section = screen
      .getByRole("heading", { name: /tag roles/i })
      .closest("section") as HTMLElement;
    expect((within(section).getByLabelText(/pinned tag role/i) as HTMLInputElement).value).toBe(
      "starred",
    );
    await act(async () => {
      fireEvent.click(within(section).getByRole("button", { name: /reset to defaults/i }));
    });
    const stored = JSON.parse(localStorage.getItem("notes:settings:dev") ?? "{}") as {
      settings?: { tagRoles?: { pinned?: string } };
    };
    expect(stored.settings?.tagRoles?.pinned).toBe("pinned");
    expect((within(section).getByLabelText(/pinned tag role/i) as HTMLInputElement).value).toBe(
      "pinned",
    );
  });
});

// Voice-retention transparency (voice recordings section). The dial is
// server-side vault config (`config.audio_retention` on GET/PATCH
// /api/vault, identical on both doors); the section reflects the cached
// /api/vault read, PATCHes on change, surfaces errors honestly, and treats
// an absent config block (older vault) as "keep" with the radios disabled
// — a control that would silently no-op is not offered. Gated like the mic
// (#167): a vault that explicitly declares transcription disabled has no
// recorder, so it gets no retention dial either.
describe("Settings — voice recordings (audio retention)", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    useToastStore.setState({ toasts: [] });
    seedActiveVault();
    // These tests exercise live vault reads/writes — seed a token so
    // useActiveVaultClient constructs a client (the sections above run
    // clientless on purpose; this one talks to /api/vault).
    localStorage.setItem(
      "lens:token:dev",
      JSON.stringify({ accessToken: "pvt_abc", scope: "full", vault: "default" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubVaultFetch(opts: {
    getBody: unknown;
    patch?: { status?: number; body?: unknown };
  }) {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/api/vault") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => opts.getBody,
          text: async () => "",
        } as Response;
      }
      if (url.includes("/api/vault") && method === "PATCH") {
        const status = opts.patch?.status ?? 200;
        return {
          ok: status < 400,
          status,
          json: async () => opts.patch?.body ?? null,
          text: async () => "",
        } as Response;
      }
      return { ok: false, status: 404, json: async () => null, text: async () => "" } as Response;
    });
    vi.stubGlobal("fetch", fetchImpl);
    return fetchImpl;
  }

  function patchBodies(fetchImpl: ReturnType<typeof stubVaultFetch>): unknown[] {
    return fetchImpl.mock.calls
      .filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH")
      .map(([, init]) => JSON.parse(String(init?.body)));
  }

  function radios(section: HTMLElement) {
    return {
      keep: within(section).getByRole("radio", { name: /^keep/i }) as HTMLInputElement,
      untilTranscribed: within(section).getByRole("radio", {
        name: /delete after transcribing/i,
      }) as HTMLInputElement,
      never: within(section).getByRole("radio", { name: /never store/i }) as HTMLInputElement,
    };
  }

  async function findSection(): Promise<HTMLElement> {
    const heading = await screen.findByRole("heading", { name: /voice recordings/i });
    return heading.closest("section") as HTMLElement;
  }

  it("reflects the current server value from /api/vault", async () => {
    stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        transcription: { enabled: true, provider: "scribe-http" },
        config: { audio_retention: "until_transcribed", auto_transcribe: { enabled: true } },
      },
    });
    renderSettings();

    const section = await findSection();
    await waitFor(() => {
      const r = radios(section);
      expect(r.untilTranscribed.checked).toBe(true);
      expect(r.keep.checked).toBe(false);
      expect(r.never.checked).toBe(false);
      expect(r.keep.disabled).toBe(false);
    });
    // The honest per-option copy is on the page.
    expect(
      within(section).getByText(/audio file is removed once the transcript lands/i),
    ).toBeInTheDocument();
    expect(
      within(section).getByText(/even if transcription fails — the transcript is your only copy/i),
    ).toBeInTheDocument();
  });

  it("changing the value PATCHes config.audio_retention, toasts success, and settles the first-capture choice", async () => {
    const fetchImpl = stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        transcription: { enabled: true, provider: "scribe-http" },
        config: { audio_retention: "keep", auto_transcribe: { enabled: true } },
      },
      patch: {
        body: {
          name: "dev",
          description: null,
          config: { audio_retention: "never", auto_transcribe: { enabled: true } },
        },
      },
    });
    renderSettings();

    const section = await findSection();
    await waitFor(() => expect(radios(section).keep.checked).toBe(true));

    await act(async () => {
      fireEvent.click(radios(section).never);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(patchBodies(fetchImpl)).toEqual([{ config: { audio_retention: "never" } }]);
    // Cache merged from the echo → the radio moves to the new server truth.
    await waitFor(() => expect(radios(section).never.checked).toBe(true));
    expect(useToastStore.getState().toasts.some((t) => /saved/i.test(t.message))).toBe(true);
    // Dialing it here answers the recorder's first-capture prompt too.
    expect(localStorage.getItem("lens:audio-retention-choice:dev")).not.toBeNull();
  });

  it("PATCH failure surfaces an error toast and the radios stay on the server truth", async () => {
    stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        transcription: { enabled: true, provider: "scribe-http" },
        config: { audio_retention: "keep", auto_transcribe: { enabled: true } },
      },
      patch: { status: 500, body: { error: "boom" } },
    });
    renderSettings();

    const section = await findSection();
    await waitFor(() => expect(radios(section).keep.checked).toBe(true));

    await act(async () => {
      fireEvent.click(radios(section).untilTranscribed);
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.tone === "error" && /couldn't save/i.test(t.message)),
      ).toBe(true);
    });
    // A failed PATCH never lies about state — still on the server value.
    expect(radios(section).keep.checked).toBe(true);
    expect(radios(section).untilTranscribed.checked).toBe(false);
    expect(localStorage.getItem("lens:audio-retention-choice:dev")).toBeNull();
  });

  it("old vault without the config block → treated as keep, radios disabled, honest line", async () => {
    stubVaultFetch({ getBody: { name: "dev", description: "" } });
    renderSettings();

    const section = await findSection();
    await waitFor(() => {
      expect(within(section).getByTestId("retention-unsupported")).toBeInTheDocument();
    });
    const r = radios(section);
    expect(r.keep.checked).toBe(true);
    // Disabled via the enclosing fieldset — jest-dom's matcher accounts for
    // fieldset ancestry (the raw `.disabled` property would not).
    expect(r.keep).toBeDisabled();
    expect(r.untilTranscribed).toBeDisabled();
    expect(r.never).toBeDisabled();
  });

  it("vault explicitly declares transcription disabled → no voice recordings section (#167 gate)", async () => {
    stubVaultFetch({
      getBody: {
        name: "dev",
        description: "",
        transcription: { enabled: false },
        config: { audio_retention: "keep", auto_transcribe: { enabled: false } },
      },
    });
    renderSettings();

    // Another section renders (the page is up)…
    await screen.findByRole("heading", { name: /text size/i });
    // …give the vault query a beat to settle, then pin the absence.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /voice recordings/i })).toBeNull();
    });
  });
});
