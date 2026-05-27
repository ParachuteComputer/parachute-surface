import { getHubOrigin } from "@openparachute/surface-client";
import { useEffect, useState } from "react";
import { discoverAuthServer } from "./discovery";
import { useVaultStore } from "./store";

export type ProbeStatus = "probing" | "found" | "not-found" | "skipped";

export interface ProbeResult {
  status: ProbeStatus;
  // The OAuth issuer URL — passed straight into `beginOAuth`. Under
  // hub-as-issuer this is the hub origin; under a standalone vault it's the
  // vault URL. Naming `origin` (not `issuerUrl`) is kept for backwards-compat
  // with existing callers; semantically these are the same thing.
  origin: string | null;
}

const DEFAULT_TIMEOUT_MS = 2500;

// Canonical Parachute hub address on a local install. The hub binds itself
// to 127.0.0.1:1939 (see parachute-hub/src/service-spec.ts). Hardcoded here
// because the browser has no other way to discover it — `~/.parachute/hub.port`
// is on disk, not visible to JS. Used as a fallback when the same-origin
// probe fails (e.g. Notes is served standalone at :1942 instead of behind
// the hub portal at :1939/notes).
const LOCAL_HUB_URL = "http://127.0.0.1:1939";

// Probe a candidate URL for an OAuth authorization server. Under hub-as-issuer
// the hub origin itself answers `/.well-known/oauth-authorization-server`; the
// JWT it mints carries a `services` catalog so notes never has to chase a
// vault URL separately. For a standalone vault (no hub fronting it), the
// vault URL itself answers OAuth metadata directly. Same probe shape covers
// both cases.
//
// Returns the probed URL on success, or `null` if discovery fails or times out.
export async function probeIssuerAtOrigin(
  origin: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<string | null> {
  return tryDiscoverAuthServer(origin, timeoutMs, fetchImpl);
}

async function tryDiscoverAuthServer(
  candidate: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const withSignal: typeof fetch = (input, init) =>
    fetchImpl(input, { ...(init ?? {}), signal: ctrl.signal });
  try {
    await discoverAuthServer(candidate, withSignal);
    return candidate;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolution order, in preference:
//   1. `<meta name="parachute-hub">` — host (parachute-surface) explicitly
//      tells the bundle which hub to OAuth against. Authoritative when
//      present; covers the cross-origin bundled case (notes-ui served at
//      notes.example.com with the hub at hub.example.com).
//   2. Same-origin probe — when the bundle and the hub share an origin
//      (the default localhost install, or single-origin Render deploys).
//   3. Loopback fallback to `127.0.0.1:1939` — covers the standalone-notes
//      case (`parachute install notes` → `http://localhost:1942/notes`):
//      the static notes server doesn't serve OAuth metadata, but the hub
//      on 1939 does. Only attempted for localhost-ish origins not already
//      on the hub port (CORS would block it for remote origins anyway).
//
// CORS note: the loopback fallback is cross-origin (1942 → 1939). The hub
// must serve `Access-Control-Allow-Origin: *` on
// `/.well-known/oauth-authorization-server` for the browser to expose the
// response body. If it doesn't, the fetch rejects and we fall through to
// manual entry.
export async function probeForIssuer(
  pageOrigin: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  hubMetaOrigin: string | null = readHubMetaOrigin(),
): Promise<string | null> {
  if (hubMetaOrigin) {
    const hub = await probeIssuerAtOrigin(hubMetaOrigin, timeoutMs, fetchImpl);
    if (hub) return hub;
    // Meta tag was present but didn't answer OAuth metadata — fall through
    // to the page-origin and loopback fallbacks rather than failing closed.
    // A misconfigured host should still let the operator enter a hub URL
    // manually, not block the surface entirely.
  }

  const sameOrigin = await probeIssuerAtOrigin(pageOrigin, timeoutMs, fetchImpl);
  if (sameOrigin) return sameOrigin;

  if (shouldTryLocalHubFallback(pageOrigin)) {
    const local = await probeIssuerAtOrigin(LOCAL_HUB_URL, timeoutMs, fetchImpl);
    if (local) return local;
  }

  return null;
}

// Read the runtime-tenancy `<meta name="parachute-hub">` tag injected by
// parachute-surface. Returns null outside the DOM (SSR / tests without a
// document) or when the host hasn't injected it. See
// `parachute-patterns/patterns/runtime-tenancy-contract.md`.
function readHubMetaOrigin(): string | null {
  if (typeof document === "undefined") return null;
  return getHubOrigin();
}

export function shouldTryLocalHubFallback(pageOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(pageOrigin);
  } catch {
    return false;
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!isLoopback) return false;
  // Already on the hub origin — same-origin probe already covered it.
  if (url.origin === LOCAL_HUB_URL) return false;
  return true;
}

// Probe the current window's origin on mount, but skip if the user already has
// vaults in storage — their choice is already made and a probe would just be
// noise + a wasted request.
export function useOriginVaultProbe(): ProbeResult {
  const hasVaults = useVaultStore((s) => Object.keys(s.vaults).length > 0);
  const [result, setResult] = useState<ProbeResult>(() => ({
    status: hasVaults ? "skipped" : "probing",
    origin: null,
  }));

  useEffect(() => {
    if (hasVaults) {
      setResult({ status: "skipped", origin: null });
      return;
    }
    let cancelled = false;
    setResult({ status: "probing", origin: null });
    probeForIssuer(window.location.origin).then((found) => {
      if (cancelled) return;
      setResult(found ? { status: "found", origin: found } : { status: "not-found", origin: null });
    });
    return () => {
      cancelled = true;
    };
  }, [hasVaults]);

  return result;
}
