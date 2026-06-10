/**
 * Tests for the per-surface detail page (R3b — the heart of the revamp):
 *
 *   - real-status copy + the Reload remediation for quarantined backends
 *   - DCR retry registration (the pending dead-end exit)
 *   - audience editing (PATCH /surface/<name>)
 *   - the credential panel: link-to-a-vault happy path (hub POST with the
 *     exact H4 body), the ambiguous-binding auto-PATCH, write-requires-tags,
 *     and the hub-401 sign-in guidance
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { UiInfoResponse } from "../lib/api.ts";
import { UiInfo } from "./UiInfo.tsx";

const realFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.setItem("parachute_operator_token", "test-token");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function renderInfo(name = "alpha") {
  return render(
    <MemoryRouter initialEntries={[`/info/${name}`]}>
      <Routes>
        <Route path="/info/:name" element={<UiInfo />} />
      </Routes>
    </MemoryRouter>,
  );
}

function baseUi(overrides: Record<string, unknown> = {}): UiInfoResponse["ui"] {
  return {
    name: "alpha",
    dirName: "alpha",
    displayName: "Alpha",
    path: "/surface/alpha",
    version: "0.1.0",
    scopes_required: ["vault:*:read"],
    pwa: false,
    audience: "hub-users",
    public: false,
    status: "static-only",
    credential: null,
    server: null,
    ...overrides,
  } as UiInfoResponse["ui"];
}

function infoResponse(ui: UiInfoResponse["ui"], oauth?: unknown): UiInfoResponse {
  return {
    ui,
    meta: { name: ui.name },
    paths: { uiDir: `/uis/${ui.name}`, distDir: `/uis/${ui.name}/dist` },
    oauth_client: (oauth ?? null) as UiInfoResponse["oauth_client"],
  };
}

type Captured = { url: string; method: string; body?: unknown };

/**
 * Fetch mock for the detail page. `info` may be an array — successive
 * GET /info calls shift through it (the last entry repeats), letting tests
 * model "state changed after an action".
 */
function mockFetch(opts: {
  info: UiInfoResponse | UiInfoResponse[];
  log?: Captured[];
  vaults?: Array<{ name: string }>;
  connectionsPost?: { status: number; body: unknown };
  patchConfigStatus?: number;
  registerOauth?: { status: number; body: unknown };
}): void {
  const infoQueue = Array.isArray(opts.info) ? [...opts.info] : [opts.info];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    opts.log?.push({ url, method, body });

    if (url.endsWith("/info")) {
      const payload = infoQueue.length > 1 ? infoQueue.shift() : infoQueue[0];
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/dev")) {
      return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    }
    if (url.endsWith("/reload")) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui: null }), { status: 200 }));
    }
    if (url.endsWith("/register-oauth")) {
      const r = opts.registerOauth ?? {
        status: 200,
        body: {
          ok: true,
          oauth_client: {
            client_id: "client_new",
            client_name: "Alpha",
            redirect_uris: [],
            scope: "vault:*:read",
            status: "approved",
            registered_at: new Date().toISOString(),
            hub_url: "http://hub",
          },
        },
      };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }
    if (method === "PATCH" && url.endsWith("/surface/api/config")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, credential_connections: {} }), {
          status: opts.patchConfigStatus ?? 200,
        }),
      );
    }
    if (method === "PATCH" && /\/surface\/[a-z-]+$/.test(url)) {
      const ui = baseUi({ audience: (body as { audience: string }).audience });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ui }), { status: 200 }));
    }
    if (url.endsWith("/.well-known/parachute.json")) {
      return Promise.resolve(
        new Response(JSON.stringify({ vaults: opts.vaults ?? [{ name: "default" }] }), {
          status: 200,
        }),
      );
    }
    if (method === "POST" && url.endsWith("/admin/connections")) {
      const r = opts.connectionsPost ?? {
        status: 200,
        body: {
          ok: true,
          connection: { id: "cred-surface-vault-default", kind: "credential" },
          expires_at: "2027-01-01T00:00:00Z",
        },
      };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
}

const BACKED_NONE = baseUi({
  status: "active",
  server: { entry: "server/index.js", format: "markdown", capabilities: [], timeoutMs: 30000 },
  credential: {
    state: "none",
    vault: "default",
    reason: "no vault credential provisioned",
  },
});

describe("UiInfo — health + remediation", () => {
  test("quarantined backend shows plain-language copy + Reload triggers the endpoint", async () => {
    const log: Captured[] = [];
    mockFetch({
      info: infoResponse(
        baseUi({
          status: "backend-disabled",
          statusReason: "backend crash-looped",
          server: {
            entry: "server/index.js",
            format: "markdown",
            capabilities: [],
            timeoutMs: 30000,
          },
          credential: { state: "none", vault: "default" },
        }),
      ),
      log,
    });
    renderInfo();
    expect(await screen.findByText("Quarantined")).toBeInTheDocument();
    expect(screen.getByText(/crashed repeatedly/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reload surface/ }));
    await waitFor(() => {
      expect(log.find((c) => c.method === "POST" && c.url.endsWith("/reload"))).toBeTruthy();
    });
  });

  test("static surface: no reload remediation, no credential panel", async () => {
    mockFetch({ info: infoResponse(baseUi()) });
    renderInfo();
    expect(await screen.findByText("Static")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reload surface/ })).toBeNull();
    expect(screen.queryByText(/Vault credential/)).toBeNull();
  });
});

describe("UiInfo — OAuth retry", () => {
  test("pending client shows the honest distinction + Retry registration calls the endpoint", async () => {
    const log: Captured[] = [];
    mockFetch({
      info: infoResponse(baseUi({ oauthClientId: "client_old", oauthStatus: "pending" }), {
        client_id: "client_old",
        hub_url: "http://hub",
        scope: "vault:*:read",
        registered_at: new Date().toISOString(),
        status: "pending",
      }),
      log,
    });
    renderInfo();
    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.getByText(/registered but not approved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retry registration/ }));
    await waitFor(() => {
      expect(
        log.find((c) => c.method === "POST" && c.url.endsWith("/surface/alpha/register-oauth")),
      ).toBeTruthy();
    });
    expect(await screen.findByText(/re-registered and approved/)).toBeInTheDocument();
  });

  test("no client at all → retry affordance present", async () => {
    mockFetch({ info: infoResponse(baseUi()) });
    renderInfo();
    expect(await screen.findByText(/No OAuth client is registered/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry registration/ })).toBeInTheDocument();
  });
});

describe("UiInfo — audience editing", () => {
  test("picking a new audience PATCHes /surface/<name>", async () => {
    const log: Captured[] = [];
    mockFetch({ info: infoResponse(baseUi()), log });
    renderInfo();
    await screen.findByText("Static");
    await userEvent.click(screen.getByRole("radio", { name: /Public/ }));
    await userEvent.click(screen.getByRole("button", { name: /Set audience to/ }));
    await waitFor(() => {
      const patch = log.find((c) => c.method === "PATCH" && c.url.endsWith("/surface/alpha"));
      expect(patch).toBeTruthy();
      expect((patch?.body as { audience: string }).audience).toBe("public");
    });
  });

  test("no save button until the draft differs from the current audience", async () => {
    mockFetch({ info: infoResponse(baseUi()) });
    renderInfo();
    await screen.findByText("Static");
    expect(screen.queryByRole("button", { name: /Set audience to/ })).toBeNull();
  });
});

describe("UiInfo — credential link flow", () => {
  test("link flow POSTs the exact H4 credential body; auto-bound connection needs no config PATCH", async () => {
    const log: Captured[] = [];
    const after = infoResponse(
      baseUi({
        status: "active",
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
          expires_at: "2027-01-01T00:00:00Z",
        },
      }),
    );
    mockFetch({ info: [infoResponse(BACKED_NONE), after], log });
    renderInfo();

    expect(await screen.findByText("No vault linked")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Link to a vault/ }));
    // Vault picker populated from the public discovery doc.
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "default" })).toBeInTheDocument();
    });
    await userEvent.type(screen.getByPlaceholderText(/meeting, public-doc/), "meeting");
    await userEvent.click(screen.getByRole("button", { name: /Approve \+ link/ }));

    await waitFor(() => {
      const post = log.find((c) => c.method === "POST" && c.url.endsWith("/admin/connections"));
      expect(post).toBeTruthy();
      expect(post?.body).toEqual({
        kind: "credential",
        requestedBy: "surface",
        credential: { module: "surface", key: "vault", vault: "default", tags: ["meeting"] },
      });
    });
    expect(
      await screen.findByText(/Linked\. Connection cred-surface-vault-default/),
    ).toBeInTheDocument();
    // Auto-bound: the refreshed info already resolves to the new connection.
    expect(
      log.find((c) => c.method === "PATCH" && c.url.endsWith("/surface/api/config")),
    ).toBeUndefined();
  });

  test("ambiguous binding after link → the explicit mapping is PATCHed in the same flow", async () => {
    const log: Captured[] = [];
    const ambiguous = infoResponse(
      baseUi({
        status: "active",
        server: {
          entry: "server/index.js",
          format: "markdown",
          capabilities: [],
          timeoutMs: 30000,
        },
        credential: {
          state: "ambiguous",
          vault: "default",
          candidates: ["cred-a", "cred-surface-vault-default"],
          reason: "multiple credentials match",
        },
      }),
    );
    mockFetch({ info: [infoResponse(BACKED_NONE), ambiguous], log });
    renderInfo();

    await screen.findByText("No vault linked");
    await userEvent.click(screen.getByRole("button", { name: /Link to a vault/ }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "default" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Approve \+ link/ }));

    await waitFor(() => {
      const patch = log.find((c) => c.method === "PATCH" && c.url.endsWith("/surface/api/config"));
      expect(patch).toBeTruthy();
      expect(patch?.body).toEqual({
        credential_connections: { alpha: "cred-surface-vault-default" },
      });
    });
    expect(await screen.findByText(/Bound explicitly to this surface/)).toBeInTheDocument();
  });

  test("write access requires a tag scope — blocked client-side with the attenuation message", async () => {
    const log: Captured[] = [];
    mockFetch({ info: infoResponse(BACKED_NONE), log });
    renderInfo();
    await screen.findByText("No vault linked");
    await userEvent.click(screen.getByRole("button", { name: /Link to a vault/ }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "default" })).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /Access/ }), "write");
    await userEvent.click(screen.getByRole("button", { name: /Approve \+ link/ }));
    expect(await screen.findByText(/List the tags this surface may write/)).toBeInTheDocument();
    expect(
      log.find((c) => c.method === "POST" && c.url.endsWith("/admin/connections")),
    ).toBeUndefined();
  });

  test("hub 401 → sign-in guidance, not a raw error", async () => {
    mockFetch({
      info: infoResponse(BACKED_NONE),
      connectionsPost: { status: 401, body: { error: "unauthorized" } },
    });
    renderInfo();
    await screen.findByText("No vault linked");
    await userEvent.click(screen.getByRole("button", { name: /Link to a vault/ }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "default" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Approve \+ link/ }));
    expect(await screen.findByText(/Not signed in to the hub/)).toBeInTheDocument();
  });

  test("hub error surfaces verbatim", async () => {
    mockFetch({
      info: infoResponse(BACKED_NONE),
      connectionsPost: {
        status: 400,
        body: { error: "unknown_vault", error_description: 'no vault named "default" in this hub' },
      },
    });
    renderInfo();
    await screen.findByText("No vault linked");
    await userEvent.click(screen.getByRole("button", { name: /Link to a vault/ }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "default" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("button", { name: /Approve \+ link/ }));
    expect(await screen.findByText(/no vault named "default" in this hub/)).toBeInTheDocument();
  });

  test("ambiguous state renders the binding picker; Bind PATCHes the mapping", async () => {
    const log: Captured[] = [];
    mockFetch({
      info: infoResponse(
        baseUi({
          status: "active",
          server: {
            entry: "server/index.js",
            format: "markdown",
            capabilities: [],
            timeoutMs: 30000,
          },
          credential: {
            state: "ambiguous",
            vault: "default",
            candidates: ["cred-a", "cred-b"],
            reason: "multiple credentials match",
          },
        }),
      ),
      log,
    });
    renderInfo();
    expect(await screen.findByText("Binding ambiguous")).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Use credential/ }),
      "cred-b",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Bind$/ }));
    await waitFor(() => {
      const patch = log.find((c) => c.method === "PATCH" && c.url.endsWith("/surface/api/config"));
      expect(patch?.body).toEqual({ credential_connections: { alpha: "cred-b" } });
    });
  });
});
