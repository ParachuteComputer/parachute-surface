/**
 * Tests for the Add route — the R3b two-step unified add flow:
 * source-kind selection + validation, inspect-before-install, the
 * server-block trust card, the audience selector, and the install POST.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Add, validateSource } from "./Add.tsx";

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.setItem("parachute_operator_token", "test-token");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <Add />
    </MemoryRouter>,
  );
}

type Captured = { url: string; method: string; body?: unknown };

/** Fetch mock answering /surface/inspect + /surface/add; logs every call. */
function mockHostFetch(opts: {
  inspect?: unknown;
  inspectStatus?: number;
  add?: unknown;
  addStatus?: number;
  log?: Captured[];
}): void {
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    opts.log?.push({ url, method, body });
    if (url.endsWith("/surface/inspect")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.inspect ?? {}), {
          status: opts.inspectStatus ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/surface/add")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.add ?? {}), {
          status: opts.addStatus ?? 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

const INSPECT_WITH_META = {
  ok: true,
  source_kind: "npm",
  has_meta: true,
  meta: {
    name: "myui",
    displayName: "My UI",
    path: "/surface/myui",
    version: "1.2.3",
    scopes_required: ["vault:*:read"],
    pwa: false,
    audience: "hub-users",
  },
  meta_errors: null,
  warnings: [],
  server: null,
};

const INSPECT_BACKED = {
  ...INSPECT_WITH_META,
  meta: {
    ...INSPECT_WITH_META.meta,
    name: "backed",
    path: "/surface/backed",
    server: {
      entry: "server/index.js",
      format: "markdown",
      capabilities: ["websocket"],
      timeoutMs: 30000,
    },
  },
  server: {
    entry: "server/index.js",
    format: "markdown",
    capabilities: ["websocket"],
    timeoutMs: 30000,
  },
};

const INSPECT_NO_META = {
  ok: true,
  source_kind: "path",
  has_meta: false,
  meta: null,
  meta_errors: null,
  warnings: [],
  server: null,
};

const GITHUB_DOWNLOAD_URL =
  "https://github.com/Unforced-Dev/WovenBoulder/releases/download/v1.2.3/woven-boulder-surface-1.2.3.tgz";

const INSPECT_GITHUB = {
  ...INSPECT_WITH_META,
  source_kind: "url",
  github_release: {
    owner: "Unforced-Dev",
    repo: "WovenBoulder",
    tag: "v1.2.3",
    asset_name: "woven-boulder-surface-1.2.3.tgz",
    download_url: GITHUB_DOWNLOAD_URL,
  },
};

describe("validateSource", () => {
  test("npm kind rejects paths + urls, accepts specs", () => {
    expect(validateSource("npm", "@openparachute/notes-ui")).toBeNull();
    expect(validateSource("npm", "@openparachute/notes-ui@1.0.0")).toBeNull();
    expect(validateSource("npm", "/tmp/x")).toMatch(/Server path/);
    expect(validateSource("npm", "https://x.com/a.tgz")).toMatch(/URL \/ GitHub release/);
    expect(validateSource("npm", "Not A Spec!")).toMatch(/Not a valid npm/);
  });
  test("npm kind nudges a GitHub shorthand toward the URL kind", () => {
    expect(validateSource("npm", "Unforced-Dev/WovenBoulder")).toMatch(/GitHub owner\/repo/);
  });
  test("path kind requires an absolute path", () => {
    expect(validateSource("path", "/abs/dir")).toBeNull();
    expect(validateSource("path", "relative/dir")).toMatch(/absolute/);
  });
  test("url kind requires https (http loopback-only)", () => {
    expect(validateSource("url", "https://example.com/a.tgz")).toBeNull();
    expect(validateSource("url", "http://127.0.0.1:9999/a.tgz")).toBeNull();
    expect(validateSource("url", "http://example.com/a.tgz")).toMatch(/loopback/);
    expect(validateSource("url", "ftp://example.com/a.tgz")).toMatch(/http\(s\)/);
  });
  test("url kind accepts the GitHub owner/repo shorthand (+ #asset)", () => {
    expect(validateSource("url", "Unforced-Dev/WovenBoulder")).toBeNull();
    expect(validateSource("url", "owner/repo#my-surface-1.2.3.tgz")).toBeNull();
    expect(validateSource("url", "https://github.com/Unforced-Dev/WovenBoulder")).toBeNull();
    expect(validateSource("url", "owner/repo/extra")).toMatch(/http\(s\)/);
  });
});

describe("Add — inspect step", () => {
  test("Inspect source POSTs /surface/inspect and shows derived meta fields", async () => {
    const log: Captured[] = [];
    mockHostFetch({ inspect: INSPECT_WITH_META, log });
    renderWithRouter();
    await userEvent.type(
      screen.getByPlaceholderText(/@openparachute\/notes-ui/),
      "@openparachute/my-ui",
    );
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));

    await screen.findByText(/From the bundle's meta.json/);
    const inspectCall = log.find((c) => c.url.endsWith("/surface/inspect"));
    expect(inspectCall?.method).toBe("POST");
    expect((inspectCall?.body as { source: string }).source).toBe("@openparachute/my-ui");
    // Derived fields shown, not retyped.
    expect(screen.getByText("myui")).toBeInTheDocument();
    expect(screen.getByText("/surface/myui")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    // No manual identity fields when meta is present + valid.
    expect(screen.queryByPlaceholderText("my-surface")).toBeNull();
  });

  test("client-side validation blocks a kind/source mismatch without a network call", async () => {
    const log: Captured[] = [];
    mockHostFetch({ inspect: INSPECT_WITH_META, log });
    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/@openparachute\/notes-ui/), "/tmp/somewhere");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    expect(await screen.findByText(/switch the source kind/)).toBeInTheDocument();
    expect(log.find((c) => c.url.endsWith("/surface/inspect"))).toBeUndefined();
  });

  test("a backed surface shows the trust card BEFORE install", async () => {
    mockHostFetch({ inspect: INSPECT_BACKED });
    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/@openparachute\/notes-ui/), "backed-pkg");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));

    expect(await screen.findByText(/This surface ships a server/)).toBeInTheDocument();
    expect(screen.getByText("server/index.js")).toBeInTheDocument();
    expect(screen.getByText("websocket")).toBeInTheDocument();
    expect(screen.getByText(/Vault access is NOT granted by installing/)).toBeInTheDocument();
  });

  test("no meta.json → manual name + mount fields appear", async () => {
    mockHostFetch({ inspect: INSPECT_NO_META });
    renderWithRouter();
    const sourceKind = screen.getByRole("radio", { name: /Server path/ });
    await userEvent.click(sourceKind);
    await userEvent.type(screen.getByPlaceholderText(/\/abs\/path/), "/tmp/bare-bundle");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));

    expect(await screen.findByText(/ships no meta.json/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("my-surface")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/surface/my-surface")).toBeInTheDocument();
  });

  test("a GitHub-resolved source shows the release (tag + asset) in the confirm step", async () => {
    mockHostFetch({ inspect: INSPECT_GITHUB });
    renderWithRouter();
    await userEvent.click(screen.getByRole("radio", { name: /URL \/ GitHub release/ }));
    await userEvent.type(screen.getByPlaceholderText(/owner\/repo/), "Unforced-Dev/WovenBoulder");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));

    expect(await screen.findByText(/Resolved GitHub release/)).toBeInTheDocument();
    expect(screen.getByText("Unforced-Dev/WovenBoulder")).toBeInTheDocument();
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("woven-boulder-surface-1.2.3.tgz")).toBeInTheDocument();
  });

  test("inspect error surfaces inline", async () => {
    mockHostFetch({
      inspect: { error: "bad_source", message: "no index.html" },
      inspectStatus: 400,
    });
    renderWithRouter();
    const sourceKind = screen.getByRole("radio", { name: /Server path/ });
    await userEvent.click(sourceKind);
    await userEvent.type(screen.getByPlaceholderText(/\/abs\/path/), "/tmp/nope");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 400");
  });
});

describe("Add — install step", () => {
  test("Install POSTs /surface/add with source + audience, no retyped meta fields", async () => {
    const log: Captured[] = [];
    mockHostFetch({
      inspect: INSPECT_WITH_META,
      add: {
        ok: true,
        ui: { name: "myui", path: "/surface/myui", displayName: "My UI", audience: "hub-users" },
        oauth_client_id: "client_myui",
        oauth_status: "approved",
      },
      log,
    });
    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/@openparachute\/notes-ui/), "my-ui-pkg");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/From the bundle's meta.json/);
    await userEvent.click(screen.getByRole("button", { name: /Install surface/ }));

    await screen.findByText(/Added myui/);
    const addCall = log.find((c) => c.url.endsWith("/surface/add"));
    expect(addCall?.method).toBe("POST");
    const body = addCall?.body as Record<string, unknown>;
    expect(body.source).toBe("my-ui-pkg");
    expect(body.audience).toBe("hub-users");
    // Meta-derived identity is NOT retyped back at the host.
    expect(body.name).toBeUndefined();
    expect(body.path).toBeUndefined();
    expect(screen.getByText(/client_myui/)).toBeInTheDocument();
  });

  test("picking a non-default audience rides the add body", async () => {
    const log: Captured[] = [];
    mockHostFetch({
      inspect: INSPECT_WITH_META,
      add: { ok: true, ui: { name: "myui", path: "/surface/myui", audience: "operator" } },
      log,
    });
    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/@openparachute\/notes-ui/), "my-ui-pkg");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/Who can open it\?/);
    await userEvent.click(screen.getByRole("radio", { name: /Operator only/ }));
    await userEvent.click(screen.getByRole("button", { name: /Install surface/ }));
    await waitFor(() => {
      const addCall = log.find((c) => c.url.endsWith("/surface/add"));
      expect((addCall?.body as { audience: string }).audience).toBe("operator");
    });
  });

  test("manual identity (no-meta source) rides the add body", async () => {
    const log: Captured[] = [];
    mockHostFetch({
      inspect: INSPECT_NO_META,
      add: { ok: true, ui: { name: "bare", path: "/surface/bare" } },
      log,
    });
    renderWithRouter();
    await userEvent.click(screen.getByRole("radio", { name: /Server path/ }));
    await userEvent.type(screen.getByPlaceholderText(/\/abs\/path/), "/tmp/bare-bundle");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/ships no meta.json/);
    await userEvent.type(screen.getByPlaceholderText("my-surface"), "bare");
    await userEvent.type(screen.getByPlaceholderText("/surface/my-surface"), "/surface/bare");
    await userEvent.click(screen.getByRole("button", { name: /Install surface/ }));
    await waitFor(() => {
      const addCall = log.find((c) => c.url.endsWith("/surface/add"));
      const body = addCall?.body as Record<string, unknown>;
      expect(body.name).toBe("bare");
      expect(body.path).toBe("/surface/bare");
    });
  });

  test("a GitHub-resolved source installs the exact inspected asset URL", async () => {
    const log: Captured[] = [];
    mockHostFetch({
      inspect: INSPECT_GITHUB,
      add: { ok: true, ui: { name: "myui", path: "/surface/myui" } },
      log,
    });
    renderWithRouter();
    await userEvent.click(screen.getByRole("radio", { name: /URL \/ GitHub release/ }));
    await userEvent.type(screen.getByPlaceholderText(/owner\/repo/), "Unforced-Dev/WovenBoulder");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/Resolved GitHub release/);
    await userEvent.click(screen.getByRole("button", { name: /Install surface/ }));
    await waitFor(() => {
      const addCall = log.find((c) => c.url.endsWith("/surface/add"));
      // The install rides the resolved download_url, NOT the shorthand — the
      // operator gets exactly the artifact the confirm step showed.
      expect((addCall?.body as { source: string }).source).toBe(GITHUB_DOWNLOAD_URL);
    });
  });

  test("install error surfaces inline (409 name_exists)", async () => {
    mockHostFetch({
      inspect: INSPECT_WITH_META,
      add: { error: "name_exists", message: 'UI named "myui" exists' },
      addStatus: 409,
    });
    renderWithRouter();
    await userEvent.type(screen.getByPlaceholderText(/@openparachute\/notes-ui/), "my-ui-pkg");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/From the bundle's meta.json/);
    await userEvent.click(screen.getByRole("button", { name: /Install surface/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 409");
  });

  test("changing the source resets the inspection", async () => {
    mockHostFetch({ inspect: INSPECT_WITH_META });
    renderWithRouter();
    const input = screen.getByPlaceholderText(/@openparachute\/notes-ui/);
    await userEvent.type(input, "my-ui-pkg");
    await userEvent.click(screen.getByRole("button", { name: /Inspect source/ }));
    await screen.findByText(/From the bundle's meta.json/);
    await userEvent.type(input, "x");
    expect(screen.queryByText(/From the bundle's meta.json/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Install surface/ })).toBeNull();
  });
});
