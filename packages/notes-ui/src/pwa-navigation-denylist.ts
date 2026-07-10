// The service worker's navigation fallback (workbox `navigateFallback`) serves
// the cached SPA shell (`index.html`) for any in-scope navigation that isn't a
// precached asset. That behaviour is exactly WRONG for the auth/account
// *ceremonies* — server-rendered pages the identity worker owns. Today the
// ceremonies live on a different origin (`cloud.parachute.computer`) so the SW
// never sees them; once the SPA is served same-origin with them (the Parachute
// App campaign — `app.parachute.computer`, parachute-cloud#116) an un-denied
// ceremony navigation would be swallowed by the installed SW and painted as the
// SPA shell instead of the real server page. Each entry below forces its
// navigation past the SW to the origin.
//
// The prefix set mirrors the identity worker's route table
// (`parachute-cloud/workers/identity/src/index.ts`). Every entry is a real
// server-owned prefix; none collides with a route the SPA owns — the one hazard,
// `/oauth/callback`, is the SPA's PKCE redirect target and is deliberately
// EXCLUDED (negative lookahead). `pwa-navigation-denylist.test.ts` asserts both
// directions: ceremonies are denied, SPA routes are not.
//
// Harmless on `notes.parachute.computer` today (these prefixes 404 there
// anyway); load-bearing at one origin.
export const navigationDenylist: readonly RegExp[] = [
  // Vault REST + the legacy notes-daemon API proxy — never the SPA shell.
  /^\/api\//,

  // OAuth ceremony endpoints (authorize / token / register / revoke) belong to
  // the identity worker. EXCEPTION: `/oauth/callback` is the SPA's OWN route
  // (`App.tsx`) — the PKCE redirect target that must boot the SPA (even offline
  // / cache-first). The negative lookahead denies the worker's `/oauth/*` while
  // letting the callback fall through to the cached shell.
  /^\/oauth\/(?!callback)/,

  // OAuth/OIDC discovery + JWKS — served by the worker.
  /^\/\.well-known\//,

  // Session-cookie account ceremonies (server-rendered pages).
  /^\/signup/, // signup GET/POST
  /^\/login/, // login GET/POST + /login/2fa second factor
  /^\/logout/, // logout POST
  /^\/auth\//, // magic-link request + verify
  /^\/console/, // account console + /console/* (security, vaults, checklist, promo…)
  /^\/admin/, // operator admin console + /admin/*
  // Phase-2 account contract (parachute-cloud#116). Forward-looking: the route
  // does not exist yet, and the SPA's account UI lives under `/settings`, not
  // here — so denying it now cannot collide, only pre-empt the hazard.
  /^\/account\//,
  /^\/billing/, // Stripe checkout / portal / webhook + /billing/*
  /^\/unsubscribe/, // onboarding-drip one-click unsubscribe (GET/POST)
  /^\/health/, // liveness JSON
];
