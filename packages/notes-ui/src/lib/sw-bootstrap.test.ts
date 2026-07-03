import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_TIME_BASE,
  cleanupStaleServiceWorker,
  resolveBuildTimeBase,
  shouldRegisterServiceWorker,
} from "./sw-bootstrap";

// Guards the service-worker registration gate.
//
// The contract: notes-ui builds with a fixed mount baked into the PWA
// manifest + service-worker precache (default `/notes/`). When the same
// `dist/` is served at a different runtime mount (e.g. `/surface/notes/`
// under parachute-surface), we must NOT register the SW — its scope would
// straddle a precache table built for the wrong path, breaking every
// navigation. And we must also unregister any stale SW left behind by a
// pre-0.1.2 install that auto-registered before this gate existed.
//
// The vitest config sets vite's `base` to `/notes/`, so
// `import.meta.env.BASE_URL` resolves to `/notes/` and
// `BUILD_TIME_BASE` evaluates to `/notes`. Tests below assume that.

describe("BUILD_TIME_BASE", () => {
  it("trims the trailing slash from vite's BASE_URL", () => {
    expect(BUILD_TIME_BASE).toBe("/notes");
  });
});

describe("resolveBuildTimeBase — standalone-mount SW gate reconciliation (FIX 1)", () => {
  // The bug this guards against: the standalone deploy (notes.parachute.computer)
  // stamps `VITE_BASE_PATH="/"`. `detectMountBase()` returns "" (origin root)
  // for that build, but `buildTimeBase()` used to normalise "/" → "/notes", so
  // `shouldRegisterServiceWorker` (`runtime === build-time`) could NEVER pass —
  // the installed PWA got no offline shell on cold start. The fix reconciles
  // the build-time base to "" for the standalone build so the gate passes.

  // The mount `detectMountBase()` returns for the standalone (VITE_BASE_PATH=/)
  // build. Kept as a named constant so the reconciliation is explicit: the
  // build-time base must equal this for the gate to pass.
  const STANDALONE_RUNTIME_MOUNT = "";

  it("maps the standalone VITE_BASE_PATH=/ build to '' so it matches detectMountBase()", () => {
    // VITE_BASE_PATH wins even when Vite's BASE_URL disagrees.
    expect(resolveBuildTimeBase("/", "/notes/")).toBe(STANDALONE_RUNTIME_MOUNT);
    expect(resolveBuildTimeBase("/", "/")).toBe(STANDALONE_RUNTIME_MOUNT);
    expect(resolveBuildTimeBase("/", undefined)).toBe(STANDALONE_RUNTIME_MOUNT);
    // Gate now passes for standalone: runtime ("") === build-time ("").
  });

  it("still folds a bundled-host BASE_URL=/ (VITE_BASE_PATH unset) to the legacy /notes", () => {
    // A `base: ""` build surfaces BASE_URL as "/", but its runtime mount is
    // always `/notes` or `/surface/<slug>` (never ""), so the gate must
    // compare against `/notes` — NOT be misread as the standalone build.
    expect(resolveBuildTimeBase(undefined, "/")).toBe("/notes");
  });

  it("resolves the default daemon build (BASE_URL=/notes/) to /notes", () => {
    expect(resolveBuildTimeBase(undefined, "/notes/")).toBe("/notes");
  });

  it("resolves an explicit custom surface mount verbatim (trailing slash trimmed)", () => {
    expect(resolveBuildTimeBase("/surface/notes/", undefined)).toBe("/surface/notes");
    expect(resolveBuildTimeBase("/surface/my-notes", undefined)).toBe("/surface/my-notes");
  });

  it("falls back to /notes when neither signal is usable", () => {
    expect(resolveBuildTimeBase(undefined, undefined)).toBe("/notes");
    expect(resolveBuildTimeBase("", "")).toBe("/notes");
  });
});

describe("shouldRegisterServiceWorker", () => {
  it("returns true when the runtime mount matches the build-time base (default daemon mount)", () => {
    expect(shouldRegisterServiceWorker("/notes/")).toBe(true);
  });

  it("returns true for a deep route under the matching mount", () => {
    expect(shouldRegisterServiceWorker("/notes/n/abc123")).toBe(true);
  });

  it("returns false when the runtime mount is parachute-surface's /surface/notes/", () => {
    // The bug: bundle built for /notes/, served at /surface/notes/.
    expect(shouldRegisterServiceWorker("/surface/notes/")).toBe(false);
  });

  it("returns false for a custom-slug app mount", () => {
    expect(shouldRegisterServiceWorker("/surface/my-notes/")).toBe(false);
  });

  it("returns false for an OAuth callback under a mismatched mount (the exact scenario Aaron hit)", () => {
    expect(shouldRegisterServiceWorker("/surface/notes/oauth/callback")).toBe(false);
  });
});

describe("cleanupStaleServiceWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeRegistration(scope: string, unregister = vi.fn().mockResolvedValue(true)) {
    return { scope, unregister } as unknown as ServiceWorkerRegistration & {
      unregister: ReturnType<typeof vi.fn>;
    };
  }

  function fakeNavigator(registrations: ServiceWorkerRegistration[]): Navigator {
    return {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue(registrations),
      },
    } as unknown as Navigator;
  }

  it("unregisters a stale /notes/-scoped SW when running under /surface/notes/", async () => {
    const stale = fakeRegistration("https://hub.example.com/notes/");
    const nav = fakeNavigator([stale]);
    const count = await cleanupStaleServiceWorker(nav, "/surface/notes/");
    expect(count).toBe(1);
    expect(stale.unregister).toHaveBeenCalledTimes(1);
  });

  it("leaves the SW alone when its scope matches the runtime mount", async () => {
    const matching = fakeRegistration("https://hub.example.com/notes/");
    const nav = fakeNavigator([matching]);
    const count = await cleanupStaleServiceWorker(nav, "/notes/");
    expect(count).toBe(0);
    expect(matching.unregister).not.toHaveBeenCalled();
  });

  it("unregisters a stale /surface/old-notes/ SW when the runtime mount is /surface/notes/", async () => {
    // Operator renamed their app install — the previous slug's SW is now stale.
    const stale = fakeRegistration("https://hub.example.com/surface/old-notes/");
    const nav = fakeNavigator([stale]);
    const count = await cleanupStaleServiceWorker(nav, "/surface/notes/");
    expect(count).toBe(1);
    expect(stale.unregister).toHaveBeenCalledTimes(1);
  });

  it("does not touch SWs whose scope doesn't look like a parachute mount", async () => {
    // Defensive: don't clobber unrelated SWs on the same origin.
    const unrelated = fakeRegistration("https://hub.example.com/some-other-app/");
    const nav = fakeNavigator([unrelated]);
    const count = await cleanupStaleServiceWorker(nav, "/surface/notes/");
    expect(count).toBe(0);
    expect(unrelated.unregister).not.toHaveBeenCalled();
  });

  it("handles environments without navigator.serviceWorker gracefully", async () => {
    const nav = {} as unknown as Navigator;
    const count = await cleanupStaleServiceWorker(nav, "/notes/");
    expect(count).toBe(0);
  });

  it("handles undefined navigator (SSR-style) gracefully", async () => {
    const count = await cleanupStaleServiceWorker(undefined, "/notes/");
    expect(count).toBe(0);
  });

  it("continues past a single unregister failure and reports the count of successes", async () => {
    const failing = fakeRegistration(
      "https://hub.example.com/notes/",
      vi.fn().mockRejectedValue(new Error("boom")),
    );
    const succeeding = fakeRegistration("https://hub.example.com/surface/old-notes/");
    const nav = fakeNavigator([failing, succeeding]);
    const count = await cleanupStaleServiceWorker(nav, "/surface/notes/");
    // Only the second one succeeds; the first throws inside the loop's
    // try/catch and bumps no counter.
    expect(count).toBe(1);
    expect(succeeding.unregister).toHaveBeenCalledTimes(1);
  });

  it("unregisters multiple stale SWs in one pass", async () => {
    const a = fakeRegistration("https://hub.example.com/notes/");
    const b = fakeRegistration("https://hub.example.com/surface/other-notes/");
    const nav = fakeNavigator([a, b]);
    const count = await cleanupStaleServiceWorker(nav, "/surface/notes/");
    expect(count).toBe(2);
    expect(a.unregister).toHaveBeenCalledTimes(1);
    expect(b.unregister).toHaveBeenCalledTimes(1);
  });
});
