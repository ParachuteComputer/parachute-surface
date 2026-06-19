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

  // Built with DOM APIs + textContent (NOT innerHTML interpolation) so an
  // operator-configured `tag` / a provider name can never inject markup into
  // their own page.
  body.replaceChildren();

  const p = document.createElement("p");
  p.append("Notes are tagged ");
  const code = document.createElement("code");
  code.textContent = `#${status.tag}`;
  p.append(code, ".");

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Provider", "API key", "Webhook secret"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const prov of status.providers) {
    const tr = document.createElement("tr");
    const cells = [
      prov.provider,
      prov.apiKeySet ? "✓ set" : "✗ missing",
      prov.webhookSecretSet ? "✓ set" : "✗ missing",
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  body.append(p, table);
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
