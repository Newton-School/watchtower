import { useEffect, useState } from 'react';
import type { RunControls, SlackUser, StartedRunStatus } from '../types';
import { SlackText } from '../lib/slackText';
import { readFlag, writeFlag } from '../lib/prefs';

const RERUN_POSTS_KEY = 'watchtower.rerunPostsAsk';

/** A run started from this thread view, and what the sidecar has made of it so far. */
export type StartedRunView = { kind: 'rerun' | 'ask'; requestId: string; status: StartedRunStatus | null };

/** Waiting for the sidecar to take the request. */
export function isWaiting(status: StartedRunStatus | null): boolean {
  return !status || (!status.jobId && ['PENDING', 'CLAIMED', 'QUEUED'].includes(status.status));
}

type RunControlsBarProps = {
  jobId: string;
  controls: RunControls;
  users: Record<string, SlackUser>;
  /** The thread can't take a new run (deleted, or unreadable). */
  threadClosed: boolean;
  busy: boolean;
  started: StartedRunView | null;
  onStop: () => Promise<boolean>;
  onRerun: (postAsk: boolean) => Promise<boolean>;
  onDismissStarted: () => void;
  onOpenRun?: (jobId: string) => void;
};

/** Stop the run or run its ask again, from the top of its thread. */
export function RunControlsBar({
  jobId,
  controls,
  users,
  threadClosed,
  busy,
  started,
  onStop,
  onRerun,
  onDismissStarted,
  onOpenRun,
}: RunControlsBarProps) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [postAsk, setPostAsk] = useState(() => readFlag(RERUN_POSTS_KEY, true));

  const otherRun = controls.busyJobId && controls.busyJobId !== jobId ? controls.busyJobId : null;
  const blocked = controls.busyJobId
    ? 'miniOG is already working in this thread.'
    : controls.starting
      ? 'A run started from here is waiting to be picked up.'
      : null;
  const canRerun = Boolean(controls.rerunAsk) && !threadClosed;

  // Close what no longer applies once the run moves on.
  useEffect(() => {
    if (!controls.canStop) setConfirmingStop(false);
  }, [controls.canStop]);

  // Escape backs out of a prompt here without leaving the run page.
  const open = confirmingStop || rerunOpen;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setConfirmingStop(false);
      setRerunOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!controls.canStop && !canRerun && !otherRun && !started) return null;

  return (
    <div className="run-controls">
      <div className="run-controls-row">
        <span className="run-controls-note">
          {controls.busyJobId === jobId
            ? 'miniOG is working on this run.'
            : otherRun
              ? 'miniOG is working on another run in this thread.'
              : null}
          {otherRun && onOpenRun ? (
            <button className="run-controls-link" type="button" onClick={() => onOpenRun(otherRun)}>
              Open it
            </button>
          ) : null}
        </span>
        <div className="run-controls-buttons">
          {controls.canStop ? (
            <button
              className="ghost-button"
              type="button"
              disabled={busy}
              aria-expanded={confirmingStop}
              onClick={() => {
                setRerunOpen(false);
                setConfirmingStop(current => !current);
              }}
            >
              ■ Stop run
            </button>
          ) : null}
          {canRerun ? (
            <button
              className="ghost-button"
              type="button"
              disabled={busy || Boolean(blocked)}
              title={blocked ?? 'Run the same ask again in this thread'}
              aria-expanded={rerunOpen}
              onClick={() => {
                setConfirmingStop(false);
                setRerunOpen(current => !current);
              }}
            >
              ↻ Re-run
            </button>
          ) : null}
        </div>
      </div>

      {confirmingStop ? (
        <div className="run-controls-panel" role="group" aria-label="Stop this run">
          <span>Stop this run? miniOG stops where it is.</span>
          <div className="run-controls-panel-actions">
            <button className="ghost-button" type="button" onClick={() => setConfirmingStop(false)}>
              Keep going
            </button>
            <button
              className="primary-button slack-danger"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (await onStop()) setConfirmingStop(false);
              }}
            >
              Stop run
            </button>
          </div>
        </div>
      ) : null}

      {rerunOpen && controls.rerunAsk ? (
        <div className="run-controls-panel" role="group" aria-label="Re-run this ask">
          <div className="run-controls-ask">
            <span className="muted">
              {controls.rerunFor ? (
                <>
                  Re-run for <SlackText text={`<@${controls.rerunFor}>`} users={users} />, on your authority:
                </>
              ) : (
                'Re-run, on your authority:'
              )}
            </span>
            <blockquote>
              <SlackText text={controls.rerunAsk} users={users} />
            </blockquote>
          </div>
          <label className="slack-broadcast">
            <input
              type="checkbox"
              checked={postAsk}
              onChange={e => {
                setPostAsk(e.target.checked);
                writeFlag(RERUN_POSTS_KEY, e.target.checked);
              }}
            />
            Post the ask in the thread
          </label>
          <span className="muted run-controls-hint">
            {postAsk
              ? 'miniOG posts that you re-ran it, with the ask, and its emojis go on that post.'
              : 'Nothing is posted; miniOG just starts answering here.'}
          </span>
          {blocked ? <span className="slack-thread-warning">{blocked}</span> : null}
          <div className="run-controls-panel-actions">
            <button className="ghost-button" type="button" onClick={() => setRerunOpen(false)}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy || Boolean(blocked)}
              onClick={async () => {
                if (await onRerun(postAsk)) setRerunOpen(false);
              }}
            >
              Re-run
            </button>
          </div>
        </div>
      ) : null}

      {started ? (
        <StartedRunLine started={started} jobId={jobId} onDismiss={onDismissStarted} onOpenRun={onOpenRun} />
      ) : null}
    </div>
  );
}

function StartedRunLine({
  started,
  jobId,
  onDismiss,
  onOpenRun,
}: {
  started: StartedRunView;
  jobId: string;
  onDismiss: () => void;
  onOpenRun?: (jobId: string) => void;
}) {
  const what = started.kind === 'rerun' ? 're-run' : 'ask';
  const { status } = started;
  const newRun = status?.jobId && status.jobId !== jobId ? status.jobId : null;
  let text: string;
  if (isWaiting(status)) text = `Waiting for miniOG to pick up your ${what}…`;
  else if (newRun) text = `miniOG took your ${what}.`;
  else text = `miniOG didn't start your ${what}: ${status?.error ?? `it ended as ${status?.status.toLowerCase()}`}`;

  return (
    <div className={newRun || isWaiting(status) ? 'run-controls-started' : 'run-controls-started slack-thread-error'}>
      <span role="status">{text}</span>
      {newRun && onOpenRun ? (
        <button className="run-controls-link" type="button" onClick={() => onOpenRun(newRun)}>
          Open the new run →
        </button>
      ) : null}
      <button className="slack-action" type="button" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
