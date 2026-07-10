import { InstallPrompt } from "@/components/InstallPrompt";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { TextSizeControl } from "@/components/TextSizeControl";
import { ThemeToggle } from "@/components/ThemeToggle";
import { VaultPopover } from "@/components/VaultPopover";
import { useVaultStore } from "@/lib/vault";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";

// Mobile + tablet top bar (`lg:hidden`). On desktop the left Rail is the app's
// spine and this header is gone; below lg the Rail collapses and this bar +
// the BottomTabBar carry navigation.
//
// The vault switcher leads the bar — the vault name is the identity spine on
// the phone exactly as in the desktop rail (SYNTHESIS D6: "vault name = the
// title"). Primary rooms live in the bottom tabs; Settings and the secondary
// destinations live one tap off in the ⋯ menu. With no vault, the bar shows
// the "Parachute" wordmark and the connect state instead.
export function Header() {
  const location = useLocation();
  const hasVaults = useVaultStore((s) => Object.keys(s.vaults).length > 0);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the menu whenever the route changes — otherwise a tap on a nav link
  // would leave the panel open over the destination page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a value used in the body
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <header
      className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur lg:hidden"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <nav className="flex items-center justify-between gap-3 px-4 py-3">
        {hasVaults ? (
          <div className="min-w-0 flex-1">
            <VaultPopover />
          </div>
        ) : (
          <Link
            to="/"
            className="focus-ring min-w-0 shrink truncate font-serif text-lg tracking-tight text-fg hover:text-accent"
          >
            Parachute
          </Link>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {hasVaults ? (
            <SyncStatusIndicator />
          ) : (
            <span className="text-sm text-fg-dim">No vault connected</span>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card text-fg-muted hover:text-accent"
          >
            <span aria-hidden="true" className="font-mono text-base leading-none">
              {menuOpen ? "✕" : "☰"}
            </span>
          </button>
        </div>
      </nav>

      {menuOpen ? (
        <div id="mobile-menu" className="border-t border-border bg-bg/95 px-4 py-4">
          {hasVaults ? (
            <div className="flex flex-col gap-1">
              {/* Settings leads — it's the dissolved console, the primary
                  secondary destination now that the bottom bar is the 4-slot
                  D6 set (Home · Notes · + · Search). */}
              <MenuLink to="/settings">Settings</MenuLink>
              <MenuLink to="/connect">Connect your AI</MenuLink>
              <MenuLink to="/graph">Map</MenuLink>
              <MenuLink to="/activity">Activity</MenuLink>
              <MenuLink to="/calendar">Calendar</MenuLink>
              <MenuLink to="/import">Import</MenuLink>
              <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                <InstallPrompt />
                <TextSizeControl />
                <ThemeToggle />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <InstallPrompt />
              <TextSizeControl />
              <ThemeToggle />
            </div>
          )}
        </div>
      ) : null}
    </header>
  );
}

function MenuLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="focus-ring py-1.5 text-sm text-fg hover:text-accent">
      {children}
    </Link>
  );
}
