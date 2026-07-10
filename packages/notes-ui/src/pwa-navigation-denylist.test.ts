import { describe, expect, it } from "vitest";
import { navigationDenylist } from "./pwa-navigation-denylist";

// Mirror workbox's NavigationRoute matching: it tests each denylist RegExp
// against `url.pathname + url.search` and skips the SPA nav-fallback (lets the
// request reach the origin) iff SOME entry matches.
function isDenied(pathnameAndSearch: string): boolean {
  return navigationDenylist.some((re) => re.test(pathnameAndSearch));
}

describe("PWA navigation denylist", () => {
  // Every server-owned ceremony (identity worker route table,
  // parachute-cloud/workers/identity/src/index.ts) MUST be denied the SPA
  // shell — otherwise the installed SW paints the cached index.html over the
  // real server page once the app is served same-origin.
  const ceremonies = [
    "/api/vault/x",
    "/oauth/authorize?client_id=x&response_type=code",
    "/oauth/token",
    "/oauth/register",
    "/oauth/revoke",
    "/.well-known/oauth-authorization-server",
    "/.well-known/jwks.json",
    "/signup",
    "/login",
    "/login/2fa",
    "/logout",
    "/auth/magic",
    "/auth/verify?token=abc",
    "/console",
    "/console/security",
    "/console/vaults/export",
    "/admin",
    "/admin/users",
    "/account/token",
    "/billing",
    "/billing/checkout",
    "/unsubscribe?token=abc",
    "/health",
  ];
  it.each(ceremonies)("denies the server ceremony %s", (path) => {
    expect(isDenied(path)).toBe(true);
  });

  // The inverse guard — the regression that actually bites: NEVER deny a route
  // the SPA owns, or the installed app breaks. Mirrors App.tsx.
  const spaRoutes = [
    "/",
    "/all",
    "/all?view=pinned",
    "/tags",
    "/new",
    "/capture",
    "/import",
    "/connect",
    "/graph",
    "/today",
    "/calendar",
    "/activity",
    "/n/abc123",
    "/n/abc123/edit",
    "/add?add=https://u.parachute.computer/vault/x",
    "/vaults",
    "/settings",
    // The SPA's OWN OAuth redirect target — must boot the shell (even offline).
    "/oauth/callback?code=xyz&state=abc",
    // Canonical note ids live under /n/, so even ids that spell a ceremony word
    // never collide with a ceremony prefix.
    "/n/login",
    "/n/admin",
    "/n/billing",
  ];
  it.each(spaRoutes)("serves the SPA shell for %s", (path) => {
    expect(isDenied(path)).toBe(false);
  });

  // The one genuine collision, pinned explicitly: /oauth/callback stays
  // SPA-owned while its /oauth siblings are denied.
  it("keeps /oauth/callback SPA-owned while denying sibling /oauth ceremonies", () => {
    expect(isDenied("/oauth/callback")).toBe(false);
    expect(isDenied("/oauth/authorize")).toBe(true);
  });
});
