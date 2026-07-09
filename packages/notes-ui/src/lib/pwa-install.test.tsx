import type { BeforeInstallPromptEvent } from "@/lib/pwa";
import { __resetInstallAffordanceForTests, useInstallAffordance } from "@/lib/pwa-install";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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

function fireBeforeInstallPrompt(
  opts: {
    outcome?: "accepted" | "dismissed";
    prompt?: () => Promise<void>;
  } = {},
) {
  const event = new Event("beforeinstallprompt") as unknown as BeforeInstallPromptEvent;
  Object.assign(event, {
    platforms: ["web"],
    userChoice: Promise.resolve({ outcome: opts.outcome ?? "accepted", platform: "web" }),
    prompt: opts.prompt ?? vi.fn<() => Promise<void>>(async () => {}),
  });
  window.dispatchEvent(event);
}

function Probe() {
  const { state, isIOSDevice } = useInstallAffordance();
  return <div data-testid="state">{`${state}${isIOSDevice ? ":ios" : ""}`}</div>;
}

// Probe that also drives promptInstall and records the resolved outcome.
function PromptProbe() {
  const { state, promptInstall } = useInstallAffordance();
  const [outcome, setOutcome] = useState<string>("");
  return (
    <div>
      <div data-testid="state">{state}</div>
      <div data-testid="outcome">{outcome}</div>
      <button type="button" onClick={async () => setOutcome(await promptInstall())}>
        prompt
      </button>
    </div>
  );
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

  it("clears the spent event after a DISMISSED prompt so a retry can't no-op", async () => {
    render(<PromptProbe />);
    act(() => fireBeforeInstallPrompt({ outcome: "dismissed" }));
    expect(screen.getByTestId("state").textContent).toBe("available");
    fireEvent.click(screen.getByRole("button", { name: "prompt" }));
    // Dismissed is reported, and the single-use event is dropped → the
    // affordance stops offering a prompt that can't fire again.
    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("dismissed"));
    expect(screen.getByTestId("state").textContent).toBe("unsupported");
  });

  it("swallows a throw from prompt() (spent event) and reports unavailable", async () => {
    render(<PromptProbe />);
    act(() =>
      fireBeforeInstallPrompt({
        prompt: async () => {
          throw new Error("already used");
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "prompt" }));
    await waitFor(() => expect(screen.getByTestId("outcome").textContent).toBe("unavailable"));
    expect(screen.getByTestId("state").textContent).toBe("unsupported");
  });
});
