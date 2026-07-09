import { noteTitle, pathLeaf, stripLeadingH1 } from "@/lib/note-title";
import { useActiveVaultClient, useNote } from "@/lib/vault";
import {
  DEFAULT_DEPTH,
  type GraphNode,
  MAX_DEPTH,
  MIN_DEPTH,
  type NeighborhoodGraphData,
  useNeighborhood,
} from "@/lib/vault/neighborhood";
import type { Note } from "@/lib/vault/types";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

const ForceGraph2D = lazy(() => import("react-force-graph-2d"));

interface Props {
  anchor: Note;
}

export function NeighborhoodGraph({ anchor }: Props) {
  const [open, setOpen] = useState(true);
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const client = useActiveVaultClient();
  const { data, isLoading } = useNeighborhood(client, open ? anchor : undefined, depth);

  return (
    <section className="mt-10 border-t border-border pt-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="font-serif text-xl text-fg hover:text-accent"
          >
            {open ? "▾" : "▸"} Neighborhood
          </button>
          {open && data ? (
            <span className="text-xs text-fg-dim">
              {data.nodes.length} {data.nodes.length === 1 ? "note" : "notes"}
            </span>
          ) : null}
        </div>
        {open ? <DepthControl depth={depth} onChange={setDepth} /> : null}
      </header>

      {open ? <Body data={data} isLoading={isLoading} /> : null}
    </section>
  );
}

function DepthControl({ depth, onChange }: { depth: number; onChange: (d: number) => void }) {
  const options: number[] = [];
  for (let i = MIN_DEPTH; i <= MAX_DEPTH; i++) options.push(i);
  return (
    <fieldset className="flex items-center gap-1 text-xs text-fg-dim">
      <legend className="mr-1 inline-block">Hops</legend>
      {options.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={d === depth}
          onClick={() => onChange(d)}
          className={
            d === depth
              ? "rounded border border-accent bg-accent/10 px-2 py-0.5 text-accent"
              : "rounded border border-border bg-card px-2 py-0.5 hover:text-accent"
          }
        >
          {d}
        </button>
      ))}
    </fieldset>
  );
}

function Body({ data, isLoading }: { data: NeighborhoodGraphData | null; isLoading: boolean }) {
  // The neighbor a click/tap selected for preview. Held here (not in the canvas)
  // so BOTH the graph and the keyboard-accessible list feed the same preview.
  const [previewId, setPreviewId] = useState<string | null>(null);
  // The element that opened the preview, so an explicit close (Esc / ✕) can
  // return focus to it rather than dropping to <body>.
  const triggerRef = useRef<HTMLElement | null>(null);

  // Drop a stale selection when a depth round-trip removes the node from the
  // graph — otherwise raising the depth back would re-open the card unbidden.
  useEffect(() => {
    if (previewId && data && !data.nodes.some((n) => n.id === previewId)) {
      setPreviewId(null);
    }
  }, [data, previewId]);

  if (!data && isLoading) {
    return <GraphSkeleton />;
  }
  if (!data) return null;
  if (data.nodes.length <= 1) {
    return (
      <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-fg-dim">
        This note has no neighbors yet.
      </div>
    );
  }

  const neighbors = data.nodes.filter((n) => !n.isAnchor);
  const previewNode = previewId ? (data.nodes.find((n) => n.id === previewId) ?? null) : null;

  const select = (id: string) => {
    // Remember what to restore focus to (the graph node-click leaves focus on
    // the canvas/body — fine; a list button leaves it on that button).
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    setPreviewId(id);
  };
  const close = (opts?: { restoreFocus?: boolean }) => {
    setPreviewId(null);
    if (opts?.restoreFocus) triggerRef.current?.focus?.();
  };

  return (
    <>
      <GraphCanvas data={data} onSelect={select} />
      {previewNode ? (
        <NeighborPreview key={previewNode.id} node={previewNode} onClose={close} />
      ) : null}
      <NeighborList neighbors={neighbors} selectedId={previewId} onSelect={select} />
    </>
  );
}

// A keyboard- and touch-accessible way into the neighborhood: the force graph
// is a canvas (no focusable nodes), so this list is how you reach a neighbor
// without a mouse. Each button opens the same preview a graph node-click does.
function NeighborList({
  neighbors,
  selectedId,
  onSelect,
}: {
  neighbors: GraphNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (neighbors.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="eyebrow mb-2">Neighbors</h3>
      <ul className="flex flex-wrap gap-2">
        {neighbors.map((n) => {
          const label = pathLeaf(n.path ?? n.id);
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                aria-haspopup="dialog"
                aria-pressed={selectedId === n.id}
                aria-label={`Preview ${label}`}
                className={`btn btn-sm btn-touch max-w-full ${
                  selectedId === n.id ? "btn-primary" : "btn-secondary"
                }`}
              >
                <span className="truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The mini preview card: title + tags render instantly from the graph node;
// the snippet is fetched lazily (one note, via the shared query cache — never
// the whole graph) on open. Non-modal dialog: focus lands on it, Esc closes,
// blurring away (Tab out / click elsewhere) closes, and "Open note" navigates.
function NeighborPreview({
  node,
  onClose,
}: {
  node: GraphNode;
  onClose: (opts?: { restoreFocus?: boolean }) => void;
}) {
  const note = useNote(node.id);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const title = noteTitle({ id: node.id, path: node.path, content: note.data?.content });
  const snippet = previewSnippet(note.data);

  return (
    // biome-ignore lint/a11y/useSemanticElements: non-modal inline popover; a native <dialog> wants showModal() (jsdom-unfriendly) and traps focus — this is a declarative focus-on-open + Esc/blur-close card.
    <div
      role="dialog"
      ref={ref}
      aria-label="Note preview"
      tabIndex={-1}
      data-testid="neighbor-preview"
      onKeyDown={(e) => {
        // Explicit close → hand focus back to whatever opened the card.
        if (e.key === "Escape") onClose({ restoreFocus: true });
      }}
      onBlur={(e) => {
        // Close when focus leaves the card entirely (keyboard Tab-out / click
        // away), but not when it moves to a child (the close button / link). No
        // focus restore here — the user is already moving focus themselves.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      className="focus-ring card mt-3 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate font-serif text-lg text-fg">{title}</h3>
        <button
          type="button"
          onClick={() => onClose({ restoreFocus: true })}
          aria-label="Close preview"
          className="shrink-0 text-fg-dim hover:text-accent"
        >
          ✕
        </button>
      </div>
      {node.tags && node.tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {node.tags.map((t) => (
            <span key={t} className="chip chip-tag max-w-full break-all">
              #{t}
            </span>
          ))}
        </div>
      ) : null}
      <PreviewSnippet
        isPaused={note.fetchStatus === "paused"}
        isPending={note.isPending}
        isError={note.isError}
        snippet={snippet}
      />
      <div className="mt-3">
        <Link to={`/n/${encodeURIComponent(node.id)}`} className="btn btn-primary btn-touch">
          Open note
        </Link>
      </div>
    </div>
  );
}

// The snippet line's states. Offline (query paused with no data) and error get
// honest lines instead of a permanent "Loading…" / "No preview text.".
function PreviewSnippet({
  isPaused,
  isPending,
  isError,
  snippet,
}: {
  isPaused: boolean;
  isPending: boolean;
  isError: boolean;
  snippet: string | null;
}) {
  // Paused-while-pending = offline with nothing cached; check it before the
  // generic pending state so we don't spin "Loading…" forever.
  if (isPaused && isPending) {
    return <p className="mt-2 text-sm text-fg-dim">Preview unavailable offline.</p>;
  }
  if (isPending) {
    return <p className="mt-2 text-sm text-fg-dim">Loading preview…</p>;
  }
  if (isError) {
    return <p className="mt-2 text-sm text-fg-dim">Couldn't load preview.</p>;
  }
  if (snippet) {
    return <p className="mt-2 text-sm text-fg-muted">{snippet}</p>;
  }
  return <p className="mt-2 text-sm text-fg-dim">No preview text.</p>;
}

// A short plain-text snippet for the preview: prefer the server's list preview,
// else the note body with its leading H1 (the title) stripped, truncated.
function previewSnippet(note: Note | null | undefined): string | null {
  if (!note) return null;
  const raw = (note.preview ?? stripLeadingH1(note.content ?? "")).trim();
  if (!raw) return null;
  return raw.length > 200 ? `${raw.slice(0, 200).trimEnd()}…` : raw;
}

function GraphSkeleton() {
  return (
    <div
      aria-busy="true"
      className="h-[24rem] w-full animate-pulse rounded-md border border-border bg-card"
    />
  );
}

function GraphCanvas({
  data,
  onSelect,
}: {
  data: NeighborhoodGraphData;
  onSelect: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 384 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: Math.max(320, Math.floor(rect.width)), h: 384 });
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const graphData = useMemo(
    () => ({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.edges.map((e) => ({ source: e.source, target: e.target, rel: e.relationship })),
    }),
    [data],
  );

  return (
    <div
      ref={containerRef}
      data-testid="neighborhood-graph-canvas"
      className="overflow-hidden rounded-md border border-border bg-card"
    >
      <Suspense fallback={<GraphSkeleton />}>
        <ForceGraph2D
          graphData={graphData}
          width={size.w}
          height={size.h}
          nodeLabel={(n) => nodeTooltip(n as unknown as GraphNode)}
          nodeVal={(n) => {
            const node = n as unknown as GraphNode;
            return node.isAnchor ? 8 : 3 + Math.min(node.linkCount, 8);
          }}
          nodeColor={(n) => ((n as unknown as GraphNode).isAnchor ? "#c9b170" : "#8a9a7a")}
          linkColor={() => "rgba(160, 160, 160, 0.4)"}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={80}
          onNodeClick={(n) => {
            // A click/tap opens a preview card (not a hard navigation) — the
            // neighborhood becomes a way to look before you move. The preview's
            // "Open note" does the navigation.
            const node = n as unknown as GraphNode;
            onSelect(node.id);
          }}
        />
      </Suspense>
    </div>
  );
}

function nodeTooltip(n: GraphNode): string {
  const lines = [n.path ?? n.id];
  if (n.tags && n.tags.length > 0) lines.push(`tags: ${n.tags.join(", ")}`);
  if (n.summary) lines.push(n.summary);
  return lines.join("\n");
}
