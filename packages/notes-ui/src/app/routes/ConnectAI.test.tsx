import { ConnectAI } from "@/app/routes/ConnectAI";
import { loadChecklistState } from "@/lib/home/checklist";
import { useVaultStore } from "@/lib/vault/store";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function seedStore() {
  useVaultStore.setState({
    vaults: {
      v1: {
        id: "v1",
        url: "https://u.parachute.computer/vault/aaron",
        name: "Aaron's Vault",
        issuer: "https://u.parachute.computer",
        clientId: "c",
        scope: "full",
        addedAt: "2026-07-01T00:00:00.000Z",
        lastUsedAt: "2026-07-01T00:00:00.000Z",
      },
    },
    activeVaultId: "v1",
  });
}

function LocationSpy() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderConnect() {
  return render(
    <MemoryRouter initialEntries={["/connect"]}>
      <Routes>
        <Route path="/connect" element={<ConnectAI />} />
        <Route path="/" element={<LocationSpy />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ConnectAI", () => {
  beforeEach(() => {
    localStorage.clear();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    seedStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    localStorage.clear();
  });

  it("shows the vault MCP URL and the Claude + ChatGPT walkthroughs", () => {
    renderConnect();
    expect(screen.getByRole("heading", { level: 1, name: /connect your ai/i })).toBeInTheDocument();
    // The load-bearing MCP endpoint (bare vault URL + /mcp).
    expect(screen.getByText("https://u.parachute.computer/vault/aaron/mcp")).toBeInTheDocument();
    // Claude steps mirror the console's canonical copy.
    expect(screen.getByText(/settings → connectors/i)).toBeInTheDocument();
    expect(screen.getByText(/add custom connector/i)).toBeInTheDocument();
    // Both assistants get a card.
    expect(screen.getByRole("region", { name: /connect claude/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /connect chatgpt/i })).toBeInTheDocument();
  });

  it("copies the MCP URL to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderConnect();
    fireEvent.click(screen.getByRole("button", { name: /copy vault mcp url/i }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://u.parachute.computer/vault/aaron/mcp"),
    );
  });

  it("marks the connect step done and returns home", async () => {
    renderConnect();
    fireEvent.click(screen.getByRole("button", { name: /i've connected my ai/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/"));
    expect(loadChecklistState("v1").overrides.connect).toBe(true);
  });

  it("redirects to the index when no vault is connected", () => {
    useVaultStore.setState({ vaults: {}, activeVaultId: null });
    renderConnect();
    expect(screen.getByTestId("location")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /connect your ai/i })).not.toBeInTheDocument();
  });
});
