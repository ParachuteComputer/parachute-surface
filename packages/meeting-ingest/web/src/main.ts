/**
 * The Meeting Ingest config page's tiny client. It shows the live config
 * status to an operator (which keys are set — booleans only, never values)
 * and fills the webhook URL / config-path hints from the current origin.
 *
 * Everything here is best-effort: the page is a static setup doc, so a failed
 * fetch just leaves the static instructions in place.
 */

const MOUNT = "/surface/meeting-ingest";

interface ConfigStatus {
  tag: string;
  providers: { provider: string; apiKeySet: boolean; webhookSecretSet: boolean }[];
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fillWebhookUrl(): void {
  setText("webhook-url", `${window.location.origin}${MOUNT}/api/webhook/fireflies`);
}

function renderStatus(status: ConfigStatus): void {
  const section = document.getElementById("status");
  const body = document.getElementById("status-body");
  if (!section || !body) return;
  section.hidden = false;

  const rows = status.providers
    .map((p) => {
      const api = p.apiKeySet ? "✓ set" : "✗ missing";
      const secret = p.webhookSecretSet ? "✓ set" : "✗ missing";
      return `<tr><td>${p.provider}</td><td>${api}</td><td>${secret}</td></tr>`;
    })
    .join("");
  body.innerHTML = `
    <p>Notes are tagged <code>#${status.tag}</code>.</p>
    <table>
      <thead><tr><th>Provider</th><th>API key</th><th>Webhook secret</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function init(): Promise<void> {
  fillWebhookUrl();
  try {
    const res = await fetch(`${MOUNT}/api/config-status`, { credentials: "include" });
    if (!res.ok) return; // not an operator (401/403) — leave the static doc.
    renderStatus((await res.json()) as ConfigStatus);
  } catch {
    // network error — static instructions stand.
  }
}

void init();
