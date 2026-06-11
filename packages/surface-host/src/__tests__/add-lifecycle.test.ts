/**
 * Lifecycle regressions for the add/upsert path — #103 + #101.
 *
 *   #103 — `POST /surface/add` with `force: true` replaced the files on
 *   disk but the supervisor's sync() left the unchanged-spec mount alone,
 *   so the daemon kept executing the OLD in-process module until an
 *   explicit reload (live finding, docs-editor fix rollout 2026-06-11:
 *   force-add returned ok+active while every probe still hit the stale
 *   code). The add path must remount through the same generation-bumped
 *   seam the reload route uses.
 *
 *   #101 — `POST /surface/add` blocked until a credential existed for
 *   backends whose factory awaits a vault token at startup (live finding,
 *   docs-editor install 2026-06-10: the add hung until the credential was
 *   delivered mid-add). With `scopes_required` declared and no stored
 *   credential, the factory must be DEFERRED: add returns promptly with
 *   `pending-credential`, and the credential-delivery endpoint triggers
 *   the real mount.
 *
 * Integration-style: real tmpdir sources, the real admin add handler, a
 * real BackendSupervisor dynamically importing real entries.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type AdminHandlerOpts, type EnforceScopeFn, routeAdmin } from "../admin-routes.ts";
import { BackendSupervisor } from "../backend-supervisor.ts";
import { createPendingCredentialGate } from "../credential-store.ts";
import { createHostContextBuilder } from "../host-context.ts";
import type { AppState } from "../http-server.ts";
import { scanUis } from "../ui-registry.ts";

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const allowAdmin: EnforceScopeFn = async () => ({ scopes: ["surface:admin"] });

let tmpDir: string;
let uisDir: string;
let credsDir: string;
let stateDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-lifecycle-"));
  uisDir = path.join(tmpDir, "uis");
  credsDir = path.join(tmpDir, "credentials");
  stateDir = path.join(tmpDir, "state");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});
afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(): AppState {
  const scan = scanUis({ uisDir, logger: silent });
  return {
    config: {
      hub_url: "http://127.0.0.1:1939",
      auto_register_oauth_clients: false,
      disabled: false,
      default_scope_required: ["vault:*:read"],
      dev_mode_allowed: true,
      bootstrap_default_apps: { enabled: false, apps: [] },
      auto_provision_required_schema: false,
      credential_connections: {},
    },
    registeredUis: scan.registered,
    skippedUis: scan.skipped.map((s) => ({
      dirName: s.dirName,
      status: s.status,
      reason: s.reason,
    })),
  };
}

/** Wire a REAL supervisor into the state — with the #101 credential gate. */
function attachSupervisor(state: AppState): BackendSupervisor {
  const backends = new BackendSupervisor({
    buildContext: createHostContextBuilder({
      config: state.config,
      logger: silent,
      stateDir,
      tokenProviderFor: () => () => "test-token",
    }),
    pendingCredentialReason: createPendingCredentialGate({
      dir: credsDir,
      getConfig: () => state.config,
    }),
    logger: silent,
  });
  state.backends = backends;
  return backends;
}

/** Seed a local source dir: dist/index.html + meta.json + server entry. */
function seedBackedSource(
  localName: string,
  meta: Record<string, unknown>,
  serverCode: string,
): string {
  const root = path.join(tmpDir, "src", localName);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "index.html"), "<html><head></head></html>");
  fs.writeFileSync(path.join(root, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(root, "server", "index.js"), serverCode);
  return root;
}

async function dispatch(
  req: Request,
  state: AppState,
  extra: Partial<AdminHandlerOpts> = {},
): Promise<Response> {
  const result = routeAdmin(req, {
    state,
    uisDir,
    manifestPath,
    credentialsDir: credsDir,
    logger: silent,
    skipSelfRegisterRefresh: true,
    enforceScopeFn: allowAdmin,
    ...extra,
  });
  if (!result.handled) throw new Error("routeAdmin did not handle this request");
  return await result.response;
}

function addReq(body: Record<string, unknown>): Request {
  return new Request("http://x/surface/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function backendMeta(name: string, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    displayName: name,
    path: `/surface/${name}`,
    server: { entry: "server/index.js" },
    ...extras,
  };
}

describe("#103 — force-add remounts the backend (no silent stale-code window)", () => {
  test("force-add over an installed backed surface serves the NEW module without an explicit reload", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const source = seedBackedSource(
      "evolver",
      // scopes_required: [] keeps the #101 gate out of this test's way.
      backendMeta("evolver", { scopes_required: [] }),
      `export default () => ({ fetch: () => new Response("v1") });`,
    );

    const first = await dispatch(addReq({ source }), state);
    expect(first.status).toBe(201);
    const installed = state.registeredUis.find((u) => u.meta.name === "evolver");
    expect(installed).toBeDefined();
    expect(backends.statusFor(installed!)).toBe("active");
    expect(
      await (await backends.handleRequest(installed!, new Request("http://x/api"))).text(),
    ).toBe("v1");

    // Ship the upgrade: same name, same spec, NEW server code.
    fs.writeFileSync(
      path.join(source, "server", "index.js"),
      `export default () => ({ fetch: () => new Response("v2") });`,
    );
    const second = await dispatch(addReq({ source, force: true }), state);
    expect(second.status).toBe(201);
    const body = (await second.json()) as { ok: boolean; ui: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.ui.status).toBe("active");

    // THE regression (#103): the daemon must serve the new module NOW —
    // no POST /surface/<name>/reload in between.
    const replaced = state.registeredUis.find((u) => u.meta.name === "evolver");
    expect(replaced).toBeDefined();
    expect(
      await (await backends.handleRequest(replaced!, new Request("http://x/api"))).text(),
    ).toBe("v2");

    await backends.stop();
  });

  test("force-add that drops the server block unmounts the old backend", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const source = seedBackedSource(
      "debacked",
      backendMeta("debacked", { scopes_required: [] }),
      `export default () => ({ fetch: () => new Response("v1") });`,
    );
    await dispatch(addReq({ source }), state);
    expect(backends.has("debacked")).toBe(true);

    // Replace with a STATIC bundle (no server block in meta, no server dir).
    const staticRoot = path.join(tmpDir, "src", "debacked-static");
    fs.mkdirSync(path.join(staticRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(staticRoot, "dist", "index.html"), "<html><head></head></html>");
    fs.writeFileSync(
      path.join(staticRoot, "meta.json"),
      JSON.stringify({
        name: "debacked",
        displayName: "debacked",
        path: "/surface/debacked",
        scopes_required: [],
      }),
    );
    const res = await dispatch(addReq({ source: staticRoot, force: true }), state);
    expect(res.status).toBe(201);
    expect(backends.has("debacked")).toBe(false);
    const replaced = state.registeredUis.find((u) => u.meta.name === "debacked");
    expect(backends.statusFor(replaced!)).toBe("static-only");

    await backends.stop();
  });
});

/**
 * A factory shaped like the docs editor's: writes an "invoked" marker the
 * moment it runs, then AWAITS a vault credential (polls the credential
 * store the way the real factory awaits its tokenProvider through
 * grants.start()/reconciler.start()), bounded so a pre-fix regression
 * fails the test instead of hanging the suite.
 */
function tokenAwaitingFactory(markerFile: string, credentialsDir: string): string {
  return `
import { writeFileSync, existsSync, readdirSync } from "node:fs";
export default async () => {
  writeFileSync(${JSON.stringify(markerFile)}, "invoked");
  const deadline = Date.now() + 4500;
  for (;;) {
    if (
      existsSync(${JSON.stringify(credentialsDir)}) &&
      readdirSync(${JSON.stringify(credentialsDir)}).some((f) => f.endsWith(".credential.json"))
    ) {
      break;
    }
    if (Date.now() > deadline) throw new Error("no credential ever arrived");
    await new Promise((r) => setTimeout(r, 25));
  }
  return { fetch: () => new Response("mounted-with-credential") };
};`;
}

function credentialPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "credential",
    op: "provisioned",
    connection_id: "cred-surface-vault-default",
    key: "vault",
    vault: "default",
    scope: "vault:default:read",
    scoped_tags: ["docs"],
    token: "jwt-token-1",
    jti: "jti-1",
    expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    renew_path: "/admin/connections/cred-surface-vault-default/renew",
    ...overrides,
  };
}

describe("#101 — add must not block awaiting a credential (pending-credential mount)", () => {
  test("add without a stored credential returns promptly, pending, factory NOT invoked", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const marker = path.join(tmpDir, "docsish-invoked.marker");
    const source = seedBackedSource(
      "docsish",
      backendMeta("docsish", { scopes_required: ["vault:default:read", "vault:default:write"] }),
      tokenAwaitingFactory(marker, credsDir),
    );

    const started = Date.now();
    const res = await dispatch(addReq({ source }), state);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(201);
    // Pre-fix this add blocked inside the factory until a credential was
    // delivered (live: the docs add hung; here the bounded await makes the
    // pre-fix path take >4.5s and trip the elapsed assertion).
    expect(elapsed).toBeLessThan(1500);
    const body = (await res.json()) as { ui: { status: string; statusReason?: string } };
    expect(body.ui.status).toBe("pending-credential");
    expect(body.ui.statusReason).toContain("no vault credential provisioned");
    expect(fs.existsSync(marker)).toBe(false);

    // The api namespace says WHY it isn't serving.
    const ui = state.registeredUis.find((u) => u.meta.name === "docsish");
    const apiRes = await backends.handleRequest(ui!, new Request("http://x/api"));
    expect(apiRes.status).toBe(503);
    expect(((await apiRes.json()) as { error: string }).error).toBe("credential_pending");

    await backends.stop();
  });

  test("credential delivery mounts the pending backend (active, factory ran)", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const marker = path.join(tmpDir, "delivered-invoked.marker");
    const source = seedBackedSource(
      "delivered",
      backendMeta("delivered"),
      tokenAwaitingFactory(marker, credsDir),
    );
    await dispatch(addReq({ source }), state);
    const ui = state.registeredUis.find((u) => u.meta.name === "delivered");
    expect(backends.statusFor(ui!)).toBe("pending-credential");

    const res = await dispatch(
      new Request("http://x/surface/api/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentialPayload()),
      }),
      state,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mounted?: string[] };
    expect(body.ok).toBe(true);
    expect(body.mounted).toEqual(["delivered"]);

    expect(backends.statusFor(ui!)).toBe("active");
    expect(fs.existsSync(marker)).toBe(true);
    expect(await (await backends.handleRequest(ui!, new Request("http://x/api"))).text()).toBe(
      "mounted-with-credential",
    );

    await backends.stop();
  });

  test("credential already stored at add time → mounts immediately (today's behavior)", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    // Credential lands FIRST (the other install order).
    await dispatch(
      new Request("http://x/surface/api/credential", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentialPayload()),
      }),
      state,
    );
    const marker = path.join(tmpDir, "preloaded-invoked.marker");
    const source = seedBackedSource(
      "preloaded",
      backendMeta("preloaded"),
      tokenAwaitingFactory(marker, credsDir),
    );
    const res = await dispatch(addReq({ source }), state);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ui: { status: string } };
    expect(body.ui.status).toBe("active");
    expect(fs.existsSync(marker)).toBe(true);

    await backends.stop();
  });

  test("surface with scopes_required: [] (no credential required) mounts exactly as today", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const source = seedBackedSource(
      "credfree",
      backendMeta("credfree", { scopes_required: [] }),
      `export default () => ({ fetch: () => new Response("no-cred-needed") });`,
    );
    const res = await dispatch(addReq({ source }), state);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ui: { status: string } };
    expect(body.ui.status).toBe("active");
    const ui = state.registeredUis.find((u) => u.meta.name === "credfree");
    expect(await (await backends.handleRequest(ui!, new Request("http://x/api"))).text()).toBe(
      "no-cred-needed",
    );

    await backends.stop();
  });
});

function credReq(payload: Record<string, unknown>): Request {
  return new Request("http://x/surface/api/credential", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("#111 — credential-delivery lifecycle follow-ups", () => {
  test('op:"removed" also retries pending mounts — a removal resolves multi-credential ambiguity', async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    // TWO write-scope credentials for the same vault and no explicit
    // binding → the gate parks the surface on the ambiguity reason.
    await dispatch(
      credReq(
        credentialPayload({ connection_id: "cred-a", scope: "vault:default:write", jti: "jti-a" }),
      ),
      state,
    );
    await dispatch(
      credReq(
        credentialPayload({ connection_id: "cred-b", scope: "vault:default:write", jti: "jti-b" }),
      ),
      state,
    );
    const marker = path.join(tmpDir, "ambig-invoked.marker");
    const source = seedBackedSource(
      "ambig",
      backendMeta("ambig"),
      tokenAwaitingFactory(marker, credsDir),
    );
    await dispatch(addReq({ source }), state);
    const ui = state.registeredUis.find((u) => u.meta.name === "ambig");
    expect(backends.statusFor(ui!)).toBe("pending-credential");
    expect(backends.reasonFor("ambig")).toContain("multiple credentials");

    // The hub tears one down: exactly one candidate remains. Pre-fix the
    // removed op skipped the retry and the surface stayed parked until
    // reload/PATCH/reboot.
    const res = await dispatch(
      credReq(credentialPayload({ op: "removed", connection_id: "cred-b" })),
      state,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mounted?: string[] };
    expect(body.mounted).toEqual(["ambig"]);
    expect(backends.statusFor(ui!)).toBe("active");
    expect(fs.existsSync(marker)).toBe(true);

    await backends.stop();
  });

  test("a delivery-triggered mount refreshes services.json (hub tile flips pending → active)", async () => {
    // An existing row is the precondition for the refresh (selfRegister
    // preserves its port; without one the port-0 guard refuses).
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ services: [{ name: "parachute-surface", port: 4321 }] }, null, 2)}\n`,
    );
    const state = makeState();
    const backends = attachSupervisor(state);
    const marker = path.join(tmpDir, "manifested-invoked.marker");
    const source = seedBackedSource(
      "manifested",
      backendMeta("manifested"),
      tokenAwaitingFactory(marker, credsDir),
    );
    await dispatch(addReq({ source }), state, { skipSelfRegisterRefresh: false });
    const manifestBefore = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string; uis?: Record<string, { status: string }> }>;
    };
    expect(manifestBefore.services[0]?.uis?.manifested?.status).toBe("pending");

    const res = await dispatch(credReq(credentialPayload()), state, {
      skipSelfRegisterRefresh: false,
    });
    expect(((await res.json()) as { mounted?: string[] }).mounted).toEqual(["manifested"]);
    // Pre-fix: the mount went active but services.json still said
    // "pending" until the next add/reload/boot.
    const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string; port: number; uis?: Record<string, { status: string }> }>;
    };
    expect(manifestAfter.services[0]?.uis?.manifested?.status).toBe("active");
    expect(manifestAfter.services[0]?.port).toBe(4321); // existing port preserved

    await backends.stop();
  });

  test("`mounted` lists only retried factories that SUCCEEDED — a failing factory is not reported", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const source = seedBackedSource(
      "doomed",
      backendMeta("doomed"),
      `export default () => { throw new Error("boom at mount"); };`,
    );
    await dispatch(addReq({ source }), state);
    const ui = state.registeredUis.find((u) => u.meta.name === "doomed");
    expect(backends.statusFor(ui!)).toBe("pending-credential");

    // The credential lands; the retried factory then throws. The response
    // must NOT claim the surface mounted.
    const res = await dispatch(credReq(credentialPayload()), state);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; mounted?: string[] };
    expect(body.ok).toBe(true);
    expect(body.mounted).toBeUndefined();
    expect(backends.statusFor(ui!)).toBe("backend-error");
    expect(backends.reasonFor("doomed")).toContain("boom at mount");

    await backends.stop();
  });
});
