/**
 * The frontend's view of the docs backend — every call rides the surface's
 * own narrow API under `${mount}/api/*`. Two identities, one client:
 *
 *   - the OPERATOR sends a hub JWT Bearer (hosted-mode OAuth via
 *     surface-client — see auth.ts);
 *   - the AUDIENCE rides the httpOnly link-session cookie set by the
 *     capability entry URL (nothing to attach — `credentials` carries it).
 */

export interface Me {
  kind: "operator" | "audience" | "anon";
  subject?: "link" | "personal";
}

export interface DocListItem {
  id: string;
  title: string;
  updatedAt: string | null;
  level: "owner" | "view" | "comment" | "suggest" | "edit";
}

export interface DocDetail {
  id: string;
  title: string;
  content: string;
  updatedAt: string | null;
  editable: boolean;
}

export interface ShareGrant {
  id: string;
  subject: string;
  resourceType: string;
  resource: string;
  level: string;
  expiresAt: string | null;
}

export interface MintedShare {
  kind: "capability" | "personal";
  entryPath: string;
  token?: string;
  delivered?: boolean;
  grantId: string;
}

/** Resolve the surface mount from the host-injected tenancy meta tag. */
export function resolveMount(): string {
  const meta = document.querySelector('meta[name="parachute-mount"]');
  const content = meta?.getAttribute("content") ?? "";
  if (content.length > 0) return content.replace(/\/$/, "");
  // Standalone dev fallback: the vite base path.
  return import.meta.env.BASE_URL.replace(/\/$/, "") || "/surface/docs";
}

export class DocsApi {
  readonly mount: string;
  /** Returns the operator Bearer, or null for cookie/anon callers. */
  #bearer: () => string | null;

  constructor(opts: { mount?: string; bearer?: () => string | null } = {}) {
    this.mount = opts.mount ?? resolveMount();
    this.#bearer = opts.bearer ?? (() => null);
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const bearer = this.#bearer();
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    return fetch(`${this.mount}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.#request(path, init);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  me(): Promise<Me> {
    return this.#json<Me>("/api/me");
  }

  async listDocs(): Promise<DocListItem[]> {
    return (await this.#json<{ docs: DocListItem[] }>("/api/docs")).docs;
  }

  getDoc(id: string): Promise<DocDetail> {
    return this.#json<DocDetail>(`/api/doc/${encodeURIComponent(id)}`);
  }

  createDoc(title: string): Promise<{ id: string }> {
    return this.#json<{ id: string }>("/api/docs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }

  /** Single-use, short-TTL — mint per WS connect. */
  async ticket(): Promise<string> {
    const { ticket } = await this.#json<{ ticket: string }>("/api/collab/ticket", {
      method: "POST",
    });
    return ticket;
  }

  async listShares(): Promise<ShareGrant[]> {
    return (await this.#json<{ grants: ShareGrant[] }>("/api/shares")).grants;
  }

  mintShare(args: {
    noteId: string;
    level: string;
    email?: string;
    expiresAt?: string;
  }): Promise<MintedShare> {
    return this.#json<MintedShare>("/api/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  }

  async revokeShare(grantId: string): Promise<void> {
    await this.#json<{ ok: boolean }>(`/api/shares/${encodeURIComponent(grantId)}`, {
      method: "DELETE",
    });
  }

  /** ws(s):// URL for the collab endpoint. */
  wsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${this.mount}/ws`;
  }
}
