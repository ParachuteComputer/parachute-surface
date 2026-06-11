/**
 * #105 — instance name/mount override at install: multiple instances of one
 * surface package (instance-per-vault).
 *
 * The driver: the docs editor installed twice — `/surface/docs` bound to
 * vault `default` AND `/surface/boulder-docs` bound to vault `boulder`,
 * each with its own credential + per-instance config. Pre-fix, instances
 * key on the package meta.json `name`, so the second install collides
 * (409 name_exists) — the headline test below FAILS on the pre-fix tree.
 *
 * Design under test:
 *   - `POST /surface/add` accepts optional `instance_name` + `mount_path`,
 *     defaulting to the package meta's values.
 *   - Instance identity = the override name everywhere downstream: the
 *     uis dir, registry key, status, per-instance state/config, credential
 *     binding, DCR record, services.json uis row, the api namespace.
 *   - The PACKAGE meta.json inside the instance dir stays untouched; the
 *     override is recorded in an `instance.json` sidecar (absent when no
 *     override — pre-override installs round-trip with no migration).
 *
 * Integration-style like add-lifecycle.test.ts: real tmpdir sources, the
 * real admin add handler, a real BackendSupervisor importing real entries.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type AdminHandlerOpts,
  type EnforceScopeFn,
  type SerializedUi,
  routeAdmin,
} from "../admin-routes.ts";
import { BackendSupervisor } from "../backend-supervisor.ts";
import { createPendingCredentialGate } from "../credential-store.ts";
import { createHostContextBuilder, surfaceConfigPathFor } from "../host-context.ts";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-override-"));
  uisDir = path.join(tmpDir, "uis");
  credsDir = path.join(tmpDir, "credentials");
  stateDir = path.join(tmpDir, "state");
  manifestPath = path.join(tmpDir, "services.json");
  fs.mkdirSync(uisDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});
afterEach(() => {
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
    stateDir,
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

function credentialReq(overrides: Record<string, unknown>): Request {
  return new Request("http://x/surface/api/credential", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "credential",
      op: "provisioned",
      key: "vault",
      scoped_tags: ["docs"],
      token: "jwt-token",
      jti: "jti",
      expires_at: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      ...overrides,
    }),
  });
}

/**
 * Seed the fixture package — ONE source the tests install twice. A backed
 * surface whose api echoes its mount + a per-instance config value, so two
 * instances provably run with distinct contexts.
 */
function seedDocsPackage(): string {
  const root = path.join(tmpDir, "src", "docs-pkg");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "index.html"), "<html><head></head></html>");
  fs.writeFileSync(
    path.join(root, "meta.json"),
    JSON.stringify({
      name: "docs",
      displayName: "Docs",
      path: "/surface/docs",
      version: "1.2.3",
      scopes_required: ["vault:*:read"],
      server: { entry: "server/index.js" },
    }),
  );
  fs.writeFileSync(
    path.join(root, "server", "index.js"),
    `export default (ctx) => ({
  fetch: () => Response.json({ mount: ctx.mount, mark: ctx.config.get("mark") ?? null }),
});`,
  );
  return root;
}

async function listUis(state: AppState): Promise<SerializedUi[]> {
  const res = await dispatch(new Request("http://x/surface/list"), state);
  expect(res.status).toBe(200);
  return ((await res.json()) as { uis: SerializedUi[] }).uis;
}

describe("#105 headline — two instances of one package in one daemon", () => {
  test("install twice with distinct instance names/mounts/vaults: both mount, distinct configs + credentials + api namespaces; removing one leaves the other untouched", async () => {
    const state = makeState();
    const backends = attachSupervisor(state);
    const source = seedDocsPackage();

    // Two vault credentials stored host-side (the hub's delivery shape).
    expect(
      (
        await dispatch(
          credentialReq({
            connection_id: "cred-surface-vault-default",
            vault: "default",
            scope: "vault:default:read",
            renew_path: "/admin/connections/cred-surface-vault-default/renew",
          }),
          state,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await dispatch(
          credentialReq({
            connection_id: "cred-surface-vault-boulder",
            vault: "boulder",
            scope: "vault:boulder:read",
            renew_path: "/admin/connections/cred-surface-vault-boulder/renew",
          }),
          state,
        )
      ).status,
    ).toBe(200);

    // Per-instance config files (host-context reads <state>/<name>.config.json).
    fs.writeFileSync(surfaceConfigPathFor("docs", stateDir), JSON.stringify({ mark: "main" }));
    fs.writeFileSync(
      surfaceConfigPathFor("boulder-docs", stateDir),
      JSON.stringify({ mark: "boulder" }),
    );

    // Instance 1 — package defaults (no override), vault `default`.
    const first = await dispatch(addReq({ source }), state);
    expect(first.status).toBe(201);

    // Instance 2 — THE capability under test: same package, overridden
    // instance name + mount, bound to vault `boulder`. Pre-fix this add
    // collides on the package name (409 name_exists).
    const second = await dispatch(
      addReq({
        source,
        instance_name: "boulder-docs",
        mount_path: "/surface/boulder-docs",
        vault_default: "boulder",
      }),
      state,
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { ui: SerializedUi };
    expect(secondBody.ui.name).toBe("boulder-docs");
    expect(secondBody.ui.path).toBe("/surface/boulder-docs");
    expect(secondBody.ui.packageName).toBe("docs");

    // Both registered, both active, distinct uis dirs.
    const uis = await listUis(state);
    const docs = uis.find((u) => u.name === "docs");
    const boulder = uis.find((u) => u.name === "boulder-docs");
    expect(docs).toBeDefined();
    expect(boulder).toBeDefined();
    expect(docs!.status).toBe("active");
    expect(boulder!.status).toBe("active");
    expect(fs.existsSync(path.join(uisDir, "docs", "dist", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(uisDir, "boulder-docs", "dist", "index.html"))).toBe(true);

    // Package identity stays untouched in BOTH installed meta.json files
    // (the override lives in the instance.json sidecar, not a rewrite).
    const metaA = JSON.parse(fs.readFileSync(path.join(uisDir, "docs", "meta.json"), "utf8"));
    const metaB = JSON.parse(
      fs.readFileSync(path.join(uisDir, "boulder-docs", "meta.json"), "utf8"),
    );
    expect(metaA.name).toBe("docs");
    expect(metaB.name).toBe("docs");
    expect(metaB.path).toBe("/surface/docs");
    expect(fs.existsSync(path.join(uisDir, "docs", "instance.json"))).toBe(false);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(uisDir, "boulder-docs", "instance.json"), "utf8"),
    );
    expect(sidecar).toEqual({ name: "boulder-docs", path: "/surface/boulder-docs" });

    // Distinct credentials resolve per instance (vault binding drives it).
    expect(docs!.credential?.connection_id).toBe("cred-surface-vault-default");
    expect(docs!.credential?.vault).toBe("default");
    expect(boulder!.credential?.connection_id).toBe("cred-surface-vault-boulder");
    expect(boulder!.credential?.vault).toBe("boulder");

    // Distinct api namespaces answer with distinct mounts + configs.
    const uiA = state.registeredUis.find((u) => u.meta.name === "docs")!;
    const uiB = state.registeredUis.find((u) => u.meta.name === "boulder-docs")!;
    const resA = (await (
      await backends.handleRequest(uiA, new Request("http://x/surface/docs/api/whoami"))
    ).json()) as { mount: string; mark: string };
    const resB = (await (
      await backends.handleRequest(uiB, new Request("http://x/surface/boulder-docs/api/whoami"))
    ).json()) as { mount: string; mark: string };
    expect(resA).toEqual({ mount: "/surface/docs", mark: "main" });
    expect(resB).toEqual({ mount: "/surface/boulder-docs", mark: "boulder" });

    // Remove the second instance — the first is untouched.
    const del = await dispatch(
      new Request("http://x/surface/boulder-docs", { method: "DELETE" }),
      state,
    );
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(uisDir, "boulder-docs"))).toBe(false);
    expect(fs.existsSync(path.join(uisDir, "docs", "dist", "index.html"))).toBe(true);
    const after = await listUis(state);
    expect(after.map((u) => u.name)).toEqual(["docs"]);
    expect(after[0]!.status).toBe("active");
    expect(after[0]!.credential?.connection_id).toBe("cred-surface-vault-default");
    // The surviving instance's backend still answers.
    const survivingUi = state.registeredUis.find((u) => u.meta.name === "docs")!;
    const survives = (await (
      await backends.handleRequest(survivingUi, new Request("http://x/surface/docs/api/whoami"))
    ).json()) as { mount: string };
    expect(survives.mount).toBe("/surface/docs");
    // The removed instance's credential copy was dropped; the survivor's kept.
    expect(fs.existsSync(path.join(credsDir, "cred-surface-vault-default.credential.json"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(credsDir, "cred-surface-vault-boulder.credential.json"))).toBe(
      false,
    );

    await backends.stop();
  });
});

describe("#105 — collision refusals", () => {
  test("same instance name collides (409 name_exists)", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    expect((await dispatch(addReq({ source }), state)).status).toBe(201);
    // Same instance name (the package default), different mount: refused.
    const res = await dispatch(addReq({ source, mount_path: "/surface/docs-two" }), state);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("name_exists");
  });

  test("same mount path collides (409 path_taken)", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    expect((await dispatch(addReq({ source }), state)).status).toBe(201);
    // Distinct instance name but the mount is already claimed: refused.
    const res = await dispatch(addReq({ source, instance_name: "docs-two" }), state);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("path_taken");
  });

  test("reserved mount_path is refused (409 reserved_path)", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    const res = await dispatch(
      addReq({ source, instance_name: "evil", mount_path: "/surface/admin" }),
      state,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("reserved_path");
  });

  test("invalid instance_name / mount_path are refused (400, meta name charset rules)", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    for (const body of [
      { source, instance_name: "Bad_Name" },
      { source, instance_name: "../escape" },
      { source, mount_path: "/elsewhere/docs" },
      { source, mount_path: "/surface/UPPER" },
      { source, instance_name: "" },
    ]) {
      const res = await dispatch(addReq(body), state);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_instance");
    }
    // Nothing was installed by any refused add.
    expect(fs.readdirSync(uisDir)).toEqual([]);
  });
});

describe("#105 — backwards compatibility (pre-override installs)", () => {
  test("a pre-override-format install dir (meta.json only, no instance.json) loads identically", async () => {
    // Hand-seed the EXACT on-disk shape the pre-override add path wrote:
    // uis/<name>/ with meta.json + dist/ and NO instance.json.
    const dir = path.join(uisDir, "legacy");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html><head></head></html>");
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        name: "legacy",
        displayName: "Legacy",
        path: "/surface/legacy",
        version: "0.9.0",
        scopes_required: [],
        pwa: false,
        audience: "hub-users",
        public: false,
      }),
    );

    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.skipped).toEqual([]);
    expect(scan.registered).toHaveLength(1);
    const ui = scan.registered[0]!;
    expect(ui.dirName).toBe("legacy");
    expect(ui.meta.name).toBe("legacy");
    expect(ui.meta.path).toBe("/surface/legacy");
    // No override recorded — package identity passthrough.
    expect(ui.packageName).toBeUndefined();
    expect(ui.packagePath).toBeUndefined();

    // The wire shape reports packageName = the instance name (no rename).
    const state = makeState();
    const uis = await listUis(state);
    expect(uis[0]!.name).toBe("legacy");
    expect(uis[0]!.packageName).toBe("legacy");
  });

  test("an add WITHOUT overrides still writes the pre-override on-disk format (round-trip)", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    expect((await dispatch(addReq({ source }), state)).status).toBe(201);
    // No sidecar — the install record is byte-for-byte the legacy format.
    expect(fs.existsSync(path.join(uisDir, "docs", "instance.json"))).toBe(false);

    // Round-trip: a fresh scan of the on-disk state reproduces the same
    // registration the add reported.
    const rescan = scanUis({ uisDir, logger: silent });
    expect(rescan.registered).toHaveLength(1);
    expect(rescan.registered[0]!.meta.name).toBe("docs");
    expect(rescan.registered[0]!.meta.path).toBe("/surface/docs");
    expect(rescan.registered[0]!.packageName).toBeUndefined();
  });

  test("explicit overrides equal to the package defaults write no sidecar", async () => {
    const state = makeState();
    const source = seedDocsPackage();
    const res = await dispatch(
      addReq({ source, instance_name: "docs", mount_path: "/surface/docs" }),
      state,
    );
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(uisDir, "docs", "instance.json"))).toBe(false);
  });
});

describe("#105 — instance.json sidecar validation at scan time", () => {
  function seedInstalledDir(dirName: string, sidecar: string | null): void {
    const dir = path.join(uisDir, dirName);
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html><head></head></html>");
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ name: "docs", displayName: "Docs", path: "/surface/docs" }),
    );
    if (sidecar !== null) fs.writeFileSync(path.join(dir, "instance.json"), sidecar);
  }

  test("a valid sidecar renames + remounts the instance; package identity is preserved", () => {
    seedInstalledDir(
      "boulder-docs",
      JSON.stringify({ name: "boulder-docs", path: "/surface/boulder-docs" }),
    );
    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.skipped).toEqual([]);
    const ui = scan.registered[0]!;
    expect(ui.meta.name).toBe("boulder-docs");
    expect(ui.meta.path).toBe("/surface/boulder-docs");
    expect(ui.packageName).toBe("docs");
    expect(ui.packagePath).toBe("/surface/docs");
  });

  test("invalid sidecar JSON / shape / charset → skip with invalid-instance (never a crash)", () => {
    seedInstalledDir("broken-json", "{not json");
    seedInstalledDir("bad-name", JSON.stringify({ name: "Bad_Name" }));
    seedInstalledDir("bad-path", JSON.stringify({ path: "/elsewhere/docs" }));
    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.registered).toEqual([]);
    expect(scan.skipped).toHaveLength(3);
    for (const s of scan.skipped) {
      expect(s.status).toBe("invalid-instance");
    }
  });

  test("sidecar name that disagrees with the directory name is refused (identity = the dir)", () => {
    seedInstalledDir("boulder-docs", JSON.stringify({ name: "other-name" }));
    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.registered).toEqual([]);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]!.status).toBe("invalid-instance");
    expect(scan.skipped[0]!.reason).toContain("directory");
  });

  test("sidecar mount collisions resolve like meta collisions (one wins, one skipped)", () => {
    seedInstalledDir("a-docs", JSON.stringify({ name: "a-docs", path: "/surface/shared" }));
    seedInstalledDir("b-docs", JSON.stringify({ name: "b-docs", path: "/surface/shared" }));
    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.registered).toHaveLength(1);
    expect(scan.registered[0]!.meta.name).toBe("a-docs");
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]!.status).toBe("collision");
  });

  test("sidecar claiming a reserved path is refused at scan", () => {
    seedInstalledDir("sneaky", JSON.stringify({ name: "sneaky", path: "/surface/admin" }));
    const scan = scanUis({ uisDir, logger: silent });
    expect(scan.registered).toEqual([]);
    expect(scan.skipped[0]!.status).toBe("reserved-path");
  });
});
