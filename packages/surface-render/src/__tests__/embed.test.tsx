import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VaultAudio } from "../embed/VaultAudio.js";
import { VaultImage } from "../embed/VaultImage.js";
import {
  type BlobCapableClient,
  isVaultStorageUrl,
  vaultClientFetchBlob,
} from "../embed/fetch-blob.js";

// jsdom doesn't implement createObjectURL/revokeObjectURL.
beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
});

describe("isVaultStorageUrl", () => {
  it("matches relative + absolute storage URLs, not other URLs", () => {
    expect(isVaultStorageUrl("/api/storage/a.png")).toBe(true);
    expect(isVaultStorageUrl("https://v.example/api/storage/a.png")).toBe(true);
    expect(isVaultStorageUrl("https://cdn.example/a.png")).toBe(false);
    expect(isVaultStorageUrl("/static/a.png")).toBe(false);
  });
});

describe("vaultClientFetchBlob adapter", () => {
  it("prefers fetchAttachmentBlob when present (notes-ui subclass shape)", async () => {
    const client: BlobCapableClient = {
      fetchAttachmentBlob: vi.fn(async () => new Blob(["a"])),
    };
    const fb = vaultClientFetchBlob(client);
    expect(fb).not.toBeNull();
    await fb?.("/api/storage/x.png");
    expect(client.fetchAttachmentBlob).toHaveBeenCalledWith("/api/storage/x.png");
  });

  it("falls back to storageUrl + token fetch for a base VaultClient shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["b"]), { status: 200 }));
    const client: BlobCapableClient = {
      storageUrl: (p) => `https://v.example/api/storage/${p}`,
      getAccessToken: () => "tok",
    };
    const fb = vaultClientFetchBlob(client, fetchImpl as unknown as typeof fetch);
    await fb?.("/api/storage/x.png");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://v.example/api/storage/x.png",
      expect.objectContaining({ headers: { Authorization: "Bearer tok" } }),
    );
  });

  it("returns null for a client with no blob capability", () => {
    expect(vaultClientFetchBlob({})).toBeNull();
    expect(vaultClientFetchBlob(null)).toBeNull();
  });
});

describe("VaultImage", () => {
  it("fetches storage URLs with auth and renders the object URL", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/png" }));
    render(<VaultImage src="/api/storage/p.png" alt="pic" fetchBlob={fetchBlob} />);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:mock"));
    expect(fetchBlob).toHaveBeenCalledWith("/api/storage/p.png");
  });

  it("renders non-storage URLs directly without fetching", () => {
    const fetchBlob = vi.fn();
    render(<VaultImage src="https://cdn.example/p.png" alt="pic" fetchBlob={fetchBlob} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://cdn.example/p.png");
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("surfaces an error affordance when the auth'd fetch fails", async () => {
    const fetchBlob = vi.fn(async () => {
      throw new Error("403");
    });
    render(<VaultImage src="/api/storage/p.png" alt="pic" fetchBlob={fetchBlob} />);
    await waitFor(() => expect(screen.getByText(/pic: 403/)).toBeInTheDocument());
  });
});

describe("VaultAudio", () => {
  it("fetches storage audio with auth and renders an <audio> with the object URL", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["a"], { type: "audio/webm" }));
    const { container } = render(
      <VaultAudio src="/api/storage/memo.webm" fetchBlob={fetchBlob} label="memo" />,
    );
    await waitFor(() => {
      const audio = container.querySelector("audio");
      expect(audio).not.toBeNull();
      expect(audio).toHaveAttribute("src", "blob:mock");
    });
    expect(screen.getByText("memo")).toBeInTheDocument();
    expect(fetchBlob).toHaveBeenCalledWith("/api/storage/memo.webm");
  });
});
