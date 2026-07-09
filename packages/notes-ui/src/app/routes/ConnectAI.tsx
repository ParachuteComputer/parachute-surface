import { CopyField } from "@/components/CopyField";
import { claudeConnectCommand, mcpEndpoint } from "@/lib/home/connect";
import { useHomeChecklist } from "@/lib/home/use-home-checklist";
import { useToastStore } from "@/lib/toast/store";
import { useVaultStore } from "@/lib/vault";
import { Link, Navigate, useNavigate } from "react-router";

// The "Connect your AI" moment. A vault speaks MCP, so any assistant that
// speaks MCP can read and write it. This is guidance, never a wall: the user
// reaches it from the home quick action / checklist and can leave any time.
//
// Connecting an AI happens in the assistant's own settings and isn't
// detectable from here — so completion is a manual "I've connected it" tick,
// never faked. Copy-to-clipboard on the vault URL is the one thing this screen
// does for you.
export function ConnectAI() {
  const vault = useVaultStore((s) => s.getActiveVault());
  const { state, setOverride } = useHomeChecklist(vault?.id ?? null);
  const pushToast = useToastStore((s) => s.push);
  const navigate = useNavigate();

  // No vault → nothing to connect to. Bounce to the index (which shows the
  // no-vault landing).
  if (!vault) return <Navigate to="/" replace />;

  const mcpUrl = mcpEndpoint(vault.url);
  const cliCommand = claudeConnectCommand(vault.name, mcpUrl);
  const connected = state.overrides.connect === true;

  const markConnected = () => {
    setOverride("connect", true);
    pushToast("Marked as connected.", "success");
    navigate("/");
  };

  return (
    <div className="page-prose">
      <header className="mb-8">
        <p className="eyebrow">{vault.name}</p>
        <h1 className="page-title">Connect your AI</h1>
        <p className="mt-3 text-fg-muted">
          Your vault speaks MCP — an open standard — so any AI can read and write it: Claude,
          ChatGPT, Claude Code, Cursor, or an agent you build. One memory, shared with every
          assistant you choose to connect.
        </p>
      </header>

      <section aria-labelledby="mcp-url-heading" className="mb-8">
        <h2 id="mcp-url-heading" className="eyebrow mb-2">
          Your vault address
        </h2>
        <p className="mb-3 text-sm text-fg-muted">
          Paste this wherever an AI asks for an MCP server. The <code>/mcp</code> suffix matters —
          it's the connection endpoint, not a page to open.
        </p>
        <CopyField value={mcpUrl} label="vault MCP URL" />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <StepCard title="Claude" steps={CLAUDE_STEPS} />
        <StepCard
          title="ChatGPT"
          steps={CHATGPT_STEPS}
          note="Exact menu names vary by ChatGPT version; the shape is the same — add an MCP server, paste the URL."
        />
      </div>

      <section aria-labelledby="other-clients-heading" className="mt-8">
        <h2 id="other-clients-heading" className="eyebrow mb-2">
          Other AIs &amp; the command line
        </h2>
        <p className="mb-3 text-sm text-fg-muted">
          That same URL works in any MCP-compatible client — Cursor, an agent you build, anywhere an
          AI asks for an MCP server. For Claude Code:
        </p>
        <CopyField value={cliCommand} label="Claude Code command" />
      </section>

      <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-border pt-6">
        {connected ? (
          <p className="text-sm text-accent">✓ You've marked your AI as connected.</p>
        ) : (
          <button type="button" onClick={markConnected} className="btn btn-primary btn-touch">
            I've connected my AI
          </button>
        )}
        <Link to="/" className="text-sm text-fg-muted hover:text-accent">
          Back to home
        </Link>
      </div>
    </div>
  );
}

// Each step is a keyed node so the numbered list renders without synthetic
// index keys; the copy lives here, once, out of the render body.
interface Step {
  key: string;
  body: React.ReactNode;
}

const CLAUDE_STEPS: Step[] = [
  {
    key: "settings",
    body: (
      <>
        Open{" "}
        <a
          href="https://claude.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          claude.ai
        </a>{" "}
        and go to <strong className="text-fg">Settings → Connectors</strong>.
      </>
    ),
  },
  {
    key: "add",
    body: (
      <>
        Choose <strong className="text-fg">Add custom connector</strong>.
      </>
    ),
  },
  { key: "paste", body: "Paste your vault address above and connect." },
];

const CHATGPT_STEPS: Step[] = [
  {
    key: "settings",
    body: (
      <>
        Open ChatGPT's <strong className="text-fg">Settings</strong> and find its connectors (custom
        connectors need a paid ChatGPT plan).
      </>
    ),
  },
  { key: "add", body: "Add a custom connector / MCP server." },
  { key: "paste", body: "Paste the same vault address and connect." },
];

function StepCard({ title, steps, note }: { title: string; steps: Step[]; note?: string }) {
  return (
    <section className="card p-5" aria-label={`Connect ${title}`}>
      <h2 className="mb-3 font-serif text-xl text-fg">{title}</h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
        {steps.map((step) => (
          <li key={step.key}>{step.body}</li>
        ))}
      </ol>
      {note ? <p className="mt-3 text-xs text-fg-dim">{note}</p> : null}
    </section>
  );
}
