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
      "/api/storage/.\t./notes",
      "/api/storage/\\evil",
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
