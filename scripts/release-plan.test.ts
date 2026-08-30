/**
 * The publish-on-merge decision.
 *
 * Release logic that can double-publish or silently drop a release is exactly
 * the kind that should not live untested in a YAML `run:` block. Every case
 * here is one where a wrong answer costs something real.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SURFACE_NPM_TAG_PREFIX,
  compareVersions,
  coreVersion,
  decidePublish,
  disallowedStablePromotionPaths,
  distTagFor,
  driftLogArgs,
  emitOutputs,
  latestMatchingRcTag,
  matchingRcVersions,
  rcTagListArgs,
  readRegistry,
  stablePromotionDiffArgs,
  tagPrefixFor,
  unpublishedDrift,
} from "./release-plan.ts";

describe("distTagFor", () => {
  test("prerelease → rc, release → latest", () => {
    expect(distTagFor("0.7.9-rc.2")).toBe("rc");
    expect(distTagFor("0.7.9")).toBe("latest");
  });
});

describe("compareVersions", () => {
  test("orders patch versions", () => {
    expect(compareVersions("0.7.5", "0.7.4")).toBeGreaterThan(0);
    expect(compareVersions("0.7.4", "0.7.5")).toBeLessThan(0);
    expect(compareVersions("0.7.5", "0.7.5")).toBe(0);
  });

  test("orders rc chains numerically, not lexically", () => {
    // The lexical trap: "rc.10" < "rc.9" as strings.
    expect(compareVersions("0.7.5-rc.10", "0.7.5-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.7.5-rc.5", "0.7.5-rc.6")).toBeLessThan(0);
  });

  test("a release sorts above its own prereleases", () => {
    expect(compareVersions("0.7.5", "0.7.5-rc.99")).toBeGreaterThan(0);
  });

  test("major/minor dominate the prerelease suffix", () => {
    expect(compareVersions("0.8.0-rc.1", "0.7.9")).toBeGreaterThan(0);
  });
});

describe("decidePublish", () => {
  test("a fresh version publishes", () => {
    const d = decidePublish("0.7.9-rc.2", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.1",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an already-published version is skipped — the idempotency guarantee", () => {
    // Re-runs, reverts, and merges that didn't bump must all be no-ops.
    const d = decidePublish("0.7.9-rc.1", { versionExists: true });
    expect(d).toMatchObject({ publish: false });
  });

  test("a never-published package SKIPS on a branch push — a first publish is deliberate", () => {
    // surface#220 verbatim: @openparachute/account-client@0.1.0 was on no
    // registry at all, this read "0.1.0 is not on npm" → should_publish=true,
    // and the OIDC publish 404'd. Trusted publishing cannot CREATE a package.
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/first publish is a deliberate act/);
    expect("reason" in d && d.reason).toMatch(/cannot create a package/);
  });

  test("an rc of a never-published package skips too — it's the package, not the channel", () => {
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("omitted publishedVersions with no dist-tag reads as never-published — skip, don't publish", () => {
    // The unplumbed-caller case fails toward a skip. Costing a release is
    // recoverable; attempting a publish npm structurally refuses is not.
    const d = decidePublish("0.1.0-rc.1", { versionExists: false });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("a never-published package on an rc TAG PUSH still tries — a human said release this", () => {
    // Kept deliberately: `isTagPush` short-circuits ahead of every registry
    // check, so the first publish stays possible through the explicit path,
    // and a failure there surfaces npm's own error rather than ours.
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/explicit tag push/);
  });

  test("a never-published STABLE on a tag push is still refused by the from-main gate", () => {
    // The stable gate sits above the tag-push short-circuit, so a first
    // publish via tag has to be an rc. Unchanged by surface#220.
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("an existing package is unaffected — one published version is enough", () => {
    // The carve-out is "never published", not "small". A package with a
    // single rc on npm keeps publishing on merge exactly as before.
    const d = decidePublish(
      "0.1.0-rc.2",
      {
        versionExists: false,
        currentDistTagVersion: "0.1.0-rc.1",
        publishedVersions: ["0.1.0-rc.1"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/is not on npm/);
  });

  test("an unreadable registry is still a REFUSAL, not a never-published skip", () => {
    // The two ways to see "nothing" must not collapse: 404 is knowledge and
    // skips, a 5xx is ignorance and fails the job loudly.
    const ambiguous = decidePublish("0.1.0-rc.1", { ambiguous: true }, { branch: "next" });
    expect(ambiguous).toMatchObject({ refuse: true });
    expect("refuse" in ambiguous && ambiguous.reason).toMatch(/refusing to guess/);
  });

  test("REFUSES to move a dist-tag backwards — the parallel-merge hazard", () => {
    // Several open PRs each pin their own rc.N and don't necessarily merge in
    // order. Publishing rc.5 after rc.6 would leave `@rc` pointing at the
    // older one, silently downgrading anyone who installs it.
    const d = decidePublish("0.7.5-rc.5", {
      versionExists: false,
      currentDistTagVersion: "0.7.5-rc.6",
    });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/OLDER than the current rc/);
    expect("refuse" in d && d.reason).toMatch(/merged out of version order/);
  });

  test("rc and latest are tracked independently", () => {
    // Publishing 0.8.0-rc.1 compares against the `rc` tag, not `latest`, so a
    // newer stable doesn't block the next prerelease line.
    const d = decidePublish("0.8.0-rc.1", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.5",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an ambiguous registry REFUSES rather than guessing", () => {
    // A false "not published" double-publishes; a false "published" drops a
    // release. Guessing is worse than failing loudly.
    const d = decidePublish("0.7.9", { ambiguous: true }, { branch: "main" });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/refusing to guess/);
  });

  test("an explicit rc tag push overrides the registry checks — a human said release this rc", () => {
    const d = decidePublish(
      "0.7.0-rc.1",
      {
        versionExists: false,
        currentDistTagVersion: "0.9.0",
      },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("an rc tag push even overrides ambiguity", () => {
    const d = decidePublish("0.7.9-rc.1", { ambiguous: true }, { isTagPush: true });
    expect(d).toMatchObject({ publish: true });
  });

  test("a stable without a matching rc is refused — 0.7.13 through 0.7.16 skipped this", () => {
    // Cutting @latest with new code and no rc of the same X.Y.Z is how
    // 0.7.13–0.7.16 shipped. Stable is a suffix-drop, never a skip.
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.12-rc.2"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/0\.7\.17-rc/);
    expect("refuse" in d && d.reason).toMatch(/suffix-drop|Cut an rc first/i);
  });

  test("a stable whose only published rcs are a different X.Y.Z is still refused", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.16-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("a stable with a matching rc publishes from main — suffix-drop is the only legal stable", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16", "0.7.17-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("omitted publishedVersions still refuses a stable when latest already exists", () => {
    // Callers that forget to plumb the version list must not silently skip
    // the gate — that's how 0.7.13–0.7.16 would keep shipping.
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("a tag push of a stable does NOT override the matching-rc check — stables publish from main only", () => {
    const d = decidePublish(
      "0.7.17",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.16",
        publishedVersions: ["0.7.16"],
      },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("next skips a stable even when a matching rc exists — tonight's hole", () => {
    // After 0.7.18-rc.9, next HEAD *is* that rc. A suffix-drop PR targeting
    // next would pass matching-rc + the version/changelog-only diff. This
    // gate is what stops it from publishing @latest.
    const d = decidePublish(
      "0.7.18",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.17",
        publishedVersions: ["0.7.17", "0.7.18-rc.9"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("next still publishes an rc", () => {
    const d = decidePublish(
      "0.7.18-rc.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.18-rc.8",
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("a stable with no branch is refused — fail closed, don't guess the trigger", () => {
    const d = decidePublish("0.7.18", {
      versionExists: false,
      publishedVersions: ["0.7.18-rc.9"],
    });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });
});

describe("matchingRcVersions", () => {
  test("matches only the same X.Y.Z rc chain", () => {
    expect(
      matchingRcVersions("0.7.17", ["0.7.16", "0.7.16-rc.1", "0.7.17-rc.1", "0.7.17-rc.2"]),
    ).toEqual(["0.7.17-rc.1", "0.7.17-rc.2"]);
  });

  test("a prerelease still matches siblings of its core", () => {
    expect(matchingRcVersions("0.7.17-rc.3", ["0.7.17-rc.1", "0.7.16-rc.1"])).toEqual([
      "0.7.17-rc.1",
    ]);
  });
});

describe("coreVersion", () => {
  test("strips the rc suffix and leaves a stable alone", () => {
    expect(coreVersion("0.7.17-rc.1")).toBe("0.7.17");
    expect(coreVersion("0.7.17")).toBe("0.7.17");
  });
});

describe("latestMatchingRcTag", () => {
  test("picks the highest N for hub's bare-v tags", () => {
    expect(
      latestMatchingRcTag(
        ["v0.7.16-rc.1", "v0.7.17-rc.1", "v0.7.17-rc.2", "v0.7.17"],
        "0.7.17",
        "v",
      ),
    ).toBe("v0.7.17-rc.2");
  });

  test("namespaces sub-package tags — a hub v tag is not door-contract's", () => {
    expect(
      latestMatchingRcTag(
        ["v0.7.0-rc.9", "door-contract-v0.7.0-rc.1", "door-contract-v0.7.0-rc.2"],
        "0.7.0",
        "door-contract-v",
      ),
    ).toBe("door-contract-v0.7.0-rc.2");
  });

  test("undefined when the chain has no rc tag", () => {
    expect(latestMatchingRcTag(["v0.7.16"], "0.7.17", "v")).toBeUndefined();
  });
});

describe("disallowedStablePromotionPaths", () => {
  test("version/changelog/lockfile-only is a suffix-drop", () => {
    expect(disallowedStablePromotionPaths(["package.json", "CHANGELOG.md", "bun.lock"])).toEqual(
      [],
    );
  });

  test("a source file is new code — the 0.7.13–0.7.16 skip-rc shape", () => {
    expect(disallowedStablePromotionPaths(["package.json", "src/users.ts"])).toEqual([
      "src/users.ts",
    ]);
  });

  test("surface-client version.ts is part of a suffix-drop, not new code", () => {
    expect(
      disallowedStablePromotionPaths([
        "packages/surface-client/package.json",
        "packages/surface-client/CHANGELOG.md",
        "packages/surface-client/src/version.ts",
        "bun.lock",
      ]),
    ).toEqual([]);
  });
});

describe("rcTagListArgs / stablePromotionDiffArgs", () => {
  test("surface-host lists bare-v rc tags, not surface-host-v", () => {
    expect(rcTagListArgs("packages/surface-host", "0.3.9")).toEqual([
      "git",
      "tag",
      "-l",
      "v0.3.9-rc.*",
    ]);
  });

  test("surface-client lists client-v, not surface-client-v", () => {
    expect(rcTagListArgs("packages/surface-client", "0.3.6")[3]).toBe("client-v0.3.6-rc.*");
  });

  test("the suffix-drop diff is name-only from the rc tag to HEAD", () => {
    expect(stablePromotionDiffArgs("v0.3.9-rc.1")).toEqual([
      "git",
      "diff",
      "--name-only",
      "v0.3.9-rc.1..HEAD",
    ]);
  });
});

describe("readRegistry", () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  test("reads existence + the relevant dist-tag", async () => {
    const v = await readRegistry("@openparachute/hub", "0.7.9-rc.2", (() =>
      json({
        versions: { "0.7.9-rc.1": {}, "0.7.9-rc.2": {} },
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    expect(v).toMatchObject({
      versionExists: true,
      currentDistTagVersion: "0.7.9-rc.2",
      publishedVersions: ["0.7.9-rc.1", "0.7.9-rc.2"],
    });
  });

  test("picks the dist-tag matching the version's channel", async () => {
    const v = await readRegistry("@openparachute/hub", "0.7.9", (() =>
      json({
        versions: {},
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    // A stable version compares against `latest`, not `rc`.
    expect(v).toMatchObject({ currentDistTagVersion: "0.7.8" });
  });

  test("a never-published package is not ambiguous — a 404 is knowledge", async () => {
    const v = await readRegistry("@openparachute/new", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    // publishedVersions must be present and EMPTY: that pair is what
    // decidePublish reads as "never published" (surface#220). Dropping it
    // would make a 404 indistinguishable from an unplumbed caller.
    expect(v).toMatchObject({ versionExists: false, publishedVersions: [] });
    expect(v).not.toHaveProperty("ambiguous");
  });

  test("the 404 view composes into a skip — the two halves of surface#220 line up", async () => {
    const v = await readRegistry("@openparachute/account-client", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect(decidePublish("0.1.0", v, { branch: "main" })).toMatchObject({ publish: false });
  });

  test("a 5xx is ambiguous", async () => {
    const v = await readRegistry("@openparachute/hub", "1.0.0", (() =>
      json({}, 503)) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });

  test("a network throw is ambiguous, not a crash", async () => {
    const v = await readRegistry("@openparachute/hub", "1.0.0", (() =>
      Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });
});

describe("unpublishedDrift", () => {
  test("no commits → not drifted", () => {
    expect(unpublishedDrift([]).drifted).toBe(false);
    expect(unpublishedDrift(["", "  "]).drifted).toBe(false);
  });

  test("commits → drifted, counted, and LISTED", () => {
    // The list is the point: "you have unpublished work" without naming what
    // leaves someone diffing tags by hand to find out.
    const d = unpublishedDrift(["abc feat: one", "def fix: two"]);
    expect(d.drifted).toBe(true);
    expect(d.count).toBe(2);
    expect(d.summary).toContain("feat: one");
    expect(d.summary).toContain("fix: two");
    expect(d.summary).toMatch(/release PR/i);
  });

  test("blank lines from git's trailing newline don't inflate the count", () => {
    expect(unpublishedDrift(["abc one", ""]).count).toBe(1);
  });
});

/**
 * hub#830: the drift advisory has to be able to RUN.
 *
 * Two independent defects made it dead code in CI:
 *
 *   1. The `plan` job used a bare `actions/checkout@v6`, which fetches
 *      `--depth=1 --no-tags`. `git log v0.7.14..HEAD` in that clone exits 128
 *      ("unknown revision"), the `proc.exitCode === 0` guard skips, and the
 *      advisory reports nothing — indistinguishable from "everything is
 *      shipped", which is the exact confusion it was built to end.
 *   2. The revision range hardcoded a `v` prefix. Sub-package tags are
 *      namespaced (`door-contract-v0.7.0`), so door-contract@0.7.0 would have
 *      been compared against HUB's `v0.7.0` tag — a real tag, pointing at
 *      unrelated history, so the advisory would have listed nine months of hub
 *      commits as "door-contract's unpublished work". Masked only by defect 1.
 *
 * The prefixes here are not invented: they're the ones `tag-record` pushes at
 * the bottom of release.yml, and the ones the `on: push: tags:` filters match.
 */
describe("tagPrefixFor", () => {
  test("surface-host is the bare-v package — NOT surface-host-v (hub#830 class)", () => {
    expect(tagPrefixFor("packages/surface-host")).toBe("v");
    expect(tagPrefixFor("packages/surface-host/")).toBe("v");
    expect(tagPrefixFor("packages/surface-host")).not.toBe("surface-host-v");
  });

  test("the other five npm packages use their alias prefixes, not directory basenames", () => {
    expect(tagPrefixFor("packages/surface-client")).toBe("client-v");
    expect(tagPrefixFor("packages/account-client")).toBe("account-v");
    expect(tagPrefixFor("packages/surface-render")).toBe("render-v");
    expect(tagPrefixFor("packages/doc-schema")).toBe("doc-schema-v");
    expect(tagPrefixFor("packages/surface-server")).toBe("server-v");
    expect(tagPrefixFor("packages/surface-client")).not.toBe("surface-client-v");
    expect(tagPrefixFor("packages/surface-server")).not.toBe("surface-server-v");
  });

  test("unknown dirs throw rather than infer a basename — inference is how hub#830 happened", () => {
    expect(() => tagPrefixFor(".")).toThrow(/not a publishable surface npm package/);
    expect(() => tagPrefixFor("packages/docs-editor")).toThrow(/docs-editor/);
    expect(() => tagPrefixFor("packages/scope-guard")).toThrow(/not a publishable/);
  });

  test("the prefixes match what release.yml's tag-record actually pushes", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../.github/workflows/release.yml"),
      "utf8",
    );
    for (const [dir, prefix] of Object.entries(SURFACE_NPM_TAG_PREFIX)) {
      expect(tagPrefixFor(dir)).toBe(prefix);
      expect(workflow).toMatch(new RegExp(`tag_if\\s+"${prefix}"\\s+"${dir}"`));
    }
  });
});

describe("driftLogArgs", () => {
  test("surface-host compares against bare-v, not surface-host-v", () => {
    expect(driftLogArgs("packages/surface-host", "0.3.9")).toEqual([
      "git",
      "log",
      "v0.3.9..HEAD",
      "--oneline",
      "--no-merges",
      "--",
      "packages/surface-host",
    ]);
  });

  test("surface-client compares against client-v, NOT surface-host's v tag", () => {
    const args = driftLogArgs("packages/surface-client", "0.3.6");
    expect(args).toContain("client-v0.3.6..HEAD");
    // The bug: `v0.3.6` might exist as a host tag, so the wrong range would
    // resolve and list host history as client drift (hub#830).
    expect(args).not.toContain("v0.3.6..HEAD");
    expect(args).not.toContain("surface-client-v0.3.6..HEAD");
  });

  test("the listing is scoped to the package — a host commit isn't client drift", () => {
    expect(driftLogArgs("packages/surface-client", "0.3.6").slice(-2)).toEqual([
      "--",
      "packages/surface-client",
    ]);
  });
});

describe("release.yml drift advisory can execute (hub#830)", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
  // Scope every assertion to the `plan` job — publish jobs' shallow
  // checkouts are fine; `plan` reads git history.
  const planJob = workflow.match(/\n {2}plan:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/)?.[1];

  test("the plan job is findable (guards the slicing above)", () => {
    expect(planJob).toBeTruthy();
    expect(planJob).toContain(
      "bun scripts/release-plan.ts packages/surface-host @openparachute/surface",
    );
  });

  test("the plan job's checkout fetches full history — depth=1 has no merge base", () => {
    expect(planJob).toMatch(/actions\/checkout@v6\n\s*with:\n(?:\s*.+\n)*?\s*fetch-depth:\s*0/);
  });

  test("the plan job's checkout fetches tags — the advisory's range is a TAG", () => {
    expect(planJob).toMatch(/fetch-tags:\s*true/);
  });
});

describe("release.yml tag-record can see existing tags", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
  const tagRecord = workflow.match(/\n {2}tag-record:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/)?.[1];

  test("the tag-record job is findable", () => {
    expect(tagRecord).toBeTruthy();
    expect(tagRecord).toContain("tag published packages");
  });

  test("tag-record's checkout fetches tags — the dedupe is git rev-parse $T", () => {
    // Bare checkout is --depth=1 --no-tags. A tag already on origin is then
    // invisible, so the job git-tags locally and git-push rejects; continue-
    // on-error swallows it. Same fetch as plan.
    expect(tagRecord).toMatch(/actions\/checkout@v6\n\s*with:\n(?:\s*.+\n)*?\s*fetch-depth:\s*0/);
    expect(tagRecord).toMatch(/fetch-tags:\s*true/);
  });

  test("tag-record still does not --force the tag push", () => {
    expect(tagRecord).not.toMatch(/git push --force/);
    expect(tagRecord).toContain('git tag "$T" && git push origin "$T"');
  });
});

/**
 * The rc tag-push override (hub#841).
 *
 * `decidePublish`'s `isTagPush` short-circuit (rc versions only) is
 * unit-tested above, but unreachable unless the workflow actually passes
 * `--tag-push` on a tag push.
 */
describe("release.yml tag-push override (hub#841)", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");

  test("every plan step passes --tag-push on a tag push, nothing on a merge", () => {
    const flag = "${{ github.ref_type == 'tag' && '--tag-push' || '' }}";
    for (const cmd of [
      "bun scripts/release-plan.ts packages/surface-host @openparachute/surface",
      "bun scripts/release-plan.ts packages/surface-client @openparachute/surface-client",
      "bun scripts/release-plan.ts packages/account-client @openparachute/account-client",
      "bun scripts/release-plan.ts packages/surface-render @openparachute/surface-render",
      "bun scripts/release-plan.ts packages/doc-schema @openparachute/doc-schema",
      "bun scripts/release-plan.ts packages/surface-server @openparachute/surface-server",
    ]) {
      expect(workflow).toContain(`${cmd} ${flag}`);
    }
  });

  test("publish jobs consult plan even on a tag push — a tag is not a bypass of the stable-from-main gate", () => {
    expect(workflow).toContain(
      "needs.plan.outputs.surface == 'true' && (github.ref_type != 'tag' || (!startsWith(github.ref_name, 'client-') && !startsWith(github.ref_name, 'account-') && !startsWith(github.ref_name, 'render-') && !startsWith(github.ref_name, 'doc-schema-') && !startsWith(github.ref_name, 'server-') && !startsWith(github.ref_name, 'docs-editor-') && !startsWith(github.ref_name, 'meeting-ingest-') && !startsWith(github.ref_name, 'meeting-mcp-')))",
    );
    expect(workflow).toContain(
      "needs.plan.outputs.surface_client == 'true' && (github.ref_type != 'tag' || startsWith(github.ref_name, 'client-'))",
    );
  });

  test("tarball jobs stay tag-only — they are not npm and have no @rc", () => {
    expect(workflow).toContain("if: ${{ startsWith(github.ref_name, 'docs-editor-') }}");
    expect(workflow).toContain("if: ${{ startsWith(github.ref_name, 'meeting-ingest-') }}");
    expect(workflow).toContain("if: ${{ startsWith(github.ref_name, 'meeting-mcp-') }}");
  });

  test("npm dist-tag is derived from package.json version, not github.ref_name (hub#792)", () => {
    // Merge-triggered runs have ref_name `next`/`main`. Reading that for
    // dist-tag published every rc to @latest (hub 0.7.9-rc.3).
    // Tarball jobs still read the tag — they only run on tags.
    expect(workflow.match(/case "\$PKG_VERSION" in/g)?.length).toBe(6);
    expect(workflow.match(/if \[\[ "\$GITHUB_REF_NAME" =~ -rc\\\. \]\]/g)?.length).toBe(3);
  });
});

/**
 * The step outputs are the wire between `plan` and every publish job. Losing
 * one is silent — the consuming expression just interpolates to an empty
 * string.
 */
describe("emitOutputs", () => {
  test("APPENDS every output — `Bun.write` truncated, keeping only the last", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-release-plan-"));
    try {
      const out = join(dir, "github_output");
      writeFileSync(out, "");
      emitOutputs(
        out,
        [
          ["version", "0.7.15"],
          ["dist_tag", "latest"],
          ["should_publish", "true"],
        ],
        () => {},
      );
      expect(readFileSync(out, "utf8")).toBe(
        "version=0.7.15\ndist_tag=latest\nshould_publish=true\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps whatever an earlier step already wrote to the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-release-plan-"));
    try {
      const out = join(dir, "github_output");
      writeFileSync(out, "earlier=kept\n");
      emitOutputs(out, [["version", "0.7.15"]], () => {});
      expect(readFileSync(out, "utf8")).toBe("earlier=kept\nversion=0.7.15\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs every output even with no output file (local runs)", () => {
    const lines: string[] = [];
    emitOutputs(
      undefined,
      [
        ["version", "0.7.15"],
        ["dist_tag", "latest"],
      ],
      (l) => lines.push(l),
    );
    expect(lines).toEqual(["version=0.7.15", "dist_tag=latest"]);
  });
});
