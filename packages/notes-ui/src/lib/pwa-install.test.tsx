import type { BeforeInstallPromptEvent } from "@/lib/pwa";
import { useInstallAffordance } from "@/lib/pwa-install";
import { act, render, screen } from "@testing-library/react";
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
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
  });
  afterEach(() => {
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
});
