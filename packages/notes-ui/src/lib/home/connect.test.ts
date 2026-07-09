import { describe, expect, it } from "vitest";
import { claudeConnectCommand, connectHandle, mcpEndpoint } from "./connect";

describe("mcpEndpoint", () => {
  it("appends the load-bearing /mcp suffix", () => {
    expect(mcpEndpoint("https://u.parachute.computer/vault/aaron")).toBe(
      "https://u.parachute.computer/vault/aaron/mcp",
    );
  });

  it("tolerates a trailing slash on the vault URL (no double slash)", () => {
    expect(mcpEndpoint("http://localhost:1940/")).toBe("http://localhost:1940/mcp");
  });
});

describe("connectHandle", () => {
  it("slugifies a display name into a shell-safe token", () => {
    expect(connectHandle("My Vault")).toBe("parachute-my-vault");
  });

  it("collapses punctuation and trims dashes", () => {
    expect(connectHandle("Aaron's Notes!!")).toBe("parachute-aaron-s-notes");
  });

  it("falls back to a generic handle when the name has no usable characters", () => {
    expect(connectHandle("—")).toBe("parachute-vault");
  });
});

describe("claudeConnectCommand", () => {
  it("builds the Claude Code one-liner with the handle + MCP URL", () => {
    const url = "https://u.parachute.computer/vault/aaron/mcp";
    expect(claudeConnectCommand("default", url)).toBe(
      `claude mcp add --transport http parachute-default ${url}`,
    );
  });
});
