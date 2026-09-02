/**
 * Unit tests for the `doctor` step runner, against a MOCKED hub.
 *
 * The step machine is where the value is — which step reports which failure,
 * which exit code it maps to, when a step skips instead of failing, and that
 * the write probe cleans up after itself even when it fails. A live hub cannot
 * be made to produce those failures on demand, so `runDoctor` takes every
 * dependency as an injected `DoctorDeps` and this file hands it a fake session.
 * The end-to-end path over a real SDK client, real signing and a real
 * Streamable-HTTP hub is covered in commands-run.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type DoctorDeps,
  type DoctorHub,
  type DoctorReport,
  type DoctorSession,
  KEY_RESOLUTION_ORDER,
  PROBE_PATH_PREFIX,
  type StepName,
  collectContentStrings,
  parseVaultListing,
  probeContent,
  probePath,
  renderReport,
  runDoctor,
} from "../doctor.js";
import { EXIT, UsageError } from "../exit.js";

const NPUB = "npub1doctorprobe000000000000000000000000000000000000000000000000";
const HUB: DoctorHub = { alias: "home", url: "https://hub.example.test/mcp" };
const NOW = new Date("2026-09-02T04:15:00.000Z");

const HUB_TOOLS = [
  "list-vaults",
  "create-note",
  "query-notes",
  "delete-note",
  "update-note",
] as const;

interface CallRecord {
  name: string;
  args: Record<string, unknown>;
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

interface FakeHubOptions {
  tools?: readonly string[];
  /** Vault names `list-vaults` reports. */
  vaults?: string[];
  covered?: string;
  /** Override a tool's behaviour: return a result, or throw. */
  respond?: (name: string, args: Record<string, unknown>) => CallToolResult | undefined;
  serverInfo?: { name?: string; version?: string };
}

interface FakeHub {
  session: DoctorSession;
  calls: CallRecord[];
  closed: () => number;
  /** Notes the fake vault currently holds, by path. */
  notes: Map<string, string>;
}

/**
 * A fake hub that actually STORES the probe note, so the read-back assertion
 * is a real assertion: a doctor that never wrote, or wrote different bytes,
 * fails here the same way it would against a live vault.
 */
function fakeHub(opts: FakeHubOptions = {}): FakeHub {
  const calls: CallRecord[] = [];
  const notes = new Map<string, string>();
  let closes = 0;
  const names = opts.tools ?? HUB_TOOLS;
  const tools: Tool[] = names.map((name) => ({ name, inputSchema: { type: "object" } }));

  const session: DoctorSession = {
    listTools: async () => tools,
    serverInfo: () => opts.serverInfo,
    close: async () => {
      closes++;
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      const override = opts.respond?.(name, args);
      if (override) return override;
      switch (name) {
        case "list-vaults":
          return text({
            covered: opts.covered ?? "listed",
            vaults: (opts.vaults ?? ["uni"]).map((v) => ({ name: v, url: `https://h/${v}` })),
          });
        case "create-note": {
          notes.set(String(args.path), String(args.content));
          return text({ id: String(args.path), path: args.path });
        }
        case "query-notes": {
          const path = String(args.id);
          const content = notes.get(path);
          // The real hub wraps each vault's answer in a fan-out envelope; the
          // read-back has to survive that, so the fake reproduces it.
          return text({
            vaults_queried: [args.vault],
            results: [
              {
                vault: args.vault,
                notes: content === undefined ? [] : { id: path, path, content },
              },
            ],
          });
        }
        case "delete-note":
          notes.delete(String(args.id));
          return text({ deleted: true });
        case "update-note":
          notes.set(String(args.id), String(args.content));
          return text({ updated: true });
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    },
  };
  return { session, calls, closed: () => closes, notes };
}

interface DepsOverrides {
  resolveKey?: DoctorDeps["resolveKey"];
  resolveHub?: DoctorDeps["resolveHub"];
  openSession?: DoctorDeps["openSession"];
  classify?: DoctorDeps["classify"];
}

function deps(hub: FakeHub, over: DepsOverrides = {}): DoctorDeps {
  return {
    version: "0.0.0-test",
    now: () => NOW,
    resolveKey: over.resolveKey ?? (() => ({ npub: NPUB, source: 'config "keyFile"' })),
    resolveHub: over.resolveHub ?? (() => HUB),
    openSession: over.openSession ?? (async () => hub.session),
    classify: over.classify ?? ((err) => (err instanceof UsageError ? EXIT.usage : EXIT.transport)),
  };
}

/** The step with this name, or undefined. */
function step(report: DoctorReport, name: StepName) {
  return report.steps.find((s) => s.step === name);
}

function statuses(report: DoctorReport): string {
  return report.steps.map((s) => `${s.step}:${s.status}`).join(" ");
}

describe("probe path and content", () => {
  test("the path is npub-prefixed, timestamped, and inside the probe namespace", () => {
    const path = probePath(NPUB, NOW);
    expect(path).toBe(`${PROBE_PATH_PREFIX}npub1doctorp-20260902T041500Z`);
    expect(path.startsWith(".parachute/doctor/")).toBe(true);
    // No colons: the path becomes a filename in the vault's export.
    expect(path).not.toContain(":");
  });

  test("two different keys at the same instant do not collide", () => {
    const other = `npub1other${"0".repeat(50)}`;
    expect(probePath(NPUB, NOW)).not.toBe(probePath(other, NOW));
  });

  test("the content is a single plain-ASCII line", () => {
    const content = probeContent(NOW);
    expect(content).toBe("parachute-mcp doctor probe 2026-09-02T04:15:00.000Z");
    expect(content).not.toContain("\n");
  });
});

describe("parseVaultListing", () => {
  test("reads the hub's {covered, vaults:[{name}]} shape", () => {
    const listing = parseVaultListing(
      text({ covered: "all", vaults: [{ name: "uni" }, { name: "team" }] }),
    );
    expect(listing).toEqual({ names: ["uni", "team"], covered: "all" });
  });

  test("tolerates a bare array and plain string names", () => {
    expect(parseVaultListing(text(["uni", "team"]))?.names).toEqual(["uni", "team"]);
    expect(parseVaultListing(text([{ name: "uni" }]))?.names).toEqual(["uni"]);
  });

  test("an empty vault list parses as an empty list, not as unparseable", () => {
    expect(parseVaultListing(text({ covered: "listed", vaults: [] }))).toEqual({
      names: [],
      covered: "listed",
    });
  });

  test("undefined for a shape with no vaults array at all", () => {
    expect(parseVaultListing(text({ ok: true }))).toBeUndefined();
    expect(parseVaultListing({ content: [{ type: "text", text: "not json" }] })).toBeUndefined();
  });
});

describe("collectContentStrings", () => {
  test("finds content through the hub's fan-out envelope", () => {
    const found = collectContentStrings({
      vaults_queried: ["uni"],
      results: [{ vault: "uni", notes: { path: "p", content: "hello" } }],
    });
    expect(found).toEqual(["hello"]);
  });

  test("finds content in a bare array of notes", () => {
    expect(collectContentStrings([{ content: "a" }, { content: "b" }])).toEqual(["a", "b"]);
  });

  test("ignores a non-string content field rather than throwing", () => {
    expect(collectContentStrings({ content: [{ type: "text", text: "x" }] })).toEqual([]);
  });
});

describe("runDoctor — the happy path", () => {
  test("all four steps pass and the exit code is 0", async () => {
    const hub = fakeHub({ serverInfo: { name: "parachute-account", version: "0.1.0" } });
    const report = await runDoctor({}, deps(hub));

    expect(report.exitCode).toBe(EXIT.ok);
    expect(report.ok).toBe(true);
    expect(statuses(report)).toBe("key:pass hub:pass vaults:pass write:pass");
    expect(report.summary).toContain("PASS");
  });

  test("the key step reports the npub and the source, and NOTHING else", async () => {
    const hub = fakeHub();
    const report = await runDoctor({}, deps(hub));
    const key = step(report, "key");
    expect(key?.reason).toBe(`signing as ${NPUB} (from config "keyFile")`);
    // The whole report is the public artifact — no nsec-shaped string anywhere.
    expect(JSON.stringify(report)).not.toContain("nsec1");
  });

  test("the hub step reports the tool count and the server identity", async () => {
    const hub = fakeHub({ serverInfo: { name: "parachute-account", version: "0.1.0" } });
    const report = await runDoctor({}, deps(hub));
    expect(step(report, "hub")?.reason).toContain("5 tools");
    expect(step(report, "hub")?.reason).toContain("parachute-account 0.1.0");
  });

  test("a hub that sends no serverInfo still passes", async () => {
    const report = await runDoctor({}, deps(fakeHub()));
    expect(step(report, "hub")?.status).toBe("pass");
    expect(step(report, "hub")?.reason).not.toContain("server ");
  });

  test("the vaults step names the vaults and the coverage", async () => {
    const hub = fakeHub({ vaults: ["uni", "team"], covered: "all" });
    const report = await runDoctor({ vault: "uni" }, deps(hub));
    expect(step(report, "vaults")?.reason).toContain("uni, team");
    expect(step(report, "vaults")?.reason).toContain("ALL vaults on this hub");
    expect(step(report, "vaults")?.details?.vaults).toEqual(["uni", "team"]);
  });

  test("the write probe creates, reads back, and deletes — inside the namespace only", async () => {
    const hub = fakeHub();
    const report = await runDoctor({}, deps(hub));

    const written = hub.calls.filter((c) => c.name !== "list-vaults");
    expect(written.map((c) => c.name)).toEqual(["create-note", "query-notes", "delete-note"]);
    for (const call of written) {
      const path = String(call.args.path ?? call.args.id);
      expect(path.startsWith(PROBE_PATH_PREFIX)).toBe(true);
    }
    // Nothing left behind.
    expect(hub.notes.size).toBe(0);
    expect(step(report, "write")?.reason).toContain("deleted");
  });

  test("the probe carries the vault selector the hub door requires", async () => {
    const hub = fakeHub();
    await runDoctor({}, deps(hub));
    for (const call of hub.calls.filter((c) => c.name !== "list-vaults")) {
      expect(call.args.vault).toBe("uni");
    }
  });

  test("the session is always closed", async () => {
    const hub = fakeHub();
    await runDoctor({}, deps(hub));
    expect(hub.closed()).toBe(1);
  });
});

describe("runDoctor — key step", () => {
  test("no key fails at the key step with the resolution order, exit 1", async () => {
    const hub = fakeHub();
    const report = await runDoctor(
      {},
      deps(hub, {
        resolveKey: () => {
          throw new UsageError("no configuration: pass --config <path>");
        },
      }),
    );
    expect(report.exitCode).toBe(EXIT.usage);
    expect(report.steps).toHaveLength(1);
    expect(step(report, "key")?.status).toBe("fail");
    expect(step(report, "key")?.reason).toContain(KEY_RESOLUTION_ORDER);
  });

  test("a failed key step never opens a session", async () => {
    const hub = fakeHub();
    let opened = 0;
    await runDoctor(
      {},
      deps(hub, {
        resolveKey: () => {
          throw new UsageError("no key");
        },
        openSession: async () => {
          opened++;
          return hub.session;
        },
      }),
    );
    expect(opened).toBe(0);
    expect(hub.calls).toHaveLength(0);
  });
});

describe("runDoctor — hub step", () => {
  test("an auth rejection at connect is exit 3, not exit 2", async () => {
    const hub = fakeHub();
    const report = await runDoctor(
      {},
      deps(hub, {
        openSession: async () => {
          throw new Error("Error POSTing to endpoint (HTTP 401): unauthorized");
        },
        classify: () => EXIT.auth,
      }),
    );
    expect(report.exitCode).toBe(EXIT.auth);
    expect(statuses(report)).toBe("key:pass hub:fail");
    expect(step(report, "hub")?.reason).toContain(HUB.url);
  });

  test("an unreachable hub is exit 2 and stops the run", async () => {
    const hub = fakeHub();
    const report = await runDoctor(
      {},
      deps(hub, {
        openSession: async () => {
          throw new Error("fetch failed");
        },
      }),
    );
    expect(report.exitCode).toBe(EXIT.transport);
    expect(statuses(report)).toBe("key:pass hub:fail");
  });

  test("an ambiguous hub is a usage error, exit 1", async () => {
    const hub = fakeHub();
    const report = await runDoctor(
      {},
      deps(hub, {
        resolveHub: () => {
          throw new UsageError("doctor checks one hub at a time — pass --hub <alias|url>");
        },
      }),
    );
    expect(report.exitCode).toBe(EXIT.usage);
    expect(step(report, "hub")?.reason).toContain("one hub at a time");
  });
});

describe("runDoctor — vaults step", () => {
  test("a door with no list-vaults tool SKIPS rather than failing", async () => {
    const hub = fakeHub({ tools: ["query-notes", "create-note"] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(statuses(report)).toBe("key:pass hub:pass vaults:skip write:skip");
    expect(step(report, "vaults")?.reason).toContain("not a hub account door");
  });

  test("zero reachable vaults PASSES with an honest reason — the key just has no grant", async () => {
    const hub = fakeHub({ vaults: [] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "vaults")?.status).toBe("pass");
    expect(step(report, "vaults")?.reason).toContain("no vault grant");
    expect(step(report, "write")?.status).toBe("skip");
  });

  test("a list-vaults tool error is exit 4 and stops the run", async () => {
    const hub = fakeHub({
      respond: (name) =>
        name === "list-vaults"
          ? { content: [{ type: "text", text: "not granted" }], isError: true }
          : undefined,
    });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.toolError);
    expect(statuses(report)).toBe("key:pass hub:pass vaults:fail");
    expect(step(report, "vaults")?.reason).toContain("not granted");
  });

  test("an unparseable list-vaults result fails rather than pretending", async () => {
    const hub = fakeHub({ respond: (name) => (name === "list-vaults" ? text({}) : undefined) });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.toolError);
    expect(step(report, "vaults")?.reason).toContain("does not understand");
  });
});

describe("runDoctor — write step", () => {
  test("several vaults and no --vault: skip, and say which flag to pass", async () => {
    const hub = fakeHub({ vaults: ["uni", "team"] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "write")?.status).toBe("skip");
    expect(step(report, "write")?.reason).toContain("--vault");
    expect(hub.calls.map((c) => c.name)).toEqual(["list-vaults"]);
  });

  test("--vault selects the target when several are reachable", async () => {
    const hub = fakeHub({ vaults: ["uni", "team"] });
    const report = await runDoctor({ vault: "team" }, deps(hub));
    expect(step(report, "write")?.status).toBe("pass");
    expect(hub.calls.find((c) => c.name === "create-note")?.args.vault).toBe("team");
  });

  test("a read-back mismatch FAILS — and still deletes the probe", async () => {
    const hub = fakeHub({
      respond: (name, args) =>
        name === "query-notes"
          ? text({
              results: [{ vault: args.vault, notes: { content: "something else entirely" } }],
            })
          : undefined,
    });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.toolError);
    expect(step(report, "write")?.reason).toContain("byte-exact");
    expect(hub.calls.map((c) => c.name)).toContain("delete-note");
    expect(hub.notes.size).toBe(0);
  });

  test("a create that the hub refuses is exit 4, and nothing is deleted", async () => {
    const hub = fakeHub({
      respond: (name) =>
        name === "create-note"
          ? { content: [{ type: "text", text: "read-only grant" }], isError: true }
          : undefined,
    });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.toolError);
    expect(step(report, "write")?.reason).toContain("read-only grant");
    expect(hub.calls.map((c) => c.name)).not.toContain("delete-note");
  });

  test("no delete-note tool: fall back to update-note and SAY the note was left", async () => {
    const hub = fakeHub({ tools: ["list-vaults", "create-note", "query-notes", "update-note"] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "write")?.status).toBe("pass");
    expect(step(report, "write")?.reason).toContain("NOT deleted");
    expect(step(report, "write")?.reason).toContain("safe to delete");
    const left = [...hub.notes.values()][0];
    expect(left).toContain("safe to delete");
  });

  test("no delete and no update: still passes, but names the note to remove by hand", async () => {
    const hub = fakeHub({ tools: ["list-vaults", "create-note", "query-notes"] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "write")?.reason).toContain("by hand");
    expect(step(report, "write")?.reason).toContain(PROBE_PATH_PREFIX);
  });

  test("a delete that fails does not fail the write step — the write already worked", async () => {
    const hub = fakeHub({
      respond: (name) =>
        name === "delete-note"
          ? { content: [{ type: "text", text: "delete forbidden" }], isError: true }
          : undefined,
    });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "write")?.status).toBe("pass");
    expect(step(report, "write")?.reason).toContain("NOT deleted");
  });

  test("no create/query pair on the door: skip", async () => {
    const hub = fakeHub({ tools: ["list-vaults", "query-notes"] });
    const report = await runDoctor({}, deps(hub));
    expect(report.exitCode).toBe(EXIT.ok);
    expect(step(report, "write")?.status).toBe("skip");
    expect(step(report, "write")?.reason).toContain("create-note");
  });

  test("--vault against a door with no vault listing still probes", async () => {
    const hub = fakeHub({ tools: ["create-note", "query-notes", "delete-note"] });
    const report = await runDoctor({ vault: "uni" }, deps(hub));
    expect(statuses(report)).toBe("key:pass hub:pass vaults:skip write:pass");
    expect(report.exitCode).toBe(EXIT.ok);
  });
});

describe("renderReport", () => {
  test("one line per step plus the summary", async () => {
    const report = await runDoctor({}, deps(fakeHub()));
    const rendered = renderReport(report);
    const lines = rendered.trimEnd().split("\n");
    expect(lines[0]).toContain("PASS");
    expect(lines[0]).toContain("key");
    expect(lines.at(-1)).toBe(report.summary);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  test("a failed run's summary names the step and the exit code", async () => {
    const hub = fakeHub();
    const report = await runDoctor(
      {},
      deps(hub, {
        resolveKey: () => {
          throw new UsageError("no key");
        },
      }),
    );
    expect(report.summary).toContain("FAIL at key");
    expect(report.summary).toContain("exit 1");
  });
});
