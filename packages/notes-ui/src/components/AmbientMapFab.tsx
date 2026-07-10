import { IconMap } from "@/components/NavIcons";
import { useMapEarned } from "@/lib/vault/map-earned";
import { useVaultStore } from "@/lib/vault/store";
import { Link, useLocation } from "react-router";

// The Map's ambient home (SYNTHESIS D5). Until the Map earns a rail slot
// (`useMapEarned`), it lives here: a quiet bottom-right button that opens the
// existing vault graph. Once earned, the rail carries a Map row on desktop, so
// this FAB steps back to `lg:hidden` — it stays the phone's Map access (there
// is no rail on a phone), but never doubles up with the desktop rail row.
//
// It sits above the mobile bottom-tab bar (bottom-20) and drops to the corner
// on desktop (lg:bottom-6). Hidden on the graph route itself — you're already
// there. Uses ONLY the shipped graph route; no new backend.
export function AmbientMapFab() {
  const hasVault = useVaultStore((s) => s.activeVaultId !== null);
  const earned = useMapEarned();
  const { pathname } = useLocation();

  if (!hasVault) return null;
  if (pathname === "/graph") return null;

  return (
    <Link
      to="/graph"
      aria-label="Open the relational map"
      title="Your map"
      className={`focus-ring fixed right-5 bottom-20 z-20 grid h-12 w-12 place-items-center rounded-full border border-border bg-card text-accent shadow-lg hover:border-accent lg:right-6 lg:bottom-6 ${
        earned ? "lg:hidden" : ""
      }`}
    >
      <IconMap width={22} height={22} />
    </Link>
  );
}
