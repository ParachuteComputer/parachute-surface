/**
 * Tests for the GitHub-release shorthand resolver (`src/github-release.ts`):
 *
 *   - parseGithubSource — the three accepted shapes (`owner/repo` shorthand,
 *     repo-home URL, release-page URLs) + the `#asset` disambiguation, and
 *     PASSTHROUGH (null) for everything else: direct tarball URLs, direct
 *     `…/releases/download/…` asset URLs, npm specs, local paths, junk.
 *   - resolveGithubRelease — asset selection (one / zero / multiple /
 *     disambiguated), API error mapping (404, rate-limit 403/429, plain 403,
 *     network failure, malformed responses), and the final-URL sanity check.
 *
 * The GitHub API is MOCKED throughout (injected fetchFn — no live network).
 * NOTE: an end-to-end test against the real Unforced-Dev/WovenBoulder
 * release is not possible yet — that repo has no published release.
 */

import { describe, expect, test } from "bun:test";

import {
  type GithubReleaseRef,
  GithubResolveError,
  parseGithubSource,
  resolveGithubRelease,
} from "../github-release.ts";

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// parseGithubSource — input normalization
// ---------------------------------------------------------------------------

describe("parseGithubSource", () => {
  test("owner/repo shorthand", () => {
    expect(parseGithubSource("Unforced-Dev/WovenBoulder")).toEqual({
      owner: "Unforced-Dev",
      repo: "WovenBoulder",
    });
    expect(parseGithubSource("a/b")).toEqual({ owner: "a", repo: "b" });
    expect(parseGithubSource("owner/repo.name_x-1")).toEqual({
      owner: "owner",
      repo: "repo.name_x-1",
    });
  });

  test("shorthand with #asset disambiguation", () => {
    expect(parseGithubSource("owner/repo#my-surface-1.2.3.tgz")).toEqual({
      owner: "owner",
      repo: "repo",
      asset: "my-surface-1.2.3.tgz",
    });
  });

  test("repo-home URL (incl. trailing slash, www., http, .git suffix)", () => {
    const expected = { owner: "Unforced-Dev", repo: "WovenBoulder" };
    expect(parseGithubSource("https://github.com/Unforced-Dev/WovenBoulder")).toEqual(expected);
    expect(parseGithubSource("https://github.com/Unforced-Dev/WovenBoulder/")).toEqual(expected);
    expect(parseGithubSource("https://www.github.com/Unforced-Dev/WovenBoulder")).toEqual(expected);
    expect(parseGithubSource("http://github.com/Unforced-Dev/WovenBoulder")).toEqual(expected);
    expect(parseGithubSource("https://github.com/Unforced-Dev/WovenBoulder.git")).toEqual(expected);
  });

  test("release-page URLs → latest", () => {
    expect(parseGithubSource("https://github.com/o/r/releases")).toEqual({ owner: "o", repo: "r" });
    expect(parseGithubSource("https://github.com/o/r/releases/")).toEqual({
      owner: "o",
      repo: "r",
    });
    expect(parseGithubSource("https://github.com/o/r/releases/latest")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  test("release-tag URL names that release", () => {
    expect(parseGithubSource("https://github.com/o/r/releases/tag/v1.2.3")).toEqual({
      owner: "o",
      repo: "r",
      tag: "v1.2.3",
    });
    // Tags may contain slashes (`releases/v1`) — both raw and pre-encoded.
    expect(parseGithubSource("https://github.com/o/r/releases/tag/releases/v1")).toEqual({
      owner: "o",
      repo: "r",
      tag: "releases/v1",
    });
    expect(parseGithubSource("https://github.com/o/r/releases/tag/releases%2Fv1")).toEqual({
      owner: "o",
      repo: "r",
      tag: "releases/v1",
    });
  });

  test("#asset fragment on URL shapes", () => {
    expect(parseGithubSource("https://github.com/o/r#pick-me.tgz")).toEqual({
      owner: "o",
      repo: "r",
      asset: "pick-me.tgz",
    });
    expect(parseGithubSource("https://github.com/o/r/releases/tag/v2#pick-me.tgz")).toEqual({
      owner: "o",
      repo: "r",
      tag: "v2",
      asset: "pick-me.tgz",
    });
  });

  test("query strings are ignored on matching shapes", () => {
    expect(parseGithubSource("https://github.com/o/r?tab=readme-ov-file")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  test("passthrough (null): direct tarball + releases/download asset URLs", () => {
    // The existing direct-URL behavior must remain untouched.
    expect(parseGithubSource("https://example.com/releases/my-surface.tgz")).toBeNull();
    expect(
      parseGithubSource("https://github.com/o/r/releases/download/v1.0.0/surface-1.0.0.tgz"),
    ).toBeNull();
  });

  test("passthrough (null): non-release github.com URLs", () => {
    expect(parseGithubSource("https://github.com/o/r/blob/main/README.md")).toBeNull();
    expect(parseGithubSource("https://github.com/o/r/tree/main")).toBeNull();
    expect(parseGithubSource("https://github.com/o")).toBeNull();
    expect(parseGithubSource("https://github.com")).toBeNull();
    expect(parseGithubSource("https://gist.github.com/o/abc123")).toBeNull();
  });

  test("passthrough (null): npm specs, local paths, junk", () => {
    expect(parseGithubSource("@openparachute/notes-ui")).toBeNull(); // scoped npm
    expect(parseGithubSource("@openparachute/notes-ui@1.0.0")).toBeNull();
    expect(parseGithubSource("notes-ui")).toBeNull(); // bare npm name
    expect(parseGithubSource("/abs/path/to/bundle")).toBeNull(); // absolute path
    expect(parseGithubSource("./relative/path")).toBeNull();
    expect(parseGithubSource("a/b/c")).toBeNull(); // too many segments
    expect(parseGithubSource("not a source!")).toBeNull();
    expect(parseGithubSource("owner/repo extra")).toBeNull(); // space in repo
    expect(parseGithubSource("")).toBeNull();
    expect(parseGithubSource("owner/")).toBeNull();
    expect(parseGithubSource("/repo")).toBeNull();
    expect(parseGithubSource("owner/repo#")).toBeNull(); // empty asset
    expect(parseGithubSource("-owner/repo")).toBeNull(); // bad owner charset
    expect(parseGithubSource("ftp://github.com/o/r")).toBeNull(); // non-http scheme
  });

  test("API-path traversal guards: `.`/`..` repo segments rejected", () => {
    expect(parseGithubSource("owner/..")).toBeNull();
    expect(parseGithubSource("owner/.")).toBeNull();
    expect(parseGithubSource("https://github.com/owner/..")).toBeNull();
    // …but a legitimately dot-prefixed repo (e.g. `.github`) is fine.
    expect(parseGithubSource("owner/.github")).toEqual({ owner: "owner", repo: ".github" });
  });
});

// ---------------------------------------------------------------------------
// resolveGithubRelease — API interaction (mocked fetch, no live network)
// ---------------------------------------------------------------------------

type FetchLogEntry = { url: string; init?: RequestInit };

function mockApi(
  response: Response | (() => Response | Promise<Response>),
  log?: FetchLogEntry[],
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    log?.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
    return typeof response === "function" ? response() : response;
  };
}

function releaseJson(tagName: string, assets: Array<{ name: string; url?: string }>): Response {
  return Response.json({
    tag_name: tagName,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url:
        a.url ?? `https://github.com/o/r/releases/download/${tagName}/${a.name}`,
    })),
  });
}

const REF: GithubReleaseRef = { owner: "o", repo: "r" };

async function expectResolveError(
  promise: Promise<unknown>,
  code: GithubResolveError["code"],
): Promise<GithubResolveError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(GithubResolveError);
    const err = e as GithubResolveError;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected GithubResolveError(${code}), but the resolve succeeded`);
}

describe("resolveGithubRelease", () => {
  test("latest release with exactly one .tgz asset → its browser_download_url", async () => {
    const log: FetchLogEntry[] = [];
    const resolved = await resolveGithubRelease(REF, {
      fetchFn: mockApi(
        releaseJson("v1.2.3", [
          { name: "woven-boulder-surface-1.2.3.tgz" },
          { name: "checksums.txt" },
        ]),
        log,
      ),
      logger: silentLogger,
    });
    expect(resolved).toEqual({
      owner: "o",
      repo: "r",
      tag: "v1.2.3",
      asset_name: "woven-boulder-surface-1.2.3.tgz",
      download_url:
        "https://github.com/o/r/releases/download/v1.2.3/woven-boulder-surface-1.2.3.tgz",
    });
    // SSRF discipline: the ONLY fetched URL is the self-constructed API URL.
    expect(log).toHaveLength(1);
    expect(log[0]!.url).toBe("https://api.github.com/repos/o/r/releases/latest");
  });

  test("tag-named ref hits /releases/tags/<tag> (URL-encoded)", async () => {
    const log: FetchLogEntry[] = [];
    await resolveGithubRelease(
      { ...REF, tag: "releases/v1" },
      { fetchFn: mockApi(releaseJson("releases/v1", [{ name: "x.tgz" }]), log) },
    );
    expect(log[0]!.url).toBe("https://api.github.com/repos/o/r/releases/tags/releases%2Fv1");
  });

  test(".tar.gz assets count as tarballs", async () => {
    const resolved = await resolveGithubRelease(REF, {
      fetchFn: mockApi(releaseJson("v1", [{ name: "bundle.tar.gz" }])),
    });
    expect(resolved.asset_name).toBe("bundle.tar.gz");
  });

  test("zero tarball assets → no_tgz_asset listing what IS there", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(releaseJson("v1", [{ name: "binary.zip" }, { name: "notes.md" }])),
      }),
      "no_tgz_asset",
    );
    expect(err.message).toContain("no .tgz asset");
    expect(err.message).toContain("binary.zip");
  });

  test("multiple tarball assets → ambiguous_assets listing candidates + syntax", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(releaseJson("v1", [{ name: "a.tgz" }, { name: "b.tgz" }])),
      }),
      "ambiguous_assets",
    );
    expect(err.message).toContain("a.tgz");
    expect(err.message).toContain("b.tgz");
    expect(err.message).toContain("o/r#<asset-name>");
  });

  test("#asset disambiguation picks the exact name among several", async () => {
    const resolved = await resolveGithubRelease(
      { ...REF, asset: "b.tgz" },
      { fetchFn: mockApi(releaseJson("v1", [{ name: "a.tgz" }, { name: "b.tgz" }])) },
    );
    expect(resolved.asset_name).toBe("b.tgz");
  });

  test("#asset that doesn't exist → asset_not_found listing available assets", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(
        { ...REF, asset: "missing.tgz" },
        { fetchFn: mockApi(releaseJson("v1", [{ name: "a.tgz" }])) },
      ),
      "asset_not_found",
    );
    expect(err.message).toContain('"missing.tgz"');
    expect(err.message).toContain("a.tgz");
  });

  test("404 → not_found with the private-repo hint", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(new Response("{}", { status: 404 })),
      }),
      "not_found",
    );
    expect(err.message).toContain("private");
    expect(err.message).toContain("public");
  });

  test("404 on a tag-named ref mentions the tag", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(
        { ...REF, tag: "v9.9.9" },
        { fetchFn: mockApi(new Response("{}", { status: 404 })) },
      ),
      "not_found",
    );
    expect(err.message).toContain('"v9.9.9"');
  });

  test("403 with exhausted x-ratelimit-remaining → rate_limited, friendly message", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(
          new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
        ),
      }),
      "rate_limited",
    );
    expect(err.message).toContain("rate limit");
    expect(err.message).toContain("60/hour");
  });

  test("429 → rate_limited", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, { fetchFn: mockApi(new Response("{}", { status: 429 })) }),
      "rate_limited",
    );
  });

  test("non-rate-limit 403 → forbidden", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(
          new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "42" } }),
        ),
      }),
      "forbidden",
    );
  });

  test("5xx → api_error", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, { fetchFn: mockApi(new Response("oops", { status: 500 })) }),
      "api_error",
    );
  });

  test("network failure → api_error with reachability hint", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: async () => {
          throw new Error("getaddrinfo ENOTFOUND api.github.com");
        },
      }),
      "api_error",
    );
    expect(err.retryHint).toContain("api.github.com");
  });

  test("non-JSON body → bad_response", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(new Response("<html>login</html>", { status: 200 })),
      }),
      "bad_response",
    );
  });

  test("JSON without tag_name/assets → bad_response", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(Response.json({ message: "Moved Permanently" })),
      }),
      "bad_response",
    );
  });

  test("download URL outside GitHub → bad_response (refuses to hand it onward)", async () => {
    const err = await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(
          releaseJson("v1", [{ name: "evil.tgz", url: "https://evil.example.com/evil.tgz" }]),
        ),
      }),
      "bad_response",
    );
    expect(err.message).toContain("outside GitHub");
  });

  test("non-https download URL → bad_response", async () => {
    await expectResolveError(
      resolveGithubRelease(REF, {
        fetchFn: mockApi(
          releaseJson("v1", [{ name: "x.tgz", url: "http://github.com/o/r/x.tgz" }]),
        ),
      }),
      "bad_response",
    );
  });

  test("API request carries the GitHub media-type + User-Agent headers", async () => {
    const log: FetchLogEntry[] = [];
    await resolveGithubRelease(REF, {
      fetchFn: mockApi(releaseJson("v1", [{ name: "x.tgz" }]), log),
    });
    const headers = log[0]!.init?.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["user-agent"]).toBe("parachute-surface-host");
  });
});
