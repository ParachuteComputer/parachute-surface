import { BottomTabBar } from "@/components/BottomTabBar";
import { Header } from "@/components/Header";
import { QuickSwitchMount } from "@/components/QuickSwitchMount";
import { TextSizeShortcutsMount } from "@/components/TextSizeControl";
import { Toaster } from "@/components/Toaster";
import { UpdateBanner } from "@/components/UpdateBanner";
import { VaultStatusBanner } from "@/components/VaultStatusBanner";
import { detectMountBase } from "@/lib/base-url";
import { applyTextSize, readStoredTextSize } from "@/lib/text-size";
import { useVaultStore } from "@/lib/vault";
import { useCrossTabVaultSync } from "@/lib/vault/cross-tab-sync";
import { useActiveVaultClient } from "@/lib/vault/queries";
import { useReachabilityProbe } from "@/lib/vault/reachability-probe";
import { QueryProvider } from "@/providers/QueryProvider";
import { SyncProvider } from "@/providers/SyncProvider";
import { matchesNavigationDenylist } from "@/pwa-navigation-denylist";
import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams, useSearchParams } from "react-router";
import { Home } from "./routes/Home";
import { Landing } from "./routes/Landing";
import { Notes } from "./routes/Notes";
import { Today } from "./routes/Today";

// Home + Landing + Today + Notes stay eager: the index dispatcher paints the
// guided Home (with a vault) or the Landing (without) on first load, so
// splitting them would block FCP on a network round-trip. Every other route
// gets its own chunk so the editor's CodeMirror, the graph's force-graph
// layer, settings, etc. don't pile into the initial download.
const Activity = lazy(() => import("./routes/Activity").then((m) => ({ default: m.Activity })));
const AddVault = lazy(() => import("./routes/AddVault").then((m) => ({ default: m.AddVault })));
const Calendar = lazy(() => import("./routes/Calendar").then((m) => ({ default: m.Calendar })));
const ConnectAI = lazy(() => import("./routes/ConnectAI").then((m) => ({ default: m.ConnectAI })));
const Import = lazy(() => import("./routes/Import").then((m) => ({ default: m.Import })));
const NoteEditor = lazy(() =>
  import("./routes/NoteEditor").then((m) => ({ default: m.NoteEditor })),
);
const NoteNew = lazy(() => import("./routes/NoteNew").then((m) => ({ default: m.NoteNew })));
const NoteView = lazy(() => import("./routes/NoteView").then((m) => ({ default: m.NoteView })));
const OAuthCallback = lazy(() =>
  import("./routes/OAuthCallback").then((m) => ({ default: m.OAuthCallback })),
);
const Settings = lazy(() => import("./routes/Settings").then((m) => ({ default: m.Settings })));
const Tags = lazy(() => import("./routes/Tags").then((m) => ({ default: m.Tags })));
const VaultGraph = lazy(() =>
  import("./routes/VaultGraph").then((m) => ({ default: m.VaultGraph })),
);
const Vaults = lazy(() => import("./routes/Vaults").then((m) => ({ default: m.Vaults })));

// Index dispatcher: the front door is the guided Home when a vault is
// connected, else the landing page. Both live at internal `/`, which maps to
// external `/notes/` via BrowserRouter's basename. The full notes browser is
// `/all`; the pure day-grouped timeline (+ single-day drill-in) is `/today`.
// Keeps Landing free of connected-vault concerns and Home free of any redirect
// logic.
function NotesIndex() {
  const activeVault = useVaultStore((s) => s.getActiveVault());
  const [searchParams] = useSearchParams();
  // `?add=<vault url>` connect deep link — the cloud console links the
  // origin root (`/?add=…`), but /add owns the connect flow. Forward the
  // full search string so companions like `redirect=` ride along; AddVault
  // strips the param from history once consumed.
  if (searchParams.get("add")) {
    return <Navigate to={`/add?${searchParams.toString()}`} replace />;
  }
  return activeVault ? <Home /> : <Landing />;
}

// Fallback while a lazy route's chunk loads. Routes are tiny once split, so
// the round-trip is usually invisible — but if the network stalls (slow PWA
// cold-start, offline-with-stale-SW, throttled mobile) the user needs *some*
// signal that the app is doing work. `<output>` carries an implicit
// `role="status"`; we set `aria-live="polite"` explicitly because NVDA on
// Windows has historically inconsistent support for the implicit form, and
// the rest of the codebase (Toaster) already pairs status with explicit
// aria-live. The visible "Loading…" matches what sighted users see, so both
// audiences get the same affordance.
export function RouteFallback() {
  return (
    <output
      aria-live="polite"
      className="mx-auto block max-w-5xl px-6 py-10 text-center text-sm text-fg-dim"
    >
      Loading…
    </output>
  );
}

// Shim for pre-mount external bookmarks. When the app lived at the origin root,
// links were `/<id>` and `/<id>/edit`. After the frontend moved under its own
// mount (now `/notes/`), Tailscale strips that prefix, leaving internal
// `/<id>` and `/<id>/edit` — which the catch-all would otherwise bounce to
// `/`. Redirect them to the canonical `/n/<id>` routes so old bookmarks
// survive.
//
// One class of bare path must NOT be treated as a note: a ceremony-shaped path
// (`/login`, `/admin`, `/console`, …). Once the app is served same-origin with
// the auth/account ceremonies (Phase 1 — parachute-cloud#116) the service
// worker forwards those paths past the SPA to the real server page (the
// navigation denylist), so the route table has to agree — otherwise a note
// bookmarked as bare `/login` would be redirected to `/n/login` on the SPA
// side while a hard nav to the same URL lands on the ceremony, and the two
// would disagree. The canonical `/n/<id>` form is unaffected (it never matches
// the denylist), so a note literally named `login` stays reachable there. We
// test `window.location.pathname` — the origin-absolute path the SW itself
// evaluates — so the guard is mount-aware: under a `/notes` or `/surface/<slug>`
// mount the same note sits at `/notes/login`, which is not a ceremony, and
// still redirects. Only ordinary bare paths (`/MyNote`) keep the legacy shim.
function NoteIdRedirect({ suffix = "" }: { suffix?: string }) {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  if (matchesNavigationDenylist(window.location.pathname)) {
    return <Navigate to="/" replace />;
  }
  return <Navigate to={`/n/${encodeURIComponent(id)}${suffix}`} replace />;
}

// Mounted under SyncProvider (which is under QueryProvider) so the
// reachability probe can use both `useQueryClient` and `useActiveVaultClient`.
// Renders no DOM — purely effects.
function ReachabilityProbeMount() {
  const activeId = useVaultStore((s) => s.activeVaultId);
  const client = useActiveVaultClient();
  useReachabilityProbe(activeId, client);
  return null;
}

export function App() {
  // Wired at the app root (not a provider) so the storage-event listener
  // outlives every route transition. Same vault state surfaces in every tab
  // without a refresh.
  useCrossTabVaultSync();
  // Apply the stored text-size on mount. Wired here rather than inline in
  // Settings so the preference takes effect on every route — Settings is
  // where you change it, App is where it lives.
  useEffect(() => {
    applyTextSize(readStoredTextSize());
  }, []);
  return (
    <QueryProvider>
      <SyncProvider>
        <ReachabilityProbeMount />
        <TextSizeShortcutsMount />
        {/*
          Mount-agnostic basename: detected at runtime from window.location
          so the same built bundle works at `/notes/` (legacy daemon),
          `/surface/notes/` (parachute-surface default), or `/surface/<custom-slug>/`
          (parachute-surface with a renamed install). See `src/lib/base-url.ts`
          for the detector + the design rationale.
        */}
        <BrowserRouter basename={detectMountBase()}>
          <div className="app-canvas min-h-dvh overflow-x-hidden text-fg pb-16 md:pb-0">
            <Toaster />
            <UpdateBanner />
            <VaultStatusBanner />
            <Header />
            <QuickSwitchMount />
            <main>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/" element={<NotesIndex />} />
                  <Route path="/all" element={<Notes />} />
                  {/*
                    The four built-in views are filters inside /all now (a
                    ?view= chip), not their own routes. Old bookmarks redirect
                    into the filtered list so links keep working.
                  */}
                  <Route path="/pinned" element={<Navigate to="/all?view=pinned" replace />} />
                  <Route path="/archived" element={<Navigate to="/all?view=archived" replace />} />
                  <Route path="/untagged" element={<Navigate to="/all?view=untagged" replace />} />
                  <Route path="/orphaned" element={<Navigate to="/all?view=orphaned" replace />} />
                  <Route path="/tags" element={<Tags />} />
                  <Route path="/new" element={<NoteNew />} />
                  {/*
                    Capture and New were split surfaces pre-2026-05-27. Unified
                    into NoteNew per Aaron's "serious pass": one creation
                    screen with title up front, voice as an affordance.
                    Legacy `/capture` bookmarks redirect into the new flow.
                  */}
                  <Route path="/capture" element={<Navigate to="/new" replace />} />
                  <Route path="/import" element={<Import />} />
                  <Route path="/connect" element={<ConnectAI />} />
                  <Route path="/graph" element={<VaultGraph />} />
                  <Route path="/today" element={<Today />} />
                  <Route path="/calendar" element={<Calendar />} />
                  <Route path="/activity" element={<Activity />} />
                  <Route path="/n/:id" element={<NoteView />} />
                  <Route path="/n/:id/edit" element={<NoteEditor />} />
                  <Route path="/:id" element={<NoteIdRedirect />} />
                  <Route path="/:id/edit" element={<NoteIdRedirect suffix="/edit" />} />
                  <Route path="/add" element={<AddVault />} />
                  <Route path="/oauth/callback" element={<OAuthCallback />} />
                  <Route path="/vaults" element={<Vaults />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </main>
            <BottomTabBar />
            <footer className="mx-auto max-w-5xl px-6 py-10 text-center text-sm text-fg-dim">
              <p>
                Part of the{" "}
                <a href="https://parachute.computer" className="text-accent hover:underline">
                  Parachute Computer
                </a>{" "}
                ecosystem. AGPL-3.0.
              </p>
            </footer>
          </div>
        </BrowserRouter>
      </SyncProvider>
    </QueryProvider>
  );
}
