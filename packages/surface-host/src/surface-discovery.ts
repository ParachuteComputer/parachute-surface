/**
 * `#surface` discovery — the "vault declares" half of the Surface Git Transport
 * (Phase 1, design doc 2026-06-30-surface-git-transport.md §9/§10).
 *
 * A surface is a vault-native entity, parallel to `#agent/thread`: a note tagged
 * `#surface` whose metadata declares `{ mount, mode, source: { ref }, scopes }`.
 * surface-host is the READER (it custodies a vault read cred); the hub is the
 * substrate. So on boot surface-host:
 *
 *   1. queries the vault for `tag:surface` (with a custodied read credential),
 *   2. parses each note into a {@link DeclaredSurface}, and
 *   3. REGISTERS each with the hub over `POST /admin/surfaces` (operator-authed)
 *      — which provisions the bare repo + records the name→repo mapping the
 *      `/git/<name>` transport gates provisioning on.
 *
 * This realizes "the vault declares; the hub authenticates; surface-host serves":
 * a surface exists the moment its note does, ready to receive a `git push`, even
 * before the first push lands. Discovery is BEST-EFFORT (mirrors the
 * credential-renewal + redirect-self-heal boot sweeps): a missing read cred, an
 * unreachable vault, or a malformed note logs + is skipped, never blocks startup.
 *
 * The git SOURCE is never in the vault — the note holds only the low-churn
 * declaration + a pointer (§9). Serving the actual bytes happens when a push
 * arrives (git-deploy.ts).
 */
import type { Note, NotesQueryInput } from "@openparachute/surface-client";
import { NAME_PATTERN } from "./meta-schema.ts";

/** The tag that declares a surface. */
export const SURFACE_TAG = "surface";

/**
 * Minimal fetch signature (matches dcr.ts `FetchFn`) — a plain callable, not
 * `typeof fetch` (whose extra `preconnect` prop the injected test/dcr fetch
 * doesn't carry). The real `fetch` is assignable to it.
 */
export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DeclaredSurface {
  /** Canonical surface name (the `/git/<name>` + `/surface/<name>` segment). */
  name: string;
  /** Mount path — always the canonical `/surface/<name>`. */
  mount: string;
  /** Declared mode; defaults to "prod" when the note omits it. */
  mode: "dev" | "prod";
  /** Optional source ref pointer (`metadata.source.ref`), informational. */
  sourceRef?: string;
  /** Declared backend scopes (`metadata.scopes`), informational. */
  scopes?: string[];
  /** The declaring note's id (for logging + dedupe). */
  noteId: string;
}

export type SkippedSurface = { noteId: string; reason: string };

export interface DiscoverLog {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/** Last path/mount segment (after the final `/`), trimmed. */
function lastSegment(s: string): string {
  const parts = s.split("/").filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : "";
}

/**
 * Parse a `#surface` note into a {@link DeclaredSurface}, or return an error
 * string when it can't be resolved to a servable name. Pure — no I/O.
 *
 * Name resolution (first that matches {@link NAME_PATTERN} wins): explicit
 * `metadata.name` → the `/surface/<name>` suffix of `metadata.mount` → the last
 * path segment of the note. The mount is ALWAYS the canonical `/surface/<name>`
 * (the note's `mount` is only a hint for deriving the name); the name is the one
 * key the hub registry + git endpoint agree on.
 */
export function parseSurfaceNote(note: Note): DeclaredSurface | { error: string } {
  const meta = (note.metadata ?? {}) as Record<string, unknown>;

  const candidates: string[] = [];
  if (typeof meta.name === "string" && meta.name.length > 0) candidates.push(meta.name);
  if (typeof meta.mount === "string" && meta.mount.length > 0)
    candidates.push(lastSegment(meta.mount));
  if (typeof note.path === "string" && note.path.length > 0)
    candidates.push(lastSegment(note.path));

  const name = candidates.find((c) => NAME_PATTERN.test(c));
  if (!name) {
    return {
      error: `no servable name (must match ${NAME_PATTERN.source}) from metadata.name / mount / path — tried [${candidates.join(", ") || "none"}]`,
    };
  }

  const mode = meta.mode === "dev" ? "dev" : "prod";

  let sourceRef: string | undefined;
  const source = meta.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const ref = (source as Record<string, unknown>).ref;
    if (typeof ref === "string" && ref.length > 0) sourceRef = ref;
  }

  let scopes: string[] | undefined;
  if (Array.isArray(meta.scopes)) {
    const strs = meta.scopes.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (strs.length > 0) scopes = strs;
  }

  return {
    name,
    mount: `/surface/${name}`,
    mode,
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
    noteId: note.id,
  };
}

/**
 * Query the vault for `tag:surface` and parse each note. Best-effort: a query
 * failure returns empty (logged); a malformed note is skipped + surfaced in
 * `skipped`. Deduped by name (first declaration wins; a later collision is a
 * skip) so two notes can't fight over one mount.
 */
export async function discoverDeclaredSurfaces(opts: {
  queryNotes: (q: NotesQueryInput) => Promise<Note[]>;
  logger?: DiscoverLog;
}): Promise<{ declared: DeclaredSurface[]; skipped: SkippedSurface[] }> {
  const logger = opts.logger ?? console;
  let notes: Note[];
  try {
    notes = await opts.queryNotes({ tag: SURFACE_TAG, includeMetadata: true });
  } catch (e) {
    logger.warn(
      `[surface-discovery] vault query for tag:${SURFACE_TAG} failed: ${(e as Error).message}`,
    );
    return { declared: [], skipped: [] };
  }

  const declared: DeclaredSurface[] = [];
  const skipped: SkippedSurface[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    const parsed = parseSurfaceNote(note);
    if ("error" in parsed) {
      logger.warn(`[surface-discovery] skip note ${note.id}: ${parsed.error}`);
      skipped.push({ noteId: note.id, reason: parsed.error });
      continue;
    }
    if (seen.has(parsed.name)) {
      const reason = `duplicate surface name "${parsed.name}" — first declaration wins`;
      logger.warn(`[surface-discovery] skip note ${note.id}: ${reason}`);
      skipped.push({ noteId: note.id, reason });
      continue;
    }
    seen.add(parsed.name);
    declared.push(parsed);
  }
  return { declared, skipped };
}

export type RegisterOutcome = {
  registered: string[];
  failed: Array<{ name: string; reason: string }>;
};

/**
 * Register each declared surface with the hub (`POST /admin/surfaces`,
 * operator-authed). Idempotent hub-side; best-effort per surface (one failure
 * never stops the rest). Returns which registered vs failed for the boot log.
 */
export async function registerDeclaredSurfaces(opts: {
  surfaces: DeclaredSurface[];
  hubOrigin: string;
  operatorToken: string;
  fetchImpl?: FetchLike;
  logger?: DiscoverLog;
}): Promise<RegisterOutcome> {
  const logger = opts.logger ?? console;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = `${opts.hubOrigin.replace(/\/+$/, "")}/admin/surfaces`;
  const out: RegisterOutcome = { registered: [], failed: [] };

  for (const s of opts.surfaces) {
    try {
      // Phase 1 sends only { name, mount, mode }; the declaration's `sourceRef` +
      // `scopes` stay informational on `DeclaredSurface` (a later phase can
      // forward them to the hub for access-gating / mirror config).
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: s.name, mount: s.mount, mode: s.mode }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const text = (await res.text()).trim();
          if (text) detail += `: ${text.slice(0, 200)}`;
        } catch {
          // best-effort detail
        }
        logger.warn(`[surface-discovery] hub rejected register of "${s.name}" (${detail})`);
        out.failed.push({ name: s.name, reason: detail });
        continue;
      }
      out.registered.push(s.name);
    } catch (e) {
      const reason = (e as Error).message;
      logger.warn(`[surface-discovery] register of "${s.name}" failed: ${reason}`);
      out.failed.push({ name: s.name, reason });
    }
  }
  return out;
}

export type SurfaceDiscoveryResult = {
  declared: DeclaredSurface[];
  skipped: SkippedSurface[];
  registered: string[];
  failed: Array<{ name: string; reason: string }>;
  /** Set when the whole pass was skipped before querying (else undefined). */
  skipReason?: string;
};

/**
 * The boot-time sweep: discover `#surface` notes → register each with the hub.
 * Composed from the pieces above so `serve()` wires one call. Returns a summary
 * for the daemon log. Skips cleanly (with `skipReason`) when no operator token
 * or no vault query fn is available — never throws.
 */
export async function runSurfaceDiscovery(opts: {
  /** Vault query fn (built over a custodied read credential in serve()). */
  queryNotes?: (q: NotesQueryInput) => Promise<Note[]>;
  hubOrigin: string;
  /** Operator bearer for the hub register call. */
  operatorToken?: string;
  fetchImpl?: FetchLike;
  logger?: DiscoverLog;
}): Promise<SurfaceDiscoveryResult> {
  const logger = opts.logger ?? console;
  const base: SurfaceDiscoveryResult = { declared: [], skipped: [], registered: [], failed: [] };

  if (!opts.queryNotes) {
    return { ...base, skipReason: "no vault read credential for surface discovery" };
  }
  if (!opts.operatorToken) {
    return {
      ...base,
      skipReason: "no operator token to register discovered surfaces with the hub",
    };
  }

  const { declared, skipped } = await discoverDeclaredSurfaces({
    queryNotes: opts.queryNotes,
    logger,
  });
  if (declared.length === 0) {
    return { ...base, skipped };
  }

  const reg = await registerDeclaredSurfaces({
    surfaces: declared,
    hubOrigin: opts.hubOrigin,
    operatorToken: opts.operatorToken,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    logger,
  });

  if (reg.registered.length > 0) {
    logger.log(
      `[surface-discovery] registered ${reg.registered.length} declared surface(s): ${reg.registered.join(", ")}`,
    );
  }
  return { declared, skipped, registered: reg.registered, failed: reg.failed };
}
