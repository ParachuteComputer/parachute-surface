/**
 * Tests for the Modules route — list rendering, empty state, reload + remove
 * actions invoke the API helpers, dev-mode toggle / trigger / disable flows
 * (Phase 1.3).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Modules } from "./Modules.tsx";

const realFetch = globalThis.fetch;

function withFetchMock(handler: typeof fetch) {
  globalThis.fetch = handler as typeof fetch;
}

/**
 * Build a fake fetch that handles `/surface/list`, `/surface/dev/list`, and any
 * additional routes via the supplied `extras` map. Test-only convenience
 * — every Modules test fetches both endpoints in parallel.
 */
function buildFetch(opts: {
  uis?: unknown[];
  skipped?: unknown[];
  devUis?: unknown[];
  listStatus?: number;
  listBody?: unknown;
  extras?: (url: string, init?: RequestInit) => Response | undefined;
}): typeof fetch {
  const uis = opts.uis ?? [];
  const skipped = opts.skipped ?? [];
  const devUis = opts.devUis ?? [];
  return vi.fn((url: string, init?: RequestInit) => {
    const extra = opts.extras?.(url, init);
    if (extra) return Promise.resolve(extra);
    if (url.endsWith("/surface/dev/list")) {
      return Promise.resolve(
        new Response(JSON.stringify({ uis: devUis }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/surface/list")) {
      const status = opts.listStatus ?? 200;
      const body = opts.listBody ?? { uis, skipped };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

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
      <Modules />
    </MemoryRouter>,
  );
}

describe("Modules", () => {
  test("renders empty state when no UIs", async () => {
    withFetchMock(buildFetch({}));
    renderWithRouter();
    expect(await screen.findByText(/No surfaces installed yet/)).toBeInTheDocument();
  });

  test("renders rows for installed UIs", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "notes",
            dirName: "notes",
            displayName: "Notes",
            path: "/surface/notes",
            version: "0.1.0",
            scopes_required: ["vault:*:read", "vault:*:write"],
            pwa: true,
            public: false,
            status: "active",
            oauthClientId: "client_notes",
            oauthStatus: "approved",
          },
        ],
      }),
    );
    renderWithRouter();
    expect(await screen.findByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("/surface/notes")).toBeInTheDocument();
    // Card layout (post-redesign) doesn't render the raw OAuth client_id as
    // visible text — it surfaces as a `title` attribute on the OAuth-status
    // badge so operators see "OAuth connected" / "OAuth pending" at a glance.
    // The client_id is still in the DOM for diagnostic hover; assert that.
    const oauthBadge = screen.getByTitle("client_notes");
    expect(oauthBadge).toBeInTheDocument();
    expect(screen.getByText("PWA")).toBeInTheDocument();
  });

  test("error surfaces an alert", async () => {
    withFetchMock(
      buildFetch({
        listStatus: 401,
        listBody: { error: "unauthorized", message: "no token" },
      }),
    );
    renderWithRouter();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("HTTP 401");
  });

  test("Reload button triggers POST /surface/<name>/reload", async () => {
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      callLog.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "POST" && url.endsWith("/reload")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 }),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(new Response(JSON.stringify({ uis: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/surface/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const reloadBtn = await screen.findByRole("button", { name: /^Reload$/ });
    await userEvent.click(reloadBtn);
    await waitFor(() => {
      const reloadCall = callLog.find((c) => c.url.endsWith("/reload"));
      expect(reloadCall).toBeTruthy();
      expect(reloadCall?.method).toBe("POST");
    });
  });

  test("Uninstall button triggers DELETE after confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      callLog.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, removed: "alpha" }), { status: 200 }),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(new Response(JSON.stringify({ uis: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/surface/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const uninstallBtn = await screen.findByRole("button", { name: /Uninstall/ });
    await userEvent.click(uninstallBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      const del = callLog.find((c) => c.method === "DELETE");
      expect(del).toBeTruthy();
      expect(del?.url).toContain("/surface/alpha");
    });
  });

  // --- Dev-mode UI (Phase 1.3) ------------------------------------------

  test("renders 'off' state and Enable dev button when dev mode is off", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "alpha",
            dirName: "alpha",
            displayName: "Alpha",
            path: "/surface/alpha",
            scopes_required: [],
            pwa: false,
            public: false,
            status: "active",
          },
        ],
        devUis: [],
      }),
    );
    renderWithRouter();
    expect(await screen.findByRole("button", { name: /Enable dev/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Trigger reload/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disable dev/ })).toBeNull();
  });

  test("renders Dev ON badge + Trigger + Disable when dev mode is on", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "alpha",
            dirName: "alpha",
            displayName: "Alpha",
            path: "/surface/alpha",
            scopes_required: [],
            pwa: false,
            public: false,
            status: "active",
          },
        ],
        devUis: [{ name: "alpha", enabled: true, enabledAt: Date.now(), subscribers: 2 }],
      }),
    );
    renderWithRouter();
    expect(await screen.findByText(/Dev ON/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trigger reload/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disable dev/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enable dev/ })).toBeNull();
    expect(screen.getByText(/2 tab/)).toBeInTheDocument();
  });

  test("Enable dev button POSTs /dev/enable", async () => {
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      callLog.push({ url, method });
      if (method === "POST" && url.endsWith("/dev/enable")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              name: "alpha",
              enabled: true,
              enabledAt: Date.now(),
              subscribers: 0,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(new Response(JSON.stringify({ uis: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/surface/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200 },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const btn = await screen.findByRole("button", { name: /Enable dev/ });
    await userEvent.click(btn);
    await waitFor(() => {
      const post = callLog.find((c) => c.method === "POST" && c.url.endsWith("/dev/enable"));
      expect(post).toBeTruthy();
      expect(post?.url).toContain("/surface/alpha/dev/enable");
    });
  });

  test("Trigger reload button POSTs /dev/trigger", async () => {
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      callLog.push({ url, method });
      if (method === "POST" && url.endsWith("/dev/trigger")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, name: "alpha", notified: 1 }), { status: 200 }),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              uis: [{ name: "alpha", enabled: true, enabledAt: Date.now(), subscribers: 1 }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/surface/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200 },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const btn = await screen.findByRole("button", { name: /Trigger reload/ });
    await userEvent.click(btn);
    await waitFor(() => {
      const post = callLog.find((c) => c.method === "POST" && c.url.endsWith("/dev/trigger"));
      expect(post).toBeTruthy();
      expect(post?.url).toContain("/surface/alpha/dev/trigger");
    });
  });

  test("renders SchemaRequirements summary when required_schema declared", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "notes",
            dirName: "notes",
            displayName: "Notes",
            path: "/surface/notes",
            scopes_required: [],
            pwa: false,
            public: false,
            status: "active",
            required_schema: {
              tags: [
                {
                  name: "capture",
                  description: "Quick captures",
                  fields: {
                    source: { type: "string", required: true },
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    renderWithRouter();
    // Summary line surfaces in the row's Scopes column
    expect(await screen.findByText(/1 tag, 1 field/)).toBeInTheDocument();
  });

  test("no SchemaRequirements summary when required_schema absent", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "alpha",
            dirName: "alpha",
            displayName: "Alpha",
            path: "/surface/alpha",
            scopes_required: [],
            pwa: false,
            public: false,
            status: "active",
          },
        ],
      }),
    );
    renderWithRouter();
    await screen.findByText("Alpha");
    expect(screen.queryByText(/Schema requirements/)).toBeNull();
  });

  // --- R3b: list chips ----------------------------------------------------

  test("rows show real status, audience badge, backed indicator + credential chip", async () => {
    withFetchMock(
      buildFetch({
        uis: [
          {
            name: "boulder",
            dirName: "boulder",
            displayName: "Woven Boulder",
            path: "/surface/boulder",
            scopes_required: ["vault:*:read"],
            pwa: false,
            audience: "public",
            public: true,
            status: "backend-error",
            statusReason: "factory threw",
            server: {
              entry: "server/index.js",
              format: "markdown",
              capabilities: [],
              timeoutMs: 30000,
            },
            credential: {
              state: "ok",
              connection_id: "cred-surface-vault-default",
              vault: "default",
              scope: "vault:default:read",
              scoped_tags: ["meeting"],
            },
          },
        ],
      }),
    );
    renderWithRouter();
    expect(await screen.findByText("backend error")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("backed")).toBeInTheDocument();
    expect(screen.getByText("vault: default")).toBeInTheDocument();
  });

  // --- R3b: composed remove ------------------------------------------------

  /** A backed UI whose credential connection is exclusively bound. */
  function backedUi(credential: Record<string, unknown> | null) {
    return {
      name: "backed",
      dirName: "backed",
      displayName: "Backed",
      path: "/surface/backed",
      scopes_required: [],
      pwa: false,
      audience: "hub-users",
      public: false,
      status: "active",
      server: { entry: "server/index.js", format: "markdown", capabilities: [], timeoutMs: 30000 },
      credential,
    };
  }

  function composedFetch(opts: {
    uis: unknown[];
    log: Array<{ url: string; method: string }>;
    connectionDeleteStatus?: number;
    removeBody?: unknown;
  }): typeof fetch {
    return vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      opts.log.push({ url, method });
      if (method === "DELETE" && url.includes("/admin/connections/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              opts.connectionDeleteStatus === 200 ? { ok: true } : { error: "unauthorized" },
            ),
            {
              status: opts.connectionDeleteStatus ?? 200,
            },
          ),
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify(opts.removeBody ?? { ok: true, removed: "backed" }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(new Response(JSON.stringify({ uis: [] }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ uis: opts.uis, skipped: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  }

  test("uninstalling a backed surface tears down its hub connection FIRST, then the host removal", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const log: Array<{ url: string; method: string }> = [];
    withFetchMock(
      composedFetch({
        uis: [
          backedUi({
            state: "ok",
            connection_id: "cred-surface-vault-default",
            vault: "default",
          }),
        ],
        log,
        connectionDeleteStatus: 200,
      }),
    );
    renderWithRouter();
    await userEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    await waitFor(() => {
      const deletes = log.filter((c) => c.method === "DELETE");
      expect(deletes).toHaveLength(2);
      expect(deletes[0]?.url).toContain("/admin/connections/cred-surface-vault-default");
      expect(deletes[1]?.url).toContain("/surface/backed");
    });
    expect(await screen.findByText(/torn down — credential revoked/)).toBeInTheDocument();
  });

  test("hub teardown failure + operator declines → nothing removed (two-step honest ask)", async () => {
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true) // intent confirm
      .mockReturnValueOnce(false); // decline proceed-without-teardown
    const log: Array<{ url: string; method: string }> = [];
    withFetchMock(
      composedFetch({
        uis: [backedUi({ state: "ok", connection_id: "cred-x", vault: "default" })],
        log,
        connectionDeleteStatus: 401,
      }),
    );
    renderWithRouter();
    await userEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    await screen.findByText(/Removal cancelled/);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // The second confirm carried the failure detail + the explicit choice.
    expect(String(confirmSpy.mock.calls[1]?.[0])).toContain("Hub teardown failed");
    // The host DELETE never ran.
    expect(
      log.find((c) => c.method === "DELETE" && c.url.includes("/surface/backed")),
    ).toBeUndefined();
  });

  test("hub teardown failure + operator proceeds → host removal runs, banner says hub side did NOT run", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const log: Array<{ url: string; method: string }> = [];
    withFetchMock(
      composedFetch({
        uis: [backedUi({ state: "ok", connection_id: "cred-x", vault: "default" })],
        log,
        connectionDeleteStatus: 500,
        removeBody: { ok: true, removed: "backed" },
      }),
    );
    renderWithRouter();
    await userEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    await waitFor(() => {
      expect(
        log.find((c) => c.method === "DELETE" && c.url.includes("/surface/backed")),
      ).toBeTruthy();
    });
    expect(await screen.findByText(/Hub teardown did NOT run/)).toBeInTheDocument();
    expect(screen.getByText(/hub admin → Connections/)).toBeInTheDocument();
  });

  test("shared credential → connection left standing, no hub DELETE", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const log: Array<{ url: string; method: string }> = [];
    withFetchMock(
      composedFetch({
        uis: [
          backedUi({
            state: "ok",
            connection_id: "cred-shared",
            vault: "default",
            shared_with: ["other-surface"],
          }),
        ],
        log,
      }),
    );
    renderWithRouter();
    await userEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    await waitFor(() => {
      expect(
        log.find((c) => c.method === "DELETE" && c.url.includes("/surface/backed")),
      ).toBeTruthy();
    });
    expect(log.find((c) => c.url.includes("/admin/connections/"))).toBeUndefined();
    expect(
      await screen.findByText(/left standing \(shared with other-surface\)/),
    ).toBeInTheDocument();
  });

  test("DCR orphan case (hub can't delete clients) is surfaced, not swallowed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const log: Array<{ url: string; method: string }> = [];
    withFetchMock(
      composedFetch({
        uis: [
          {
            name: "backed",
            dirName: "backed",
            displayName: "Backed",
            path: "/surface/backed",
            scopes_required: [],
            pwa: false,
            public: false,
            status: "static-only",
            credential: null,
          },
        ],
        log,
        removeBody: {
          ok: true,
          removed: "backed",
          oauth_revoke: {
            localFileRemoved: true,
            hubDeleteStatus: "unsupported",
            detail: "hub returned 405; DELETE not supported",
          },
        },
      }),
    );
    renderWithRouter();
    await userEvent.click(await screen.findByRole("button", { name: /Uninstall/ }));
    expect(
      await screen.findByText(/OAuth client record may remain registered/),
    ).toBeInTheDocument();
  });

  test("Disable dev button POSTs /dev/disable", async () => {
    const callLog: Array<{ url: string; method: string }> = [];
    const fakeFetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      callLog.push({ url, method });
      if (method === "POST" && url.endsWith("/dev/disable")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, name: "alpha", enabled: false, was_on: true }), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/surface/dev/list")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              uis: [{ name: "alpha", enabled: true, enabledAt: Date.now(), subscribers: 0 }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            uis: [
              {
                name: "alpha",
                dirName: "alpha",
                displayName: "Alpha",
                path: "/surface/alpha",
                scopes_required: [],
                pwa: false,
                public: false,
                status: "active",
              },
            ],
            skipped: [],
          }),
          { status: 200 },
        ),
      );
    });
    withFetchMock(fakeFetch as unknown as typeof fetch);
    renderWithRouter();
    const btn = await screen.findByRole("button", { name: /Disable dev/ });
    await userEvent.click(btn);
    await waitFor(() => {
      const post = callLog.find((c) => c.method === "POST" && c.url.endsWith("/dev/disable"));
      expect(post).toBeTruthy();
      expect(post?.url).toContain("/surface/alpha/dev/disable");
    });
  });
});
