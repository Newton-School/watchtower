import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Bot,
  Check,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  Inbox,
  Keyboard,
  LoaderCircle,
  MessageSquareText,
  Play,
  Settings2,
  SquareTerminal,
  TriangleAlert,
  User,
} from 'lucide-react';
import type { MyDay, MyDayItem } from '../types';
import { MyDayCard, type CardHandle, type Notice } from '../components/MyDayCard';
import { MyDaySettings } from '../components/MyDaySettings';
import { useEscapeLayer } from '../lib/escapeLayers';
import { loadSlackDirectory } from '../lib/slackCache';
import {
  ageDays,
  didBreakdown,
  didFeed,
  didRecently,
  displayAsk,
  groupByDay,
  isMiniog,
  isNew,
  isSession,
  money,
  nextRunText,
  OLD_AFTER_DAYS,
  prLabel,
  runStatus,
  tapQuestion,
  tapsFor,
  waitKind,
  yourMove,
  type DidEntry,
  type ViewId,
} from '../lib/myDay';

const POLL_MS = 10_000;
/** What `close_my_day_items` takes in one call. */
const BULK_CLOSE_BATCH = 200;

const VIEW_KEYS: Record<string, ViewId> = { '1': 'move', '2': 'did', '3': 'waiting', '4': 'sessions' };

const SHORTCUTS: Array<[string, string]> = [
  ['1 – 4', 'Switch between Your move, miniOG did, Waiting and Sessions'],
  ['j / k', 'Next / previous item'],
  ['y', 'The main action: the suggested answer, Run again, Open draft, Resume'],
  ['e', 'Done'],
  ['s', 'Snooze'],
  ['x', 'Skip'],
  ['o', 'Open in Slack'],
  ['Enter', 'Details'],
  ['?', 'This list'],
];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Tile({
  id,
  active,
  label,
  count,
  sub,
  tone,
  icon,
  onSelect,
}: {
  id: ViewId;
  active: boolean;
  label: string;
  count: number;
  sub: string;
  tone: string;
  icon: ReactNode;
  onSelect: (id: ViewId) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`myday-tile tone-${tone}${active ? ' is-active' : ''}`}
      onClick={() => onSelect(id)}
    >
      <span className="myday-tile-label">
        {icon}
        {label}
      </span>
      <span className="myday-tile-count">{count}</span>
      <span className="myday-tile-sub">{sub}</span>
    </button>
  );
}

function Section({
  title,
  count,
  hint,
  actions,
  children,
}: {
  title: string;
  count?: number;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="myday-section">
      <header className="myday-section-head">
        <div>
          <h2>
            {title}
            {count !== undefined ? <span className="myday-section-count">{count}</span> : null}
          </h2>
          {hint ? <p className="muted">{hint}</p> : null}
        </div>
        {actions ? <div className="myday-section-actions">{actions}</div> : null}
      </header>
      <div className="myday-stack">{children}</div>
    </section>
  );
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="myday-empty">
      <span className="myday-empty-icon">{icon}</span>
      <strong>{title}</strong>
      {children ? <p className="muted">{children}</p> : null}
    </div>
  );
}

const WHO_ICON: Record<DidEntry['who'], ReactNode> = {
  night: <Bot size={14} />,
  live: <Bot size={14} />,
  drafted: <MessageSquareText size={14} />,
  you: <User size={14} />,
  others: <Check size={14} />,
};

function DidRow({
  entry,
  onOpenRun,
  onChanged,
  onError,
}: {
  entry: DidEntry;
  onOpenRun?: (runId: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { item } = entry;
  const deploy = item.prUrls.flatMap(url => tapsFor(item, url)).filter(tap => tap.kind === 'deploy');
  const [confirmDeploy, setConfirmDeploy] = useState<string | null>(null);
  const time = new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const run = async (command: string, args: Record<string, unknown>) => {
    try {
      await invoke(command, args);
      onChanged();
    } catch (err) {
      onError(String(err));
    }
  };
  const mark =
    entry.outcome === 'needs_you' ? (
      <CircleAlert size={12} />
    ) : entry.outcome === 'working' ? (
      <LoaderCircle size={12} className="myday-spin" />
    ) : null;
  return (
    <article className={`myday-did who-${entry.who} outcome-${entry.outcome}`}>
      <span className="myday-did-icon" aria-hidden="true">
        {WHO_ICON[entry.who]}
      </span>
      <div className="myday-did-main">
        <div className="myday-did-head">
          <strong>
            {mark}
            {entry.verb}
          </strong>
          {item.asker && entry.who !== 'you' ? <span className="muted">for {item.asker}</span> : null}
          <span className="myday-did-time">{time}</span>
        </div>
        <p className="myday-did-title">{displayAsk(item)}</p>
        {item.doneSummary && item.doneSummary !== 'miniOG handled this.' ? (
          <p className="myday-did-summary">{item.doneSummary}</p>
        ) : null}
        {entry.outcome === 'ready' && entry.who === 'night' ? (
          <p className="myday-did-summary">A reply is waiting for you in Your move.</p>
        ) : null}
        {entry.outcome === 'needs_you' ? <p className="myday-did-summary">Back with you in Your move.</p> : null}
        {item.state === 'done' && item.draftStatus === 'saved' ? (
          <p className="myday-did-summary">If you haven't sent it, its draft is still in Slack.</p>
        ) : null}
        <div className="myday-did-links">
          {item.prUrls.map(url => (
            <a key={url} className="myday-pr" href={url} target="_blank" rel="noopener noreferrer">
              <GitPullRequest size={12} />
              {prLabel(url, Boolean(item.prInfo[url]))}
              {item.prInfo[url]?.state ? <span className="myday-pr-state">{item.prInfo[url]?.state}</span> : null}
            </a>
          ))}
          {item.jobId && onOpenRun ? (
            <button className="myday-link-button" type="button" onClick={() => onOpenRun(item.jobId ?? '')}>
              See the run
            </button>
          ) : null}
          {item.permalink ? (
            <button
              className="myday-link-button"
              type="button"
              onClick={() => void run('open_my_day_in_slack', { key: item.key })}
            >
              Slack <ExternalLink size={12} />
            </button>
          ) : null}
          {item.ownerClosed ? (
            <button
              className="myday-link-button"
              type="button"
              onClick={() => void run('close_my_day_item', { key: item.key, how: 'reopen' })}
            >
              Reopen
            </button>
          ) : null}
          {deploy.map(tap => (
            <button key={tap.url} className="myday-link-button" type="button" onClick={() => setConfirmDeploy(tap.url)}>
              Deploy {item.prUrls.length > 1 ? prLabel(tap.url, true) : ''}
            </button>
          ))}
        </div>
        {confirmDeploy ? (
          <div className="myday-confirm">
            <span>{tapQuestion({ kind: 'deploy', url: confirmDeploy }, item.prInfo[confirmDeploy])}</span>
            <div className="myday-confirm-actions">
              <button
                className="primary-button myday-btn"
                type="button"
                onClick={() => {
                  const url = confirmDeploy;
                  setConfirmDeploy(null);
                  void run('deploy_my_day_item', { key: item.key, url });
                }}
              >
                Yes, deploy
              </button>
              <button className="ghost-button myday-btn" type="button" onClick={() => setConfirmDeploy(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEscapeLayer(true, onClose);
  return (
    <div className="myday-help" role="dialog" aria-label="Keyboard shortcuts">
      <div className="myday-help-head">
        <strong>Keyboard</strong>
        <button className="myday-link-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <dl>
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function MyDayPage({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [day, setDay] = useState<MyDay | null>(null);
  const [view, setView] = useState<ViewId>('move');
  const [error, setError] = useState<string | null>(null);
  // Separate from the actions' errors: this one clears itself when a later poll works.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gapsOpen, setGapsOpen] = useState(false);
  const [showOld, setShowOld] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [confirmClear, setConfirmClear] = useState<'old' | 'sessions' | null>(null);
  const [didFilter, setDidFilter] = useState<'miniog' | 'all'>('miniog');
  const [helpOpen, setHelpOpen] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const handles = useRef(new Map<string, CardHandle>());
  const order = useRef<string[]>([]);

  const load = useCallback(async () => {
    try {
      setDay(await invoke<MyDay>('get_my_day'));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const changed = useCallback(() => void load(), [load]);

  // Names for the mentions in replies; the directory is slow the first time, so only when one has a mention.
  const mentions = Boolean(day?.items.some(item => item.state === 'ready' && item.replyText?.includes('<@')));
  useEffect(() => {
    if (!mentions) return;
    let live = true;
    loadSlackDirectory()
      .then(directory => {
        if (!live || !directory?.people) return;
        setNames(Object.fromEntries(directory.people.map(person => [person.id, person.name])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mentions]);

  const notice: Notice = useCallback(
    (message, undo) => {
      toast(
        message,
        undo
          ? {
              action: {
                label: 'Undo',
                onClick: () => {
                  void Promise.resolve(undo()).then(() => load());
                },
              },
            }
          : undefined,
      );
    },
    [load],
  );

  const register = useCallback((key: string, handle: CardHandle | null) => {
    if (handle) handles.current.set(key, handle);
    else handles.current.delete(key);
  }, []);

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

  const runNow = async (span: string | null = null, prepareOnly = false) => {
    setError(null);
    try {
      await invoke('run_my_day_now', { span, prepareOnly });
      await load();
      notice(prepareOnly ? 'Sweeping now, without acting on anything' : 'Sweeping now');
    } catch (err) {
      setError(String(err));
    }
  };

  const items = useMemo(() => day?.items ?? [], [day]);
  const lastRun = day?.lastRun ?? null;
  const move = useMemo(() => yourMove(items, now), [items, now]);
  const recent = useMemo(() => didRecently(items, now), [items, now]);
  const feed = useMemo(() => didFeed(items), [items]);
  const waiting = items.filter(item => waitKind(item) !== null);
  const onMiniog = waiting.filter(item => waitKind(item) === 'miniog');
  const onOthers = waiting.filter(item => waitKind(item) === 'others');
  const sessions = items.filter(item => isSession(item) && item.state !== 'done');
  const freshSessions = sessions.filter(item => ageDays(item, now) < OLD_AFTER_DAYS);
  const oldSessions = sessions.filter(item => ageDays(item, now) >= OLD_AFTER_DAYS);
  const running = lastRun?.status === 'RUNNING' || Boolean(day?.runQueued);
  const status = runStatus(day, now);
  const newCount = move.sections.flatMap(section => section.items).filter(item => isNew(item, lastRun)).length;

  const clearMany = async (keys: string[], what: string) => {
    setConfirmClear(null);
    try {
      // The app closes at most 200 in one go, so a bigger pile goes in batches.
      let closed = 0;
      for (let start = 0; start < keys.length; start += BULK_CLOSE_BATCH) {
        const batch = keys.slice(start, start + BULK_CLOSE_BATCH);
        closed += (await invoke<number>('close_my_day_items', { keys: batch, how: 'skipped' })) ?? batch.length;
      }
      await load();
      notice(`${what}: ${plural(closed, 'item', 'items')}`, async () => {
        for (const key of keys) {
          await invoke('close_my_day_item', { key, how: 'reopen' }).catch(() => undefined);
        }
      });
    } catch (err) {
      setError(String(err));
    }
  };

  // Cards in the order they're shown, for j and k.
  const shownKeys: string[] = [];
  const card = (item: MyDayItem, compact = false) => {
    shownKeys.push(item.key);
    return (
      <MyDayCard
        key={item.key}
        item={item}
        now={now}
        lastRun={lastRun}
        compact={compact}
        names={names}
        focused={focusedKey === item.key}
        onFocus={() => setFocusedKey(item.key)}
        onChanged={changed}
        onError={setError}
        onNotice={notice}
        onOpenRun={onOpenRun}
        register={register}
      />
    );
  };

  let body: ReactNode;
  if (view === 'move') {
    const nothing = move.sections.length === 0 && move.old.length === 0;
    body = (
      <>
        {nothing ? (
          <Empty icon={<Check size={18} />} title="You're clear">
            Nothing needs you right now. {nextRunText(day, now)}.
          </Empty>
        ) : null}
        {move.sections.map(section => (
          <Section key={section.kind} title={section.title} count={section.items.length} hint={section.hint}>
            {section.items.map(item => card(item))}
          </Section>
        ))}
        {move.old.length > 0 ? (
          <Section
            title="Over a week old"
            count={move.old.length}
            hint="Still open after a week. Keep what still matters, and clear the rest in one go."
            actions={
              <>
                <button className="ghost-button myday-btn" type="button" onClick={() => setShowOld(open => !open)}>
                  {showOld ? 'Hide' : 'Show'}
                </button>
                <button className="ghost-button myday-btn" type="button" onClick={() => setConfirmClear('old')}>
                  Skip all {move.old.length}
                </button>
              </>
            }
          >
            {confirmClear === 'old' ? (
              <div className="myday-confirm">
                <span>
                  Skip all {move.old.length}? They move to Done, the nightly sweep won't raise them again unless someone
                  asks again, and you can reopen any of them.
                </span>
                <div className="myday-confirm-actions">
                  <button
                    className="primary-button myday-btn"
                    type="button"
                    onClick={() =>
                      void clearMany(
                        move.old.map(item => item.key),
                        'Skipped',
                      )
                    }
                  >
                    Skip all {move.old.length}
                  </button>
                  <button className="ghost-button myday-btn" type="button" onClick={() => setConfirmClear(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {showOld ? move.old.map(item => card(item, true)) : null}
          </Section>
        ) : null}
        {move.snoozed.length > 0 ? (
          <Section
            title="Snoozed"
            count={move.snoozed.length}
            hint="Back on their own when the time comes."
            actions={
              <button className="ghost-button myday-btn" type="button" onClick={() => setShowSnoozed(open => !open)}>
                {showSnoozed ? 'Hide' : 'Show'}
              </button>
            }
          >
            {showSnoozed ? move.snoozed.map(item => card(item, true)) : null}
          </Section>
        ) : null}
      </>
    );
  } else if (view === 'did') {
    const entries = didFilter === 'miniog' ? feed.filter(isMiniog) : feed;
    const groups = groupByDay(entries, now);
    body = (
      <>
        <div className="myday-did-bar">
          <p className="muted">
            {didFilter === 'miniog'
              ? 'Reviews, changes and drafts miniOG did for you, overnight and live in Slack, over the last week.'
              : 'Everything that got closed over the last week: by miniOG, by you, and by others.'}
          </p>
          <div className="myday-segmented" role="group" aria-label="Show">
            <button
              type="button"
              aria-pressed={didFilter === 'miniog'}
              className={didFilter === 'miniog' ? 'is-on' : ''}
              onClick={() => setDidFilter('miniog')}
            >
              miniOG
            </button>
            <button
              type="button"
              aria-pressed={didFilter === 'all'}
              className={didFilter === 'all' ? 'is-on' : ''}
              onClick={() => setDidFilter('all')}
            >
              Everyone
            </button>
          </div>
        </div>
        {groups.length === 0 ? (
          <Empty icon={<Bot size={18} />} title="Nothing yet">
            What miniOG does for you shows up here.
          </Empty>
        ) : (
          groups.map(group => (
            <Section key={group.label} title={group.label} count={group.entries.length}>
              {group.entries.map(entry => (
                <DidRow
                  key={entry.item.key}
                  entry={entry}
                  onOpenRun={onOpenRun}
                  onChanged={changed}
                  onError={setError}
                />
              ))}
            </Section>
          ))
        )}
      </>
    );
  } else if (view === 'waiting') {
    body =
      waiting.length === 0 ? (
        <Empty icon={<Inbox size={18} />} title="Nothing waiting">
          Asks you answered that now wait on someone else show up here, and so does work miniOG is doing.
        </Empty>
      ) : (
        <>
          {onMiniog.length > 0 ? (
            <Section
              title="miniOG is on it"
              count={onMiniog.length}
              hint="Running now. Each one comes back here when it ends."
            >
              {onMiniog.map(item => card(item))}
            </Section>
          ) : null}
          {onOthers.length > 0 ? (
            <Section
              title="Waiting on someone else"
              count={onOthers.length}
              hint="You answered or acted. The nightly sweep closes these when they reply."
            >
              {onOthers.map(item => card(item))}
            </Section>
          ) : null}
        </>
      );
  } else {
    body =
      sessions.length === 0 ? (
        <Empty icon={<SquareTerminal size={18} />} title="No unfinished sessions">
          Claude Code sessions that end on a question, or leave work uncommitted, show up here.
        </Empty>
      ) : (
        <>
          {freshSessions.length > 0 ? (
            <Section
              title="Left unfinished this week"
              count={freshSessions.length}
              hint="Resume opens Terminal right where the session stopped."
            >
              {freshSessions.map(item => card(item))}
            </Section>
          ) : null}
          {oldSessions.length > 0 ? (
            <Section
              title="Older"
              count={oldSessions.length}
              actions={
                <button className="ghost-button myday-btn" type="button" onClick={() => setConfirmClear('sessions')}>
                  Dismiss all {oldSessions.length}
                </button>
              }
            >
              {confirmClear === 'sessions' ? (
                <div className="myday-confirm">
                  <span>Dismiss {plural(oldSessions.length, 'session', 'sessions')} older than a week?</span>
                  <div className="myday-confirm-actions">
                    <button
                      className="primary-button myday-btn"
                      type="button"
                      onClick={() =>
                        void clearMany(
                          oldSessions.map(item => item.key),
                          'Dismissed',
                        )
                      }
                    >
                      Dismiss {oldSessions.length}
                    </button>
                    <button className="ghost-button myday-btn" type="button" onClick={() => setConfirmClear(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {oldSessions.map(item => card(item, true))}
            </Section>
          ) : null}
        </>
      );
  }
  order.current = shownKeys;

  // Keys work anywhere on the page except while typing.
  const keyState = useRef({ focusedKey, settingsOpen });
  keyState.current = { focusedKey, settingsOpen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // A held key moves through the list, but never repeats an action on the next card.
      if (event.repeat && event.key !== 'j' && event.key !== 'k') return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const { focusedKey: current, settingsOpen: drawerOpen } = keyState.current;
      // The drawer sits over the list: keys pressed there aren't meant for the card behind it.
      if (drawerOpen) return;
      const keys = order.current;
      const at = current ? keys.indexOf(current) : -1;
      const handle = current ? handles.current.get(current) : undefined;
      const go = (step: number) => {
        if (keys.length === 0) return;
        const next = at < 0 ? (step > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, at + step));
        setFocusedKey(keys[next]);
      };
      if (VIEW_KEYS[event.key]) {
        setView(VIEW_KEYS[event.key]);
        setFocusedKey(null);
      } else if (event.key === 'j') go(1);
      else if (event.key === 'k') go(-1);
      else if (event.key === '?') setHelpOpen(open => !open);
      else if (!handle) return;
      else if (event.key === 'y') handle.primary();
      else if (event.key === 'e') handle.done();
      else if (event.key === 's') handle.snooze();
      else if (event.key === 'x') handle.skip();
      else if (event.key === 'o') handle.slack();
      else if (event.key === 'Enter' && target?.tagName !== 'BUTTON' && target?.tagName !== 'A') handle.toggle();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // When the focused card goes (done, snoozed), focus the one that took its place.
  const lastOrder = useRef<string[]>([]);
  useEffect(() => {
    if (focusedKey && !shownKeys.includes(focusedKey)) {
      const was = lastOrder.current.indexOf(focusedKey);
      setFocusedKey(shownKeys[Math.min(Math.max(was, 0), shownKeys.length - 1)] ?? null);
    }
    lastOrder.current = shownKeys;
  });

  const tiles: Array<{ id: ViewId; label: string; count: number; sub: string; tone: string; icon: ReactNode }> = [
    {
      id: 'move',
      label: 'Your move',
      count: move.count,
      sub:
        move.count === 0
          ? 'All clear'
          : [newCount ? `${newCount} new` : '', move.old.length ? `${move.old.length} over a week old` : '']
              .filter(Boolean)
              .join(' · ') || plural(move.count, 'thing', 'things'),
      tone: 'accent',
      icon: <Inbox size={14} />,
    },
    {
      id: 'did',
      label: 'miniOG did',
      count: recent.length,
      sub: recent.length ? `${didBreakdown(recent)} · last 24h` : 'Nothing in the last 24h',
      tone: 'success',
      icon: <Bot size={14} />,
    },
    {
      id: 'waiting',
      label: 'Waiting',
      count: waiting.length,
      sub: waiting.length
        ? [onMiniog.length ? `${onMiniog.length} on miniOG` : '', onOthers.length ? `${onOthers.length} on others` : '']
            .filter(Boolean)
            .join(' · ')
        : 'Nothing pending',
      tone: 'warm',
      icon: <LoaderCircle size={14} />,
    },
    {
      id: 'sessions',
      label: 'Sessions',
      count: sessions.length,
      sub: sessions.length
        ? `${sessions.filter(item => /question/i.test(item.doneSummary ?? '')).length} ended on a question`
        : 'None unfinished',
      tone: 'muted',
      icon: <SquareTerminal size={14} />,
    },
  ];

  const today = new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="page-stack myday-page">
      <header className="myday-head">
        <div className="myday-head-copy">
          <h1>My day</h1>
          <div className="myday-status">
            <span className="myday-date">{today}</span>
            <span className={`myday-status-pill tone-${status.tone}`}>
              {status.tone === 'running' ? (
                <LoaderCircle size={12} className="myday-spin" />
              ) : (
                <span className="myday-dot" aria-hidden="true" />
              )}
              {status.text}
            </span>
            {lastRun && lastRun.status !== 'RUNNING' ? (
              <span
                className="myday-status-item"
                title={`Reading Slack ${money(lastRun.sweepCostUsd)} · reviews and changes ${money(lastRun.workCostUsd)}`}
              >
                {money(lastRun.costUsd)}
              </span>
            ) : null}
            <span className="myday-status-item">{nextRunText(day, now)}</span>
            {lastRun?.gaps.length ? (
              <button
                className="myday-status-item myday-gaps-toggle"
                type="button"
                aria-expanded={gapsOpen}
                onClick={() => setGapsOpen(open => !open)}
              >
                <TriangleAlert size={12} /> {plural(lastRun.gaps.length, 'blind spot', 'blind spots')}
              </button>
            ) : null}
          </div>
        </div>
        <div className="myday-head-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setHelpOpen(open => !open)}
          >
            <Keyboard size={16} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="My day settings"
            title="My day settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={16} />
          </button>
          <button className="ghost-button myday-btn" type="button" disabled={running} onClick={() => void runNow()}>
            <Play size={14} /> {running ? 'Sweeping…' : 'Sweep now'}
          </button>
        </div>
        {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
      </header>

      {error ? (
        <div className="myday-banner tone-danger" role="alert">
          <span>{error}</span>
          <button className="myday-link-button" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {loadError ? (
        <div className="myday-banner tone-danger" role="alert">
          <span>{loadError}</span>
        </div>
      ) : null}
      {lastRun?.status === 'FAILED' && lastRun.error ? (
        <div className="myday-banner tone-danger">
          <span>The last sweep failed: {lastRun.error}</span>
          <button className="ghost-button myday-btn" type="button" disabled={running} onClick={() => void runNow()}>
            Sweep again
          </button>
        </div>
      ) : null}
      {gapsOpen && lastRun?.gaps.length ? (
        <div className="myday-banner tone-warm">
          <div>
            <strong>What the last sweep couldn't check</strong>
            <ul className="myday-gaps">
              {lastRun.gaps.map(gap => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {day && !lastRun && !day.enabled ? (
        <div className="myday-banner tone-accent">
          <span>
            My day sweeps your Slack and GitHub every night for asks nobody finished, has miniOG do what it can, and
            lines up the rest here.
          </span>
          <div className="myday-confirm-actions">
            <button className="primary-button myday-btn" type="button" onClick={() => void saveSchedule(true, '22:00')}>
              Sweep every night at 22:00
            </button>
            <button className="ghost-button myday-btn" type="button" onClick={() => void runNow('3d')}>
              Sweep the last 3 days now
            </button>
          </div>
        </div>
      ) : null}

      <div className="myday-tiles" role="tablist" aria-label="My day">
        {tiles.map(tile => (
          <Tile
            key={tile.id}
            {...tile}
            active={view === tile.id}
            onSelect={id => {
              setView(id);
              setFocusedKey(null);
            }}
          />
        ))}
      </div>

      <div className="myday-body">{body}</div>

      {settingsOpen ? (
        <MyDaySettings
          day={day}
          now={now}
          running={running}
          onClose={() => setSettingsOpen(false)}
          onSaveSchedule={saveSchedule}
          onSavePolicy={savePolicy}
          onRunNow={runNow}
        />
      ) : null}
    </div>
  );
}
