import type { BeforeInstallPromptEvent } from "@/lib/pwa";
import { __resetInstallAffordanceForTests, useInstallAffordance } from "@/lib/pwa-install";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function stubMatchMedia(standalone: boolean) {
  const mm = (q: string) => ({
    matches: q === "(display-mode: standalone)" ? standalone : false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: mm });
}

function stubUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ua });
}

function fireBeforeInstallPrompt() {
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.assign(event, {
    platforms: ["web"],
    userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
    prompt: vi.fn<() => Promise<void>>(async () => {}),
  });
  window.dispatchEvent(event);
}

function Probe() {
  const { state, isIOSDevice } = useInstallAffordance();
  return <div data-testid="state">{`${state}${isIOSDevice ? ":ios" : ""}`}</div>;
}

describe("useInstallAffordance", () => {
  beforeEach(() => {
    __resetInstallAffordanceForTests();
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
  });
  afterEach(() => {
    __resetInstallAffordanceForTests();
    vi.unstubAllGlobals();
  });

  it("reports unsupported on a browser with no install path", () => {
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("unsupported");
  });

  it("reports installed when running standalone", () => {
    stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("installed");
  });

  it("flips to available once beforeinstallprompt fires", () => {
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("unsupported");
    act(() => fireBeforeInstallPrompt());
    expect(screen.getByTestId("state").textContent).toBe("available");
  });

  it("treats iOS Safari as available (manual add-to-home-screen)", () => {
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    render(<Probe />);
    expect(screen.getByTestId("state").textContent).toBe("available:ios");
  });

  it("shares the captured event with an instance mounted AFTER it fired (F1)", () => {
    // The regression behind PR #182 F1: beforeinstallprompt is one-shot and
    // doesn't replay. A second consumer that mounts after the event must still
    // see it via the module-scope singleton — a per-instance listener wouldn't.
    const first = render(<Probe />);
    act(() => fireBeforeInstallPrompt());
    expect(within(first.container).getByTestId("state").textContent).toBe("available");
    // Mount a fresh, independent instance now — after the event already fired.
    const second = render(<Probe />);
    expect(within(second.container).getByTestId("state").textContent).toBe("available");
  });
});
