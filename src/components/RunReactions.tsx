import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { JobReactions, RemoveReactionsResult, SlackReadError } from '../types';
import { SectionCard } from './primitives';

// The emojis miniOG uses; anything else shows as its :name:.
const EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  x: '❌',
  zzz: '💤',
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

  // miniOG swaps 👀 for its last emoji when the run ends, so read again then.
  // The status flips a moment before the swap, so give it a beat.
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended) return;
    const timer = setTimeout(() => void load(), 2000);
    return () => clearTimeout(timer);
  }, [running, load]);

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
        <ReadErrorRow
          readError={reactions.readError}
          busy={busy}
          onRetry={() => void load()}
          onSweep={() => void remove(null)}
        />
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

type ReadErrorRowProps = {
  readError: SlackReadError | null;
  busy: boolean;
  onRetry: () => void;
  onSweep: () => void;
};

function ReadErrorRow({ readError, busy, onRetry, onSweep }: ReadErrorRowProps) {
  const code = readError?.code ?? 'unknown_error';
  if (readError?.kind === 'deleted') {
    return <p className="muted">That message was deleted, so there's nothing to clean.</p>;
  }
  if (readError?.kind === 'noAccess') {
    return (
      <div className="run-reactions-row">
        <span className="muted">Slack won't let the app read that message ({code}), so it can't list them.</span>
        <button className="ghost-button" type="button" disabled={busy} onClick={onSweep}>
          Remove any miniOG emojis
        </button>
      </div>
    );
  }
  const message =
    readError?.kind === 'auth'
      ? `Slack rejected the bot token (${code}). Check it in Settings.`
      : `Slack couldn't read that message (${code}).`;
  return (
    <div className="run-reactions-row">
      <span className="run-reactions-error">{message}</span>
      <button className="ghost-button" type="button" disabled={busy} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
