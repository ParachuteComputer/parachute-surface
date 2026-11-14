/**
 * A note must not make the reader's device load anything from outside the
 * vault. `![](https://tracker.example/x.png)` in a note would otherwise tell
 * that server the note was opened, when, and from which IP (privacy), and an
 * absolute URL that merely *looks* like storage on another host
 * (`https://evil.example/api/storage/…`) must never receive the vault token
 * (credential exposure).
 *
 * Made-up notes and hosts only.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultAudio } from "../embed/VaultAudio.js";
import { VaultImage } from "../embed/VaultImage.js";
import { isVaultStorageUrl, vaultClientFetchBlob } from "../embed/fetch-blob.js";
import { MarkdownView } from "../markdown/MarkdownView.js";
import { NoteRenderer } from "../note/NoteRenderer.js";

beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
});

/** Every URL the rendered DOM would make the browser load on its own. */
function loadedUrls(root: ParentNode): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll("[src],[srcset],[poster]"))) {
    for (const attr of ["src", "srcset", "poster"]) {
      const v = el.getAttribute(attr);
      if (v) out.push(v);
    }
  }
  return out;
}

const NOTE = [
  "# Weekly review",
  "",
  "![tracker pixel](https://tracker.example/open.png?note=1)",
  "",
  "![](http://plain.example/x.gif)",
  "",
  "![protocol-relative](//cdn.example/y.png)",
  "",
  "![looks like storage](https://evil.example/api/storage/pixel.png)",
  "",
  "![same-origin path](/static/logo.png)",
  "",
  "![script](javascript:alert(1))",
].join("\n");

describe("remote images in a note never load", () => {
  it("MarkdownView: no remote src reaches the DOM, and fetchBlob is never asked for one", () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"]));
    const { container } = render(<MarkdownView content={NOTE} fetchBlob={fetchBlob} />);
    expect(loadedUrls(container)).toEqual([]);
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("NoteRenderer (the default markdown branch) loads nothing remote either", () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"]));
    const { container } = render(
      <NoteRenderer note={{ path: "review.md", content: NOTE }} fetchBlob={fetchBlob} />,
    );
    expect(loadedUrls(container)).toEqual([]);
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("a remote http(s) image shows as a plain link the reader can choose to open", () => {
    render(<VaultImage src="https://tracker.example/open.png" alt="tracker pixel" />);
    expect(screen.queryByRole("img", { name: "tracker pixel" })).toBeNull();
    const link = screen.getByRole("link", { name: /tracker pixel/ });
    expect(link).toHaveAttribute("href", "https://tracker.example/open.png");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("a remote image with no alt shows its address as the link text", () => {
    render(<VaultImage src="https://plain.example/x.gif" />);
    expect(screen.getByRole("link")).toHaveTextContent("https://plain.example/x.gif");
  });

  it("a non-http scheme is neither loaded nor linked", () => {
    const { container } = render(<VaultImage src="javascript:alert(1)" alt="script" />);
    expect(loadedUrls(container)).toEqual([]);
    expect(container.querySelector("a")).toBeNull();
  });

  it("a storage-looking URL on another host is remote: no fetch, so no token", () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"]));
    const { container } = render(
      <VaultImage src="https://evil.example/api/storage/pixel.png" fetchBlob={fetchBlob} />,
    );
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(loadedUrls(container)).toEqual([]);
  });

  it("VaultAudio never loads a remote src", () => {
    const { container } = render(<VaultAudio src="https://tracker.example/a.mp3" />);
    expect(loadedUrls(container)).toEqual([]);
  });
});

describe("a rich note (NoteRenderer rich) keeps the same guarantees", () => {
  const VAULT = "https://hub.example/vault/default";
  // Tasks make it a rich note; the images are the hostile set above plus
  // bare relative paths, which the kit hands to the host as attachments.
  const RICH_NOTE = [
    NOTE,
    "",
    "- [ ] Check the pixels",
    "",
    "![bare host](tracker.example/open.png)",
    "",
    "![other folder](attachments/other.png)",
    "",
    "![other vault](https://hub.example/vault/other/api/storage/a.png)",
  ].join("\n");

  /** A surface's own fetchBlob that trusts its caller: it fetches whatever
   *  it is asked for, with the token. Only the guard stands in front of it. */
  function naiveSurface() {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(new Blob(["b"])),
    );
    const fetchBlob = vi.fn(async (url: string) => {
      const target = url.startsWith("/") ? `${VAULT}${url}` : new URL(url, `${VAULT}/`).href;
      const res = await fetchImpl(target, {
        headers: { Authorization: "Bearer SECRET" },
      });
      return res.blob();
    });
    return { fetchImpl, fetchBlob };
  }

  it("a remote image makes no request, is a plain link, and the token never leaves the vault", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const { container } = render(
      <NoteRenderer
        note={{ path: "review.md", content: RICH_NOTE }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    expect(container.querySelector(".rn")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(loadedUrls(container)).toEqual([]);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const link = container.querySelector('a[href="https://tracker.example/open.png?note=1"]');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("its vault attachment still loads, with the token, inside the vault", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const { container } = render(
      <NoteRenderer
        note={{
          path: "review.md",
          content: `${RICH_NOTE}\n\n![plan](/api/storage/att/plan.png)\n`,
        }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).not.toBeNull());
    expect(fetchBlob.mock.calls).toEqual([["/api/storage/att/plan.png"]]);
    for (const [url] of fetchImpl.mock.calls)
      expect(url.startsWith(`${VAULT}/api/storage/`), url).toBe(true);
  });

  // The kit hands host.image the raw src (as MarkdownView gets it), encoded
  // forms included; the host's isVaultStorageUrl decides every load.
  it("a full URL outside the vault stays a link: no request, no token", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const outside = [
      "https://evil.example/vault/default/api/storage/a.png",
      "https://hub.example.evil.example/vault/default/api/storage/a.png",
      "https://hub.example@evil.example/vault/default/api/storage/a.png",
      "https:%2F%2Fevil.example/vault/default/api/storage/a.png",
    ];
    // Refused by the vault check or, since kit 0.3 decodes leniently to a
    // fixed point, by the kit itself (the double-encoded `..` behind a `%`).
    const refused = [
      "/api/storage/a%2Fb.png",
      "/api/storage/att%5C..%5Cx.png",
      "/static/logo.png",
      "/api/storage/%252e%252e/%252e%252e/other/x.png?%",
      "/api/storage/%25%32%65%25%32%65/other/x.png?%",
    ];
    const { container } = render(
      <NoteRenderer
        note={{
          path: "outside.md",
          content: ["- [ ] look", "", ...[...outside, ...refused].map((u) => `![x](${u})`)].join(
            "\n\n",
          ),
        }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".rn-img-off").length).toBe(
        outside.length + refused.length,
      ),
    );
    expect(loadedUrls(container)).toEqual([]);
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const u of outside.slice(0, 2))
      expect(container.querySelector(`a[href="${u}"]`), u).not.toBeNull();
    expect(container.textContent).toContain("Image: x (not loaded)");
    expect(container.querySelector(".rn-img-wait")).toBeNull();
  });

  // Kit 0.3 asks host.isAttachment about an absolute src; RichNoteView answers
  // with exactly isVaultStorageUrl, so the vault check decides these too.
  it("a full URL inside the vault loads, with the token, from the vault", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const inVault = [
      `${VAULT}/api/storage/att/plan.png`,
      `${VAULT}/api/storage/att/100%.png`,
      "/api/storage/att/100%.png",
    ];
    const { container } = render(
      <NoteRenderer
        note={{
          path: "full.md",
          content: ["- [ ] look", "", ...inVault.map((u) => `![a](${u})`)].join("\n\n"),
        }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('img[src="blob:mock"]').length).toBe(inVault.length),
    );
    // markdown-it hands a stray `%` over as `%25`.
    expect(fetchBlob.mock.calls.map(([u]) => u)).toEqual([
      `${VAULT}/api/storage/att/plan.png`,
      `${VAULT}/api/storage/att/100%25.png`,
      "/api/storage/att/100%25.png",
    ]);
    for (const [url] of fetchImpl.mock.calls)
      expect(url.startsWith(`${VAULT}/api/storage/`), url).toBe(true);
    expect(container.querySelector(".rn-img-off")).toBeNull();
  });

  it("a vaultUrl that arrives after the first draw lets a full in-vault URL load, in place", async () => {
    const { fetchBlob } = naiveSurface();
    const note = {
      path: "late.md",
      content: `- [ ] look\n\n![a](${VAULT}/api/storage/att/a.png)\n`,
    };
    const { container, rerender } = render(<NoteRenderer note={note} rich fetchBlob={fetchBlob} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchBlob).not.toHaveBeenCalled();
    const view = container.querySelector(".rich-note");
    rerender(<NoteRenderer note={note} rich fetchBlob={fetchBlob} vaultUrl={VAULT} />);
    await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).not.toBeNull());
    expect(fetchBlob.mock.calls).toEqual([[`${VAULT}/api/storage/att/a.png`]]);
    // Redrawn, not remounted: the reader's sitting stays.
    expect(container.querySelector(".rich-note")).toBe(view);
  });

  it("a vaultUrl that arrives after a saved tick keeps the tick", async () => {
    const { fetchBlob } = naiveSurface();
    const onSave = vi.fn(async () => ({ updatedAt: "2026-11-14T00:00:00.000Z" }));
    const note = {
      path: "ticks.md",
      updatedAt: "2026-11-13T00:00:00.000Z",
      content: `- [ ] one\n- [ ] two\n\n![a](${VAULT}/api/storage/att/a.png)\n`,
    };
    const props = { note, rich: true, fetchBlob, onSave };
    const { container, rerender } = render(<NoteRenderer {...props} />);
    const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(container.querySelector(".rn-status")).toHaveTextContent("Saved."));
    rerender(<NoteRenderer {...props} vaultUrl={VAULT} />);
    await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).not.toBeNull());
    expect(boxes().map((b) => b.checked)).toEqual([true, false]);
    fireEvent.click(boxes()[1]);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toContain("- [x] one\n- [x] two");
  });

  // Kit 0.4's refreshImages (its item 17): the store behind a same-path note
  // changed, so every image is asked afresh, and the reader's sitting stays.
  it("switching to another vault asks every image afresh and keeps the sitting", async () => {
    const a = naiveSurface();
    const b = naiveSurface();
    const onSave = vi.fn(async () => ({ updatedAt: "2026-11-14T00:00:00.000Z" }));
    const note = {
      path: "same.md",
      updatedAt: "2026-11-13T00:00:00.000Z",
      content: "- [ ] one\n- [ ] two\n\n![r](/api/storage/att/a.png)\n",
    };
    const { container, rerender } = render(
      <NoteRenderer note={note} rich fetchBlob={a.fetchBlob} onSave={onSave} vaultUrl={VAULT} />,
    );
    await waitFor(() => expect(a.fetchBlob).toHaveBeenCalledTimes(1));
    const boxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    fireEvent.click(boxes()[0]);
    await waitFor(() => expect(container.querySelector(".rn-status")).toHaveTextContent("Saved."));
    const view = container.querySelector(".rich-note");
    rerender(
      <NoteRenderer
        note={note}
        rich
        fetchBlob={b.fetchBlob}
        onSave={onSave}
        vaultUrl="https://hub.example/vault/other"
      />,
    );
    await waitFor(() => expect(b.fetchBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('img[src="blob:mock"]')).not.toBeNull());
    expect(a.fetchBlob).toHaveBeenCalledTimes(1);
    // Not remounted: the same view, the tick still there.
    expect(container.querySelector(".rich-note")).toBe(view);
    expect(boxes().map((x) => x.checked)).toEqual([true, false]);
  });

  it("a first vaultUrl asks again for a relative image fetched before it", async () => {
    const { fetchBlob } = naiveSurface();
    const note = { path: "first.md", content: "- [ ] look\n\n![r](/api/storage/att/a.png)\n" };
    const { container, rerender } = render(<NoteRenderer note={note} rich fetchBlob={fetchBlob} />);
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1));
    const view = container.querySelector(".rich-note");
    rerender(
      <NoteRenderer
        note={note}
        rich
        fetchBlob={fetchBlob}
        vaultUrl="https://hub.example/vault/other"
      />,
    );
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2));
    expect(container.querySelector(".rich-note")).toBe(view);
  });

  it("a vault that goes away and comes back as another asks again, in place", async () => {
    const { fetchBlob } = naiveSurface();
    const note = { path: "same.md", content: "- [ ] look\n\n![r](/api/storage/att/a.png)\n" };
    const props = { note, rich: true, fetchBlob };
    const { container, rerender } = render(<NoteRenderer {...props} vaultUrl={VAULT} />);
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(1));
    const view = container.querySelector(".rich-note");
    rerender(<NoteRenderer {...props} />);
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2));
    rerender(<NoteRenderer {...props} vaultUrl="https://hub.example/vault/other" />);
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(3));
    expect(container.querySelector(".rich-note")).toBe(view);
  });

  // Kit 0.4 reads only the path and hands the query over as written (its
  // items 18-20); isVaultStorageUrl reads the query, so a climb hidden there
  // is never fetched, whichever renderer draws the note.
  it("a query that tries to smuggle a path is never fetched, in either renderer", async () => {
    const smuggled = [
      `${VAULT}/api/storage/att/a.png?x=/../../other/api/storage/b.png`,
      `${VAULT}/api/storage/att/a.png?x=%2F..%2F..%2Fother`,
      `${VAULT}/api/storage/att/a.png?x=%252e%252e/%252e%252e/other`,
      "/api/storage/att/a.png?x=/../../other/x.png",
    ];
    const content = ["- [ ] look", "", ...smuggled.map((u) => `![q](${u})`)].join("\n\n");
    for (const rich of [true, false]) {
      const { fetchImpl, fetchBlob } = naiveSurface();
      const { container, unmount } = render(
        <NoteRenderer
          note={{ path: "smuggle.md", content }}
          rich={rich}
          fetchBlob={fetchBlob}
          vaultUrl={VAULT}
        />,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchBlob, `rich=${rich}`).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(loadedUrls(container)).toEqual([]);
      unmount();
    }
  });

  it("without fetchBlob, a full in-vault URL stays a link the reader can open", async () => {
    const inVault = `${VAULT}/api/storage/att/a.png`;
    const { container } = render(
      <NoteRenderer
        note={{ path: "nofetch.md", content: `- [ ] look\n\n![a](${inVault})\n` }}
        rich
        vaultUrl={VAULT}
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(`a.rn-img-off[href="${inVault}"]`)).not.toBeNull();
    expect(container.querySelector("span.rn-img-off, .rn-img-wait")).toBeNull();
  });

  it("a full URL in another vault, on another host, or with an encoded climb stays a link: no request, no token", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const links = [
      "https://evil.example/vault/default/api/storage/a.png",
      "https://hub.example/vault/other/api/storage/a.png",
      "https://hub.example.evil.example/vault/default/api/storage/a.png",
      `${VAULT}/api/storage/a%2Fb.png`,
      `${VAULT}/api/storage/a%2f..%2f..%2fother%2fx.png`,
      `${VAULT}/api/storage/att%5C..%5Cx.png`,
      `${VAULT}/api/storage/att%5c..%5cx.png`,
      `${VAULT}/api/storage/%2e%2e/%2e%2e/other/x.png`,
      `${VAULT}/api/storage/../../other/x.png`,
      `${VAULT}/api/storage/%252e%252e/%ff/x.png`,
    ];
    const { container } = render(
      <NoteRenderer
        note={{
          path: "links.md",
          content: ["- [ ] look", "", ...links.map((u) => `![x](${u})`)].join("\n\n"),
        }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    expect(container.querySelector(".rn")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadedUrls(container)).toEqual([]);
    // Never asked: each is the kit's plain link, not a refused attachment.
    expect(container.querySelectorAll("img, .rn-img-wait, span.rn-img-off").length).toBe(0);
    expect(
      [...container.querySelectorAll("a.rn-img-off")].map((a) => a.getAttribute("href")),
    ).toEqual(links.map((u) => new URL(u).href)); // the kit's safeHref parses the link
  });

  it("an attachment with an encoded name, a query or a hash loads from the raw src", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const srcs = [
      "/api/storage/att/Pasted%20image.png",
      "/api/storage/att/cr%C3%A8me.jpg",
      "/api/storage/att/scan.png?v=2",
      "/api/storage/att/100%25.png",
      "/api/storage/att/100%2525%20off.png#top",
    ];
    const { container } = render(
      <NoteRenderer
        note={{
          path: "names.md",
          content: ["- [ ] look", "", ...srcs.map((u) => `![a](${u})`)].join("\n\n"),
        }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll('img[src="blob:mock"]').length).toBe(srcs.length),
    );
    // Kit 0.3 cuts the `#fragment` before asking (its item 16).
    expect(fetchBlob.mock.calls.map(([u]) => u)).toEqual(srcs.map((u) => u.replace(/#.*$/, "")));
    for (const [url] of fetchImpl.mock.calls)
      expect(url.startsWith(`${VAULT}/api/storage/`), url).toBe(true);
  });
});

describe("vault attachments still load", () => {
  it("a relative /api/storage/ image is fetched with auth and shown", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    render(<MarkdownView content="![plan](/api/storage/att/plan.png)" fetchBlob={fetchBlob} />);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:mock"));
    expect(fetchBlob).toHaveBeenCalledWith("/api/storage/att/plan.png");
  });

  it("an absolute storage URL on the vault's own origin loads when the surface names that origin", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    render(
      <VaultImage
        src="https://hub.example/vault/default/api/storage/att/plan.png"
        alt="plan"
        vaultUrl="https://hub.example/vault/default"
        fetchBlob={fetchBlob}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "plan" })).toHaveAttribute("src", "blob:mock"),
    );
    expect(fetchBlob).toHaveBeenCalledWith(
      "https://hub.example/vault/default/api/storage/att/plan.png",
    );
  });

  it("an inline data:image is shown (it makes no request)", () => {
    render(<VaultImage src="data:image/png;base64,iVBORw0KGgo=" alt="dot" />);
    expect(screen.getByRole("img", { name: "dot" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });
});

describe("isVaultStorageUrl", () => {
  const VAULT = "https://hub.example/vault/default";
  it("is true for a relative storage path, or an absolute one under the named vault", () => {
    expect(isVaultStorageUrl("/api/storage/a.png")).toBe(true);
    expect(isVaultStorageUrl(`${VAULT}/api/storage/a.png`, VAULT)).toBe(true);
    expect(isVaultStorageUrl("HTTPS://HUB.EXAMPLE/vault/default/api/storage/a.png", VAULT)).toBe(
      true,
    );
  });

  it("is false for anything a note could use to reach another host or vault", () => {
    for (const src of [
      "https://evil.example/api/storage/pixel.png",
      "https://evil.example/vault/default/api/storage/pixel.png",
      "https://hub.example@evil.example/vault/default/api/storage/a.png",
      "https://hub.example/vault/other/api/storage/a.png",
      "https://hub.example/api/storage/a.png",
      "https:hub.example/vault/default/api/storage/a.png",
      "https:/hub.example/vault/default/api/storage/a.png",
      "https://hub.example/vault/default/api/storage/../../other/a.png",
      "//hub.example/vault/default/api/storage/a.png",
      "/api/storage/../../api/notes",
      "/api/storage/%2e%2e/notes",
      "/api/storage/..?x",
      "https://u:p@hub.example/vault/default/api/storage/a.png",
      "/api/storage/.\t./notes",
      "/api/storage/\\evil",
      // encoded more than once: a server or proxy that decodes twice climbs out
      "/api/storage/%252e%252e/notes",
      "/api/storage/%25252E%25252E/notes",
      "/api/storage/a%252Fb.png",
      "/api/storage/a%255Cb.png",
      "/api/storage/%25%32%65%25%32%65/notes",
      "/api/storage/%252%65%252%65/notes",
      "/api/storage/a%25%32%66b.png",
      "/api/storage/%2525%2532%2565%2525%2532%2565/notes",
      "/api/storage/%25%30%30x.png",
      `${VAULT}/api/storage/%252e%252e/other/a.png`,
      `${VAULT}/api/storage/%25%32%65%25%32%65/other/a.png`,
    ]) {
      expect(isVaultStorageUrl(src, VAULT), src).toBe(false);
    }
    // Without a named vault, no absolute URL is storage.
    expect(isVaultStorageUrl(`${VAULT}/api/storage/a.png`)).toBe(false);
  });
});

describe("vaultClientFetchBlob never sends the token off the vault's origin", () => {
  it("refuses an absolute URL on another host without calling fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["b"]), { status: 200 }));
    const fb = vaultClientFetchBlob(
      {
        storageUrl: (p) => `https://hub.example/vault/default/api/storage/${p}`,
        getAccessToken: () => "SECRET",
      },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(fb?.("https://evil.example/api/storage/pixel.png")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still fetches an absolute URL on the vault's own origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["b"]), { status: 200 }));
    const fb = vaultClientFetchBlob(
      {
        storageUrl: (p) => `https://hub.example/vault/default/api/storage/${p}`,
        getAccessToken: () => "tok",
      },
      fetchImpl as unknown as typeof fetch,
    );
    await fb?.("https://hub.example/vault/default/api/storage/a.png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
