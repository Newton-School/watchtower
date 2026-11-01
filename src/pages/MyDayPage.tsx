import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { MyDay, MyDayItem, MyDayRun } from '../types';
import { GlowCard } from '../components/GlowCard';
import { EmptyState, PageIntro, TabBar } from '../components/primitives';

type TabId = 'needs_you' | 'ready' | 'waiting' | 'done' | 'sessions';

const POLL_MS = 10_000;
const COPIED_MS = 2_000;

const EMPTY_COPY: Record<TabId, string> = {
  needs_you: 'Nothing needs you.',
  ready: 'No replies waiting to be sent.',
  waiting: 'Nothing is waiting on someone else.',
  done: 'Nothing finished in the last 7 days.',
  sessions: 'No Claude sessions left unfinished.',
};

const ACTION_LABELS: Record<string, string> = {
  review_pr: 'Review it',
  re_review_pr: 'Re-review it',
  fix_own_pr: 'Fix and push',
  open_pr: 'Raise the PR',
};

const POLICY_ROWS: Array<{ name: string; label: string }> = [
  { name: 'review', label: 'Reviews and re-reviews, posted on GitHub' },
  { name: 'fix_own_pr', label: 'Fixes pushed to your PRs, with replies on the comments' },
  { name: 'open_pr', label: 'New PRs for clear asks' },
  { name: 'tag', label: "miniOG's line in the thread after a review" },
];

function inTab(item: MyDayItem, tab: TabId): boolean {
  if (item.source === 'session') return tab === (item.state === 'done' ? 'done' : 'sessions');
  // Work under way is waiting on someone too, just not on him.
  return item.state === 'working' ? tab === 'waiting' : item.state === tab;
}

function prLabel(url: string): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}#${match[2]}` : url;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function runLine(run: MyDayRun | null, runQueued: boolean): string {
  if (runQueued) return 'A run is about to start.';
  if (!run) return "It hasn't run yet.";
  if (run.status === 'RUNNING') return `Running since ${when(run.startedAt)}. This can take a while.`;
  const outcome = run.status === 'FAILED' ? 'failed' : 'finished';
  return `Last run ${outcome} ${when(run.finishedAt ?? run.startedAt)}, covering from ${when(run.windowStart)}. Cost ${money(run.costUsd)}.`;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="my-day-line">
      <span className="my-day-label">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ReplyStatus({ item }: { item: MyDayItem }) {
  if (item.state === 'done') {
    return item.draftStatus === 'saved' ? (
      <p className="muted">If you haven't sent it, its draft is still in Slack.</p>
    ) : null;
  }
  if (item.draftStatus === 'saved')
    return <p className="muted">Saved as a draft in that conversation. Send it from Slack.</p>;
  if (item.draftStatus === 'blocked') {
    return (
      <p className="muted">
        A draft is already there, yours or an earlier one, and Slack keeps one. Copy this instead.
      </p>
    );
  }
  if (item.draftStatus === 'failed') {
    return (
      <p className="my-day-draft-failed">
        Couldn't save the draft: {item.draftError ?? 'unknown error'} Copy it instead.
      </p>
    );
  }
  return null;
}

export function MyDayRow({
  item,
  onChanged,
  onError,
  onOpenRun,
}: {
  item: MyDayItem;
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [answer, setAnswer] = useState('');

  const copyReply = async () => {
    if (!item.replyText) return;
    try {
      await navigator.clipboard.writeText(item.replyText);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch (err) {
      onError(`Couldn't copy the reply: ${String(err)}`);
    }
  };

  const call = async (command: string, args: Record<string, unknown>, changes = false) => {
    try {
      await invoke(command, args);
      if (changes) onChanged();
    } catch (err) {
      onError(String(err));
    }
  };

  const isSession = item.source === 'session';
  const heading = isSession
    ? 'Claude session'
    : [item.asker, item.channelName, item.askedAt].filter(Boolean).join(' · ') || 'GitHub';
  const isOpen = item.state !== 'done';
  const canAnswer = item.state === 'needs_you' && !isSession;

  const sendAnswer = async () => {
    try {
      await invoke('start_my_day_item', { key: item.key, text: answer.trim() });
      setAnswer('');
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  };

  return (
    <article className="my-day-item">
      <header className="my-day-item-head">
        <strong>{heading}</strong>
        <div className="my-day-actions">
          {item.permalink ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => void call('open_my_day_in_slack', { key: item.key })}
            >
              Open in Slack
            </button>
          ) : null}
          {item.prUrls.map(url => (
            <a key={url} className="ghost-button" href={url} target="_blank" rel="noopener noreferrer">
              {prLabel(url)}
              {item.prStates[url] ? ` · ${item.prStates[url]}` : ''}
            </a>
          ))}
          {item.jobId && onOpenRun ? (
            <button className="ghost-button" type="button" onClick={() => onOpenRun(item.jobId ?? '')}>
              See the run
            </button>
          ) : null}
          {canAnswer && item.action ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => void call('start_my_day_item', { key: item.key, text: null }, true)}
            >
              {ACTION_LABELS[item.action] ?? 'Run it'}
            </button>
          ) : null}
          {item.sessionId && isOpen ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => void call('resume_my_day_session', { key: item.key })}
            >
              Resume
            </button>
          ) : null}
          {isOpen ? (
            <>
              <button
                className="ghost-button"
                type="button"
                onClick={() => void call('close_my_day_item', { key: item.key, how: 'done' }, true)}
              >
                Mark done
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => void call('close_my_day_item', { key: item.key, how: 'skipped' }, true)}
              >
                Skip
              </button>
            </>
          ) : null}
          {item.ownerClosed ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => void call('close_my_day_item', { key: item.key, how: 'reopen' }, true)}
            >
              Reopen
            </button>
          ) : null}
        </div>
      </header>
      <Line label={isSession ? 'Session' : 'Asked'}>{item.ask}</Line>
      {item.ownerClosed ? (
        <Line label="Closed">{item.ownerClosed === 'skipped' ? 'You skipped this.' : 'You marked this done.'}</Line>
      ) : null}
      {item.doneSummary ? <Line label={isSession ? 'Left' : 'Done'}>{item.doneSummary}</Line> : null}
      {item.nextStep && isOpen ? <Line label="Next">{item.nextStep}</Line> : null}
      {item.state === 'waiting' && item.evidence ? <Line label="Waiting">{item.evidence}</Line> : null}
      {item.state === 'working' ? <Line label="Working">miniOG is on this now.</Line> : null}
      {item.replyText ? (
        <Line label="Reply">
          <p className="my-day-reply">{item.replyText}</p>
          <ReplyStatus item={item} />
          <button className="ghost-button" type="button" onClick={() => void copyReply()}>
            {copied ? 'Copied' : 'Copy reply'}
          </button>
        </Line>
      ) : null}
      {canAnswer ? (
        <div className="my-day-answer">
          <input
            aria-label={`Answer about: ${item.ask}`}
            placeholder="Your answer"
            value={answer}
            onChange={event => setAnswer(event.target.value)}
          />
          <button className="ghost-button" type="button" disabled={!answer.trim()} onClick={() => void sendAnswer()}>
            Answer
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function MyDayPage({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [day, setDay] = useState<MyDay | null>(null);
  const [tab, setTab] = useState<TabId>('needs_you');
  const [error, setError] = useState<string | null>(null);
  // Separate from the actions' errors: this one clears itself when a later poll works.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [span, setSpan] = useState('');
  const [prepareOnly, setPrepareOnly] = useState(false);
  // Saved on leaving the field: typing passes through times that aren't the one meant.
  const [runTimeDraft, setRunTimeDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDay(await invoke<MyDay>('get_my_day'));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const saveSchedule = async (enabled: boolean, runTime: string) => {
    setError(null);
    try {
      await invoke('save_my_day_schedule', { enabled, runTime });
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const savePolicy = async (name: string, value: string) => {
    setError(null);
    try {
      await invoke('save_my_day_policy', { name, value });
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const runNow = async () => {
    setError(null);
    try {
      await invoke('run_my_day_now', { span: span.trim() || null, prepareOnly });
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const items = day?.items ?? [];
  const count = (id: TabId) => items.filter(item => inTab(item, id)).length;
  const tabs: Array<{ value: TabId; label: string; count: number }> = [
    { value: 'needs_you', label: 'Needs you', count: count('needs_you') },
    { value: 'ready', label: 'Ready to send', count: count('ready') },
    { value: 'waiting', label: 'Waiting', count: count('waiting') },
    { value: 'done', label: 'Done', count: count('done') },
    { value: 'sessions', label: 'Sessions', count: count('sessions') },
  ];
  const shown = items.filter(item => inTab(item, tab));
  const running = day?.lastRun?.status === 'RUNNING' || Boolean(day?.runQueued);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Personal"
        title="My day"
        description="What was asked of you that neither you nor miniOG finished, and the work done on it. Replies wait as Slack drafts for you to send."
      />

      {error ? <div className="my-day-error">{error}</div> : null}
      {loadError ? <div className="my-day-error">{loadError}</div> : null}
      {day?.lastRun?.status === 'FAILED' && day.lastRun.error ? (
        <div className="my-day-error">The last run failed: {day.lastRun.error}</div>
      ) : null}

      <GlowCard>
        <div className="my-day-schedule">
          <label>
            <input
              type="checkbox"
              checked={Boolean(day?.enabled)}
              disabled={!day}
              onChange={event => void saveSchedule(event.target.checked, day?.runTime ?? '22:00')}
            />{' '}
            Run every night at
          </label>
          <input
            aria-label="Run time"
            type="time"
            value={runTimeDraft ?? day?.runTime ?? '22:00'}
            disabled={!day}
            onChange={event => setRunTimeDraft(event.target.value)}
            onBlur={() => {
              if (runTimeDraft && runTimeDraft !== day?.runTime) void saveSchedule(Boolean(day?.enabled), runTimeDraft);
              setRunTimeDraft(null);
            }}
          />
          <input
            aria-label="Window"
            placeholder="since the last run"
            value={span}
            onChange={event => setSpan(event.target.value)}
          />
          <label>
            <input type="checkbox" checked={prepareOnly} onChange={event => setPrepareOnly(event.target.checked)} />{' '}
            Prepare only
          </label>
          <button className="primary-button" type="button" disabled={running} onClick={() => void runNow()}>
            Run now
          </button>
        </div>
        <p className="muted">{runLine(day?.lastRun ?? null, Boolean(day?.runQueued))}</p>
      </GlowCard>

      <GlowCard>
        <strong>What runs on its own</strong>
        <p className="muted">
          Merging, approving and deploying never do. Replies are always drafts. Prepare only does none of this.
        </p>
        <div className="my-day-policies">
          {POLICY_ROWS.map(row => (
            <label key={row.name} className="my-day-policy">
              <span>{row.label}</span>
              <select
                aria-label={row.label}
                value={day?.policies[row.name] ?? 'auto'}
                disabled={!day}
                onChange={event => void savePolicy(row.name, event.target.value)}
              >
                <option value="auto">On its own</option>
                <option value="ask">Wait for my button</option>
                <option value="off">Off</option>
              </select>
            </label>
          ))}
        </div>
      </GlowCard>

      <TabBar tabs={tabs} value={tab} onChange={setTab} />

      {shown.length === 0 ? (
        <EmptyState>{EMPTY_COPY[tab]}</EmptyState>
      ) : (
        <div className="my-day-list">
          {shown.map(item => (
            <MyDayRow
              key={item.key}
              item={item}
              onChanged={() => void load()}
              onError={setError}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      )}

      {day?.lastRun?.gaps.length ? (
        <GlowCard>
          <strong>What the last run couldn't check</strong>
          <ul className="my-day-gaps">
            {day.lastRun.gaps.map(gap => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </GlowCard>
      ) : null}
    </div>
  );
}
