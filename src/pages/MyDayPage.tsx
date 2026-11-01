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

function inTab(item: MyDayItem, tab: TabId): boolean {
  if (item.source === 'session') return tab === 'sessions' && item.state !== 'done';
  return item.state === tab;
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

export function MyDayRow({ item, onError }: { item: MyDayItem; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);

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

  const resume = async () => {
    try {
      await invoke('resume_my_day_session', { key: item.key });
    } catch (err) {
      onError(String(err));
    }
  };

  const isSession = item.source === 'session';
  const heading = isSession
    ? 'Claude session'
    : [item.asker, item.channelName, item.askedAt].filter(Boolean).join(' · ') || 'GitHub';

  return (
    <article className="my-day-item">
      <header className="my-day-item-head">
        <strong>{heading}</strong>
        <div className="my-day-actions">
          {item.permalink ? (
            <a className="ghost-button" href={item.permalink} target="_blank" rel="noopener noreferrer">
              Open in Slack
            </a>
          ) : null}
          {item.prUrls.map(url => (
            <a key={url} className="ghost-button" href={url} target="_blank" rel="noopener noreferrer">
              {prLabel(url)}
            </a>
          ))}
          {item.sessionId ? (
            <button className="ghost-button" type="button" onClick={() => void resume()}>
              Resume
            </button>
          ) : null}
        </div>
      </header>
      <Line label={isSession ? 'Session' : 'Asked'}>{item.ask}</Line>
      {item.doneSummary ? <Line label={isSession ? 'Left' : 'Done'}>{item.doneSummary}</Line> : null}
      {item.nextStep ? <Line label="Next">{item.nextStep}</Line> : null}
      {item.state === 'waiting' && item.evidence ? <Line label="Waiting">{item.evidence}</Line> : null}
      {item.replyText ? (
        <Line label="Reply">
          <p className="my-day-reply">{item.replyText}</p>
          <button className="ghost-button" type="button" onClick={() => void copyReply()}>
            {copied ? 'Copied' : 'Copy reply'}
          </button>
        </Line>
      ) : null}
    </article>
  );
}

export function MyDayPage() {
  const [day, setDay] = useState<MyDay | null>(null);
  const [tab, setTab] = useState<TabId>('needs_you');
  const [error, setError] = useState<string | null>(null);
  const [span, setSpan] = useState('');

  const load = useCallback(async () => {
    try {
      setDay(await invoke<MyDay>('get_my_day'));
    } catch (err) {
      setError(String(err));
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

  const runNow = async () => {
    setError(null);
    try {
      await invoke('run_my_day_now', { span: span.trim() || null });
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
        description="What was asked of you that neither you nor miniOG finished. For now this only reads: nothing goes to Slack or GitHub."
      />

      {error ? <div className="my-day-error">{error}</div> : null}
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
            value={day?.runTime ?? '22:00'}
            disabled={!day}
            onChange={event => {
              if (event.target.value) void saveSchedule(Boolean(day?.enabled), event.target.value);
            }}
          />
          <input
            aria-label="Window"
            placeholder="since the last run"
            value={span}
            onChange={event => setSpan(event.target.value)}
          />
          <button className="primary-button" type="button" disabled={running} onClick={() => void runNow()}>
            Run now
          </button>
        </div>
        <p className="muted">{runLine(day?.lastRun ?? null, Boolean(day?.runQueued))}</p>
      </GlowCard>

      <TabBar tabs={tabs} value={tab} onChange={setTab} />

      {shown.length === 0 ? (
        <EmptyState>{EMPTY_COPY[tab]}</EmptyState>
      ) : (
        <div className="my-day-list">
          {shown.map(item => (
            <MyDayRow key={item.key} item={item} onError={setError} />
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
