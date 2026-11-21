import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlarmClock,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  Handshake,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareText,
  Play,
  RotateCw,
  Scale,
  SquareTerminal,
} from 'lucide-react';
import type { MyDayChoice, MyDayItem, MyDayRun } from '../types';
import { useEscapeLayer } from '../lib/escapeLayers';
import {
  ACTION_EFFECTS,
  ACTION_LABELS,
  ageLabel,
  choiceSnoozeUntil,
  cleanReason,
  closingStopsWork,
  displayAsk,
  displayWho,
  isBackFromSnooze,
  isNew,
  isSession,
  isSnoozed,
  moveKind,
  prLabel,
  prStateLabel,
  sessionReasons,
  snoozeOptions,
  splitNextStep,
  TAP_LABELS,
  tapQuestion,
  tapsFor,
  untilLabel,
  readableReply,
  usableReply,
  waitKind,
  type Tap,
} from '../lib/myDay';

/** What the page's keyboard can ask of the focused card. */
export type CardHandle = {
  primary: () => void;
  done: () => void;
  snooze: () => void;
  slack: () => void;
  skip: () => void;
  toggle: () => void;
};

export type Notice = (message: string, undo?: () => Promise<void> | void) => void;

type CardProps = {
  item: MyDayItem;
  now: number;
  lastRun: MyDayRun | null;
  /** One line until opened: for long lists he's clearing, not reading. */
  compact?: boolean;
  /** Slack names by user id, for mentions in a reply. */
  names?: Record<string, string>;
  focused?: boolean;
  onFocus?: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: Notice;
  onOpenRun?: (runId: string) => void;
  register?: (key: string, handle: CardHandle | null) => void;
};

type Confirm = { type: 'tap'; tap: Tap } | { type: 'miniog'; label: string; instruction: string };

const COPIED_MS = 2_000;

function KindIcon({ item }: { item: MyDayItem }) {
  const size = 16;
  if (isSession(item)) return <SquareTerminal size={size} />;
  const wait = waitKind(item);
  if (wait === 'miniog') return <LoaderCircle size={size} className="myday-spin" />;
  if (wait === 'others') return <Hourglass size={size} />;
  switch (moveKind(item)) {
    case 'asking':
      return <MessageCircleQuestion size={size} />;
    case 'stuck':
      return <CircleAlert size={size} />;
    case 'send':
      return <MessageSquareText size={size} />;
    case 'start':
      return <GitPullRequest size={size} />;
    case 'promise':
      return <Handshake size={size} />;
    case 'decide':
      return <Scale size={size} />;
    default:
      return <Check size={size} />;
  }
}

function tone(item: MyDayItem): string {
  if (isSession(item)) return 'session';
  return moveKind(item) ?? waitKind(item) ?? 'done';
}

/** A snooze menu: a few mornings to choose from. */
function SnoozeMenu({
  now,
  up,
  onPick,
  onClose,
}: {
  now: number;
  up: boolean;
  onPick: (until: Date) => void;
  onClose: () => void;
}) {
  useEscapeLayer(true, onClose);
  return (
    <div className={`myday-menu${up ? ' opens-up' : ''}`} role="menu" aria-label="Snooze until">
      {snoozeOptions(now).map(option => (
        <button key={option.label} type="button" role="menuitem" onClick={() => onPick(option.until)}>
          <span>{option.label}</span>
          <span className="myday-menu-hint">
            {option.until.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </span>
        </button>
      ))}
    </div>
  );
}

function SnoozeButton({
  now,
  open,
  onToggle,
  onPick,
  variant,
}: {
  now: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  onPick: (until: Date) => void;
  variant: 'ghost' | 'link';
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  // Near the bottom of the window the menu opens upward, so it isn't cut off.
  const box = open ? anchor.current?.getBoundingClientRect() : undefined;
  const up = Boolean(box && window.innerHeight - box.bottom < 160);
  return (
    <span ref={anchor} className="myday-menu-anchor">
      <button
        className={variant === 'ghost' ? 'ghost-button myday-btn' : 'myday-link-button'}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        {variant === 'ghost' ? <AlarmClock size={14} /> : null}
        Snooze
      </button>
      {open ? <SnoozeMenu now={now} up={up} onPick={onPick} onClose={() => onToggle(false)} /> : null}
    </span>
  );
}

function Quote({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`myday-quote ${className}`}>{children}</div>;
}

export function MyDayCard({
  item,
  now,
  lastRun,
  compact = false,
  names = {},
  focused = false,
  onFocus,
  onChanged,
  onError,
  onNotice,
  onOpenRun,
  register,
}: CardProps) {
  const kind = moveKind(item);
  const wait = waitKind(item);
  const session = isSession(item);
  const isOpen = item.state !== 'done';
  const [details, setDetails] = useState(false);
  const [confirming, setConfirming] = useState<Confirm | null>(null);
  const [composer, setComposer] = useState(false);
  const [text, setText] = useState('');
  const [snoozing, setSnoozing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  useEscapeLayer(Boolean(confirming), () => setConfirming(null));

  const reply = usableReply(item);
  const { question, suggestion } = splitNextStep(item.nextStep);
  const choices: MyDayChoice[] = kind === 'decide' || kind === 'promise' ? (item.choices ?? []) : [];
  const answering = kind === 'asking' || composer;

  /** What a command returned, or nothing when it failed: the error is shown. */
  const invokeFor = async <T,>(command: string, args: Record<string, unknown>): Promise<{ value: T } | null> => {
    setBusy(true);
    try {
      return { value: await invoke<T>(command, args) };
    } catch (err) {
      onError(String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const call = async (command: string, args: Record<string, unknown>): Promise<boolean> =>
    (await invokeFor(command, args)) !== null;

  const reopen = async () => {
    if (await call('close_my_day_item', { key: item.key, how: 'reopen' })) onChanged();
  };

  const close = async (how: 'done' | 'skipped', message?: string) => {
    // What the page last saw; the app's answer says what closing really stopped.
    const looksLive = closingStopsWork(item);
    const closed = await invokeFor<boolean>('close_my_day_item', { key: item.key, how });
    if (!closed) return;
    onChanged();
    const said = how === 'done' ? 'Marked done' : 'Skipped';
    // Reopen can't bring back work that was stopped, so there's no Undo then.
    if (closed.value) onNotice(`${said}, and its run was stopped`);
    else if (looksLive) onNotice(message ?? said);
    else onNotice(message ?? said, reopen);
  };

  const snoozeUntil = async (until: Date, message?: string) => {
    setSnoozing(false);
    if (!(await call('snooze_my_day_item', { key: item.key, until: until.toISOString() }))) return;
    onChanged();
    onNotice(message ?? `Snoozed until ${untilLabel(until.toISOString(), now)}`, async () => {
      if (await call('snooze_my_day_item', { key: item.key, until: null })) onChanged();
    });
  };

  // Waking it by hand is news, so an old item doesn't land among the week-old ones.
  const wake = async () => {
    if (await call('wake_my_day_item', { key: item.key })) onChanged();
  };

  const start = async (answer: string | null, message = 'miniOG is on it') => {
    if (!(await call('start_my_day_item', { key: item.key, text: answer }))) return;
    setText('');
    setComposer(false);
    onChanged();
    onNotice(message);
  };

  const openSlack = () => {
    if (item.permalink) void call('open_my_day_in_slack', { key: item.key });
  };

  const copyReply = async (thenOpen = false) => {
    if (!reply) return;
    try {
      await navigator.clipboard.writeText(reply);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
      if (thenOpen) openSlack();
    } catch (err) {
      onError(`Couldn't copy the reply: ${String(err)}`);
    }
  };

  const resume = () => void call('resume_my_day_session', { key: item.key });

  const pick = (choice: MyDayChoice) => {
    if (choice.do === 'close') void close('done', `Closed: ${choice.label}`);
    else if (choice.do === 'snooze')
      void snoozeUntil(
        choiceSnoozeUntil(choice, now),
        `${choice.label}: back ${untilLabel(choiceSnoozeUntil(choice, now).toISOString(), now)}`,
      );
    else if (choice.instruction)
      setConfirming({ type: 'miniog', label: choice.label, instruction: choice.instruction });
  };

  const confirm = async (what: Confirm) => {
    setConfirming(null);
    if (what.type === 'miniog') {
      await start(what.instruction);
      return;
    }
    const { tap } = what;
    const ok =
      tap.kind === 'deploy'
        ? await call('deploy_my_day_item', { key: item.key, url: tap.url })
        : await call('my_day_pr_action', { key: item.key, kind: tap.kind, url: tap.url, head: tap.head });
    if (ok) onChanged();
  };

  const taps = item.prUrls.flatMap(url => tapsFor(item, url));
  const deployTaps = taps.filter(tap => tap.kind === 'deploy');
  const prTaps = taps.filter(tap => tap.kind !== 'deploy');

  // What one tap or `y` does for this card, if anything is clear enough to be one tap.
  const primary = (): void => {
    if (session) return resume();
    if (wait === 'miniog' && item.jobId) return onOpenRun?.(item.jobId);
    if (wait === 'others') return openSlack();
    switch (kind) {
      case 'asking':
        if (text.trim()) void start(text.trim(), 'Answer sent to miniOG');
        else answerRef.current?.focus();
        return;
      case 'stuck':
        if (item.action) void start(null, 'miniOG is trying again');
        else setComposer(true);
        return;
      case 'send':
        if (item.draftStatus === 'saved') openSlack();
        else void copyReply(true);
        return;
      case 'start':
        void start(null);
        return;
      case 'promise':
        if (choices[0]) pick(choices[0]);
        else void close('done');
        return;
      case 'decide':
        if (choices[0]) pick(choices[0]);
        return;
      default:
        return;
    }
  };

  const handle = useRef<CardHandle | null>(null);
  // Closing stops work that's going, so a stray key never does that: it takes the Stop button.
  const stops = closingStopsWork(item);
  const closable = isOpen && !stops;
  // A collapsed row shows only Done and Skip: other keys open it first, so nothing happens unseen.
  const snoozedNow = isSnoozed(item, now);
  handle.current = {
    primary: () => (expanded ? primary() : setExpanded(true)),
    done: () => (closable && !(snoozedNow && !expanded) ? void close('done') : undefined),
    snooze: () => {
      if (!closable || session) return;
      setExpanded(true);
      setSnoozing(open => !open);
    },
    slack: openSlack,
    skip: () => (closable && !(snoozedNow && !expanded) ? void close('skipped') : undefined),
    toggle: () => (expanded ? setDetails(open => !open) : setExpanded(true)),
  };
  useEffect(() => {
    if (!register) return;
    register(item.key, {
      primary: () => handle.current?.primary(),
      done: () => handle.current?.done(),
      snooze: () => handle.current?.snooze(),
      slack: () => handle.current?.slack(),
      skip: () => handle.current?.skip(),
      toggle: () => handle.current?.toggle(),
    });
    return () => register(item.key, null);
  }, [register, item.key]);

  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  const who = displayWho(item);
  const where = session ? null : item.channelName;
  const ask = displayAsk(item);
  const snoozed = isSnoozed(item, now);

  if (!expanded) {
    return (
      <article
        ref={cardRef}
        className={`myday-row tone-${tone(item)}${focused ? ' is-focused' : ''}`}
        data-key={item.key}
        onMouseDown={onFocus}
      >
        <div className="myday-card-icon" aria-hidden="true">
          <KindIcon item={item} />
        </div>
        <button className="myday-row-main" type="button" onClick={() => setExpanded(true)}>
          <span className="myday-row-title">{ask}</span>
          <span className="myday-row-meta">
            {[who, where, ageLabel(item, now), snoozed ? `until ${untilLabel(item.snoozedUntil, now)}` : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </button>
        <div className="myday-row-actions">
          {snoozed ? (
            <button className="myday-link-button" type="button" disabled={busy} onClick={() => void wake()}>
              Bring back now
            </button>
          ) : (
            <>
              {!session ? (
                <button className="myday-link-button" type="button" disabled={busy} onClick={() => void close('done')}>
                  Done
                </button>
              ) : null}
              <button className="myday-link-button" type="button" disabled={busy} onClick={() => void close('skipped')}>
                {session ? 'Dismiss' : 'Skip'}
              </button>
            </>
          )}
        </div>
      </article>
    );
  }

  const primaryButtons: ReactNode[] = [];
  const add = (key: string, node: ReactNode) => primaryButtons.push(<span key={key}>{node}</span>);
  const seeRun = (label = 'See the run') =>
    item.jobId && onOpenRun ? (
      <button className="ghost-button myday-btn" type="button" onClick={() => onOpenRun(item.jobId ?? '')}>
        {label}
      </button>
    ) : null;
  const askButton = (label: string) => (
    <button className="ghost-button myday-btn" type="button" onClick={() => setComposer(true)}>
      <Bot size={14} /> {label}
    </button>
  );
  const doneButton = (label = 'Done') => (
    <button className="ghost-button myday-btn" type="button" disabled={busy} onClick={() => void close('done')}>
      <Check size={14} /> {label}
    </button>
  );
  const snoozeButton = (variant: 'ghost' | 'link') => (
    <SnoozeButton
      now={now}
      open={snoozing}
      onToggle={setSnoozing}
      onPick={until => void snoozeUntil(until)}
      variant={variant}
    />
  );
  // Done and Snooze sit up front only where they're the main answer.
  let doneUpFront = false;
  let snoozeUpFront = false;

  if (session) {
    add(
      'resume',
      <button className="primary-button myday-btn" type="button" disabled={busy} onClick={resume}>
        <Play size={14} /> Resume in Terminal
      </button>,
    );
  } else if (wait === 'miniog') {
    add('run', seeRun());
  } else if (kind === 'asking') {
    add('run', seeRun('See the run'));
  } else if (kind === 'stuck') {
    if (item.action)
      add(
        'again',
        <button
          className="primary-button myday-btn"
          type="button"
          disabled={busy}
          onClick={() => void start(null, 'miniOG is trying again')}
        >
          <RotateCw size={14} /> Run again
        </button>,
      );
    add('run', seeRun('See what happened'));
    if (!composer) add('ask', askButton('Tell miniOG what to do'));
  } else if (kind === 'send') {
    if (reply && item.draftStatus === 'saved') {
      add(
        'open',
        <button className="primary-button myday-btn" type="button" disabled={!item.permalink} onClick={openSlack}>
          <ExternalLink size={14} /> Open draft in Slack
        </button>,
      );
      add(
        'copy',
        <button className="ghost-button myday-btn" type="button" onClick={() => void copyReply()}>
          {copied ? 'Copied' : 'Copy reply'}
        </button>,
      );
    } else if (reply) {
      add(
        'copy-open',
        <button
          className="primary-button myday-btn"
          type="button"
          onClick={() => void copyReply(Boolean(item.permalink))}
        >
          {copied ? 'Copied' : item.permalink ? 'Copy and open Slack' : 'Copy reply'}
        </button>,
      );
    }
    add(
      'sent',
      <button
        className="ghost-button myday-btn"
        type="button"
        disabled={busy}
        onClick={() => void close('done', 'Marked sent')}
      >
        <Check size={14} /> Sent
      </button>,
    );
    doneUpFront = true;
  } else if (kind === 'start' && item.action) {
    add(
      'start',
      <button className="primary-button myday-btn" type="button" disabled={busy} onClick={() => void start(null)}>
        <Play size={14} /> {ACTION_LABELS[item.action] ?? 'Run it'}
      </button>,
    );
  } else if (kind === 'decide' || kind === 'promise') {
    choices.forEach((choice, index) =>
      add(
        `choice-${index}`,
        <button
          className={index === 0 ? 'primary-button myday-btn' : 'ghost-button myday-btn'}
          type="button"
          disabled={busy}
          title={choice.do === 'miniog' ? `miniOG will: ${choice.instruction ?? ''}` : undefined}
          onClick={() => pick(choice)}
        >
          {choice.do === 'miniog' ? (
            <Bot size={14} />
          ) : choice.do === 'snooze' ? (
            <AlarmClock size={14} />
          ) : (
            <Check size={14} />
          )}
          {choice.label}
        </button>,
      ),
    );
    if (choices.length === 0) {
      add('done', doneButton());
      add('snooze', snoozeButton('ghost'));
      doneUpFront = true;
      snoozeUpFront = true;
    }
    if (!composer && kind === 'decide') add('ask', askButton(choices.length > 0 ? 'Something else' : 'Hand to miniOG'));
  }
  for (const tap of deployTaps) {
    add(
      `deploy-${tap.url}`,
      <button className="ghost-button myday-btn" type="button" onClick={() => setConfirming({ type: 'tap', tap })}>
        {TAP_LABELS.deploy}
        {item.prUrls.length > 1 ? ` ${prLabel(tap.url, true)}` : ''}
      </button>,
    );
  }

  const secondary: ReactNode[] = [];
  if (isOpen && !session && !stops && !doneUpFront) {
    secondary.push(
      <button key="done" className="myday-link-button" type="button" disabled={busy} onClick={() => void close('done')}>
        Done
      </button>,
    );
  }
  if (isOpen && !session && !stops && !snoozeUpFront) {
    secondary.push(<span key="snooze">{snoozeButton('link')}</span>);
  }
  if (isOpen) {
    secondary.push(
      <button
        key="skip"
        className="myday-link-button"
        type="button"
        disabled={busy}
        title={stops ? 'Stops its run and closes this' : undefined}
        onClick={() => void close('skipped')}
      >
        {session ? 'Dismiss' : stops ? 'Stop' : 'Skip'}
      </button>,
    );
  }
  if (item.permalink && kind !== 'send') {
    secondary.push(
      <button key="slack" className="myday-link-button" type="button" onClick={openSlack}>
        Slack <ExternalLink size={12} />
      </button>,
    );
  }
  secondary.push(
    <button
      key="details"
      className="myday-link-button"
      type="button"
      aria-expanded={details}
      onClick={() => setDetails(open => !open)}
    >
      Details <ChevronDown size={12} className={details ? 'myday-flip' : ''} />
    </button>,
  );

  return (
    <article
      ref={cardRef}
      className={`myday-card tone-${tone(item)}${focused ? ' is-focused' : ''}`}
      data-key={item.key}
      onMouseDown={onFocus}
    >
      <div className="myday-card-icon" aria-hidden="true">
        <KindIcon item={item} />
      </div>
      <div className="myday-card-main">
        <div className="myday-card-meta">
          <span className="myday-card-who">{who}</span>
          {where ? <span className="myday-card-where">{where}</span> : null}
          <span className="myday-card-age" title={`First seen ${new Date(item.firstSeenAt).toLocaleString()}`}>
            {ageLabel(item, now)}
          </span>
          {isOpen && isNew(item, lastRun) && !session ? <span className="myday-chip tone-accent">New</span> : null}
          {isOpen && isBackFromSnooze(item, now) ? <span className="myday-chip">Back from snooze</span> : null}
          {snoozed ? <span className="myday-chip">Until {untilLabel(item.snoozedUntil, now)}</span> : null}
          {item.ownerClosed ? (
            <span className="myday-chip">
              {item.ownerClosed === 'skipped' ? 'You skipped this' : 'You marked this done'}
            </span>
          ) : null}
          {session
            ? sessionReasons(item).map(reason => (
                <span key={reason} className="myday-chip">
                  {reason}
                </span>
              ))
            : null}
        </div>

        <h3 className="myday-card-title">{ask}</h3>

        {!session && item.doneSummary && kind !== 'stuck' ? (
          <p className={`myday-card-context${details ? ' is-full' : ''}`}>{item.doneSummary}</p>
        ) : null}

        {item.prUrls.length > 0 ? (
          <div className="myday-prs">
            {item.prUrls.map(url => (
              <a key={url} className="myday-pr" href={url} target="_blank" rel="noopener noreferrer">
                <GitPullRequest size={12} />
                {prLabel(url, Boolean(item.prInfo[url]))}
                {prStateLabel(item, url) ? <span className="myday-pr-state">{prStateLabel(item, url)}</span> : null}
              </a>
            ))}
          </div>
        ) : null}

        {kind === 'asking' ? (
          <Quote className="tone-accent">
            <span className="myday-quote-label">miniOG asks</span>
            {item.nextStep ?? 'The run is waiting on you. See the run.'}
          </Quote>
        ) : null}

        {kind === 'stuck' ? (
          <Quote className="tone-danger">
            <span className="myday-quote-label">What happened</span>
            {cleanReason(item.nextStep) ?? "The run didn't finish."}
          </Quote>
        ) : null}

        {(kind === 'decide' || kind === 'promise') && question ? (
          <Quote className="tone-warm">
            <span className="myday-question">{question}</span>
            {suggestion && choices.length === 0 ? (
              <span className="myday-suggestion">miniOG suggests: {suggestion}</span>
            ) : null}
          </Quote>
        ) : null}

        {kind === 'start' && item.action ? (
          <p className="myday-card-effect">
            {item.nextStep ? `${item.nextStep} ` : ''}
            {ACTION_EFFECTS[item.action] ?? ''}
          </p>
        ) : null}

        {kind === 'send' && reply ? (
          <Quote className="tone-accent">
            <span className="myday-quote-label">
              {item.draftStatus === 'saved' ? 'Draft waiting in Slack' : 'Reply to send'}
            </span>
            <span className="myday-reply">{readableReply(reply, names)}</span>
            {item.draftStatus === 'blocked' ? (
              <span className="myday-quote-note">
                A draft was already there, yours or an earlier one, and Slack keeps one per conversation. Copy this one.
              </span>
            ) : null}
            {item.draftStatus === 'failed' ? (
              <span className="myday-quote-note tone-danger">
                Couldn't save the draft: {item.draftError ?? 'unknown error'} Copy it instead.
              </span>
            ) : null}
          </Quote>
        ) : null}

        {wait === 'others' && (item.evidence || item.nextStep) ? (
          <Quote>
            <span className="myday-quote-label">Waiting on</span>
            {item.evidence ?? item.nextStep}
          </Quote>
        ) : null}

        {wait === 'miniog' ? (
          <p className="myday-card-effect">miniOG is on this now{item.jobStatus === 'PAUSED' ? ', and paused' : ''}.</p>
        ) : null}

        {session && item.evidence ? (
          <Quote>
            <span className="myday-quote-label">Where it stopped</span>
            <span className={`myday-session-last${details ? ' is-full' : ''}`}>{item.evidence}</span>
          </Quote>
        ) : null}

        {!isOpen && item.state === 'done' && item.draftStatus === 'saved' ? (
          <p className="myday-card-effect">If you haven't sent it, its draft is still in Slack.</p>
        ) : null}

        {item.tapResult ? <p className="myday-card-effect">{item.tapResult}</p> : null}

        {confirming ? (
          <div className="myday-confirm" role="group" aria-label="Confirm">
            <span>
              {confirming.type === 'tap'
                ? tapQuestion(confirming.tap, item.prInfo[confirming.tap.url])
                : `miniOG will: ${confirming.instruction}`}
            </span>
            <div className="myday-confirm-actions">
              <button className="primary-button myday-btn" type="button" onClick={() => void confirm(confirming)}>
                {confirming.type === 'tap' ? `Yes, ${TAP_LABELS[confirming.tap.kind].toLowerCase()}` : 'Start it'}
              </button>
              <button className="ghost-button myday-btn" type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {answering && isOpen ? (
          <div className="myday-composer">
            <textarea
              ref={answerRef}
              rows={2}
              aria-label={kind === 'asking' ? `Answer miniOG about: ${item.ask}` : `Tell miniOG about: ${item.ask}`}
              placeholder={kind === 'asking' ? 'Your answer to miniOG' : 'What should miniOG do?'}
              value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && text.trim()) {
                  event.preventDefault();
                  void start(text.trim(), kind === 'asking' ? 'Answer sent to miniOG' : 'miniOG is on it');
                }
              }}
            />
            <div className="myday-composer-foot">
              <span className="myday-composer-note">
                {kind === 'asking'
                  ? 'Goes to the run that asked. ⌘↩ sends.'
                  : 'Starts a run in your DM with miniOG. It can review, change code and open a PR, or look into it. It never merges, approves or deploys.'}
              </span>
              <div className="myday-confirm-actions">
                {kind !== 'asking' ? (
                  <button
                    className="ghost-button myday-btn"
                    type="button"
                    onClick={() => {
                      setComposer(false);
                      setText('');
                    }}
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  className="primary-button myday-btn"
                  type="button"
                  disabled={!text.trim() || busy}
                  onClick={() =>
                    void start(text.trim(), kind === 'asking' ? 'Answer sent to miniOG' : 'miniOG is on it')
                  }
                >
                  {kind === 'asking' ? 'Send answer' : 'Start'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="myday-card-actions">
          <div className="myday-card-primary">{primaryButtons}</div>
          <div className="myday-card-secondary">
            {item.ownerClosed ? (
              <button className="myday-link-button" type="button" disabled={busy} onClick={() => void reopen()}>
                Reopen
              </button>
            ) : null}
            {snoozed ? (
              <button className="myday-link-button" type="button" disabled={busy} onClick={() => void wake()}>
                Bring back now
              </button>
            ) : null}
            {secondary}
          </div>
        </div>

        {details ? (
          <div className="myday-details">
            {item.askedAt ? (
              <div className="myday-detail">
                <span>Asked</span>
                <span>{item.askedAt}</span>
              </div>
            ) : null}
            {item.evidence && !session && wait !== 'others' ? (
              <div className="myday-detail">
                <span>Evidence</span>
                <span>{item.evidence}</span>
              </div>
            ) : null}
            {session && item.sessionCwd ? (
              <div className="myday-detail">
                <span>Folder</span>
                <span className="myday-mono">{item.sessionCwd}</span>
              </div>
            ) : null}
            {prTaps.length > 0 ? (
              <div className="myday-detail">
                <span>PRs</span>
                <span className="myday-detail-actions">
                  {prTaps.map(tap => (
                    <button
                      key={`${tap.kind}:${tap.url}`}
                      className="ghost-button myday-btn"
                      type="button"
                      onClick={() => setConfirming({ type: 'tap', tap })}
                    >
                      {TAP_LABELS[tap.kind]}
                      {item.prUrls.length > 1 ? ` ${prLabel(tap.url, true)}` : ''}
                    </button>
                  ))}
                </span>
              </div>
            ) : null}
            {(item.jobId || item.deployJobId) && onOpenRun ? (
              <div className="myday-detail">
                <span>Runs</span>
                <span className="myday-detail-actions">
                  {item.jobId ? (
                    <button
                      className="ghost-button myday-btn"
                      type="button"
                      onClick={() => onOpenRun(item.jobId ?? '')}
                    >
                      See the run
                    </button>
                  ) : null}
                  {item.deployJobId ? (
                    <button
                      className="ghost-button myday-btn"
                      type="button"
                      onClick={() => onOpenRun(item.deployJobId ?? '')}
                    >
                      See the deploy
                    </button>
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
