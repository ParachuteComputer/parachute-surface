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
import { render, screen, waitFor } from "@testing-library/react";
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

  // Kit 0.2 hands host.image the raw src (as MarkdownView gets it), encoded
  // forms included; the host's isVaultStorageUrl decides every load.
  it("a full URL outside the vault stays a link: no request, no token", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const outside = [
      "https://evil.example/vault/default/api/storage/a.png",
      "https://hub.example.evil.example/vault/default/api/storage/a.png",
      "https://hub.example@evil.example/vault/default/api/storage/a.png",
      "https:%2F%2Fevil.example/vault/default/api/storage/a.png",
    ];
    // Paths the kit lets through as attachments but the vault check refuses.
    // A stray `%` ends the kit's decode loop early, so a double-encoded `..`
    // reaches the host.
    const refused = [
      "/api/storage/a%2Fb.png",
      "/api/storage/att%5C..%5Cx.png",
      "/static/logo.png",
      "/api/storage/%252e%252e/%252e%252e/other/x.png?%",
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

  it("a full URL inside the vault is also a link under kit 0.2 (fail-closed), never fetched", async () => {
    // The kit asks the host only for scheme-less paths (FEEDBACK-REPLY item 8),
    // so even this vault's own absolute storage URL is not loaded in a rich note.
    const { fetchImpl, fetchBlob } = naiveSurface();
    const inVault = `${VAULT}/api/storage/att/plan.png`;
    const { container } = render(
      <NoteRenderer
        note={{ path: "full.md", content: `- [ ] look\n\n![plan](${inVault})\n` }}
        rich
        fetchBlob={fetchBlob}
        vaultUrl={VAULT}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadedUrls(container)).toEqual([]);
    expect(container.querySelector(`a[href="${inVault}"]`)).not.toBeNull();
  });

  it("an attachment with an encoded name, a query or a hash loads from the raw src", async () => {
    const { fetchImpl, fetchBlob } = naiveSurface();
    const srcs = [
      "/api/storage/att/Pasted%20image.png",
      "/api/storage/att/cr%C3%A8me.jpg",
      "/api/storage/att/scan.png?v=2",
      "/api/storage/att/100%25.png",
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
    expect(fetchBlob.mock.calls.map(([u]) => u)).toEqual(srcs);
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
      `${VAULT}/api/storage/%252e%252e/other/a.png`,
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
