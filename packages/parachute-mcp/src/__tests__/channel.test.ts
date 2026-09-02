/**
 * Unit tests for `channel-context`, against a MOCKED hub.
 *
 * The value is in the sequences, not the wire: which tool gets called with
 * which arguments, what the byte window works out to, what happens when the
 * note is missing (append must create then append), and that a `path_conflict`
 * is SUCCESS. A live hub cannot be made to produce a create/append race on
 * demand, and pointing these at a real vault would mean writing to someone's
 * notes — so `runChannelContext` takes every dependency injected and this file
 * hands it a fake session, exactly as doctor.test.ts does.
 */
import { describe, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type ChannelDeps,
  type ChannelOptions,
  type ChannelSession,
  DEFAULT_TAIL_BYTES,
  deriveTarget,
  extractNote,
  initialContent,
  isNotFound,
  isPathConflict,
  normalizeEntry,
  relayHostOf,
  runChannelContext,
  tailWindow,
} from "../channel.js";
import { EXIT, UsageError } from "../exit.js";

const RELAY = "wss://buzz.unforced.org";
const CHANNEL = "3d4ee4fa-249b-4c6c-be0a-b0cea4c1610d";
const PATH = `Channels/buzz.unforced.org/${CHANNEL}`;

interface CallRecord {
  name: string;
  args: Record<string, unknown>;
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

interface FakeHubOptions {
  /**
   * The stored note, if the channel already has one. Holding the CONTENT (not
   * a canned response) is what makes the window arithmetic a real assertion:
   * the fake slices the same bytes a vault would.
   */
  note?: { content: string; updatedAt?: string };
  /** Override a tool call: return a result, or throw. */
  respond?: (name: string, args: Record<string, unknown>) => CallToolResult | undefined;
}

interface FakeHub {
  session: ChannelSession;
  calls: CallRecord[];
  closed: () => number;
  content: () => string | undefined;
}

/**
 * A fake vault that actually stores the note and honours the byte window, so a
 * command that computed the wrong offset gets the wrong bytes back here in
 * exactly the way it would against a live vault.
 */
function fakeHub(opts: FakeHubOptions = {}): FakeHub {
  const calls: CallRecord[] = [];
  let note = opts.note ? { ...opts.note } : undefined;
  let closes = 0;

  const session: ChannelSession = {
    close: async () => {
      closes++;
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      const override = opts.respond?.(name, args);
      if (override) return override;
      switch (name) {
        case "query-notes": {
          if (!note) return toolError("not_found: no note with that id");
          const bytes = new TextEncoder().encode(note.content);
          const offset = typeof args.content_offset === "number" ? args.content_offset : 0;
          const length =
            typeof args.content_length === "number" ? args.content_length : bytes.length;
          const slice = new TextDecoder().decode(bytes.slice(offset, offset + length));
          // The real hub wraps each vault's answer in a fan-out envelope.
          return text({
            vaults_queried: [args.vault ?? "uni"],
            results: [
              {
                vault: args.vault ?? "uni",
                notes: [
                  {
                    id: PATH,
                    path: PATH,
                    content: slice,
                    content_offset: offset,
                    content_total_length: bytes.length,
                    updatedAt: note.updatedAt ?? "2026-09-02T08:00:00.000Z",
                  },
                ],
              },
            ],
          });
        }
        case "create-note": {
          if (note) return toolError("path_conflict: a note already exists at that path");
          note = { content: String(args.content) };
          return text({ id: String(args.path), path: args.path });
        }
        case "update-note": {
          if (!note) return toolError("not_found: no note with that id");
          note = {
            content: note.content + String(args.append ?? ""),
            updatedAt: "2026-09-02T09:30:00.000Z",
          };
          return text({ id: PATH, path: PATH, updatedAt: note.updatedAt });
        }
        default:
          return toolError(`unexpected tool ${name}`);
      }
    },
  };

  return { session, calls, closed: () => closes, content: () => note?.content };
}

function deps(hub: FakeHub, over: Partial<ChannelDeps> = {}): ChannelDeps {
  return {
    openSession: async () => hub.session,
    classify: (_err, phase) => (phase === "tool" ? EXIT.toolError : EXIT.transport),
    readStdin: async () => "",
    env: {},
    ...over,
  };
}

function options(over: Partial<ChannelOptions> = {}): ChannelOptions {
  return { action: "read", relay: RELAY, channel: CHANNEL, tail: DEFAULT_TAIL_BYTES, ...over };
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

describe("path derivation", () => {
  test("strips the scheme and any trailing slash", () => {
    expect(relayHostOf("wss://buzz.unforced.org")).toBe("buzz.unforced.org");
    expect(relayHostOf("wss://buzz.unforced.org/")).toBe("buzz.unforced.org");
    expect(relayHostOf("https://buzz.unforced.org///")).toBe("buzz.unforced.org");
    expect(relayHostOf("buzz.unforced.org")).toBe("buzz.unforced.org");
    expect(relayHostOf("  wss://buzz.unforced.org/  ")).toBe("buzz.unforced.org");
  });

  test("empty-ish relays derive nothing", () => {
    expect(relayHostOf(undefined)).toBeUndefined();
    expect(relayHostOf("")).toBeUndefined();
    expect(relayHostOf("   ")).toBeUndefined();
    expect(relayHostOf("wss://")).toBeUndefined();
  });

  test("builds Channels/<relay-host>/<channel-uuid>", () => {
    const target = deriveTarget({ relay: "wss://buzz.unforced.org/", channel: CHANNEL }, {});
    expect(target.path).toBe(PATH);
    expect(target.relayHost).toBe("buzz.unforced.org");
    expect(target.channelId).toBe(CHANNEL);
  });

  test("falls back to $BUZZ_RELAY_URL and $BUZZ_CHANNEL_ID", () => {
    const target = deriveTarget({}, { BUZZ_RELAY_URL: RELAY, BUZZ_CHANNEL_ID: CHANNEL });
    expect(target.path).toBe(PATH);
  });

  test("explicit flags beat the environment", () => {
    const target = deriveTarget(
      { relay: "wss://other.example", channel: "abc" },
      { BUZZ_RELAY_URL: RELAY, BUZZ_CHANNEL_ID: CHANNEL },
    );
    expect(target.path).toBe("Channels/other.example/abc");
  });

  test("a missing relay or channel is a usage error", () => {
    expect(() => deriveTarget({ channel: CHANNEL }, {})).toThrow(UsageError);
    expect(() => deriveTarget({ channel: CHANNEL }, {})).toThrow(/--relay/);
    expect(() => deriveTarget({ relay: RELAY }, {})).toThrow(UsageError);
    expect(() => deriveTarget({ relay: RELAY }, {})).toThrow(/--channel/);
    expect(() => deriveTarget({ relay: RELAY, channel: "   " }, {})).toThrow(UsageError);
  });

  test("a channel id cannot climb out of the Channels/ namespace", () => {
    expect(() => deriveTarget({ relay: RELAY, channel: "../Self/Charter" }, {})).toThrow(
      UsageError,
    );
    expect(() => deriveTarget({ relay: RELAY, channel: "a/b" }, {})).toThrow(UsageError);
  });

  test("the header is the runbook's shape", () => {
    expect(initialContent(deriveTarget({ relay: RELAY, channel: CHANNEL }, {}))).toBe(
      `# ${CHANNEL} — buzz.unforced.org\n\nShared, append-only channel context. One entry per agent turn. Read the tail before you act. Never rewrite; only \`append\`.\n`,
    );
  });
});

// ---------------------------------------------------------------------------
// Window arithmetic
// ---------------------------------------------------------------------------

describe("tail window", () => {
  test("reads the LAST tail bytes of a big note", () => {
    expect(tailWindow(20_000, 8000)).toEqual({ content_offset: 12_000, content_length: 8000 });
  });

  test("never asks for a negative offset", () => {
    expect(tailWindow(100, 8000)).toEqual({ content_offset: 0, content_length: 8000 });
    expect(tailWindow(0, 8000)).toEqual({ content_offset: 0, content_length: 8000 });
  });

  test("raises a tiny --tail to the vault's 4-byte floor for content_length", () => {
    expect(tailWindow(50, 1)).toEqual({ content_offset: 49, content_length: 4 });
  });
});

describe("note extraction", () => {
  test("finds the note inside the hub's fan-out envelope", () => {
    const note = extractNote({
      vaults_queried: ["uni"],
      results: [{ vault: "uni", notes: [{ id: PATH, content: "hi", content_total_length: 12 }] }],
    });
    expect(note).toEqual({ content: "hi", totalBytes: 12 });
  });

  test("falls back to the slice's own byte length when no total is reported", () => {
    const note = extractNote({ id: PATH, content: "héllo" });
    expect(note?.totalBytes).toBe(6);
  });

  test("returns undefined when there is no note-shaped object", () => {
    expect(extractNote({ vaults_queried: ["uni"], results: [] })).toBeUndefined();
  });
});

describe("error classification", () => {
  test("recognises the vault's not-found prose", () => {
    expect(isNotFound("query-notes: not_found: no note with that id")).toBe(true);
    expect(isNotFound("Note not found")).toBe(true);
    expect(isNotFound("vault not covered by this grant")).toBe(false);
  });

  test("recognises a path conflict", () => {
    expect(isPathConflict("create-note: path_conflict at Channels/x/y")).toBe(true);
    expect(isPathConflict("a note already exists at that path")).toBe(true);
    expect(isPathConflict("not granted")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("read", () => {
  test("a small note comes back in ONE call, complete", async () => {
    const hub = fakeHub({ note: { content: "# head\n\nentry one\n" } });
    const result = await runChannelContext(options(), deps(hub));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toBe("# head\n\nentry one\n");
    expect(hub.calls.map((c) => c.name)).toEqual(["query-notes"]);
    expect(hub.closed()).toBe(1);
  });

  test("a note bigger than --tail is re-read at the tail offset", async () => {
    const content = `${"x".repeat(9000)}TAIL-MARKER`;
    const hub = fakeHub({ note: { content } });
    const result = await runChannelContext(options({ tail: 100 }), deps(hub));

    expect(hub.calls).toHaveLength(2);
    expect(hub.calls[1]?.args).toMatchObject({
      content_offset: content.length - 100,
      content_length: 100,
    });
    expect(result.text).toHaveLength(100);
    expect(result.text.endsWith("TAIL-MARKER")).toBe(true);
  });

  test("--json carries path, byteSize and updatedAt", async () => {
    const hub = fakeHub({ note: { content: "abc", updatedAt: "2026-09-02T08:00:00.000Z" } });
    const result = await runChannelContext(options(), deps(hub));

    expect(result.json).toEqual({
      action: "read",
      path: PATH,
      exists: true,
      byteSize: 3,
      updatedAt: "2026-09-02T08:00:00.000Z",
      tailBytes: 3,
      content: "abc",
    });
  });

  test("a missing note prints nothing, exits 0, and reports exists:false", async () => {
    const hub = fakeHub();
    const result = await runChannelContext(options(), deps(hub));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toBe("");
    expect(result.json).toEqual({ action: "read", path: PATH, exists: false });
  });

  test("passes --vault through when given, and omits it when not", async () => {
    const withVault = fakeHub({ note: { content: "x" } });
    await runChannelContext(options({ vault: "uni" }), deps(withVault));
    expect(withVault.calls[0]?.args.vault).toBe("uni");

    const without = fakeHub({ note: { content: "x" } });
    await runChannelContext(options(), deps(without));
    expect(without.calls[0]?.args).not.toHaveProperty("vault");
  });

  test("a real tool failure is exit 4 with a stderr line, not exit 0", async () => {
    const hub = fakeHub({
      respond: (name) => (name === "query-notes" ? toolError("vault not covered") : undefined),
    });
    const result = await runChannelContext(options({ vault: "uni" }), deps(hub));

    expect(result.exitCode).toBe(EXIT.toolError);
    expect(result.error).toMatch(/vault not covered/);
    expect(result.text).toBe("");
    expect(hub.closed()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

describe("append", () => {
  test("appends the entry with exactly one leading newline", async () => {
    const hub = fakeHub({ note: { content: "# head\n" } });
    const result = await runChannelContext(
      options({ action: "append", vault: "uni" }),
      deps(hub, { readStdin: async () => "## turn\n- did: things\n" }),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(hub.calls.map((c) => c.name)).toEqual(["update-note"]);
    expect(hub.calls[0]?.args).toEqual({
      vault: "uni",
      id: PATH,
      append: "\n## turn\n- did: things\n",
    });
    expect(hub.content()).toBe("# head\n\n## turn\n- did: things\n");
    expect(result.text).toBe("2026-09-02T09:30:00.000Z\n");
    expect(result.json).toEqual({
      action: "append",
      path: PATH,
      updatedAt: "2026-09-02T09:30:00.000Z",
      created: false,
    });
  });

  test("an entry that already starts with a newline is not double-spaced", () => {
    expect(normalizeEntry("\nalready\n")).toBe("\nalready\n");
    expect(normalizeEntry("bare\n")).toBe("\nbare\n");
  });

  test("an empty entry is a usage error before any hub call", async () => {
    const hub = fakeHub({ note: { content: "x" } });
    await expect(
      runChannelContext(
        options({ action: "append", vault: "uni" }),
        deps(hub, { readStdin: async () => "   \n" }),
      ),
    ).rejects.toThrow(UsageError);
    expect(hub.calls).toHaveLength(0);
  });

  test("on the channel's FIRST turn: append → not found → init → append", async () => {
    const hub = fakeHub();
    const result = await runChannelContext(
      options({ action: "append", vault: "uni" }),
      deps(hub, { readStdin: async () => "first entry\n" }),
    );

    expect(hub.calls.map((c) => c.name)).toEqual(["update-note", "create-note", "update-note"]);
    expect(hub.calls[1]?.args).toMatchObject({
      vault: "uni",
      path: PATH,
      tags: ["channel-log"],
    });
    expect((hub.calls[1]?.args.metadata as Record<string, unknown>).channel_id).toBe(CHANNEL);
    expect(hub.content()).toBe(
      `${initialContent(deriveTarget({ relay: RELAY, channel: CHANNEL }, {}))}\nfirst entry\n`,
    );
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.json.created).toBe(true);
  });

  test("a create that LOST the race still ends with the entry appended", async () => {
    // Two agents take the channel's first turn at once. Ours sees not-found,
    // tries to create, and loses — the other agent's note is already there.
    // The retry must still land, or the turn is silently dropped.
    const calls: CallRecord[] = [];
    let exists = false;
    let content = "";
    const session: ChannelSession = {
      close: async () => {},
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "update-note") {
          if (!exists) return toolError("not_found: no note with that id");
          content += String(args.append ?? "");
          return text({ id: PATH, updatedAt: "2026-09-02T10:00:00.000Z" });
        }
        if (name === "create-note") {
          // The racing agent's create landed first.
          exists = true;
          content = "# other agent's header\n";
          return toolError("path_conflict: a note already exists at that path");
        }
        return toolError(`unexpected tool ${name}`);
      },
    };
    const hub: FakeHub = {
      session,
      calls,
      closed: () => 0,
      content: () => content,
    };
    const result = await runChannelContext(
      options({ action: "append", vault: "uni" }),
      deps(hub, { readStdin: async () => "mine\n" }),
    );

    expect(result.exitCode).toBe(EXIT.ok);
    expect(calls.map((c) => c.name)).toEqual(["update-note", "create-note", "update-note"]);
    expect(content).toBe("# other agent's header\n\nmine\n");
    expect(result.json).toMatchObject({ created: true });
  });

  test("--vault is required", async () => {
    const hub = fakeHub({ note: { content: "x" } });
    await expect(
      runChannelContext(options({ action: "append" }), deps(hub, { readStdin: async () => "x" })),
    ).rejects.toThrow(/--vault/);
    expect(hub.calls).toHaveLength(0);
  });

  test("a non-not-found tool error is NOT retried as a create", async () => {
    const hub = fakeHub({
      respond: (name) => (name === "update-note" ? toolError("read-only grant") : undefined),
    });
    const result = await runChannelContext(
      options({ action: "append", vault: "uni" }),
      deps(hub, { readStdin: async () => "entry" }),
    );
    expect(result.exitCode).toBe(EXIT.toolError);
    expect(hub.calls.map((c) => c.name)).toEqual(["update-note"]);
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("init", () => {
  test("creates the note with the header, tag and metadata", async () => {
    const hub = fakeHub();
    const result = await runChannelContext(options({ action: "init", vault: "uni" }), deps(hub));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(hub.calls.map((c) => c.name)).toEqual(["create-note"]);
    const args = hub.calls[0]?.args as Record<string, unknown>;
    expect(args.path).toBe(PATH);
    expect(args.tags).toEqual(["channel-log"]);
    expect(args.metadata).toMatchObject({
      relay: "buzz.unforced.org",
      channel_id: CHANNEL,
    });
    expect(typeof (args.metadata as Record<string, unknown>).summary).toBe("string");
    expect(args.content).toBe(initialContent(deriveTarget({ relay: RELAY, channel: CHANNEL }, {})));
    expect(result.json).toEqual({ action: "init", path: PATH, created: true });
  });

  test("path_conflict is SUCCESS — someone else got there first", async () => {
    const hub = fakeHub({ note: { content: "# already here\n" } });
    const result = await runChannelContext(options({ action: "init", vault: "uni" }), deps(hub));

    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.error).toBeUndefined();
    expect(result.json).toEqual({ action: "init", path: PATH, existed: true });
    // The existing note is left exactly as it was.
    expect(hub.content()).toBe("# already here\n");
  });

  test("any OTHER create failure still fails", async () => {
    const hub = fakeHub({
      respond: (name) => (name === "create-note" ? toolError("not granted") : undefined),
    });
    const result = await runChannelContext(options({ action: "init", vault: "uni" }), deps(hub));

    expect(result.exitCode).toBe(EXIT.toolError);
    expect(result.json).toMatchObject({ action: "init", path: PATH, ok: false });
  });

  test("--vault is required", async () => {
    const hub = fakeHub();
    await expect(runChannelContext(options({ action: "init" }), deps(hub))).rejects.toThrow(
      /--vault/,
    );
  });
});
