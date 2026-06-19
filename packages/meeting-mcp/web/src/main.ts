/**
 * The Meeting MCP landing page's tiny client. It fills the endpoint hints
 * with the current origin so an operator can copy the real URLs. The page
 * is a static doc — there is no client-side query UI (clients talk to the
 * MCP/REST endpoints directly), so a failed fetch leaves the placeholders
 * in place.
 */

const MOUNT = "/surface/meeting-mcp";

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fillUrls(): void {
  const origin = window.location.origin;
  setText("mcp-url", `${origin}${MOUNT}/api/mcp`);
  setText(
    "rest-urls",
    [
      `${origin}${MOUNT}/api/recent-meetings?limit=20`,
      `${origin}${MOUNT}/api/search-meetings?query=budget`,
      `${origin}${MOUNT}/api/meeting?id=<meeting-id>`,
    ].join("\n"),
  );
}

fillUrls();
