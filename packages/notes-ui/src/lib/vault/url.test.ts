import { describe, expect, it } from "vitest";
import { safeInternalRedirect } from "./url";

// notes#63 — `safeInternalRedirect` guards the post-connect redirect target
// that the hub `/account` "Import notes" deep-link rides through `/add` into
// the OAuth flow. It must only ever pass through an in-app, same-origin path
// so the value can never round-trip into react-router `navigate()` as an
// open redirect.
describe("safeInternalRedirect", () => {
  it("passes through a plain in-app absolute path", () => {
    expect(safeInternalRedirect("/import")).toBe("/import");
    expect(safeInternalRedirect("/notes/n/abc")).toBe("/notes/n/abc");
  });

  it("preserves an in-app path with its own query string", () => {
    expect(safeInternalRedirect("/import?foo=bar")).toBe("/import?foo=bar");
  });

  it("rejects an absolute URL (off-origin)", () => {
    expect(safeInternalRedirect("https://evil.example/phish")).toBeUndefined();
    expect(safeInternalRedirect("http://evil.example")).toBeUndefined();
  });

  it("rejects a protocol-relative URL", () => {
    // `//evil.example` would navigate off-origin even though it has no scheme.
    expect(safeInternalRedirect("//evil.example")).toBeUndefined();
  });

  it("rejects a backslash-authority form (`/\\` open-redirect bypass)", () => {
    // The WHATWG URL parser normalizes a backslash to a forward slash, so
    // `new URL('/\\evil.com', base)` resolves to `http://evil.com/`. A naive
    // `//`-only guard would let this through — pin it as rejected.
    expect(safeInternalRedirect("/\\evil.com")).toBeUndefined();
    expect(safeInternalRedirect("/\\evil.com/path")).toBeUndefined();
  });

  it("blocks the encoded `//` form after searchParams decoding", () => {
    // The redirect arrives as a URLSearchParams value, which is
    // percent-decoded before it reaches this guard. `%2F%2Fevil.com` decodes
    // to `//evil.com` — document that the decoded value is what's checked, so
    // a future change can't regress into checking the raw encoded string.
    const decoded = new URLSearchParams("redirect=%2F%2Fevil.com").get("redirect");
    expect(decoded).toBe("//evil.com");
    expect(safeInternalRedirect(decoded)).toBeUndefined();
  });

  it("rejects a non-http(s) scheme", () => {
    expect(safeInternalRedirect("javascript:alert(1)")).toBeUndefined();
  });

  it("rejects a relative (non-leading-slash) path", () => {
    // navigate() would resolve this relative to the current route — not the
    // intended absolute in-app target — so it's not a valid carrier here.
    expect(safeInternalRedirect("import")).toBeUndefined();
  });

  it("returns undefined for empty / nullish input", () => {
    expect(safeInternalRedirect(null)).toBeUndefined();
    expect(safeInternalRedirect(undefined)).toBeUndefined();
    expect(safeInternalRedirect("")).toBeUndefined();
  });
});
