import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { JobReactions, RemoveReactionsResult } from '../types';
import { SectionCard } from './primitives';

// The emojis miniOG uses; anything else shows as its :name:.
const EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  x: '❌',
  zzz: '💤',
  no_entry_sign: '🚫',
  memo: '📝',
};

function emojiFor(name: string): string {
  return EMOJI[name] ?? `:${name}:`;
}

function describeRemoval(result: RemoveReactionsResult): string {
  const parts: string[] = [];
  if (result.removed.length > 0) parts.push(`Removed ${result.removed.map(emojiFor).join(' ')}`);
  if (result.failed.length > 0) parts.push(`Couldn't remove ${result.failed.join(', ')}`);
  return parts.length > 0 ? `${parts.join('. ')}.` : 'miniOG had no emojis left there.';
}

type RunReactionsProps = {
  jobId: string;
  running: boolean;
};

/**
 * Slack lets only the bot take its own reactions off a message, so people
 * can't clear a stuck :eyes: themselves. This lists miniOG's emojis on the
 * message that started a run and removes them.
 */
export function RunReactions({ jobId, running }: RunReactionsProps) {
  const [reactions, setReactions] = useState<JobReactions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await invoke<JobReactions>('get_job_reactions', { jobId });
      setReactions(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [jobId]);

  useEffect(() => {
    setReactions(null);
    setError(null);
    setNotice(null);
    void load();
  }, [load]);

  const remove = async (names: string[] | null) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await invoke<RemoveReactionsResult>('remove_job_reactions', { jobId, names });
      setNotice(describeRemoval(result));
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (reactions && !reactions.hasMessage) return null;

  const names = reactions?.reactions ?? null;
  const actions =
    names && names.length > 1 ? (
      <button className="ghost-button" type="button" disabled={busy} onClick={() => void remove(names)}>
        Remove all
      </button>
    ) : null;

  return (
    <SectionCard
      title="miniOG's emojis"
      subtitle="Only miniOG can take its emojis off the Slack message that started this run."
      actions={actions}
    >
      {error ? (
        <div className="run-reactions-row">
          <span className="run-reactions-error">{error}</span>
          <button className="ghost-button" type="button" disabled={busy} onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !reactions ? (
        <p className="muted">Checking Slack…</p>
      ) : names === null ? (
        <div className="run-reactions-row">
          <span className="muted">
            Slack won't let the app read that message ({reactions.readError}), so it can't list them.
          </span>
          <button className="ghost-button" type="button" disabled={busy} onClick={() => void remove(null)}>
            Remove any miniOG emojis
          </button>
        </div>
      ) : names.length === 0 ? (
        <p className="muted">None left on the message.</p>
      ) : (
        <div className="run-reactions-list">
          {names.map(name => (
            <span className="run-reaction-chip" key={name} title={`:${name}:`}>
              <span className="run-reaction-emoji">{emojiFor(name)}</span>
              <button
                className="run-reaction-remove"
                type="button"
                aria-label={`Remove :${name}:`}
                disabled={busy}
                onClick={() => void remove([name])}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {notice ? <p className="muted run-reactions-notice">{notice}</p> : null}
      {running ? (
        <p className="muted run-reactions-notice">The run is still going; miniOG adds its last emoji when it ends.</p>
      ) : null}
    </SectionCard>
  );
}
