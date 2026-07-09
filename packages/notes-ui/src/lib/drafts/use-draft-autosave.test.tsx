import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DraftBody, loadDraft, saveDraft } from "./store";
import { useDraftAutosave } from "./use-draft-autosave";

const body = (over: Partial<DraftBody> = {}): DraftBody => ({
  content: "draft text",
  path: "Notes/x",
  tags: [],
  ...over,
});

function Harness({
  vaultId = "v1",
  scope = "new",
  body: b,
  enabled,
}: {
  vaultId?: string | null;
  scope?: string | null;
  body: DraftBody;
  enabled: boolean;
}) {
  useDraftAutosave(vaultId, scope, b, enabled, 500);
  return null;
}

describe("useDraftAutosave", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("persists the body after the debounce, not before", () => {
    render(<Harness body={body()} enabled />);
    expect(loadDraft("v1", "new")).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(loadDraft("v1", "new")?.body).toEqual(body());
  });

  it("only persists the latest body when it changes within the debounce window", () => {
    const { rerender } = render(<Harness body={body({ content: "A" })} enabled />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<Harness body={body({ content: "B" })} enabled />);
    act(() => vi.advanceTimersByTime(500));
    expect(loadDraft("v1", "new")?.body.content).toBe("B");
  });

  it("clears an existing draft when enabled goes false", () => {
    saveDraft("v1", "new", body({ content: "stale" }));
    render(<Harness body={body()} enabled={false} />);
    expect(loadDraft("v1", "new")).toBeNull();
  });

  it("flushes immediately on pagehide (the backgrounded-PWA / crash case)", () => {
    render(<Harness body={body({ content: "unsaved" })} enabled />);
    // No debounce advance — pagehide must persist right away.
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(loadDraft("v1", "new")?.body.content).toBe("unsaved");
  });

  it("does not flush on pagehide when disabled", () => {
    render(<Harness body={body()} enabled={false} />);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(loadDraft("v1", "new")).toBeNull();
  });
});
