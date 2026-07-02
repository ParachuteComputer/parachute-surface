import { InsecureContextBanner } from "@/components/InsecureContextBanner";
import { beginOAuth, normalizeVaultUrl, useOriginVaultProbe } from "@/lib/vault";
import { InsecureContextError } from "@/lib/vault/pkce";
import { useVaultStore } from "@/lib/vault/store";
import { safeInternalRedirect, vaultIdFromUrl } from "@/lib/vault/url";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

export function AddVault() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryUrl = searchParams.get("url") ?? "";
  // `?add=<vault url>` — the cloud console's "Open in Notes" deep link
  // (NotesIndex forwards a root-path `/?add=…` here). An alias of the
  // existing `?url=` deep link (hub `/account` "Import notes", notes#63)
  // that ALSO auto-begins the connect flow: both prefill the same field and
  // both funnel into the same connect() path below. `?url=` stays
  // prefill-only so the hub flow keeps its confirm-with-Continue shape.
  // Only explicit http(s) values are honoured for auto-begin, and the param
  // is stripped from history once consumed so refresh/back can't re-trigger.
  const addUrl = searchParams.get("add") ?? "";
  const addUrlIsHttp = /^https?:\/\//i.test(addUrl);
  // One prefill source: an explicit ?url= wins (hub flow), else a valid ?add=.
  const initialUrl = queryUrl || (addUrlIsHttp ? addUrl : "");
  // Post-connect landing path (notes#63) — the hub `/account` "Import notes"
  // deep-link arrives as `/add?url=…&redirect=/import`. Sanitized to an
  // in-app same-origin path so it can never become an open redirect; an
  // invalid value falls back to the default `/` landing in OAuthCallback.
  const redirect = safeInternalRedirect(searchParams.get("redirect"));
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [insecureContext, setInsecureContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const prefilled = useRef(initialUrl.length > 0);
  const autoBeginRan = useRef(false);
  const probe = useOriginVaultProbe();

  // Auto-focus so the user can submit with Enter when the URL is pre-filled
  // via ?url=... or the origin probe. Runs once on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // If the probe resolves with a detected origin and the user hasn't typed
  // anything, seed the input. Don't clobber a ?url=/?add= value or user input.
  useEffect(() => {
    if (prefilled.current) return;
    if (probe.status === "found" && probe.origin && url === "") {
      setUrl(probe.origin);
      prefilled.current = true;
    }
  }, [probe.status, probe.origin, url]);

  // The one connect code path — the form submit and the ?add= auto-begin
  // both go through the same normalize → beginOAuth → redirect sequence and
  // surface errors identically.
  const connect = useCallback(
    async (rawUrl: string) => {
      setError(null);
      setInsecureContext(false);

      let normalized: string;
      try {
        normalized = normalizeVaultUrl(rawUrl);
      } catch (err) {
        setError((err as Error).message);
        return;
      }

      setSubmitting(true);
      try {
        const { authorizeUrl } = await beginOAuth(normalized, undefined, undefined, {
          ...(redirect ? { redirect } : {}),
        });
        window.location.assign(authorizeUrl);
      } catch (err) {
        // Web Crypto isn't available on non-HTTPS / non-localhost origins,
        // so PKCE can't run at all. Render a distinct banner (different
        // colour + structured remediations) instead of the generic
        // "Connection failed" message so the operator understands the
        // browser-secure-context cause and the two fix paths.
        if (err instanceof InsecureContextError) {
          setInsecureContext(true);
        } else {
          setError((err as Error).message);
        }
        setSubmitting(false);
      }
    },
    [redirect],
  );

  // ?add= auto-begin. Runs at most once per mount; the field is already
  // prefilled via `initialUrl` above.
  useEffect(() => {
    if (autoBeginRan.current || !addUrl) return;
    autoBeginRan.current = true;

    // Strip the param from history first (replace, not push) so a refresh
    // or back-navigation never re-triggers the auto-connect.
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    setSearchParams(next, { replace: true });

    // When an explicit ?url= rides along, prefill-only wins: the field
    // displays queryUrl, so auto-beginning against a DIFFERENT ?add= value
    // would be a display/action mismatch a crafted link could exploit.
    if (queryUrl) return;

    // Only explicit http(s) URLs may auto-begin OAuth — a crafted link must
    // not smuggle another scheme (or a bare hostname) into the flow.
    if (!addUrlIsHttp) return;

    let normalized: string;
    try {
      normalized = normalizeVaultUrl(addUrl);
    } catch {
      // Malformed — leave the prefilled value for the user to correct.
      return;
    }

    // Already connected to this vault? Switch to it instead of running a
    // second OAuth dance.
    const store = useVaultStore.getState();
    const existing = store.vaults[vaultIdFromUrl(normalized)];
    if (existing) {
      store.setActiveVault(existing.id);
      navigate("/", { replace: true });
      return;
    }

    void connect(normalized);
  }, [addUrl, addUrlIsHttp, queryUrl, searchParams, setSearchParams, navigate, connect]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void connect(url);
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="mb-2 font-serif text-4xl tracking-tight">Connect a vault</h1>
      <p className="mb-8 text-fg-muted">
        Paste your vault address. You'll be taken to its consent page to authorize Parachute Notes.
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="vault-url" className="mb-1.5 block text-sm font-medium text-fg">
            Vault address
          </label>
          <input
            id="vault-url"
            ref={inputRef}
            type="url"
            required
            placeholder="https://u.parachute.computer/vault/your-name"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none"
          />
          <p className="mt-1.5 text-xs text-fg-dim">
            From your cloud console at <code>cloud.parachute.computer</code>, or your own Parachute
            hub — a local install lives at <code>http://localhost:1939</code>.
          </p>
        </div>

        {insecureContext ? <InsecureContextBanner /> : null}

        {error ? (
          <div className="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={submitting || !url}
          className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Starting OAuth…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
