import { useOwnOriginDoor } from "@/lib/vault";
import { Link } from "react-router";

// No-vault landing. Mounted at `/` only when no vault is connected (the
// dispatch lives in `App.tsx`'s `NotesIndex`, which renders the guided Home
// once a vault is connected), so this component never has to redirect
// anywhere and never has to think about a connected vault.
//
// The fork (SYNTHESIS D10): if a DOOR is serving us — an identity/issuer that
// answers OAuth discovery at this origin, i.e. the account ceremony lives here
// — offer "Create your Parachute" (same-origin `/signup`) alongside connecting
// a vault you already own. If it's a static host (no door), lead with
// connect-by-URL. We never present the serving origin *itself* as a connectable
// vault — that was the surface#193 misdetection (a door is not a vault).
export function Landing() {
  const door = useOwnOriginDoor();

  return (
    <div className="mx-auto max-w-2xl px-6 py-20 text-center">
      <p className="mb-6 font-serif text-xl italic text-fg-muted">
        A soft place for your thoughts to land.
      </p>
      <h1 className="mb-4 font-serif text-5xl tracking-tight">Parachute</h1>

      {/* Hold the CTA back while probing so we don't flash the connect-by-URL
          affordance and then swap in the create/connect fork once the door
          probe resolves. Reserve vertical space so the wordmark doesn't jump. */}
      {door === "probing" ? (
        <div className="h-28" aria-hidden="true" />
      ) : door === "door" ? (
        <>
          <p className="mb-8 text-fg-dim tracking-wide">
            Your notes, your vault, any AI. Create one in a minute — or connect one you already
            have.
          </p>
          {/* A plain full-page nav: `/signup` is the door's server-rendered
              account ceremony on this same origin, not an SPA route. */}
          <a
            href="/signup"
            className="inline-block rounded-md bg-accent px-6 py-3 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
          >
            Create your Parachute
          </a>
          <div className="mt-4">
            <Link to="/add" className="text-sm text-fg-dim hover:text-accent">
              I already have a vault
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="mb-10 text-fg-dim tracking-wide">
            Point it at a vault. Sign in. Browse, edit, visualize.
          </p>
          <Link
            to="/add"
            className="inline-block rounded-md bg-accent px-6 py-3 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
          >
            Connect a vault
          </Link>
        </>
      )}
    </div>
  );
}
