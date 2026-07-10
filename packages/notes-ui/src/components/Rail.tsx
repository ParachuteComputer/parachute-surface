import { IconCog, IconHome, IconMap, IconNotes, IconSearch, IconTag } from "@/components/NavIcons";
import { VaultPopover } from "@/components/VaultPopover";
import {
  type DerivedStep,
  type HomeStepId,
  deriveSteps,
  hasUserAuthoredNote,
  stepsComplete,
} from "@/lib/home/checklist";
import { useHomeChecklist } from "@/lib/home/use-home-checklist";
import { useInstallAffordance } from "@/lib/pwa-install";
import { useQuickSwitchOpen } from "@/lib/quick-switch/open-store";
import { useMapEarned, useNotesForDateViews, useVaultStore } from "@/lib/vault";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

// The desktop left rail — the app's spine on wide screens (SYNTHESIS D5;
// prototype scene 6). It REPLACES the old top nav-bar. Reading top→bottom:
//
//   · the vault switcher (identity — the vault name leads everything),
//   · a quiet Search affordance (opens the command palette),
//   · YOUR NOTES — Today · All notes · Tags, and Map once it's earned,
//   · SET UP — the same guided steps as Home, collapsing to a ✓ when done,
//   · Settings, pinned to the foot.
//
// It grows with your parachuting: the Map row only appears once the vault
// crosses the earned threshold (`useMapEarned`); until then the ambient FAB
// (`AmbientMapFab`) carries it. Rendered `hidden lg:flex` — below lg the
// mobile chrome (Header top bar + BottomTabBar) takes over. Returns null with
// no active vault (the no-vault desktop view is the full-width Landing).
export function Rail() {
  const vault = useVaultStore((s) => s.getActiveVault());

  if (!vault) return null;

  return (
    <aside
      aria-label="Primary"
      className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-bg-soft lg:flex"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="p-3">
        <VaultPopover variant="rail" />
        <RailSearch />
      </div>

      <nav aria-label="Your vault" className="flex-1 overflow-y-auto px-3 pb-3">
        <NotesSection />
        <SetupShelf vaultId={vault.id} />
      </nav>

      <div className="border-t border-border p-3">
        <RailLink
          to="/settings"
          label="Settings"
          icon={<IconCog />}
          match={(p) => p === "/settings"}
        />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Rail primitives
// ---------------------------------------------------------------------------

function RailSectionLabel({ children }: { children: ReactNode }) {
  return <p className="eyebrow px-3 pt-4 pb-1.5">{children}</p>;
}

function RailLink({
  to,
  label,
  icon,
  match,
  badge,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  match: (pathname: string) => boolean;
  badge?: ReactNode;
}) {
  const { pathname } = useLocation();
  const active = match(pathname);
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`focus-ring flex items-center gap-3 rounded-lg px-3 py-2 font-round text-sm transition-colors ${
        active
          ? "bg-[--color-coral-soft] font-semibold text-[--color-coral-ink]"
          : "font-medium text-fg-muted hover:bg-bg hover:text-fg"
      }`}
    >
      <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// YOUR NOTES — the rooms. Map earns its slot; the others are always present.
// ---------------------------------------------------------------------------

function NotesSection() {
  const mapEarned = useMapEarned();
  return (
    <div>
      <RailSectionLabel>Your notes</RailSectionLabel>
      {/* Reading a note (/n/:id) and the single-day view live under Today. */}
      <RailLink
        to="/"
        label="Today"
        icon={<IconHome />}
        match={(p) => p === "/" || p === "/today" || p.startsWith("/n/")}
      />
      <RailLink to="/all" label="All notes" icon={<IconNotes />} match={(p) => p === "/all"} />
      <RailLink to="/tags" label="Tags" icon={<IconTag />} match={(p) => p === "/tags"} />
      {mapEarned ? (
        <RailLink to="/graph" label="Map" icon={<IconMap />} match={(p) => p === "/graph"} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SET UP — the guided steps, sharing state with Home's checklist. Collapses
// to a single ✓ row once everything's done; hidden when the user dismissed it.
// ---------------------------------------------------------------------------

const SETUP_DEST: Record<HomeStepId, { label: string; to: string }> = {
  write: { label: "Write a note", to: "/new" },
  connect: { label: "Connect your AI", to: "/connect" },
  import: { label: "Bring notes over", to: "/import" },
  install: { label: "Install the app", to: "/settings" },
};

function SetupShelf({ vaultId }: { vaultId: string }) {
  const { state } = useHomeChecklist(vaultId);
  const notes = useNotesForDateViews();
  const install = useInstallAffordance();

  const steps = deriveSteps(state, {
    hasUserNote: hasUserAuthoredNote(notes.data),
    installed: install.state === "installed",
    installable: install.state === "available",
  });
  const allDone = stepsComplete(steps);

  // Respect dismissal — guidance is dismissible; the door is never a manual.
  if (state.dismissed && !allDone) return null;

  if (allDone) {
    return (
      <div>
        <RailSectionLabel>Set up</RailSectionLabel>
        <p className="flex items-center gap-2 rounded-lg px-3 py-2 font-round text-sm text-fg-muted">
          <span aria-hidden className="text-accent">
            ✓
          </span>
          You're all set
        </p>
      </div>
    );
  }

  const incomplete = steps.filter((s: DerivedStep) => !s.done);
  return (
    <div>
      <RailSectionLabel>Set up</RailSectionLabel>
      {incomplete.map((step) => {
        const dest = SETUP_DEST[step.id];
        return (
          <Link
            key={step.id}
            to={dest.to}
            className="focus-ring flex items-center gap-3 rounded-lg px-3 py-2 font-round text-sm font-medium text-fg-muted transition-colors hover:bg-bg hover:text-fg"
          >
            <span
              aria-hidden
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border text-[10px]"
            >
              ✦
            </span>
            <span className="min-w-0 flex-1 truncate">{dest.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search — opens the command palette (⌘K). Kept in the rail so desktop users
// have a visible Search entry now that the old header row is gone.
// ---------------------------------------------------------------------------

function RailSearch() {
  const setOpen = useQuickSwitchOpen((s) => s.setOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="focus-ring mt-2 flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-left font-round text-sm text-fg-dim transition-colors hover:border-accent/50 hover:text-fg-muted"
    >
      <span aria-hidden className="grid h-4 w-4 shrink-0 place-items-center">
        <IconSearch width={16} height={16} />
      </span>
      <span className="flex-1">Search…</span>
      <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 font-round text-[10px] text-fg-dim">
        ⌘K
      </kbd>
    </button>
  );
}
