import { describe, expect, test } from "bun:test";
import { isMutation, originAllowed, requestHost } from "../auth/origin-check.ts";

function req(headers: Record<string, string> = {}, url = "https://hub.test/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isMutation", () => {
  test("GET/HEAD/OPTIONS are safe; everything else mutates", () => {
    for (const safe of ["GET", "get", "HEAD", "OPTIONS"]) expect(isMutation(safe)).toBe(false);
    for (const mut of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"]) {
      expect(isMutation(mut)).toBe(true);
    }
  });
});

describe("requestHost", () => {
  test("prefers the first X-Forwarded-Host", () => {
    expect(requestHost(req({ "x-forwarded-host": "our.parachute.test, inner:1946" }))).toBe(
      "our.parachute.test",
    );
  });

  test("falls back to Host, then the URL", () => {
    expect(requestHost(req({ host: "Host.Test:443" }))).toBe("host.test:443");
    expect(requestHost(req({}, "https://from-url.test/x"))).toBe("from-url.test");
  });
});

describe("originAllowed (fail-closed)", () => {
  test("same-origin passes", () => {
    expect(originAllowed(req({ origin: "https://hub.test", host: "hub.test" }))).toBe(true);
  });

  test("proxy-forwarded same-origin passes via X-Forwarded-Host", () => {
    expect(
      originAllowed(
        req({
          origin: "https://public.test",
          "x-forwarded-host": "public.test",
          host: "127.0.0.1:1946",
        }),
      ),
    ).toBe(true);
  });

  test("absent Origin fails", () => {
    expect(originAllowed(req({ host: "hub.test" }))).toBe(false);
  });

  test("Origin: null fails", () => {
    expect(originAllowed(req({ origin: "null", host: "hub.test" }))).toBe(false);
  });

  test("cross-site Origin fails", () => {
    expect(originAllowed(req({ origin: "https://evil.example", host: "hub.test" }))).toBe(false);
  });

  test("malformed Origin fails", () => {
    expect(originAllowed(req({ origin: "not a url", host: "hub.test" }))).toBe(false);
  });
});
