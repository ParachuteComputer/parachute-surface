/**
 * The docs surface's REST routes — all riding the kit's deny-by-default
 * gateway (P7/P8: rate limit → entry route → actor resolution → origin
 * check → access declaration → handler).
 *
 * Trust shape (backed-surface pattern "the hybrid"):
 *
 *   - The backend serves the AUDIENCE (doc list/read, collab tickets) and
 *     the operator's SURFACE-DOMAIN ops (shares = capability links +
 *     grants, doc create, collab status) — authenticated per-request by
 *     hub JWT. No generic vault proxy: every read is scoped to the
 *     working tag and authorized per-note; the only shapes that leave are
 *     the ones built here.
 *   - Mutating doc CONTENT happens over the collab WS (CRDT →
 *     reconciler → `if_updated_at` writeback), never via REST — one
 *     write path, one conflict story.
 *   - `manage_*` actions (grants, tags, paths) are operator-only by kit
 *     policy; the routes below never offer tag/path writes to any actor.
 */

import type { SurfaceHostContext } from "@openparachute/surface";
import type { Note } from "@openparachute/surface-client";
import type { Level, SurfaceAuth, SurfaceAuthz, SurfaceRoute } from "@openparachute/surface-server";
import { isLevel } from "@openparachute/surface-server";
import type { Collab } from "./collab.ts";
import type { TicketStore } from "./tickets.ts";

export interface RoutesDeps {
  ctx: SurfaceHostContext;
  auth: SurfaceAuth;
  authz: SurfaceAuthz;
  tickets: TicketStore;
  collab: Collab;
  /** The surface's working tag (doc list scope + new-doc tag). */
  workingTag: string;
}

/** First `# heading` or first non-empty line — the list/display title. */
export function titleOf(note: Note): string {
  const content = note.content ?? note.preview ?? "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.replace(/^#{1,6}\s+/, "").slice(0, 120);
  }
  if (note.path) {
    const base = note.path.split("/").pop() ?? "";
    if (base.length > 0) return base.replace(/\.md$/, "");
  }
  return "Untitled";
}

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}

export function buildRoutes(deps: RoutesDeps): SurfaceRoute[] {
  const { ctx, auth, authz, tickets, collab, workingTag } = deps;

  return [
    // -- session probe ----------------------------------------------------
    {
      method: "GET",
      path: "/api/me",
      access: { kind: "public" },
      handler: async (_req, { actor }) => {
        if (actor.kind === "operator") {
          return Response.json({ kind: "operator" });
        }
        if (actor.kind === "audience") {
          return Response.json({
            kind: "audience",
            subject: actor.subjectId !== null ? "personal" : "link",
          });
        }
        return Response.json({ kind: "anon" });
      },
    },

    // -- docs -------------------------------------------------------------
    {
      method: "GET",
      path: "/api/docs",
      access: { kind: "audience" },
      handler: async (_req, { actor }) => {
        const notes = await ctx.vault.queryNotes({
          tag: workingTag,
          expand: "exact",
          includeContent: true,
        });
        const docs: unknown[] = [];
        for (const note of notes) {
          if (actor.kind === "operator") {
            docs.push({
              id: note.id,
              title: titleOf(note),
              updatedAt: note.updatedAt ?? null,
              level: "owner",
            });
            continue;
          }
          // Audience: only docs this actor holds a grant on — and the
          // level rides along so the UI can label read-only docs.
          const level = await authz.levelFor(actor, note);
          if (level === null) continue;
          docs.push({
            id: note.id,
            title: titleOf(note),
            updatedAt: note.updatedAt ?? null,
            level,
          });
        }
        return Response.json({ docs });
      },
    },
    {
      method: "POST",
      path: "/api/docs",
      access: { kind: "operator" },
      handler: async (req) => {
        let body: { title?: unknown };
        try {
          body = (await req.json()) as { title?: unknown };
        } catch {
          return badRequest("body must be JSON");
        }
        const title =
          typeof body.title === "string" && body.title.trim().length > 0
            ? body.title.trim()
            : "Untitled";
        const note = await ctx.vault.createNote({
          content: `# ${title}\n`,
          tags: [workingTag],
        });
        return Response.json(
          { id: note.id, title, updatedAt: note.updatedAt ?? null },
          { status: 201 },
        );
      },
    },
    {
      method: "GET",
      path: "/api/doc/:id",
      access: { kind: "note", action: "read" },
      handler: async (_req, { actor, note }) => {
        const n = note as Note;
        const editable = actor.kind === "operator" || (await authz.can(actor, n, "edit_content"));
        return Response.json({
          id: n.id,
          title: titleOf(n),
          content: n.content ?? "",
          updatedAt: n.updatedAt ?? null,
          editable,
        });
      },
    },

    // -- collab -----------------------------------------------------------
    {
      method: "POST",
      path: "/api/collab/ticket",
      access: { kind: "audience" },
      handler: async (_req, { actor }) => {
        const minted = tickets.mint(actor);
        return Response.json({
          ticket: minted.ticket,
          expiresInMs: minted.expiresInMs,
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/status",
      access: { kind: "operator" },
      handler: async () => Response.json({ presence: collab.presence() }),
    },

    // -- shares (operator surface-domain ops) ------------------------------
    {
      method: "POST",
      path: "/api/shares",
      access: { kind: "operator" },
      handler: async (req) => {
        let body: {
          noteId?: unknown;
          level?: unknown;
          email?: unknown;
          expiresAt?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return badRequest("body must be JSON");
        }
        if (typeof body.noteId !== "string" || body.noteId.length === 0) {
          return badRequest("noteId is required");
        }
        if (!isLevel(body.level)) {
          return badRequest('level must be one of "view", "comment", "suggest", "edit"');
        }
        const level: Level = body.level;
        const expiresAt =
          typeof body.expiresAt === "string" && body.expiresAt.length > 0 ? body.expiresAt : null;
        // The share must point at a real doc in the working scope — refuse
        // dangling grants instead of minting a link to nothing.
        const note = await ctx.vault.getNote(body.noteId);
        if (note === null) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }

        if (body.email !== undefined) {
          if (typeof body.email !== "string" || !body.email.includes("@")) {
            return badRequest("email must be an address");
          }
          // Personal link: single-use exchange bound to an email subject;
          // the durable grant attaches to the SUBJECT so re-issued links
          // (the recovery flow) keep the same access.
          const link = await auth.mintPersonalLink({ email: body.email, expiresAt });
          const grant = await authz.grants.createGrant({
            subject: `subject:${link.subjectId}`,
            resourceType: "note",
            resource: note.id,
            level,
            expiresAt: null,
          });
          return Response.json(
            {
              kind: "personal",
              entryPath: link.entryPath,
              delivered: link.delivered,
              capabilityId: link.id,
              subjectId: link.subjectId,
              grantId: grant.id,
            },
            { status: 201 },
          );
        }

        // Capability link: anonymous bearer of the grant.
        const cap = auth.mintCapability({ expiresAt });
        const grant = await authz.grants.createGrant({
          subject: `cap:${cap.id}`,
          resourceType: "note",
          resource: note.id,
          level,
          expiresAt,
        });
        return Response.json(
          {
            kind: "capability",
            entryPath: cap.entryPath,
            token: cap.token,
            capabilityId: cap.id,
            grantId: grant.id,
          },
          { status: 201 },
        );
      },
    },
    {
      method: "GET",
      path: "/api/shares",
      access: { kind: "operator" },
      handler: async () => Response.json({ grants: authz.grants.listGrants() }),
    },
    {
      method: "DELETE",
      path: "/api/shares/:id",
      access: { kind: "operator" },
      handler: async (_req, { params }) => {
        const id = params.id ?? "";
        const grant = authz.grants.listGrants().find((g) => g.id === id);
        if (!grant) {
          return Response.json({ error: "not_found" }, { status: 404 });
        }
        await authz.grants.revokeGrant(grant.id);
        // A capability-subject share also revokes the link itself, killing
        // any live sessions minted from it.
        if (grant.subject.startsWith("cap:")) {
          auth.revokeCapability(grant.subject.slice(4));
        }
        return Response.json({ ok: true });
      },
    },
  ];
}
