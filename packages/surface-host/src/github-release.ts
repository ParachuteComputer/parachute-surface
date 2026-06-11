/**
 * GitHub-release shorthand for `POST /surface/add` + `POST /surface/inspect`
 * — a RESOLVER in front of the existing URL-tarball source, never a fork of
 * the install logic.
 *
 * Surfaces are distributed as GitHub Release assets (a `.tgz` attached by a
 * release workflow). Instead of hunting down the asset's download URL, the
 * operator pastes any of:
 *
 *   owner/repo                                     → latest release
 *   owner/repo#asset-name.tgz                      → latest release, exact asset
 *   https://github.com/owner/repo                  → latest release
 *   https://github.com/owner/repo/releases         → latest release
 *   https://github.com/owner/repo/releases/latest  → latest release
 *   https://github.com/owner/repo/releases/tag/v1  → THAT release
 *
 * The `#asset-name.tgz` fragment (valid on the shorthand and on any of the
 * URL shapes) disambiguates when a release carries several tarballs — it must
 * match an asset's file name EXACTLY.
 *
 * Resolution is one anonymous `GET api.github.com/repos/{owner}/{repo}/
 * releases/{latest|tags/<tag>}` (60 req/hour unauthenticated — plenty for an
 * operator action; a rate-limit 403 maps to a friendly error). The chosen
 * asset's `browser_download_url` is then handed to the EXISTING URL-tarball
 * fetcher, which applies its own transport policy (https-only, streaming
 * size cap, content-type sanity) and follows the GitHub→CDN redirect.
 *
 * SSRF discipline:
 *   - The resolver only ever fetches an api.github.com URL it constructs
 *     ITSELF from regex-validated `owner`/`repo` parts + a URL-encoded tag.
 *   - The final download URL must be the asset's `browser_download_url`
 *     from the API response, and is sanity-checked to be https on a
 *     github.com / *.githubusercontent.com host before use.
 *
 * What does NOT route through here (existing behavior, untouched):
 *   - Direct asset URLs (`…/releases/download/<tag>/<file>`) — already a
 *     plain tarball URL today; they keep hitting the URL fetcher directly.
 *   - Any github.com URL that isn't a repo home or a release page (blob/
 *     tree/raw/…) — passes through as a plain URL source.
 *   - Everything that isn't a github.com shape at all.
 */

import type { FetchFn } from "./dcr.ts";

/** GitHub login: alphanumeric + inner hyphens (no leading/trailing hyphen). */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** GitHub repo name: alphanumeric, `.`, `_`, `-`. (`.`/`..` rejected below.) */
const REPO_RE = /^[A-Za-z0-9._-]+$/;

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** A parsed (not yet resolved) reference to a GitHub release. */
export type GithubReleaseRef = {
  owner: string;
  repo: string;
  /** Release tag named by the source; undefined → the latest release. */
  tag?: string;
  /** Exact asset file name (the `#asset-name.tgz` disambiguation). */
  asset?: string;
};

/** A resolved release asset — wire-shaped for inspect/add responses. */
export type ResolvedGithubRelease = {
  owner: string;
  repo: string;
  /** The release's tag name (resolved even when the source said "latest"). */
  tag: string;
  /** The chosen asset's file name. */
  asset_name: string;
  /** The asset's `browser_download_url`, straight from the API response. */
  download_url: string;
};

export class GithubResolveError extends Error {
  override name = "GithubResolveError" as const;
  readonly code:
    | "not_found"
    | "rate_limited"
    | "forbidden"
    | "api_error"
    | "bad_response"
    | "no_tgz_asset"
    | "ambiguous_assets"
    | "asset_not_found";
  readonly httpStatus?: number;
  readonly retryHint?: string;
  constructor(
    message: string,
    code: GithubResolveError["code"],
    extra: { httpStatus?: number; retryHint?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = extra.httpStatus;
    this.retryHint = extra.retryHint;
  }
}

/** Validated owner/repo pair, or null. Strips a trailing `.git` (GitHub
 *  forbids repo names ending in `.git`, so the strip can't collide). */
function validateOwnerRepo(owner: string, repoRaw: string): { owner: string; repo: string } | null {
  const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!OWNER_RE.test(owner)) return null;
  if (!REPO_RE.test(repo)) return null;
  // MANDATORY, not redundant: REPO_RE's charset deliberately admits dots, so
  // "." / ".." pass the regex — this is the only thing keeping them out of
  // the constructed API path. Do not remove in a cleanup.
  if (repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * Parse a source string into a GitHub release reference, or `null` when the
 * source isn't a github.com repo/release shape (the caller falls through to
 * the existing path/npm/url branches — passthrough is the contract).
 */
export function parseGithubSource(source: string): GithubReleaseRef | null {
  const s = source.trim();
  if (s.length === 0) return null;

  // URL shapes — anything with a scheme goes through the URL parser.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return parseGithubUrl(s);

  // Bare shorthand: `owner/repo` with an optional `#asset` suffix. Exactly
  // one slash; charset-validated so local relative paths, npm scoped specs
  // (`@scope/name`) and junk never match.
  const hashIdx = s.indexOf("#");
  const base = hashIdx === -1 ? s : s.slice(0, hashIdx);
  const asset = hashIdx === -1 ? undefined : s.slice(hashIdx + 1);
  if (asset !== undefined && asset.length === 0) return null;
  const parts = base.split("/");
  if (parts.length !== 2) return null;
  const validated = validateOwnerRepo(parts[0]!, parts[1]!);
  if (!validated) return null;
  return { ...validated, ...(asset !== undefined ? { asset } : {}) };
}

/** URL-shape half of {@link parseGithubSource}. */
function parseGithubUrl(s: string): GithubReleaseRef | null {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  // http:// github.com links are accepted for PARSING only — the resolver
  // talks to https://api.github.com regardless, and the asset download URL
  // comes back https. (We never fetch the pasted URL itself.)
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter((p) => p.length > 0);
  if (segments.length < 2) return null;
  const validated = validateOwnerRepo(
    decodeURIComponent(segments[0]!),
    decodeURIComponent(segments[1]!),
  );
  if (!validated) return null;

  // `#asset-name.tgz` disambiguation rides the URL fragment (fragments are
  // never sent over the wire, so this can't collide with a real page).
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const asset = fragment.length > 0 ? decodeURIComponent(fragment) : undefined;
  const withAsset = (ref: GithubReleaseRef): GithubReleaseRef => ({
    ...ref,
    ...(asset !== undefined ? { asset } : {}),
  });

  // Repo home → latest release.
  if (segments.length === 2) return withAsset(validated);

  // Release pages. NOTE: `/releases/download/<tag>/<file>` is deliberately
  // NOT matched — that's already a direct tarball URL; it passes through to
  // the URL fetcher exactly as today.
  if (segments[2] !== "releases") return null;
  if (segments.length === 3) return withAsset(validated); // /releases
  if (segments.length === 4 && segments[3] === "latest") return withAsset(validated);
  if (segments.length >= 5 && segments[3] === "tag") {
    const tag = segments
      .slice(4)
      .map((p) => decodeURIComponent(p))
      .join("/");
    return withAsset({ ...validated, tag });
  }
  return null;
}

/** Asset file names the auto-selection considers (gzipped tarballs). */
function isTarballAsset(name: string): boolean {
  return name.endsWith(".tgz") || name.endsWith(".tar.gz");
}

export type GithubResolveOpts = {
  /** Injected fetch (tests). Defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

type ReleaseAsset = { name: string; browser_download_url: string };

/**
 * Resolve a parsed reference against the GitHub API → the release asset to
 * install. One anonymous API request; throws `GithubResolveError` with an
 * operator-actionable message on every failure shape.
 */
export async function resolveGithubRelease(
  ref: GithubReleaseRef,
  opts: GithubResolveOpts = {},
): Promise<ResolvedGithubRelease> {
  const fetchFn = opts.fetchFn ?? fetch;
  const repoLabel = `${ref.owner}/${ref.repo}`;
  // Constructed EXCLUSIVELY from regex-validated owner/repo + an encoded tag
  // (encodeURIComponent leaves no path-traversal characters unescaped).
  const apiUrl =
    ref.tag !== undefined
      ? `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/releases/tags/${encodeURIComponent(ref.tag)}`
      : `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/releases/latest`;

  let res: Response;
  try {
    res = await fetchFn(apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "parachute-surface-host",
      },
    });
  } catch (e) {
    throw new GithubResolveError(
      `couldn't reach the GitHub API: ${(e as Error).message}`,
      "api_error",
      { retryHint: "check that this host can reach api.github.com and retry" },
    );
  }

  if (res.status === 404) {
    throw new GithubResolveError(
      ref.tag !== undefined
        ? `no release tagged "${ref.tag}" found for ${repoLabel} — check the tag, and note the repo + release assets must be public`
        : `no latest release found for ${repoLabel} — the repo may be private (release assets must be public), may not exist, or has no published releases yet`,
      "not_found",
      { httpStatus: 404 },
    );
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || remaining === "0") {
      throw new GithubResolveError(
        "the GitHub API rate limit was reached (anonymous requests: 60/hour per address) — wait for the window to reset, or paste the asset's direct download URL instead",
        "rate_limited",
        { httpStatus: res.status },
      );
    }
    throw new GithubResolveError(
      `the GitHub API refused the request (HTTP ${res.status}) for ${repoLabel} — if you have the release asset's direct URL, paste that instead`,
      "forbidden",
      { httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new GithubResolveError(
      `the GitHub API returned HTTP ${res.status} for ${repoLabel}`,
      "api_error",
      { httpStatus: res.status },
    );
  }

  let release: { tag_name?: unknown; assets?: unknown };
  try {
    release = (await res.json()) as typeof release;
  } catch {
    throw new GithubResolveError("the GitHub API response wasn't valid JSON", "bad_response");
  }
  const tagName = typeof release.tag_name === "string" ? release.tag_name : undefined;
  const rawAssets = Array.isArray(release.assets) ? release.assets : undefined;
  if (tagName === undefined || rawAssets === undefined) {
    throw new GithubResolveError(
      "the GitHub API response is missing tag_name/assets — not a release object",
      "bad_response",
    );
  }
  const assets: ReleaseAsset[] = rawAssets.filter(
    (a: unknown): a is ReleaseAsset =>
      !!a &&
      typeof a === "object" &&
      typeof (a as ReleaseAsset).name === "string" &&
      typeof (a as ReleaseAsset).browser_download_url === "string",
  );
  const releaseLabel = `release ${tagName} of ${repoLabel}`;

  // --- Asset selection. ------------------------------------------------------
  let chosen: ReleaseAsset;
  if (ref.asset !== undefined) {
    // Exact-name disambiguation — matched against ALL assets, not just
    // tarball-named ones (the operator said exactly what they want).
    const match = assets.find((a) => a.name === ref.asset);
    if (!match) {
      const available =
        assets.length > 0
          ? `available assets: ${assets.map((a) => a.name).join(", ")}`
          : "the release has no assets";
      throw new GithubResolveError(
        `${releaseLabel} has no asset named "${ref.asset}" — ${available}`,
        "asset_not_found",
      );
    }
    chosen = match;
  } else {
    const tarballs = assets.filter((a) => isTarballAsset(a.name));
    if (tarballs.length === 0) {
      const others =
        assets.length > 0 ? ` (assets present: ${assets.map((a) => a.name).join(", ")})` : "";
      throw new GithubResolveError(
        `${releaseLabel} has no .tgz asset${others} — surfaces are distributed as .tgz release assets`,
        "no_tgz_asset",
        {
          retryHint:
            "attach an npm-pack-style .tgz to the release, or point at a release that ships one",
        },
      );
    }
    if (tarballs.length > 1) {
      throw new GithubResolveError(
        `${releaseLabel} has ${tarballs.length} tarball assets: ${tarballs
          .map((a) => a.name)
          .join(", ")} — pick one with \`${repoLabel}#<asset-name>\``,
        "ambiguous_assets",
      );
    }
    chosen = tarballs[0]!;
  }

  // --- Final-URL sanity (SSRF discipline): the download URL is taken from the
  // API response verbatim, but must be an https github.com / GitHub-CDN URL —
  // the URL fetcher then applies its own transport policy on top.
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(chosen.browser_download_url);
  } catch {
    throw new GithubResolveError(
      `the API returned an unparseable download URL for asset "${chosen.name}"`,
      "bad_response",
    );
  }
  const dlHost = downloadUrl.hostname.toLowerCase();
  const hostOk =
    dlHost === "github.com" ||
    dlHost.endsWith(".github.com") ||
    dlHost.endsWith(".githubusercontent.com");
  if (downloadUrl.protocol !== "https:" || !hostOk) {
    throw new GithubResolveError(
      `the API returned a download URL outside GitHub (${downloadUrl.origin}) for asset "${chosen.name}" — refusing to fetch it`,
      "bad_response",
    );
  }

  opts.logger?.log(
    `[github-release] ${repoLabel} → ${tagName} / ${chosen.name} (${chosen.browser_download_url})`,
  );
  return {
    owner: ref.owner,
    repo: ref.repo,
    tag: tagName,
    asset_name: chosen.name,
    download_url: chosen.browser_download_url,
  };
}
