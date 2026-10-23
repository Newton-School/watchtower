import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Bundle, Capability, SlackDirectory } from '../types';
import { loadSlackDirectory } from '../lib/slackCache';
import { PeoplePicker } from './PeoplePicker';

type CapabilityOption = {
  id: Capability;
  label: string;
  description: string;
  ownerOnly?: boolean;
};

const CAPABILITY_OPTIONS: CapabilityOption[] = [
  { id: 'query_codebase', label: 'Query codebase', description: 'Read repo, answer informational questions.' },
  { id: 'chat', label: 'Chat', description: 'Conversational replies, greetings, status checks.' },
  { id: 'miniog_dossier_self', label: 'Dossier (self)', description: 'whoami, remember, forget — own profile only.' },
  { id: 'investigate', label: 'Investigate', description: 'Run RCA / investigation flow.' },
  { id: 'submit_pr_review', label: 'Submit PR review', description: 'Multi-agent review with inline comments.' },
  { id: 'comment_pr', label: 'Comment on PR', description: 'Single PR comment (subset of full review).' },
  { id: 'start_implementation', label: 'Start implementation', description: 'Open a PR via the multi-agent pipeline.' },
  { id: 'deploy_prod', label: 'Deploy prod', description: 'Production deploy via deploy-prod skill.' },
  { id: 'dev_assist', label: 'Dev assist', description: 'wt / swarm commands.' },
  {
    id: 'miniog_dossier_admin',
    label: 'Dossier (admin)',
    description: 'Edit other users’ dossiers; admin-only fields.',
  },
  {
    id: 'manage_access',
    label: 'Manage access',
    description: 'Edit the access-control system itself. Owner-only by convention.',
    ownerOnly: true,
  },
];

const SEED_NAMES = ['viewer', 'reviewer', 'builder', 'admin', 'owner'] as const;

function emptyBundle(name: string): Bundle {
  return {
    name,
    manualUserIds: '',
    resolvedUserIds: [],
    capabilities: [],
    allowedChannelIds: [],
    allowIm: false,
    allowMpim: false,
  };
}

type DirtyState = {
  draft: Bundle;
  dirty: boolean;
};

function bundleKey(b: Bundle): string {
  return b.name;
}

function parseIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map(id => id.trim())
        .filter(Boolean),
    ),
  ];
}

export function BundleEditor() {
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DirtyState>>({});
  const [savingName, setSavingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBundleName, setNewBundleName] = useState('');
  const [directory, setDirectory] = useState<SlackDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadSlackDirectory()
      .then(next => {
        if (live) setDirectory(next);
      })
      .catch(err => {
        if (live) setDirectoryError(String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  // Unsaved edits to other bundles survive a reload; `reloaded` (just saved,
  // or refused because it changed elsewhere) takes the stored version.
  const refresh = useCallback(async (reloaded?: string) => {
    try {
      const fetched = await invoke<Bundle[]>('get_bundles');
      setBundles(fetched);
      setDrafts(prev => {
        const next: Record<string, DirtyState> = {};
        for (const b of fetched) {
          const kept = prev[bundleKey(b)];
          next[bundleKey(b)] = kept?.dirty && b.name !== reloaded ? kept : { draft: b, dirty: false };
        }
        return next;
      });
      setError(null);
    } catch (err) {
      setError(`Failed to load bundles: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchDraft = useCallback((name: string, patch: Partial<Bundle>) => {
    setDrafts(prev => {
      const current = prev[name];
      if (!current) return prev;
      return {
        ...prev,
        [name]: { draft: { ...current.draft, ...patch }, dirty: true },
      };
    });
  }, []);

  const toggleCapability = useCallback(
    (name: string, capability: Capability) => {
      const current = drafts[name];
      if (!current) return;
      const has = current.draft.capabilities.includes(capability);
      const next = has
        ? current.draft.capabilities.filter(c => c !== capability)
        : [...current.draft.capabilities, capability];
      patchDraft(name, { capabilities: next });
    },
    [drafts, patchDraft],
  );

  const saveBundle = useCallback(
    async (name: string) => {
      const current = drafts[name];
      if (!current) return;
      setSavingName(name);
      setError(null);
      try {
        await invoke('save_bundle', { bundle: current.draft });
        await refresh(name);
      } catch (err) {
        const message = String(err);
        // Changed elsewhere since the page read it: show the stored version.
        if (message.includes('changed since Settings loaded it')) await refresh(name);
        setError(`Failed to save bundle ${name}: ${message}`);
      } finally {
        setSavingName(null);
      }
    },
    [drafts, refresh],
  );

  const deleteBundle = useCallback(
    async (name: string) => {
      if (SEED_NAMES.includes(name as (typeof SEED_NAMES)[number])) {
        if (!confirm(`Delete the default "${name}" bundle? Everyone on it loses what it grants.`)) {
          return;
        }
      } else if (!confirm(`Delete bundle "${name}"?`)) {
        return;
      }
      setDeletingName(name);
      setError(null);
      try {
        await invoke('delete_bundle', { name });
        await refresh();
      } catch (err) {
        setError(`Failed to delete bundle ${name}: ${String(err)}`);
      } finally {
        setDeletingName(null);
      }
    },
    [refresh],
  );

  const addBundle = useCallback(async () => {
    const trimmed = newBundleName.trim();
    if (!trimmed) {
      setError('Bundle name cannot be empty.');
      return;
    }
    if (bundles?.some(b => b.name === trimmed)) {
      setError(`A bundle named "${trimmed}" already exists.`);
      return;
    }
    setSavingName(trimmed);
    setError(null);
    try {
      await invoke('save_bundle', { bundle: emptyBundle(trimmed) });
      setNewBundleName('');
      await refresh();
    } catch (err) {
      setError(`Failed to create bundle ${trimmed}: ${String(err)}`);
    } finally {
      setSavingName(null);
    }
  }, [bundles, newBundleName, refresh]);

  if (bundles === null) {
    return <p className="field-hint">Loading bundles…</p>;
  }

  return (
    <div className="bundle-editor">
      {error ? (
        <div className="bundle-editor-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="bundle-editor-add">
        <label className="field" style={{ flex: 1 }}>
          <span>Add a bundle</span>
          <input
            type="text"
            value={newBundleName}
            onChange={event => setNewBundleName(event.target.value)}
            placeholder="e.g. on-call, designer, qa"
          />
        </label>
        <button
          type="button"
          className="button"
          onClick={() => void addBundle()}
          disabled={savingName !== null || newBundleName.trim().length === 0}
          style={{ alignSelf: 'flex-end' }}
        >
          {savingName === newBundleName.trim() ? 'Creating…' : 'Add bundle'}
        </button>
      </div>

      {bundles.length === 0 ? (
        <p className="field-hint">No bundles yet. The sidecar will seed the 5 default bundles on next restart.</p>
      ) : null}

      {directoryError ? (
        <p className="field-hint">
          Couldn&apos;t load people from Slack ({directoryError}). People show as Slack user IDs, and you can add
          someone by their ID.
        </p>
      ) : null}

      {bundles.map(bundle => {
        const ds = drafts[bundleKey(bundle)];
        if (!ds) return null;
        const draft = ds.draft;
        const dirty = ds.dirty;
        const channelsValue = draft.allowedChannelIds.join(',');
        return (
          <article key={bundle.name} className="bundle-card">
            <header className="bundle-card-header">
              <strong>{bundle.name}</strong>
              <div className="bundle-card-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void saveBundle(bundle.name)}
                  disabled={!dirty || savingName === bundle.name}
                >
                  {savingName === bundle.name ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                </button>
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => void deleteBundle(bundle.name)}
                  disabled={deletingName === bundle.name}
                >
                  {deletingName === bundle.name ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </header>

            <PeoplePicker
              label="People"
              accessibleName={`People on ${bundle.name}`}
              ids={parseIds(draft.manualUserIds)}
              onChange={ids => patchDraft(bundle.name, { manualUserIds: ids.join(',') })}
              directory={directory}
            />
            {bundle.name === 'admin' || bundle.name === 'owner' ? (
              <p className="field-hint">The owners are always on this bundle.</p>
            ) : null}

            <div className="settings-fields">
              <label className="field">
                <span>Allowed Channel IDs</span>
                <input
                  type="text"
                  value={channelsValue}
                  onChange={event =>
                    patchDraft(bundle.name, {
                      allowedChannelIds: event.target.value
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="C01H25RNLJH,C02XXXXXXX"
                />
              </label>
            </div>

            <div className="access-group-channel-toggles">
              <label className="access-toggle">
                <input
                  type="checkbox"
                  checked={draft.allowIm}
                  onChange={event => patchDraft(bundle.name, { allowIm: event.target.checked })}
                />
                <span>Allow DM</span>
              </label>

              <label className="access-toggle">
                <input
                  type="checkbox"
                  checked={draft.allowMpim}
                  onChange={event => patchDraft(bundle.name, { allowMpim: event.target.checked })}
                />
                <span>Allow MPIM</span>
              </label>
            </div>

            <fieldset className="bundle-capabilities">
              <legend>Capabilities</legend>
              <div className="bundle-capability-grid">
                {CAPABILITY_OPTIONS.map(opt => {
                  const enabled = draft.capabilities.includes(opt.id);
                  return (
                    <label key={opt.id} className="bundle-capability">
                      <input type="checkbox" checked={enabled} onChange={() => toggleCapability(bundle.name, opt.id)} />
                      <span>
                        <strong>{opt.label}</strong>
                        {opt.ownerOnly ? <em className="bundle-capability-flag"> (owner)</em> : null}
                        <br />
                        <small>{opt.description}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </article>
        );
      })}
    </div>
  );
}
