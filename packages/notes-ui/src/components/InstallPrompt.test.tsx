import { InstallPrompt } from "@/components/InstallPrompt";
import type { BeforeInstallPromptEvent } from "@/lib/pwa";
import { __resetInstallAffordanceForTests } from "@/lib/pwa-install";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  vi.stubGlobal("matchMedia", mm);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: mm });
}

function stubUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: ua });
}

function fireBeforeInstallPrompt(prompt = vi.fn<() => Promise<void>>(async () => {})) {
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.assign(event, {
    platforms: ["web"],
    userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" }),
    prompt,
  });
  window.dispatchEvent(event);
  return { event, prompt };
}

describe("InstallPrompt", () => {
  beforeEach(() => {
    // The beforeinstallprompt capture is a module-scope singleton — clear it so
    // a captured event doesn't leak between cases.
    __resetInstallAffordanceForTests();
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Linux; Android 13) Chrome/120");
  });
  afterEach(() => {
    __resetInstallAffordanceForTests();
    vi.unstubAllGlobals();
  });

  it("renders nothing when already standalone", () => {
    stubMatchMedia(true);
    render(<InstallPrompt />);
    expect(screen.queryByRole("button", { name: /install app/i })).not.toBeInTheDocument();
  });

  it("renders nothing on a non-iOS browser until beforeinstallprompt fires", () => {
    const { unmount } = render(<InstallPrompt />);
    expect(screen.queryByRole("button", { name: /install app/i })).not.toBeInTheDocument();
    unmount();
  });

  it("shows the Install button and triggers prompt() on click", async () => {
    render(<InstallPrompt />);
    let prompt: ReturnType<typeof vi.fn> | undefined;
    act(() => {
      prompt = fireBeforeInstallPrompt().prompt;
    });
    const btn = screen.getByRole("button", { name: /install app/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("shows iOS Add-to-Home-Screen dialog when clicked on iPhone with no prompt", async () => {
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    render(<InstallPrompt />);
    const btn = await screen.findByRole("button", { name: /install app/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(screen.getByText(/add parachute notes to your home screen/i)).toBeInTheDocument();
    expect(screen.getByText(/share icon/i)).toBeInTheDocument();
  });
});
