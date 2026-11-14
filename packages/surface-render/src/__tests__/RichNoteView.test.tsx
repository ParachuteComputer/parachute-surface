/**
 * NoteRenderer's `rich` switch and <RichNoteView> (vendored rich-notes-kit).
 * Made-up notes only (fixtures/rich-notes.ts).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../markdown/MarkdownView.js";
import { NoteRenderer } from "../note/NoteRenderer.js";
import { RichNoteView } from "../rich/RichNoteView.js";
import { hasRichPattern, parseRichNote } from "../rich/kit-api.js";
import { RICH, chant, hostile, minutes, plain, project, recipe } from "./fixtures/rich-notes.js";

beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("NoteRenderer rich switch", () => {
  it("a note with no rich pattern draws exactly as MarkdownView", () => {
    const a = render(<NoteRenderer note={plain} rich />);
    const b = render(<MarkdownView content={plain.content ?? ""} />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
    expect(a.container.querySelector(".rn")).toBeNull();
  });

  it("without `rich` (the default) every note is MarkdownView, even a recipe", () => {
    const { container } = render(<NoteRenderer note={recipe} />);
    expect(container.querySelector(".rn")).toBeNull();
    expect(container.querySelector(".prose-note")).not.toBeNull();
  });

  it("each pattern note draws with the kit", () => {
    for (const note of [recipe, minutes, project, chant]) {
      const { container, unmount } = render(<NoteRenderer note={note} rich />);
      expect(container.querySelector("article.rn")).not.toBeNull();
      unmount();
    }
  });

  it("overrides.markdown still wins over rich", () => {
    render(<NoteRenderer note={recipe} rich overrides={{ markdown: () => <p>custom</p> }} />);
    expect(screen.getByText("custom")).toBeInTheDocument();
  });

  it("non-markdown formats ignore rich", () => {
    const { container } = render(
      <NoteRenderer note={{ path: "data.json", content: '{"a":1}' }} rich />,
    );
    expect(container.querySelector(".rn")).toBeNull();
  });

  it("hasRichPattern: typed, tasks, logs, callouts, details, charts yes; plain no", () => {
    expect(hasRichPattern(parseRichNote({ ...plain, content: plain.content ?? "" }))).toBe(false);
    for (const n of [recipe, minutes, project, chant]) {
      expect(hasRichPattern(parseRichNote({ ...n, content: n.content ?? "" }))).toBe(true);
    }
  });
});

describe("RichNoteView host hooks", () => {
  it("a recipe draws its ingredients and scales", () => {
    const { container } = render(<RichNoteView note={recipe} />);
    expect(container.textContent).toContain("red lentils");
    expect(container.textContent).toContain("Simmer");
  });

  it("ticking a task saves a one-line patch through onSave", async () => {
    const onSave = vi.fn(async () => ({ updatedAt: "2026-11-13T00:00:00.000Z" }));
    const { container } = render(<RichNoteView note={project} onSave={onSave} />);
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:checked)');
    expect(box).not.toBeNull();
    fireEvent.click(box!);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [content, patch] = onSave.mock.calls[0] as unknown as [
      string,
      { op: string; after: string },
    ];
    expect(content).toContain("- [x] Measure the roof");
    expect(patch).toMatchObject({ op: "replace", after: expect.stringContaining("[x]") });
  });

  it("without a resolver, a wikilink is plain text", () => {
    const { container } = render(<RichNoteView note={project} />);
    expect(container.querySelector(".rn-wikilink")).not.toHaveAttribute("role");
  });

  it("without onSave, tasks are read-only", () => {
    const { container } = render(<RichNoteView note={project} />);
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });

  it("a wikilink goes through the resolver to onNavigate", async () => {
    const onNavigate = vi.fn();
    const resolve = (t: string) => ({ href: `/n/${encodeURIComponent(t)}`, exists: true });
    const { container } = render(
      <RichNoteView note={project} resolve={resolve} onNavigate={onNavigate} />,
    );
    const link = container.querySelector('.rn-wikilink[role="link"]');
    expect(link).toHaveTextContent("Tools list");
    fireEvent.click(link!);
    expect(onNavigate).toHaveBeenCalledWith("/n/Tools%20list");
  });

  it("a vault attachment loads through fetchBlob; nothing else is asked for", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    const note = {
      ...project,
      content: `${project.content}\n![plan](/api/storage/att/plan.png)\n![r](https://tracker.example/r.png)\n![o](attachments/other.png)\n`,
    };
    const { container } = render(<RichNoteView note={note} fetchBlob={fetchBlob} />);
    await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).not.toBeNull());
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    expect(fetchBlob).toHaveBeenCalledWith("/api/storage/att/plan.png");
  });

  it("the same note with new content updates in place", () => {
    const { container, rerender } = render(<RichNoteView note={project} />);
    const el = container.firstElementChild;
    rerender(
      <RichNoteView
        note={{ ...project, content: `${project.content}\n- 2026-11-12: patched.\n` }}
      />,
    );
    expect(container.firstElementChild).toBe(el);
    expect(container.textContent).toContain("patched.");
  });

  it("a different note starts fresh: the last note's sitting doesn't carry over", () => {
    const { container, rerender } = render(<RichNoteView note={recipe} />);
    const el = container.firstElementChild;
    const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    fireEvent.click(tick!);
    expect(container.querySelector('input[type="checkbox"]:checked')).not.toBeNull();
    const other = { ...recipe, id: "n-recipe-2", path: "Recipes/Other.md" };
    rerender(<RichNoteView note={other} />);
    expect(container.firstElementChild).not.toBe(el);
    expect(container.querySelector('input[type="checkbox"]:checked')).toBeNull();
  });

  it("onSave arriving after mount makes tasks writable; going away makes them read-only", () => {
    const onSave = vi.fn(async () => ({}));
    const { container, rerender } = render(<RichNoteView note={project} />);
    const open = () =>
      container.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:checked)');
    expect(open()?.disabled).toBe(true);
    rerender(<RichNoteView note={project} onSave={onSave} />);
    expect(open()?.disabled).toBe(false);
    rerender(<RichNoteView note={project} />);
    expect(open()?.disabled).toBe(true);
  });

  it("unmount clears the element", () => {
    const { container, unmount } = render(<RichNoteView note={recipe} />);
    unmount();
    expect(container.innerHTML).toBe("");
  });
});

/**
 * Network-zero: the kit's guarantee, kept inside surface. Every fixture is
 * drawn with every control opened; any request API the page could use, and
 * any URL-bearing node or attribute that would make the browser load
 * something, is recorded. A control request proves the recorder sees one.
 */
describe("a rendered note makes no request", () => {
  const seen: string[] = [];
  const restore: (() => void)[] = [];
  function spy<T extends object, K extends keyof T>(obj: T, key: K, make: (orig: T[K]) => T[K]) {
    const orig = obj[key];
    (obj as Record<K, T[K]>)[key] = make(orig);
    restore.push(() => {
      (obj as Record<K, T[K]>)[key] = orig;
    });
  }
  function record() {
    seen.length = 0;
    spy(
      globalThis,
      "fetch",
      () =>
        ((u: unknown) => {
          seen.push(`fetch ${String(u)}`);
          return Promise.reject(new Error("blocked"));
        }) as typeof fetch,
    );
    spy(
      XMLHttpRequest.prototype,
      "open",
      () =>
        function (this: XMLHttpRequest, _m: string, u: string | URL) {
          seen.push(`xhr ${String(u)}`);
        } as XMLHttpRequest["open"],
    );
    spy(
      navigator,
      "sendBeacon" as keyof Navigator,
      () =>
        ((u: string) => {
          seen.push(`beacon ${u}`);
          return true;
        }) as never,
    );
    spy(
      globalThis,
      "WebSocket",
      () =>
        ((u: string) => {
          seen.push(`ws ${u}`);
        }) as unknown as typeof WebSocket,
    );
    spy(
      globalThis,
      "EventSource" as keyof typeof globalThis,
      () =>
        ((u: string) => {
          seen.push(`sse ${u}`);
        }) as never,
    );
    // A detached `new Image().src = …` loads too, without ever entering the DOM.
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...desc,
      set(v: string) {
        if (!/^(blob:|data:image\/)/i.test(String(v))) seen.push(`img.src ${v}`);
        desc.set!.call(this, v);
      },
    });
    restore.push(() => Object.defineProperty(HTMLImageElement.prototype, "src", desc));
    spy(
      window,
      "open",
      () =>
        ((u?: string | URL) => {
          seen.push(`open ${String(u)}`);
          return null;
        }) as typeof window.open,
    );
  }
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  /** URLs the DOM under `root` would make the browser load on its own. */
  function loads(root: Element): string[] {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const tag = el.tagName.toLowerCase();
      for (const attr of ["src", "srcset", "poster", "data", "background", "ping"]) {
        const v = el.getAttribute(attr);
        if (v && !/^(blob:|data:image\/(png|jpe?g|gif|webp|avif);)/i.test(v))
          out.push(`${tag}[${attr}]=${v}`);
      }
      if (["iframe", "object", "embed", "link", "script", "frame", "base", "meta"].includes(tag))
        out.push(tag);
      if (tag === "image" || tag === "use") out.push(tag);
      const style = el.getAttribute("style");
      if (style && /url\(|@import|image-set\(/i.test(style)) out.push(`style=${style}`);
      if (tag === "style" && /url\(|@import/i.test(el.textContent ?? "")) out.push("style url()");
    }
    return out;
  }

  it("the recorder sees a request (control)", () => {
    record();
    fetch("https://control.example/").catch(() => {});
    new XMLHttpRequest().open("GET", "https://control.example/x");
    new Image().src = "https://control.example/detached.png";
    const img = document.createElement("img");
    img.setAttribute("src", "https://control.example/i.png");
    const holder = document.createElement("div");
    holder.appendChild(img);
    expect(seen).toEqual([
      "fetch https://control.example/",
      "xhr https://control.example/x",
      "img.src https://control.example/detached.png",
    ]);
    expect(loads(holder)).toEqual(["img[src]=https://control.example/i.png"]);
  });

  it("every fixture, with every control opened, loads nothing", async () => {
    for (const [name, note] of Object.entries(RICH)) {
      record();
      const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
      const onSave = vi.fn(async () => ({}));
      const { container, unmount } = render(
        <NoteRenderer
          note={note}
          rich
          fetchBlob={fetchBlob}
          onSave={onSave}
          resolve={(t) => ({ href: `/n/${t}`, exists: true })}
          onNavigate={() => {}}
        />,
      );
      const root = container.firstElementChild!;
      expect(root.querySelector(".rn"), name).not.toBeNull();
      // Collect every node and attribute that appears at any point, not just the end state.
      const transient: string[] = [];
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === "attributes" && m.target instanceof Element) {
            const holder = document.createElement("div");
            holder.appendChild(m.target.cloneNode(false));
            transient.push(...loads(holder));
          }
          for (const n of Array.from(m.addedNodes)) {
            if (n instanceof Element) {
              const holder = document.createElement("div");
              holder.appendChild(n.cloneNode(true));
              transient.push(...loads(holder));
            }
          }
        }
      });
      mo.observe(root, { subtree: true, childList: true, attributes: true });
      for (let pass = 0; pass < 2; pass++) {
        for (const el of Array.from(
          root.querySelectorAll("button, summary, input, a, [role=button], [role=link]"),
        )) {
          fireEvent.click(el);
          await flush();
        }
      }
      mo.disconnect();
      expect(seen, name).toEqual([]);
      expect(transient, name).toEqual([]);
      expect(loads(root), name).toEqual([]);
      // fetchBlob is the host's own attachment fetch; no fixture has one.
      expect(fetchBlob, name).not.toHaveBeenCalled();
      unmount();
      while (restore.length) restore.pop()!();
    }
  });

  it("note text never becomes markup: the hostile note's tags are text", () => {
    const { container } = render(<NoteRenderer note={hostile} rich />);
    expect(container.querySelector("iframe, script, link, style, audio, video, object")).toBeNull();
    expect(container.textContent).toContain("<iframe");
    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      expect(a.getAttribute("href")).not.toMatch(/^javascript:/i);
    }
  });
});
