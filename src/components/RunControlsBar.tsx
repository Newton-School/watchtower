import { useEffect, useState } from 'react';
import type { RunControls, SlackUser, StartedRunStatus } from '../types';
import { SlackText } from '../lib/slackText';
import { readFlag, writeFlag } from '../lib/prefs';
import { useEscapeLayer } from '../lib/escapeLayers';

const RERUN_POSTS_KEY = 'watchtower.rerunPostsAsk';
// The sidecar takes a request within seconds; this long means it isn't taking any.
const SLOW_PICKUP_MS = 2 * 60 * 1000;
// A stop lands within a few seconds; after this the button comes back.
const STOPPING_MS = 20 * 1000;

/** A run started from this thread view, and what the sidecar has made of it so far. */
export type StartedRunView = {
  kind: 'rerun' | 'ask';
  requestId: string;
  startedAt: number;
  /** The posted ask, when the ask was posted. */
  askTs: string | null;
  status: StartedRunStatus | null;
  /** Cancelled from here before miniOG took it. */
  cancelled?: boolean;
};

/** Waiting for the sidecar to take the request. */
export function isWaiting(status: StartedRunStatus | null): boolean {
  return !status || (!status.jobId && ['PENDING', 'CLAIMED', 'QUEUED'].includes(status.status));
}

/** Why a new run can't start in this thread right now. */
export function blockedReason(controls: RunControls | null): string | null {
  if (controls?.busyJobId && controls.busyWaiting) {
    return 'miniOG is waiting for an answer in this thread. Stop that run to start another.';
  }
  if (controls?.busyJobId) return 'miniOG is already working in this thread.';
  if (controls?.starting) return 'A run in this thread is waiting to be picked up.';
  return null;
}

type RunControlsBarProps = {
  jobId: string;
  controls: RunControls;
  users: Record<string, SlackUser>;
  /** The thread can't take a new run (deleted, unreadable, or not read yet). */
  threadClosed: boolean;
  busy: boolean;
  started: StartedRunView | null;
  /** What went wrong with the last Stop or Re-run. */
  error: string | null;
  onStop: () => Promise<boolean>;
  onRerun: (postAsk: boolean) => Promise<boolean>;
  onDismissStarted: () => void;
  onCancelStarted: () => void;
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
  error,
  onStop,
  onRerun,
  onDismissStarted,
  onCancelStarted,
  onOpenRun,
}: RunControlsBarProps) {
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [postAsk, setPostAsk] = useState(() => readFlag(RERUN_POSTS_KEY, true));

  const otherRun = controls.busyJobId && controls.busyJobId !== jobId ? controls.busyJobId : null;
  const blocked = blockedReason(controls);
  const canRerun = Boolean(controls.rerunAsk) && !threadClosed;

  // Close what no longer applies once the run moves on.
  useEffect(() => {
    if (!controls.canStop) {
      setConfirmingStop(false);
      setStopping(false);
    }
  }, [controls.canStop]);
  useEffect(() => {
    if (!canRerun) setRerunOpen(false);
  }, [canRerun]);
  useEffect(() => {
    if (!stopping) return;
    const timer = window.setTimeout(() => setStopping(false), STOPPING_MS);
    return () => window.clearTimeout(timer);
  }, [stopping]);

  useEscapeLayer(confirmingStop || rerunOpen, () => {
    setConfirmingStop(false);
    setRerunOpen(false);
  });

  if (!controls.canStop && !canRerun && !otherRun && !blocked && !started && !error) return null;

  const waitingNote = controls.busyWaiting ? 'waiting for an answer on' : 'working on';
  const note = controls.busyJobId === jobId ? (stopping ? 'Stopping…' : `miniOG is ${waitingNote} this run.`) : blocked;

  return (
    <div className="run-controls">
      <div className="run-controls-row">
        <span className="run-controls-note">
          {otherRun ? `miniOG is ${waitingNote} another run in this thread.` : note}
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
              disabled={busy || stopping}
              aria-expanded={confirmingStop}
              onClick={() => {
                setRerunOpen(false);
                setConfirmingStop(current => !current);
              }}
            >
              <span aria-hidden="true">■ </span>
              {stopping ? 'Stopping…' : 'Stop run'}
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
              <span aria-hidden="true">↻ </span>
              Re-run
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
                if (await onStop()) {
                  setConfirmingStop(false);
                  setStopping(true);
                }
              }}
            >
              Yes, stop
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
              ? 'miniOG posts the ask here first; its emojis go on that post.'
              : 'Nothing is posted, not even an emoji; miniOG just starts answering here.'}
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
              Re-run now
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="slack-thread-error run-controls-error" role="alert">
          {error}
        </p>
      ) : null}

      {started ? (
        <StartedRunLine
          started={started}
          jobId={jobId}
          busy={busy}
          onDismiss={onDismissStarted}
          onCancel={onCancelStarted}
          onOpenRun={onOpenRun}
        />
      ) : null}
    </div>
  );
}

function StartedRunLine({
  started,
  jobId,
  busy,
  onDismiss,
  onCancel,
  onOpenRun,
}: {
  started: StartedRunView;
  jobId: string;
  busy: boolean;
  onDismiss: () => void;
  onCancel: () => void;
  onOpenRun?: (jobId: string) => void;
}) {
  // Re-render now and then so a slow pickup gets noticed.
  const [now, setNow] = useState(() => Date.now());
  const waiting = isWaiting(started.status);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const what = started.kind === 'rerun' ? 're-run' : 'ask';
  const { status } = started;
  const newRun = status?.jobId && status.jobId !== jobId ? status.jobId : null;
  let text: string;
  if (waiting) {
    text =
      now - started.startedAt < SLOW_PICKUP_MS
        ? `Waiting for miniOG to pick up your ${what}…`
        : `miniOG hasn't picked up your ${what} yet. Check that it's running.`;
  } else if (newRun) {
    text = `miniOG took your ${what}.`;
  } else if (started.cancelled) {
    text = `Cancelled your ${what} before miniOG took it.`;
  } else {
    const why = status?.error ?? (status?.status === 'SKIPPED' ? 'it was skipped' : 'it failed');
    text = `miniOG didn't start your ${what}: ${why}`;
  }
  const trouble = !waiting && !newRun && !started.cancelled;

  return (
    <div className={trouble ? 'run-controls-started slack-thread-error' : 'run-controls-started'}>
      <span role="status">{text}</span>
      {newRun && onOpenRun ? (
        <button className="run-controls-link" type="button" onClick={() => onOpenRun(newRun)}>
          Open the new run →
        </button>
      ) : null}
      {waiting ? (
        <button className="run-controls-link" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      <button className="slack-action" type="button" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
