# Changelog — @openparachute/notes-ui

## [0.1.21] - 2026-07-09

### Changed — new-brand pass: system fonts, coral accent, warm paper

Aligns notes-ui with the ratified brand tokens (parachute.computer/design/brand-tokens.md).

- **System font stacks — Google Fonts dropped.** Instrument Serif / DM Sans /
  JetBrains Mono webfonts are gone; `--font-serif`/`--font-sans`/`--font-mono`
  now carry the brand's system stacks, plus a new `--font-round` UI-chrome stack
  applied to buttons and eyebrows. Removes a third-party network fetch — the PWA
  now renders offline with zero webfont download and no font-swap flash.
- **Accent: forest-green → coral.** `--color-accent` is the coral button hue
  `#bf4a2a` (white-on 4.97:1, on-paper 4.77:1); the bright display coral
  `#e05d3c` moves to `--color-accent-light` (large/decorative only). The dark
  accent lightens to `#ec7a5c` with a dark-warm-ink `--color-on-accent` —
  every dark pair AA-verified.
- **Warm paper.** `--color-bg` `#faf8f4` → `#fdfaf4` (light theme; dark grounds
  unchanged). PWA `theme_color`/`background_color` follow.
- **Coral highlight family.** New `--color-coral-soft`/`--color-coral-ink`
  tokens + a `.chip-featured` badge. Existing danger/warning/positive semantic
  tokens are untouched; the radius ramp is unchanged.
- Links follow the accent → coral (they've always used `text-accent`).

## [0.1.20] - 2026-07-09

### Added — neighborhood preview + navigation (#177)

The note view's neighborhood graph is now a way to MOVE through the graph, not
just look at it.

- **Click/tap a neighbor → a mini preview card** — the note's title and tags
  render instantly (from what the graph already loaded); the snippet is fetched
  lazily on demand through the shared query cache (one note, never the whole
  graph, fetched once). "Open note" navigates into it. Node-click no longer
  hard-navigates — you look before you move.
- **Keyboard + touch accessible** — a focusable "Neighbors" list sits beside the
  canvas (which has no focusable nodes), so a neighbor is reachable without a
  mouse. The preview takes focus on open, closes on Escape, and closes when
  focus leaves it. Buttons are full tap targets; nothing is hover-only.

### Added — draft safety, install-friction preempt, and a plan backlink

- **Local draft persistence (#175).** Both editors (new note + existing note)
  now mirror what you're typing to localStorage a beat after you stop — so an
  accidental navigation, tab close, or crash before an explicit save doesn't
  lose it. It is NEVER written to the vault on its own (⌘S stays the only
  server-commit path, so no surprise versions and the conflict machinery is
  untouched). Keyed per vault + per note (new-note drafts key to the compose
  session). A returning new note restores its text with a dismissible "draft
  restored" banner; an existing note OFFERS to restore only when the draft
  differs from the server copy (the server stays authoritative). Cleared on a
  successful save or an explicit discard; also flushed on tab background /
  page-hide (where a PWA never runs unmount).
- **PWA install-friction preempt (#176).** Installing the app on iOS gets a
  storage partition separate from Safari, so the vault connection doesn't carry
  over and the app asks for the address again. The Add-to-Home-Screen dialog now
  shows your vault's address, copy-ably, right where you install — with a note
  that the app may ask for it. (Android/desktop share storage and are
  unaffected.)
- **"Manage your vault plan" backlink (#99).** A quiet row on the home links
  cloud vaults to their console (`cloud.parachute.computer/console`). Self-host
  vaults show no row — no false door.

### Fixed

- **Drafts are pinned to their vault.** The draft of a note (or a new-note
  compose session) now keys to the vault it started in, captured at mount — so
  switching the active vault mid-edit via the header switcher can't move or
  clobber a draft under a different vault's key.
- **Disconnecting a vault clears its drafts.** `removeVault` now wipes every
  `notes:draft:<vaultId>:*` entry, so no plaintext note content lingers after a
  vault (and its token) are gone.
- **Explicit discards clear the draft.** Cancelling with "discard unsaved
  changes", and the conflict banner's "Reload latest (discard my edits)", both
  clear the local draft — so a discarded edit can't resurface as a false
  "restore?" offer.
- **Install prompt is single-use (PR #182 follow-up).** The deferred
  `beforeinstallprompt` event is now cleared after ANY outcome (accepted or
  dismissed) with the prompt call wrapped in try/catch — a retry after a
  dismiss can no longer silently no-op against a spent event.
- The iOS install dialog drops a dead `::backdrop` utility that a non-modal
  `<dialog open>` never renders.

## [0.1.18] - 2026-07-09

### Added — the guided home: welcome, quick actions, connect-your-AI, setup checklist

The front door (`/`) becomes a guided home when a vault is connected — the
place a fresh vault feels alive and gets set up, without getting in a returning
user's way. Structure + flow only; the visual language is unchanged (a
brand-token pass is separate).

- **Home (`/`).** The index dispatcher now renders a guided `Home` (vault
  connected) or the renamed `Landing` (no vault). Home leads with an adaptive
  welcome (warm for a fresh vault; a quiet "Home" once a real note exists),
  quick actions (Write · Connect your AI · Bring your notes over · Install),
  the setup checklist, a search box, and the recent-notes timeline. The pure
  day-grouped timeline (+ single-day drill-in) stays at `/today`; the shared
  list lives in one `RecentTimeline` component.
- **Connect your AI (`/connect`).** The vault's MCP endpoint (`<vaultUrl>/mcp`)
  with copy-to-clipboard, plus stepped Claude (Settings → Connectors → Add
  custom connector) and ChatGPT walkthroughs and the Claude Code one-liner —
  mirroring the cloud console's copy. Connecting isn't client-detectable, so
  completion is a manual "I've connected my AI" tick, never faked.
- **Setup checklist.** Persisted per-vault in localStorage (no cloud-only API —
  serves both doors). Auto-completes only what's honestly detectable: *write a
  note* when a user-authored non-seed note exists (seed guides carry `#guide`;
  system notes live under `.parachute/`), *install* when running standalone.
  *Connect* and *import* are manual ticks. Dismissible as a whole; collapsed by
  default for returning users; never modal-walled.
- **Install affordance.** A shared, module-scope `useInstallAffordance` captures
  the one-shot `beforeinstallprompt` once so every consumer (home card, header
  button) sees it regardless of mount order; the install action hides where the
  platform can't install.

## [0.1.17] - 2026-07-09

### Fixed — honest offline-cache label + save lands on the note view

- The offline-cache indicator now states what's actually cached rather than
  overclaiming.
- Saving a note from the editor lands the user on the note view (not back on a
  list), and the "save to view" flow behaves consistently.

## [0.1.16] - 2026-07-07

### Fixed — voice record is a tap-toggle (kills the 0-second-clip bug)

Voice capture is a tap-to-start / tap-to-stop toggle. This removes the
press-and-hold race that could end a recording immediately and produce a
0-second clip.

## [0.1.15] - 2026-07-05

### Changed — live queries ride WebSockets; the fallback is polling (no SSE)

Bumps `@openparachute/surface-client` to `^0.3.4`, which makes the
live-query transport **WebSocket-only** (Phase 2 of the SSE →
Hibernatable-WebSockets migration). Notes' live view (`useLiveNotesQuery` →
`createLiveList` → `VaultClient.subscribe`) sits above the transport seam, so
the live path is a **zero-code-change** pickup: against a vault that speaks the
WebSocket binding, the list runs over a hibernatable socket (idle-open tabs stop
pinning the cloud vault DO awake).

- **Polling is the floor** (there's no SSE fallback — the fallback IS polling).
  When the live socket is unavailable — an old server without the WS binding, a
  WS-blocked network, or a drop — the list degrades cleanly to react-query
  polling with **no error state and no hang**, and re-establishes live the
  moment WS is reachable again.
- **Polling-floor hardening (`queries.ts`):** the note-list queries (`useNotes`,
  `useNotesForDateViews`) now poll on a background interval (30s / 60s) AND
  refetch on window-focus **whenever the live stream is down** — so a user with
  WS blocked still sees changes within a sane window, not just on mount. Both
  are disabled while live (the stream keeps the cache fresher than any interval)
  and re-enable automatically when `isLive` flips false.

## [0.1.14] - 2026-07-04

### Added — voice-retention transparency: know (and choose) whether recordings are kept

The vault has always had an `audio_retention` dial (`keep` /
`until_transcribed` / `never` on `GET/PATCH /api/vault` — identical
contract on the self-host and cloud doors), but nothing surfaced it:
users recorded voice notes without knowing whether the audio file was
kept forever or deleted after transcription. This release is the pure
surfacing — no backend changes.

- **First-voice-capture choice (the consent moment).** The first time a
  user records in a vault whose retention has never been explicitly
  chosen, a one-time inline choice appears near the recorder — "Keep my
  recordings" / "Just keep the words (audio deleted after transcribing)".
  Selection PATCHes `config.audio_retention` and remembers the choice
  per-vault (localStorage, the `lens:path-tree:` pattern). Never blocks a
  capture: a failed PATCH shows one quiet line, the capture proceeds
  under the server default (keep), and the choice re-offers next time.
  Not offered where it can't work: vaults that predate the dial (no
  `config` block on `/api/vault` — a PATCH would silently no-op) and
  vaults already dialed away from the default via another door.
- **Settings → "Voice recordings".** Shows the CURRENT server value with
  one honest line per option: Keep ("stored with your notes; included
  wherever attachments are included"), Delete after transcribing ("your
  words stay; the audio file is removed once the transcript lands"),
  Never store ("audio is removed even if transcription fails — the
  transcript is your only copy"). Changing PATCHes immediately; errors
  surface as a toast and the radios stay on the server truth. Older
  vaults show the value read-only with an honest "can't change this yet"
  line. Setting the dial here also settles the recorder's first-capture
  prompt.
- **Respects the existing gates, adds no network.** Everything renders
  only where the mic itself renders (the 0.1.13 transcription-capability
  gate); reads ride the SAME cached `/api/vault` response as
  `useVaultInfo` — zero new requests per render. Writes go through the
  new `VaultClient.patchVault` (`PATCH /api/vault`, write-scoped on both
  doors — the Notes token carries it), and the mutation verifies the
  config ECHO so an old vault's accept-and-ignore 200 can't masquerade
  as success.

Tests: 985 (was 964) — choice renders once + persists + PATCHes
correctly; PATCH-failure path (capture unblocked, choice re-offered);
settings row reflects + updates + errors honestly; absent-config
back-compat (old vault → treated as keep, no dead control).

## [0.1.13] - 2026-07-03

### Fixed — mic gates on the vault's declared transcription capability (launch-audit P0-3)

On free-tier cloud vaults the create screen showed "Record voice memo"
("Audio gets transcribed and appended") while the vault had transcription
disabled — the user recorded, waited, and got "_Transcription unavailable._",
which reads as the product failing on a flagship feature.

- **The recorder now hides when the vault EXPLICITLY declares
  `transcription.enabled === false`** (Aaron's ratified tier design: free =
  mic hidden, honest), replaced by a single quiet line — "Voice transcription
  comes with the Voice plan." on plan-metered (cloud) vaults, "Voice
  transcription isn't enabled on this vault." on self-host vaults without a
  configured provider.
- **Back-compat pinned: an ABSENT capability keeps the mic exactly as
  today.** Older self-host vaults that predate the flag (vault#529) declare
  nothing — absent ≠ disabled, existing self-host voice users see no change.
- **Two-door capability read, no per-render network.** Self-host declares the
  flag on `GET /api/vault` (already fetched + cached by `useVaultInfo`);
  cloud declares it on the bare landing `GET /vault/<name>` (cloud#56) and
  NOT on `/api/vault`, so `useTranscriptionCapability` adds a cached fallback
  probe of the bare landing that fires only when `/api/vault` answered
  without the field.
- An in-flight capture (requesting/recording/have-audio) is never interrupted
  by a late-resolving gate — it finishes honestly.
- **Fail-open pinned by test**: a failing bare-landing probe (network error,
  500, 401 scope-mismatch, malformed JSON) leaves the capability undefined
  and keeps the mic — failure never masquerades as "disabled".

## [0.1.12] - 2026-07-03

### Fixed — Stage-0 offline trust (three phone-first PWA fixes)

Three bug fixes from the 2026-07-03 offline-PWA brief that make the installed,
phone-first PWA trustworthy offline. The excellent existing sync-queue behavior
is untouched.

- **Service worker now registers on the promoted standalone mount.** The SW
  registration gate compares the runtime mount to the build-time base. For the
  standalone `notes.parachute.computer` build (`VITE_BASE_PATH=/`),
  `detectMountBase()` returns `""` but the build-time base normalised `"/"` →
  `"/notes"`, so the gate could **never** pass — the installed PWA had **zero
  offline shell** on cold start (the front door had no offline capability at
  all). `resolveBuildTimeBase` now maps the standalone `VITE_BASE_PATH="/"`
  build to `""`, matching `detectMountBase()` so the gate passes. Bundled-host
  / local mounts (`/notes`, `/surface/<slug>`) stay gated exactly as before.
- **A failed background refetch no longer blanks what you're reading.** Today,
  the single-note view, and the All-notes list rendered the error block on
  `isError` **without** checking for cached `data`. They now render the saved
  data (under a quiet "Offline — showing what's saved" ribbon) whenever data is
  present, and fall back to the error block only when there is genuinely no
  cached data.
- **Offline voice capture lands on a readable note, not an error page.** The
  audio path navigated to `/n/<localId>` before its `create-note` row drained,
  but never seeded the query cache (the text path already did), so
  `getNote("local-…")` 404'd right after "Captured — syncing audio." The audio
  path now seeds the optimistic note into the cache (mirroring the text path),
  and `useNote` resolves a local id via the sync id-map — rendering the
  optimistic note until sync assigns the real id, then flipping to the server
  note.

## [0.1.11] - 2026-07-03

### Changed — one capture tag, quietly ensured
- **Captures carry a single `capture` tag**; how the note arrived now rides
  note metadata (`source: "text"` for typed notes, `source: "voice"` when
  audio is present) instead of the `capture/text` / `capture/voice` tag
  hierarchy. Typed notes through the create surface are captures too — they
  previously carried no capture tag at all. Coordinated with parachute-vault
  shrinking its seeded starter pack to the same single `capture` tag.
- **`NOTES_REQUIRED_SCHEMA` is now that one tag** (same description, no
  parents), and `meta.json`'s `required_schema` (the surface-host install-time
  provisioner input) matches.
- **Connect-time schema-suggestion banner retired** (with the Settings "Vault
  schema" audit panel and the audit runner/stores behind them). Replaced by a
  quiet lazy-ensure: the first capture into a vault this session audits the
  vault's tags and creates the `capture` row **only if it's missing** —
  best-effort, silent, never blocks a capture, and never overwrites an
  existing (possibly operator-customized) tag row.
- Tag Role defaults for text + voice capture both point at `capture` now.
  Stored per-vault role customizations are untouched (no force-migrate), and
  existing notes keep their `capture/text` / `capture/voice` tags.

## [0.1.7-rc.1] - 2026-06-23

First rc under the resumed per-PR rc-bump convention (every code-touching
PR bumps `rc.N` + publishes to `@rc` so every box can soak it). Re-baselines
the `@rc` channel from the stale `0.1.6-rc.2` up to `0.1.7-rc.1`, above the
`0.1.6` stable.

### Added — design-system layer
- **Design tokens** (Tailwind v4 `@theme`): semantic state tokens
  (`--color-danger`/`-hover`/`-soft`/`-border`, `--color-warning`/`-soft`,
  `--color-positive`/`-soft`, and the load-bearing `--color-on-accent`); one
  shared type ramp (`--text-2xs … --text-3xl`) used by chrome **and**
  `.prose-note h1–h4`; consolidated radii, warm-tinted shadows, and container
  widths (`--w-prose`/`-page`/`-narrow`). The dark palette is de-duplicated to
  a single source (`--_d-*`) referenced by both the system `prefers-color-scheme`
  case and the explicit `[data-theme="dark"]` gate — no drift between them.
- **Component classes** (`@layer components`): `.btn` (+ `-primary`/`-secondary`/
  `-ghost`/`-accent-soft`/`-danger`/`-danger-solid` + size mods), `.input`/
  `.textarea`/`.select`, `.card`, `.chip` (+ `-tag`/`-tag-active`),
  `.dialog-overlay`/`.dialog-panel`, `.eyebrow`, `.note-id`, `.page`/
  `.page-prose`, `.skeleton`, one accessible `.focus-ring` — all
  reduced-motion-safe.
- **Shared UI primitives** (`src/components/ui/`): `<Skeleton>`, `<EmptyState>`,
  `<ErrorState>`.
- `STYLE.md` documenting the token contract.

### Fixed
- **WCAG-AA contrast**: dark-mode accent `#7ab087` with white ink was 2.50:1
  (fail); ink is now `--color-on-accent` (`#15211a`) → 6.63:1 (pass). Swept
  every `text-white`-on-accent across `src` to `text-[--color-on-accent]`
  (zero `text-white` remain in non-test source) and moved the two solid
  destructive buttons off raw `bg-red-500` onto `.btn-danger-solid`.

### Changed
- 6 surfaces refactored onto the new system (Header, BottomTabBar, Toaster,
  Notes, NoteView, Settings); ~14 other files carry the mechanical AA swap.

## [0.1.3] - 2026-05-23

### Changed
- `detectMountBase()`'s canonical (meta-tag) path now delegates to
  `@openparachute/app-client`'s `getMountBase()` instead of parsing the
  meta tag locally. The thin wrapper preserves the legacy `/notes`
  fallback and keeps the existing `(pathname?, doc?)` signature so
  existing callers' shapes are unchanged. The local regex fallback
  stays in place for pathname-passing callers (`sw-bootstrap.ts`) —
  app-client's helper intentionally does not read
  `window.location.pathname`, so pathname-based detection remains a
  notes-ui concern until every host injects the meta tag (tracked at
  parachute-app#21, partially shipped in app#25). Closes notes#163.

### Fixed
- Removed unreachable `|| undefined` branch in `App.tsx`'s
  `<BrowserRouter basename>`. `detectMountBase()` always returns a
  non-empty string, so the fallback was dead (notes#162 nit).
- Strengthened the SSR/no-window test in `base-url.test.ts` from
  `.toBeDefined()` to `.toBe("/notes")` so the assertion actually
  proves the legacy fallback shape (notes#162 nit).

### Dependencies
- Bumps `@openparachute/app-client` from `^0.1.0-rc.3` to
  `^0.1.0-rc.4`. app-client rc.4 added the runtime tenancy helpers
  (`getMountBase`, `getTenantId`, `getHubOrigin`, `getVaultUrl`) this
  release consumes (parachute-app#27).

## [0.1.2] - 2026-05-23

### Fixed
- Service-worker registration now gates on the runtime mount matching
  the build-time vite base. Resolves the OAuth-callback breakage and
  MIME errors that hit operators running notes-ui under parachute-app
  at the canonical `/app/notes/` mount. The previous build auto-
  registered the SW unconditionally at the page's current scope; the
  precache table was built for `/notes/` so workbox served HTML for
  what should have been JS modules and JSON manifests:

  ```
  Uncaught (in promise) non-precached-url: non-precached-url ::
      [{"url":"/notes/index.html"}]
  Failed to load module script: Expected JavaScript-or-Wasm module,
      got "text/html"
  Manifest: Line: 1, column: 1, Syntax error.
  ```

  The fix:
    - New `src/lib/sw-bootstrap.ts` exports `shouldRegisterServiceWorker()`
      and `cleanupStaleServiceWorker()`. The gate compares the
      build-time vite base (`import.meta.env.BASE_URL` / `VITE_BASE_PATH`)
      against `detectMountBase()` and only registers when they match.
    - `UpdateBanner` splits the `useRegisterSW` call into an inner
      component that only renders when the gate is open — React hooks
      can't be conditional within a single component, but conditional
      *rendering* is fine.
    - `main.tsx` fires `cleanupStaleServiceWorker()` on boot to
      unregister any `/notes/`-scoped SW left over from a pre-0.1.2
      install when the bundle is now being served at a different mount.
      Operators auto-recover on first page load — no DevTools manual
      cleanup needed.
    - `vite.config.ts` declares `injectRegister: false` explicitly,
      documenting that app code is the only registration path (defensive
      — vite-plugin-pwa v1's default already skips auto-inject when
      `useRegisterSW` is used, but the explicit declaration makes the
      contract grep-able).
- `meta.json`'s `version` field synced to the package version (was
  stuck at `0.1.0` through 0.1.1). Cosmetic — `meta.json`'s `version`
  is informational; parachute-app reads `package.json` for install
  resolution — but worth keeping accurate.

### Known limitations
- PWA "Add to Home Screen" install still requires a custom build with
  `VITE_BASE_PATH=/app/<name>` when running under parachute-app at a
  non-default mount. The default bundle targets the daemon-era
  `/notes/` scope for back-compat; in-browser use works at any mount
  from the default bundle (just no installable PWA). A future
  parachute-app manifest-rewrite hook will lift this — tracked
  separately (see 0.1.1 entry below for the original limitation note).

## [0.1.1] - 2026-05-23

- **Fix: runtime mount detection — same built bundle works at any
  mount path.** The 0.1.0 bundle baked `/notes/` into asset URLs and
  the React Router basename at Vite build time, so parachute-app
  installs (which mount UIs at `/app/<slug>/`) loaded the bundle but
  immediately broke:

  ```
  <Router basename="/notes"> is not able to match the URL "/app/notes"
  because it does not start with the basename
  ```

  OAuth also 401'd because the DCR client registered with the wrong
  redirect URI (`/notes/oauth/callback` instead of the live
  `/app/notes/oauth/callback`).

  The fix:
    - Vite `base: ""` emits **relative** asset URLs (`./assets/...`,
      `./manifest.webmanifest`) in the built `index.html`. Browser
      resolves them against the document URL, so assets load from any
      mount.
    - New `src/lib/base-url.ts` exports `detectMountBase()` — reads
      `window.location.pathname` at runtime to identify the mount
      prefix. Recognises `/app/<slug>` (parachute-app's
      single-segment slug grammar, matching `meta-schema`'s
      PATH_PATTERN) and `/notes` (legacy notes-daemon mount), and
      falls back to `/notes` for unrecognised paths.
    - `BrowserRouter`'s `basename` and `oauth.basePathPrefix()` both
      switch from `import.meta.env.BASE_URL` to `detectMountBase()`,
      so router matching and the OAuth callback URL track the live
      mount automatically.

  Same `dist/` now works at `/notes/` (legacy daemon), `/app/notes/`
  (parachute-app default), `/app/<custom-slug>/` (renamed install),
  and any deep route under each.

- **Amendment: meta-tag fast-path before regex fallback.** Adds meta-tag
  fast-path to mount detection. Apps read `<meta name="parachute-mount">`
  first; regex fallback handles the interim until parachute-app injects
  the meta tag (tracked at parachute-app#21). Forward-compatible: when the canonical
  injection ships, no code change required in notes-ui.

- **PWA install limitation (known, deferred to Phase 2).** The PWA
  manifest's `start_url`/`scope` and the service worker's
  `navigateFallback` are fixed at Vite build time — the spec doesn't
  support runtime values without server-side rewriting. The default
  build keeps `/notes/` as the PWA mount; operators who install
  Notes at a non-default mount and want PWA "Add to Home Screen" to
  open the right path must build with `VITE_BASE_PATH=/app/<slug>`.
  In-browser use (no PWA install) works at any mount from a single
  build. A future parachute-app manifest-rewrite hook would lift
  this — tracked separately.

## [0.1.0] - 2026-05-23

- **First stable release; promoted from rc.5.** Tagged `@latest` for
  parachute-app bootstrap's bare-spec resolution.
- **Fix: ship `meta.json` so parachute-app bootstrap can install.**
  parachute-app's auto-bootstrap path validates `@openparachute/notes-
  ui`'s tarball against its [meta-schema][meta-schema] and requires
  `name` + `displayName` + `path`. Tarballs through rc.4 included only
  `dist/`, `LICENSE`, `README.md`, `package.json`, and `CHANGELOG.md`
  — no `meta.json`, so bootstrap failed with:

  ```
  [app] bootstrap: failed to install @openparachute/notes-ui: meta.json:
  name: is required (string); displayName: is required (non-empty
  string); path: is required (string)
  ```

  This release adds `packages/notes-ui/meta.json` and includes it in
  the `files` list. The file declares `name: "notes"`, `displayName:
  "Notes"`, `path: "/app/notes"`, `scopes_required: ["vault:*:read",
  "vault:*:write"]` (vault-agnostic — Notes' in-app vault picker
  narrows per OAuth flow), `pwa: true` + `pwa_service_worker: "sw.js"`
  (Notes is the canonical PWA-mode example per [design §18][s18]),
  `iconUrl: "icon.svg"`, and the `required_schema.tags` declaration
  for `capture` / `capture/text` / `capture/voice` mirroring
  `NOTES_REQUIRED_SCHEMA` in `src/lib/vault/schema.ts` (patterns#57 —
  Phase 2.0 validates the shape; Phase 2.1+ auto-provisions).

  Canonical reference for the shape: [design doc §5][s5].

[meta-schema]: https://github.com/ParachuteComputer/parachute-app/blob/main/packages/app-host/src/meta-schema.ts
[s5]: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md#5-per-ui-metadata-schema--metajson-draft-07
[s18]: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md#18-caching--reload-strategy

## [0.1.0-rc.4] - 2026-05-22

- **Fix: resolve `link:` dep in published manifest** (`link:` →
  `^0.1.0-rc.3`). The published tarball for `0.1.0-rc.3` carried
  `"@openparachute/app-client": "link:@openparachute/app-client"` —
  a local-dev-only protocol set up in notes#153 when app-client
  wasn't yet on npm. Installing `@openparachute/notes-ui@0.1.0-rc.3`
  failed at resolve:

  ```
  error: Workspace dependency "@openparachute/app-client" not found
  ```

  `@openparachute/app-client@0.1.0-rc.3` is now published, so we
  switch to a concrete semver. Local dev still resolves the sibling
  through Bun's workspace resolver (it matches by name regardless
  of the version string), and the published tarball declares a
  real, registry-resolvable dependency.

  The repo's `RELEASING.md` grows a "Workspace dependencies" section
  documenting the rule so this can't recur.

## [0.1.0-rc.3] - 2026-05-22

- **Refactor: `VaultClient` subclasses `@openparachute/app-client`'s
  base class** (closes notes#153 reviewer follow-up). app-client
  0.1.0-rc.3 lifted `request`, `requestWithRetry`, and
  `requestCursorWithRetry` to `protected` ([parachute-app#10][app10]),
  so Notes' VaultClient can finally subclass cleanly instead of cloning
  the request loop. Net ~220 lines deleted from `client.ts` and ~690
  from `client.test.ts` (base-class tests now covered by app-client's
  own suite); the Notes-specific surface (`renameTag`, `mergeTags`,
  `deleteTag`, `listTagsWithSchema`, `linkAttachment`,
  `fetchAttachmentBlob`) stays on the subclass.

  Notes' previous narrow-shape `updateTag` override was dropped — the
  base class's wider `TagUpsertPayload`-shaped `updateTag` accepts the
  same `{description, parent_names}` Notes was already passing, and
  `schema-ensure.ts` (the only caller) ignores the return value.

  Bundle delta: +3.8 kB raw / +0.9 kB gzip on the main chunk (the
  subclass mirrors a handful of auth-callback fields on the instance
  so `fetchAttachmentBlob` can drive its own retry loop without
  reaching into the base's `private` state — see file header for
  the rationale).

[app10]: https://github.com/ParachuteComputer/parachute-app/pull/10

## [0.1.0-rc.2] - 2026-05-22

- **Adopt `@openparachute/app-client`** (Phase 2 of the notes-migration-
  to-app arc — [parachute-app#6][app6], design doc [Section 16][s16]).
  The in-repo OAuth driver, VaultClient error classes, PKCE primitives,
  discovery + DCR helpers, URL/vault-id helpers, and service-worker
  reload code are now re-exports from `@openparachute/app-client`. Net
  ~750 lines deleted across `packages/notes-ui/src/lib/vault/` and
  `packages/notes-ui/src/lib/pwa.ts`; behaviour unchanged.

  Notes-specific orchestration stays here: `priorHaltedVaultId` round-
  trip (notes#148), `redirectUriForOrigin` (mount-path aware),
  issuer-keyed DCR cache, tag-curation endpoints (`renameTag`,
  `mergeTags`, `deleteTag`, `updateTag`, `listTagsWithSchema`), and
  the multi-vault store + refresh-on-401 pipeline. The VaultClient
  request loop currently still lives here because app-client's
  `request` is `private`; a follow-up will lift it to `protected` so
  Notes can subclass and shrink further.

  Local-dev wiring: notes-ui depends on `@openparachute/app-client` via
  `bun link` until app-client is published to npm. Operators running
  notes-ui from a local checkout should `bun link @openparachute/app-
  client` from the parachute-app workspace first.

[app6]: https://github.com/ParachuteComputer/parachute-app/issues/6

## [0.1.0-rc.1] - 2026-05-21

- **Initial release.** Parachute Notes UI bundle, split out of the
  parachute-notes monorepo as a parallel publish target alongside the
  existing `@openparachute/notes` module package. This is Phase 1 of the
  notes-migration-to-app arc captured in the [parachute apps design
  doc Section 16][s16].

  notes-ui ships only the Vite-built SPA — no daemon, no module surface,
  no `bin`, no `.parachute/module.json`. Operators install it under
  [parachute-app][app] via `parachute-app add @openparachute/notes-ui
  --name notes --path /app/notes`.

  Source remains shared with the legacy `@openparachute/notes` module
  package (sibling under `packages/notes-daemon/`). The daemon package's
  build step copies notes-ui's `dist/` into its own publish payload, so
  both packages ship the exact same bundle.

  Version chain restarts at `0.1.0-rc.1` — this is a new npm package
  with no prior history. The legacy module continues at `0.3.17-rc.1`
  on its own chain.

[s16]: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-apps-design.md#16-notes-migration-to-app
[app]: https://github.com/ParachuteComputer/parachute-app
