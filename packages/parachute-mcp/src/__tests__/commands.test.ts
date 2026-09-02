/**
 * Unit tests for the CLI face: argument parsing, exit-code mapping, and the
 * stderr secret scrub. Importing commands.ts is safe — it has no side effects
 * and main() only runs from cli.ts's entry guard.
 */
import { describe, expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallCommand,
  EXIT,
  type HttpCommand,
  type ToolsCommand,
  UsageError,
  exitCodeForError,
  isSubcommand,
  parseCommand,
  redactSecrets,
} from "../commands.js";

const tools = (argv: string[]) => parseCommand(argv) as ToolsCommand;
const call = (argv: string[]) => parseCommand(argv) as CallCommand;
const http = (argv: string[]) => parseCommand(argv) as HttpCommand;

describe("isSubcommand", () => {
  test("recognizes exactly the three subcommands", () => {
    expect(isSubcommand("tools")).toBe(true);
    expect(isSubcommand("call")).toBe(true);
    expect(isSubcommand("http")).toBe(true);
  });

  test("bridge-mode argv is never mistaken for a subcommand", () => {
    for (const arg of [undefined, "", "--config", "-v", "https://hub.example.test/mcp"]) {
      expect(isSubcommand(arg)).toBe(false);
    }
  });
});

describe("parseCommand: --help", () => {
  test("--help / -h anywhere wins, even with required positionals missing", () => {
    expect(parseCommand(["call", "--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["http", "-h"])).toEqual({ kind: "help" });
    expect(parseCommand(["tools", "--hub", "home", "--help"])).toEqual({ kind: "help" });
  });
});

describe("parseCommand: tools", () => {
  test("bare", () => {
    expect(tools(["tools"])).toEqual({ kind: "tools", table: false });
  });

  test("--table, --hub and --config in both spellings", () => {
    expect(tools(["tools", "--table", "--hub", "home", "--config", "/c.json"])).toEqual({
      kind: "tools",
      table: true,
      hub: "home",
      config: "/c.json",
    });
    expect(tools(["tools", "--hub=techne", "--config=~/c.json"])).toEqual({
      kind: "tools",
      table: false,
      hub: "techne",
      config: "~/c.json",
    });
  });

  test("--hub takes an alias or a full hub URL", () => {
    expect(tools(["tools", "--hub", "https://hub.example.test/mcp"]).hub).toBe(
      "https://hub.example.test/mcp",
    );
  });

  test("a flag with no value, an unknown flag, and a stray positional all fail", () => {
    expect(() => tools(["tools", "--hub"])).toThrow(/--hub needs a value/);
    expect(() => tools(["tools", "--config="])).toThrow(/--config needs a value/);
    expect(() => tools(["tools", "--nsec", "x"])).toThrow(/unknown flag --nsec/);
    expect(() => tools(["tools", "echo"])).toThrow(/takes no positionals/);
  });
});

describe("parseCommand: call", () => {
  test("tool name only → no arguments", () => {
    expect(call(["call", "echo"])).toEqual({
      kind: "call",
      tool: "echo",
      args: { from: "none" },
      config: undefined,
      hub: undefined,
    });
  });

  test("a positional JSON literal is captured verbatim", () => {
    expect(call(["call", "echo", '{"text":"hi"}']).args).toEqual({
      from: "literal",
      json: '{"text":"hi"}',
    });
  });

  test("--args - selects the stdin path", () => {
    expect(call(["call", "echo", "--args", "-"]).args).toEqual({ from: "stdin" });
    expect(call(["call", "echo", "--args=-"]).args).toEqual({ from: "stdin" });
  });

  test("--args with anything but - is refused, pointing at the positional form", () => {
    expect(() => call(["call", "echo", "--args", '{"text":"hi"}'])).toThrow(
      /--args only accepts "-"/,
    );
  });

  test("a literal AND --args - together is an error, not a silent winner", () => {
    expect(() => call(["call", "echo", "{}", "--args", "-"])).toThrow(/not both/);
  });

  test("flags may be interleaved with the positionals", () => {
    expect(call(["call", "--hub", "home", "echo", '{"a":1}'])).toEqual({
      kind: "call",
      tool: "echo",
      args: { from: "literal", json: '{"a":1}' },
      hub: "home",
      config: undefined,
    });
  });

  test("missing tool, a third positional and unknown flags fail", () => {
    expect(() => call(["call"])).toThrow(/needs a tool name/);
    expect(() => call(["call", "echo", "{}", "extra"])).toThrow(/unexpected argument "extra"/);
    expect(() => call(["call", "echo", "--nsec", "x"])).toThrow(/unknown flag --nsec/);
  });
});

describe("parseCommand: http", () => {
  test("method is upper-cased and the URL normalized for the u tag", () => {
    expect(http(["http", "get", "https://hub.example.test/api/notes"])).toEqual({
      kind: "http",
      method: "GET",
      url: "https://hub.example.test/api/notes",
      headers: [],
      bodyFromStdin: false,
      config: undefined,
    });
  });

  test("-H / --header accumulate and split on the first colon only", () => {
    const cmd = http([
      "http",
      "POST",
      "https://hub.example.test/api",
      "-H",
      "Content-Type: application/json",
      "--header",
      "X-Note: a: b",
    ]);
    expect(cmd.headers).toEqual([
      ["Content-Type", "application/json"],
      ["X-Note", "a: b"],
    ]);
  });

  test("-H cannot set Authorization — the command signs the request itself", () => {
    expect(() => http(["http", "GET", "https://h.test/a", "-H", "Authorization: Nostr x"])).toThrow(
      /cannot set Authorization/,
    );
    expect(() => http(["http", "GET", "https://h.test/a", "-H", "nope"])).toThrow(
      /expects "Name: value"/,
    );
  });

  test("--body accepts ONLY -, so a body can never reach argv", () => {
    expect(http(["http", "POST", "https://h.test/a", "--body", "-"]).bodyFromStdin).toBe(true);
    expect(() => http(["http", "POST", "https://h.test/a", "--body", '{"secret":1}'])).toThrow(
      /--body only accepts "-"/,
    );
  });

  test("GET and HEAD refuse a body", () => {
    expect(() => http(["http", "GET", "https://h.test/a", "--body", "-"])).toThrow(
      /GET cannot carry a body/,
    );
    expect(() => http(["http", "head", "https://h.test/a", "--body", "-"])).toThrow(
      /HEAD cannot carry a body/,
    );
  });

  test("missing/invalid method and URL fail as usage errors", () => {
    expect(() => http(["http"])).toThrow(/needs a METHOD/);
    expect(() => http(["http", "GET"])).toThrow(/needs a URL/);
    expect(() => http(["http", "GET", "not a url"])).toThrow(/is not a valid URL/);
    expect(() => http(["http", "GET", "file:///etc/passwd"])).toThrow(/must be http\(s\)/);
    expect(() => http(["http", "GET!", "https://h.test/a"])).toThrow(/is not an HTTP method/);
  });

  test("an invalid URL error never echoes the input (Node's URL error carries it)", () => {
    // node's `new URL(x)` throws with the FULL raw input on error.input — this
    // command's URL could be a signed download link with a token in it.
    const secretish = "https://[bad/?token=s3cr3t-do-not-echo";
    try {
      http(["http", "GET", secretish]);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).not.toContain("s3cr3t");
    }
  });
});

describe("exitCodeForError", () => {
  test("usage errors are 1", () => {
    expect(exitCodeForError(new UsageError("bad flag"))).toBe(EXIT.usage);
  });

  test("401 and 403 are 3, other transport failures are 2", () => {
    expect(exitCodeForError(new StreamableHTTPError(401, "Error POSTing to endpoint"))).toBe(
      EXIT.auth,
    );
    expect(exitCodeForError(new StreamableHTTPError(403, "forbidden"))).toBe(EXIT.auth);
    expect(exitCodeForError(new StreamableHTTPError(500, "boom"))).toBe(EXIT.transport);
    expect(exitCodeForError(new Error("connect ECONNREFUSED"))).toBe(EXIT.transport);
  });

  test("a status carried only in the message is still classified", () => {
    expect(exitCodeForError(new Error("failed: HTTP 401 Unauthorized"))).toBe(EXIT.auth);
  });
});

describe("redactSecrets", () => {
  test("an nsec anywhere in a stderr line is replaced", () => {
    const nsec = `nsec1${"q".repeat(58)}`;
    expect(redactSecrets(`cannot read ${nsec} oops`)).toBe("cannot read nsec1[redacted] oops");
  });

  test("leaves 64-hex alone — event ids and pubkeys look identical to hex keys", () => {
    const id = "a".repeat(64);
    expect(redactSecrets(`event id ${id}`)).toBe(`event id ${id}`);
  });
});
