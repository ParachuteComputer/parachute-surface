import { describe, expect, it } from "vitest";
import { cloudConsoleUrl } from "./console-url";

describe("cloudConsoleUrl", () => {
  it("maps a cloud vault host to the console", () => {
    expect(cloudConsoleUrl("https://u.parachute.computer/vault/aaron")).toBe(
      "https://cloud.parachute.computer/console",
    );
  });

  it("returns null for a self-host vault (no false door)", () => {
    expect(cloudConsoleUrl("http://localhost:1940")).toBeNull();
    expect(cloudConsoleUrl("https://parachute.example.ts.net/vault/default")).toBeNull();
  });

  it("does not match a look-alike host that merely contains the cloud host (F6)", () => {
    // Exact-host map, so an attacker-controlled suffix/subdomain never opens the door.
    expect(cloudConsoleUrl("https://myu.parachute.computer.evil.example/vault/x")).toBeNull();
    expect(cloudConsoleUrl("https://u.parachute.computer.evil.example/vault/x")).toBeNull();
    expect(cloudConsoleUrl("https://u.parachute.computer.evil.example")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(cloudConsoleUrl("not a url")).toBeNull();
  });

  it("prefers an explicit console origin when advertised, normalizing to /console", () => {
    expect(cloudConsoleUrl("https://self.hosted/vault/x", "https://console.self.hosted")).toBe(
      "https://console.self.hosted/console",
    );
  });

  it("uses an explicit console URL as-is when it already has a path", () => {
    expect(
      cloudConsoleUrl("https://self.hosted/vault/x", "https://console.self.hosted/manage"),
    ).toBe("https://console.self.hosted/manage");
  });

  it("falls back to host-sniff when the explicit origin is malformed", () => {
    expect(cloudConsoleUrl("https://u.parachute.computer/vault/x", "garbage")).toBe(
      "https://cloud.parachute.computer/console",
    );
  });
});
