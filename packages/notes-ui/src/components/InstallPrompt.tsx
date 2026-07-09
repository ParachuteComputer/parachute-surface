import { CopyField } from "@/components/CopyField";
import { useInstallAffordance } from "@/lib/pwa-install";
import { useVaultStore } from "@/lib/vault";
import { useState } from "react";

export function InstallPrompt() {
  const { state, isIOSDevice, promptInstall } = useInstallAffordance();
  // For the iOS add-to-home-screen path: an installed PWA on iOS gets a
  // separate storage partition from Safari, so the vault connection doesn't
  // carry over and the app asks for the address again (notes#176). Preempt it —
  // show the connected vault's address, copy-ably, right where they install.
  const activeVaultUrl = useVaultStore((s) => s.getActiveVault()?.url ?? null);
  const [iosHintOpen, setIosHintOpen] = useState(false);

  if (state !== "available") return null;

  const handleInstall = async () => {
    const outcome = await promptInstall();
    // No deferred prompt (iOS Safari) — fall back to the manual
    // Add-to-Home-Screen instructions.
    if (outcome === "unavailable" && isIOSDevice) setIosHintOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleInstall}
        className="min-h-11 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-fg-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        Install app
      </button>
      {iosHintOpen ? (
        <dialog
          open
          aria-labelledby="ios-install-title"
          // `open` (non-modal) never renders ::backdrop — that needs
          // showModal(), which jsdom doesn't implement. Keep it declarative and
          // drop the dead backdrop utility rather than ship a class that no-ops.
          className="fixed inset-0 z-50 m-auto max-w-sm rounded-md border border-border bg-card p-6 text-fg shadow-lg"
        >
          <h2 id="ios-install-title" className="mb-3 font-serif text-xl">
            Add Parachute Notes to your home screen
          </h2>
          <ol className="mb-5 list-decimal space-y-2 pl-5 text-sm text-fg-muted">
            <li>Tap the Share icon in Safari's toolbar.</li>
            <li>
              Choose <strong className="text-fg">Add to Home Screen</strong>.
            </li>
            <li>Tap Add. Parachute Notes will open standalone from your home screen.</li>
          </ol>
          {activeVaultUrl ? (
            <div className="mb-5 rounded-md border border-border bg-bg-soft/60 p-3">
              <p className="mb-2 text-sm text-fg-muted">
                The installed app may ask for your vault address — here it is, ready to paste:
              </p>
              <CopyField value={activeVaultUrl} label="vault address" />
            </div>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setIosHintOpen(false)}
              className="min-h-11 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-[--color-on-accent] hover:bg-accent-hover"
            >
              Got it
            </button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
