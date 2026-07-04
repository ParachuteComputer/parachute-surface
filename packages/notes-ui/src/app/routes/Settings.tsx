import { PATH_TREE_MODES, type PathTreeMode, usePathTreeMode } from "@/lib/path-tree";
import { isStandalone } from "@/lib/pwa";
import {
  TEXT_SIZES,
  type TextSize,
  applyTextSize,
  readStoredTextSize,
  textSizeLabel,
  writeStoredTextSize,
} from "@/lib/text-size";
import { useToastStore } from "@/lib/toast/store";
import {
  DEFAULT_TAG_ROLES,
  TAG_ROLE_KEYS,
  type TagRoleKey,
  type TagRoles,
  useTagRoles,
  useTags,
  useVaultStore,
} from "@/lib/vault";
import {
  useAudioRetention,
  useRetentionChoiceMade,
  useSetAudioRetention,
} from "@/lib/vault/audio-retention";
import { useTranscriptionCapability } from "@/lib/vault/queries";
import type { AudioRetention } from "@/lib/vault/types";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, Navigate } from "react-router";

// Per-vault settings UI. Sections stack top-to-bottom; add more as the
// per-vault customization surface grows.
export function Settings() {
  const activeVault = useVaultStore((s) => s.getActiveVault());
  if (!activeVault) return <Navigate to="/" replace />;

  return (
    <div className="page-prose">
      <header className="mb-8">
        <nav className="mb-3 text-sm text-fg-dim">
          <Link to="/" className="hover:text-accent">
            ← Home
          </Link>
        </nav>
        <h1 className="font-serif text-2xl tracking-tight md:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Configuring <span className="text-fg">{activeVault.name}</span>.
        </p>
      </header>

      <ImportSection />
      <VoiceRetentionSection vaultId={activeVault.id} />
      <TextSizeSection />
      <PathTreeSection vaultId={activeVault.id} />
      <TagRolesSection vaultId={activeVault.id} />
      <InstallStateSection />
    </div>
  );
}

// One-line surfacing of the import route on Settings — the import surface
// itself is a full page (`/import`), this just hands the user a discovery
// path from the obvious place (vault settings is where "what can I do
// with this vault?" affordances belong).
function ImportSection() {
  return (
    <section className="card mb-8 p-4">
      <h2 className="font-serif text-lg">Import notes</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Bring in an Obsidian vault zip or a folder of markdown files. Parsed in your browser;
        previewed before any note lands in the vault.
      </p>
      <div className="mt-3">
        <Link to="/import" className="btn btn-primary btn-touch">
          Open importer
        </Link>
      </div>
    </section>
  );
}

// The "Vault schema" audit section that used to sit here (notes#129) was
// retired in the 2026-07 one-tag simplification: the single `capture` tag
// is now lazily ensured on first capture (schema-ensure.ts), so there is
// nothing for the operator to review or fix.

// Voice-retention transparency: what happens to the audio file after a voice
// note is transcribed. The dial is SERVER-side vault config
// (`config.audio_retention` on GET/PATCH /api/vault — identical contract on
// the self-host and cloud doors), so unlike the sections around it this one
// applies to the vault for every connected device, not just this browser.
// One honest line per option; changing PATCHes immediately; errors surface
// as a toast and the radios stay on the server truth (controlled inputs off
// the cached /api/vault read — a failed PATCH never lies about state).
const RETENTION_OPTIONS: { value: AudioRetention; title: string; help: string }[] = [
  {
    value: "keep",
    title: "Keep",
    help: "Recordings are stored with your notes; included wherever attachments are included.",
  },
  {
    value: "until_transcribed",
    title: "Delete after transcribing",
    help: "Your words stay; the audio file is removed once the transcript lands.",
  },
  {
    value: "never",
    title: "Never store",
    help: "Audio is removed even if transcription fails — the transcript is your only copy; failed transcriptions lose the audio.",
  },
];

function VoiceRetentionSection({ vaultId }: { vaultId: string }) {
  // Same gate as the mic itself (#167): a vault that EXPLICITLY declares
  // transcription disabled has no recorder, so a retention dial would be
  // noise. Absent/undeclared keeps the section (absent ≠ disabled — the mic
  // renders there too). Both reads are cached queries; no new network.
  const transcription = useTranscriptionCapability();
  const retention = useAudioRetention();
  const setRetention = useSetAudioRetention();
  const { markMade } = useRetentionChoiceMade(vaultId);
  const pushToast = useToastStore((s) => s.push);

  if (transcription?.enabled === false) return null;

  const onChange = (value: AudioRetention) => {
    if (value === retention.value || setRetention.isPending) return;
    setRetention.mutate(value, {
      onSuccess: () => {
        // Also settles the first-capture prompt — an operator who set the
        // dial here has made their choice; don't re-ask at the recorder.
        markMade();
        pushToast("Voice recording setting saved.", "success");
      },
      onError: (err) => {
        pushToast(
          err instanceof Error && err.message
            ? `Couldn't save: ${err.message}`
            : "Couldn't save the voice recording setting.",
          "error",
        );
      },
    });
  };

  return (
    <section className="card mt-6 space-y-4 rounded-xl p-6">
      <div>
        <h2 className="font-serif text-xl text-fg">Voice recordings</h2>
        <p className="mt-1 text-xs text-fg-dim">
          What happens to the audio file after a voice note is transcribed. Applies to this vault,
          from every device connected to it.
        </p>
      </div>
      {retention.isLoading ? (
        <p className="text-sm text-fg-dim">Loading…</p>
      ) : retention.isError ? (
        <p className="text-sm text-fg-dim" data-testid="retention-load-error">
          Couldn't load this setting — check the vault connection.
        </p>
      ) : (
        <>
          <fieldset className="space-y-2" disabled={!retention.supported || setRetention.isPending}>
            <legend className="sr-only">Voice recording retention</legend>
            {RETENTION_OPTIONS.map((o) => (
              <label key={o.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="audio-retention"
                  value={o.value}
                  checked={retention.value === o.value}
                  onChange={() => onChange(o.value)}
                  className="mt-1 accent-accent"
                />
                <span>
                  <span className="text-fg">{o.title}</span>
                  <span className="ml-2 text-xs text-fg-dim">{o.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {!retention.supported ? (
            <p className="text-xs text-fg-dim" data-testid="retention-unsupported">
              This vault doesn't support changing this yet — recordings are kept. Update the vault
              to choose.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// View-level text-size knob — per-device because eye-days vary independently
// of vault. The dropdown applies + persists in one motion via the helpers in
// lib/text-size.ts; App.tsx already applies the stored value on mount, so
// this section's job is just "change + save".
function TextSizeSection() {
  // Lazy initializer reads localStorage during the first render, not in a
  // useEffect afterward — without this the radio briefly renders "Default"
  // before the effect overwrites with the stored value, which the reviewer
  // on #123 flagged as a visible flash.
  const [size, setSize] = useState<TextSize>(() => readStoredTextSize());

  const onChange = (next: TextSize) => {
    setSize(next);
    writeStoredTextSize(next);
    applyTextSize(next);
  };

  return (
    <section className="card mt-6 space-y-4 rounded-xl p-6">
      <div>
        <h2 className="font-serif text-xl text-fg">Text size</h2>
        <p className="mt-1 text-xs text-fg-dim">
          Affects the editor and rendered notes on this device. Your markdown isn't changed.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">View text size</legend>
        {TEXT_SIZES.map((s) => (
          <label key={s} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="text-size"
              value={s}
              checked={size === s}
              onChange={() => onChange(s)}
              className="mt-1 accent-accent"
            />
            <span className="text-fg">{textSizeLabel(s)}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function InstallStateSection() {
  // matchMedia is only reliable at render time on some browsers, so sample
  // once on mount.
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(isStandalone());
  }, []);
  if (!installed) return null;
  return (
    <section className="card mt-6 p-4 text-sm">
      <p className="text-fg-muted">
        <span className="mr-2 inline-block rounded-full bg-[--color-positive-soft] px-2 py-0.5 text-xs font-medium text-[--color-positive]">
          Installed
        </span>
        Parachute Notes is running as an installed app on this device.
      </p>
    </section>
  );
}

const PATH_TREE_MODE_LABELS: Record<PathTreeMode, { title: string; help: string }> = {
  auto: {
    title: "Auto",
    help: "Show the tree only when the vault has enough folders to make it worth the space.",
  },
  always: {
    title: "Always",
    help: "Always show the tree, even on a tag-flat vault.",
  },
  never: {
    title: "Never",
    help: "Hide the tree. The path-prefix text input still works.",
  },
};

function PathTreeSection({ vaultId }: { vaultId: string }) {
  const { mode, setMode } = usePathTreeMode(vaultId);
  return (
    <section className="card mt-6 space-y-4 rounded-xl p-6">
      <div>
        <h2 className="font-serif text-xl text-fg">Folder tree (Notes sidebar)</h2>
        <p className="mt-1 text-xs text-fg-dim">
          Controls the collapsible folder tree on the notes list page. Auto-detect renders the tree
          when the vault has at least five top-level folders or twenty notes in folders.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">Path tree visibility</legend>
        {PATH_TREE_MODES.map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="path-tree-mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              className="mt-1 accent-accent"
            />
            <span>
              <span className="text-fg">{PATH_TREE_MODE_LABELS[m].title}</span>
              <span className="ml-2 text-xs text-fg-dim">{PATH_TREE_MODE_LABELS[m].help}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

const ROLE_LABELS: Record<TagRoleKey, { title: string; help: string }> = {
  pinned: {
    title: "Pinned",
    help: "Tag for notes you want at the top of views.",
  },
  archived: {
    title: "Archived",
    help: "Tag for notes you've moved out of the way.",
  },
  captureVoice: {
    title: "Voice capture",
    help: "Default tag for new voice memos.",
  },
  captureText: {
    title: "Text capture",
    help: "Default tag for quick typed notes.",
  },
  view: {
    title: "Saved view",
    help: "Tag the saved-view notes carry. Used to list them in the notes sidebar.",
  },
};

function TagRolesSection({ vaultId }: { vaultId: string }) {
  const { roles, setRoles } = useTagRoles(vaultId);
  const tagsQuery = useTags();
  const pushToast = useToastStore((s) => s.push);
  const datalistId = useId();

  const [draft, setDraft] = useState<TagRoles>(roles);
  useEffect(() => setDraft(roles), [roles]);

  const tagOptions = useMemo(() => {
    const names = (tagsQuery.data ?? []).map((t) => t.name);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }, [tagsQuery.data]);

  const isDirty = TAG_ROLE_KEYS.some((k) => draft[k].trim() !== roles[k]);

  const save = () => {
    setRoles(draft);
    pushToast("Tag roles saved.", "success");
  };

  const resetDefaults = () => {
    setRoles(null);
    setDraft(DEFAULT_TAG_ROLES);
    pushToast("Tag roles reset to defaults.", "success");
  };

  return (
    <section className="card mt-6 space-y-4 rounded-xl p-6">
      <div>
        <h2 className="font-serif text-xl text-fg">Tag roles</h2>
        <p className="mt-1 text-xs text-fg-dim">
          Point each role at whatever tag your vault already uses. Changes apply to future notes
          only — existing notes keep their current tags.
        </p>
      </div>

      <datalist id={datalistId}>
        {tagOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="space-y-3">
        {TAG_ROLE_KEYS.map((key) => (
          <label key={key} className="block text-sm">
            <span className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-fg-muted">{ROLE_LABELS[key].title}</span>
              <span className="text-xs text-fg-dim">default: #{DEFAULT_TAG_ROLES[key]}</span>
            </span>
            <input
              type="text"
              value={draft[key]}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              list={datalistId}
              placeholder={DEFAULT_TAG_ROLES[key]}
              aria-label={`${ROLE_LABELS[key].title} tag role`}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="input input-on-bg"
            />
            <span className="mt-1 block text-xs text-fg-dim">{ROLE_LABELS[key].help}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button type="button" onClick={save} disabled={!isDirty} className="btn btn-primary btn-lg">
          Save
        </button>
        <button
          type="button"
          onClick={resetDefaults}
          className="focus-ring text-sm text-fg-muted hover:text-accent"
        >
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
