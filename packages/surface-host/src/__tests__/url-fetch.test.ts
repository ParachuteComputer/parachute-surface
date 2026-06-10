/**
 * Tests for `src/url-fetch.ts` — the URL-tarball source kind (R3b).
 *
 * Coverage:
 *   - looksLikeUrlSource routing predicate
 *   - scheme rules: https ok, http loopback-only, other schemes rejected
 *   - content-type sanity (text/html → bad_content_type)
 *   - HTTP error statuses → http_error
 *   - declared + streaming size caps → too_large
 *   - real extraction of a tar.gz (root-level dist/ AND npm-style package/ nesting)
 *   - missing dist/index.html → no_dist
 *   - corrupt tarball → extract_failed
 *   - staging cleanup on error paths
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { UrlFetchError, fetchUrlTarball, looksLikeUrlSource } from "../url-fetch.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;
let stagingParent: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "url-fetch-"));
  stagingParent = path.join(tmpDir, "staging");
  fs.mkdirSync(stagingParent, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a real .tgz in tmpDir from a file map (paths relative to archive root). */
async function makeTarball(files: Record<string, string>): Promise<Uint8Array> {
  const srcDir = fs.mkdtempSync(path.join(tmpDir, "tar-src-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const out = path.join(tmpDir, `bundle-${Date.now()}-${Math.random()}.tgz`);
  const proc = Bun.spawn(["tar", "-czf", out, "-C", srcDir, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error("test tarball creation failed");
  return new Uint8Array(fs.readFileSync(out));
}

function fetchReturning(
  body: Uint8Array | string,
  init: { status?: number; contentType?: string; contentLength?: string } = {},
): (url: string, i?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: {
        ...(init.contentType !== undefined ? { "content-type": init.contentType } : {}),
        ...(init.contentLength !== undefined ? { "content-length": init.contentLength } : {}),
      },
    });
}

async function expectUrlError(
  p: Promise<unknown>,
  code: UrlFetchError["code"],
): Promise<UrlFetchError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(UrlFetchError);
    expect((e as UrlFetchError).code).toBe(code);
    return e as UrlFetchError;
  }
  throw new Error(`expected UrlFetchError(${code}) but the promise resolved`);
}

describe("looksLikeUrlSource", () => {
  test("matches http(s) URLs only", () => {
    expect(looksLikeUrlSource("https://example.com/x.tgz")).toBe(true);
    expect(looksLikeUrlSource("http://127.0.0.1:9999/x.tgz")).toBe(true);
    expect(looksLikeUrlSource("HTTPS://EXAMPLE.COM/X.TGZ")).toBe(true);
    expect(looksLikeUrlSource("@openparachute/notes-ui")).toBe(false);
    expect(looksLikeUrlSource("/tmp/some/dist")).toBe(false);
    expect(looksLikeUrlSource("ftp://example.com/x.tgz")).toBe(false);
  });
});

describe("scheme + transport rules", () => {
  test("rejects a non-URL string", async () => {
    await expectUrlError(
      fetchUrlTarball({ url: "https://", stagingParent, logger: silentLogger }),
      "bad_url",
    );
  });

  test("rejects plain http:// to a non-loopback host", async () => {
    await expectUrlError(
      fetchUrlTarball({ url: "http://example.com/x.tgz", stagingParent, logger: silentLogger }),
      "insecure_url",
    );
  });

  test("allows plain http:// to loopback", async () => {
    const tarball = await makeTarball({ "dist/index.html": "<html></html>" });
    const result = await fetchUrlTarball({
      url: "http://127.0.0.1:9999/x.tgz",
      stagingParent,
      fetchFn: fetchReturning(tarball, { contentType: "application/gzip" }),
      logger: silentLogger,
    });
    expect(fs.existsSync(path.join(result.distPath, "index.html"))).toBe(true);
    result.cleanup();
  });
});

describe("download validation", () => {
  test("HTTP error status → http_error with the status carried", async () => {
    const err = await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        fetchFn: fetchReturning("nope", { status: 404 }),
        logger: silentLogger,
      }),
      "http_error",
    );
    expect(err.httpStatus).toBe(404);
  });

  test("text/html content-type → bad_content_type (the download-page footgun)", async () => {
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        fetchFn: fetchReturning("<html>login page</html>", { contentType: "text/html" }),
        logger: silentLogger,
      }),
      "bad_content_type",
    );
  });

  test("declared content-length over the cap → too_large before any read", async () => {
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        maxBytes: 10,
        fetchFn: fetchReturning("x", {
          contentType: "application/gzip",
          contentLength: "99999",
        }),
        logger: silentLogger,
      }),
      "too_large",
    );
  });

  test("streamed body over the cap → too_large mid-stream", async () => {
    // No content-length header — the cap must trip while streaming.
    const big = new Uint8Array(64 * 1024).fill(65);
    const fetchFn = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(big);
            controller.enqueue(big);
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/octet-stream" } },
      );
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        maxBytes: 64 * 1024,
        fetchFn,
        logger: silentLogger,
      }),
      "too_large",
    );
  });

  test("network throw → network_error, staging cleaned up", async () => {
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        fetchFn: async () => {
          throw new Error("ECONNREFUSED");
        },
        logger: silentLogger,
      }),
      "network_error",
    );
    expect(fs.readdirSync(stagingParent)).toHaveLength(0);
  });
});

describe("extraction", () => {
  test("root-level dist/ extracts + meta.json found", async () => {
    const tarball = await makeTarball({
      "dist/index.html": "<html>hi</html>",
      "meta.json": JSON.stringify({ name: "demo" }),
    });
    const result = await fetchUrlTarball({
      url: "https://example.com/demo.tgz",
      stagingParent,
      fetchFn: fetchReturning(tarball, { contentType: "application/gzip" }),
      logger: silentLogger,
    });
    expect(fs.readFileSync(path.join(result.distPath, "index.html"), "utf8")).toBe(
      "<html>hi</html>",
    );
    expect(result.metaJsonPath).toBeDefined();
    expect(JSON.parse(fs.readFileSync(result.metaJsonPath!, "utf8")).name).toBe("demo");
    result.cleanup();
    expect(fs.existsSync(result.stagingDir)).toBe(false);
  });

  test("npm-pack style package/ nesting is located", async () => {
    const tarball = await makeTarball({
      "package/dist/index.html": "<html>nested</html>",
      "package/meta.json": JSON.stringify({ name: "nested" }),
      "package/server/index.js": "export default () => {};",
    });
    const result = await fetchUrlTarball({
      url: "https://example.com/pkg.tgz",
      stagingParent,
      fetchFn: fetchReturning(tarball, { contentType: "application/octet-stream" }),
      logger: silentLogger,
    });
    expect(fs.readFileSync(path.join(result.distPath, "index.html"), "utf8")).toBe(
      "<html>nested</html>",
    );
    expect(result.metaJsonPath).toBeDefined();
    // The server entry rides in the same package root (copyServerFiles reads it).
    expect(fs.existsSync(path.join(result.packageRoot, "server", "index.js"))).toBe(true);
    result.cleanup();
  });

  test("tarball without dist/index.html → no_dist, staging cleaned up", async () => {
    const tarball = await makeTarball({ "readme.md": "not a bundle" });
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        fetchFn: fetchReturning(tarball, { contentType: "application/gzip" }),
        logger: silentLogger,
      }),
      "no_dist",
    );
    expect(fs.readdirSync(stagingParent)).toHaveLength(0);
  });

  test("corrupt bytes → extract_failed", async () => {
    await expectUrlError(
      fetchUrlTarball({
        url: "https://example.com/x.tgz",
        stagingParent,
        fetchFn: fetchReturning(new Uint8Array([1, 2, 3, 4, 5]), {
          contentType: "application/gzip",
        }),
        logger: silentLogger,
      }),
      "extract_failed",
    );
    expect(fs.readdirSync(stagingParent)).toHaveLength(0);
  });
});
