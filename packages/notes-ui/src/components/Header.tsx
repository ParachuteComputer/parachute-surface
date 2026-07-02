import { InstallPrompt } from "@/components/InstallPrompt";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { TextSizeControl } from "@/components/TextSizeControl";
import { ThemeToggle } from "@/components/ThemeToggle";
import { VaultPopover } from "@/components/VaultPopover";
import { useQuickSwitchOpen } from "@/lib/quick-switch/open-store";
import { useVaultStore } from "@/lib/vault";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

export function Header() {
  const location = useLocation();
  const hasVaults = useVaultStore((s) => Object.keys(s.vaults).length > 0);
  const setSwitcherOpen = useQuickSwitchOpen((s) => s.setOpen);
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the route changes — otherwise a tap on a
  // nav link would leave the panel open over the destination page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a value used in the body
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  // Breakpoint note (notes#136): the inline-cluster mode starts at `lg`
  // (1024px) so tablet and narrow-desktop widths use the hamburger menu
  // (which lays out vertically and never clips). Inside the cluster,
  // `flex-wrap` lets the row break to a second line under text-size scaling
  // rather than clip. The vault popover trigger caps its width in rem so a
  // long vault name compresses before its siblings get pushed off-screen.
  //
  // The desktop spine is deliberately five load-bearing items (Today · All
  // notes · Tags · +Capture · Search); everything secondary (Graph, Activity,
  // Calendar, Import, and the appearance/sync controls) lives behind the ⋯
  // overflow so the front door stays calm.
  return (
    <header
      className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <nav className="mx-auto flex max-w-[--w-page] items-center justify-between gap-3 px-4 py-3 lg:px-6 lg:py-5">
        <Link
          to="/"
          className="focus-ring min-w-0 shrink truncate font-serif text-lg tracking-tight text-fg hover:text-accent lg:text-xl"
        >
          Parachute Notes
        </Link>

        {/* Desktop nav — lg+ only. Wraps when text-size scaling pushes the
            row past max-w-page rather than clipping (notes#136). */}
        <div className="hidden min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2 lg:flex">
          {hasVaults ? (
            <>
              <SpineLink to="/">Today</SpineLink>
              <SpineLink to="/all">All notes</SpineLink>
              <SpineLink to="/tags">Tags</SpineLink>
              <SpineLink to="/new">+ Capture</SpineLink>
              <button
                type="button"
                onClick={() => setSwitcherOpen(true)}
                className="focus-ring text-sm text-fg-muted hover:text-accent"
              >
                Search
              </button>
              <VaultPopover />
              <OverflowMenu />
            </>
          ) : (
            <>
              <span className="text-sm text-fg-dim">No vault connected</span>
              <InstallPrompt />
              <TextSizeControl />
              <ThemeToggle />
            </>
          )}
        </div>

        {/* Mobile + tablet + narrow-desktop cluster: sync status (always
            visible) + hamburger. Visible up to lg per notes#136. */}
        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          {hasVaults ? <SyncStatusIndicator /> : null}
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
        <div id="mobile-menu" className="border-t border-border bg-bg/95 px-4 py-4 lg:hidden">
          {hasVaults ? (
            <div className="flex flex-col gap-3">
              <Link to="/graph" className="py-1 text-sm text-fg hover:text-accent">
                Graph
              </Link>
              <Link to="/activity" className="py-1 text-sm text-fg hover:text-accent">
                Activity
              </Link>
              <Link to="/calendar" className="py-1 text-sm text-fg hover:text-accent">
                Calendar
              </Link>
              <Link to="/import" className="py-1 text-sm text-fg hover:text-accent">
                Import
              </Link>
              <div className="mt-1">
                <span className="eyebrow mb-1 block">Active vault</span>
                <VaultPopover variant="inline" />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <InstallPrompt />
                <TextSizeControl />
                <ThemeToggle />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg-dim">No vault connected</p>
              <div className="flex flex-wrap items-center gap-3">
                <InstallPrompt />
                <TextSizeControl />
                <ThemeToggle />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </header>
  );
}

function SpineLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="focus-ring text-sm text-fg-muted hover:text-accent">
      {children}
    </Link>
  );
}

// The ⋯ overflow: secondary destinations + appearance/sync controls, one tap
// off the calm five-item spine. Closes on route change, outside click, Escape.
function OverflowMenu() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a value used in the body
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="focus-ring rounded-md px-1.5 text-fg-muted hover:text-accent"
      >
        <span aria-hidden="true" className="font-mono text-base leading-none">
          ⋯
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          <OverflowLink to="/graph">Graph</OverflowLink>
          <OverflowLink to="/activity">Activity</OverflowLink>
          <OverflowLink to="/calendar">Calendar</OverflowLink>
          <OverflowLink to="/import">Import</OverflowLink>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2">
            <SyncStatusIndicator />
            <InstallPrompt />
            <TextSizeControl />
            <ThemeToggle />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OverflowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      role="menuitem"
      className="block px-3 py-2 text-sm text-fg-muted hover:bg-bg hover:text-accent"
    >
      {children}
    </Link>
  );
}
