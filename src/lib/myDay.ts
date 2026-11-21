import type { MyDay, MyDayChoice, MyDayItem, MyDayPrInfo, MyDayRun } from '../types';

/**
 * How My day reads its items: what each one asks of the owner, where it shows,
 * and what miniOG did. Pure, so the page, the nav badge and the tests agree.
 */

export type ViewId = 'move' | 'did' | 'waiting' | 'sessions';

/** What an open item asks of him, in the order they're worth his time. */
export type MoveKind = 'asking' | 'stuck' | 'send' | 'start' | 'decide' | 'promise';

export const MOVE_GROUPS: Array<{ kind: MoveKind; title: string; hint: string }> = [
  { kind: 'asking', title: 'miniOG is waiting on you', hint: 'A run stopped to ask you something.' },
  { kind: 'stuck', title: 'Runs that need a look', hint: "miniOG tried these and didn't finish." },
  { kind: 'send', title: 'Replies to send', hint: 'Drafts are waiting in Slack. Sending is up to you.' },
  { kind: 'start', title: 'Ready for miniOG', hint: 'One tap starts each. Set to wait for your button.' },
  { kind: 'decide', title: 'Your call', hint: 'Only you can decide these.' },
  { kind: 'promise', title: 'You said you would', hint: 'Your own promises from Slack.' },
];

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Past this, an item goes under "over a week old", where it can be cleared in one go. */
export const OLD_AFTER_DAYS = 7;

const LIVE_JOB = new Set(['RUNNING', 'PAUSED']);

export const ACTION_LABELS: Record<string, string> = {
  review_pr: 'Review it',
  re_review_pr: 'Re-review it',
  fix_own_pr: 'Fix and push',
  open_pr: 'Raise the PR',
};

/** What pressing the work button does, said before it's pressed. */
export const ACTION_EFFECTS: Record<string, string> = {
  review_pr: 'miniOG reviews it and posts its comments on GitHub. It never approves.',
  re_review_pr: 'miniOG reviews the new commits and posts on GitHub. It never approves.',
  fix_own_pr: 'miniOG pushes fixes for the open review comments to your PR. It never merges.',
  open_pr: 'miniOG makes the change and opens a PR. It never merges or deploys.',
};

export function isSession(item: MyDayItem): boolean {
  return item.source === 'session';
}

export function isSnoozed(item: MyDayItem, now: number): boolean {
  return Boolean(item.snoozedUntil) && Date.parse(item.snoozedUntil ?? '') > now;
}

/** Came back from a snooze in the last few days: worth a word, so it doesn't look new. */
export function isBackFromSnooze(item: MyDayItem, now: number): boolean {
  const until = Date.parse(item.snoozedUntil ?? '');
  return Number.isFinite(until) && until <= now && now - until < 3 * DAY_MS;
}

/** Older notes were written about him. The inbox talks to him, so a promise reads as his. */
export function displayAsk(item: MyDayItem): string {
  const ask = item.ask.replace(/^(?:his|your) own promise:\s*/i, '');
  return ask === item.ask ? ask : ask.charAt(0).toUpperCase() + ask.slice(1);
}

/** Who an item is from, as the card's first word. */
export function displayWho(item: MyDayItem): string {
  if (isSession(item)) return sessionRepo(item) ?? 'Claude session';
  if (isPromise(item)) return 'Your promise';
  return item.asker || (item.source === 'github' ? 'GitHub' : 'Slack');
}

/** What went wrong, without the old "see the run" tail the buttons now say. */
export function cleanReason(text: string | null): string | null {
  if (!text) return null;
  return text.replace(/\s*See the run(?:, then answer or run it again| for what it (?:said|did))?\.?\s*$/i, '').trim();
}

function isPromise(item: MyDayItem): boolean {
  return /\bpromise\b/i.test(item.asker ?? '') || /^(his|your) own promise|^you said you'?d/i.test(item.ask);
}

/** What an open item asks of him, or nothing when it isn't his move. */
export function moveKind(item: MyDayItem): MoveKind | null {
  if (isSession(item) || item.state === 'done') return null;
  if (item.state === 'ready') return 'send';
  if (item.state !== 'needs_you') return null;
  // A run waiting for an answer takes the answer, not a second start.
  if (item.jobId && LIVE_JOB.has(item.jobStatus ?? '')) return 'asking';
  if (item.action && item.jobId) return 'stuck';
  if (/^the run couldn't start/i.test(item.nextStep ?? '')) return 'stuck';
  if (item.action) return 'start';
  if (isPromise(item)) return 'promise';
  return 'decide';
}

/** Closing it would stop work that's going: started and not finished, or a run waiting on him. */
export function closingStopsWork(item: MyDayItem): boolean {
  if (item.state === 'done' || isSession(item)) return false;
  return item.state === 'working' || (Boolean(item.jobId) && LIVE_JOB.has(item.jobStatus ?? ''));
}

export type WaitKind = 'miniog' | 'others';

export function waitKind(item: MyDayItem): WaitKind | null {
  if (isSession(item) || item.state === 'done') return null;
  if (item.state === 'working') return 'miniog';
  if (item.state === 'waiting') return LIVE_JOB.has(item.jobStatus ?? '') ? 'miniog' : 'others';
  return null;
}

export function ageDays(item: MyDayItem, now: number): number {
  const seen = Date.parse(item.firstSeenAt);
  return Number.isFinite(seen) ? Math.max(0, Math.floor((now - seen) / DAY_MS)) : 0;
}

/**
 * When an item last had news: first seen, back from a snooze, or its work ending.
 * An old ask with a fresh result, or one he put off, is news again.
 */
export function freshSince(item: MyDayItem, now: number): number {
  const times = [Date.parse(item.firstSeenAt)];
  const woke = Date.parse(item.snoozedUntil ?? '');
  if (Number.isFinite(woke) && woke <= now) times.push(woke);
  if (item.requestId) times.push(Date.parse(item.jobUpdatedAt ?? ''));
  return Math.max(...times.filter(Number.isFinite));
}

/** No news for a week and not a run that's blocked on him: a candidate for clearing in one go. */
export function isOld(item: MyDayItem, now: number): boolean {
  return moveKind(item) !== 'asking' && now - freshSince(item, now) >= OLD_AFTER_DAYS * DAY_MS;
}

/** Found by the newest run: what he hasn't seen yet. */
export function isNew(item: MyDayItem, lastRun: MyDayRun | null): boolean {
  if (!lastRun) return false;
  return Date.parse(item.firstSeenAt) >= Date.parse(lastRun.startedAt);
}

export function ageLabel(item: MyDayItem, now: number): string {
  const seen = Date.parse(item.firstSeenAt);
  if (!Number.isFinite(seen)) return '';
  const hours = Math.floor((now - seen) / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export type MoveSection = { kind: MoveKind; title: string; hint: string; items: MyDayItem[] };

export type MoveList = {
  sections: MoveSection[];
  old: MyDayItem[];
  snoozed: MyDayItem[];
  count: number;
};

/** His move: fresh items by kind, then what's over a week old, then what he put off. */
export function yourMove(items: MyDayItem[], now: number): MoveList {
  const open = items.filter(item => moveKind(item) !== null);
  const snoozed = open.filter(item => isSnoozed(item, now));
  const awake = open.filter(item => !isSnoozed(item, now));
  const old = awake.filter(item => isOld(item, now)).sort(byOldestFirst);
  const fresh = awake.filter(item => !isOld(item, now));
  const sections = MOVE_GROUPS.map(group => ({
    ...group,
    items: fresh.filter(item => moveKind(item) === group.kind).sort(byNewestFirst),
  })).filter(section => section.items.length > 0);
  return { sections, old, snoozed: snoozed.sort(bySnoozeEnd), count: awake.length };
}

function byNewestFirst(a: MyDayItem, b: MyDayItem): number {
  return b.firstSeenAt.localeCompare(a.firstSeenAt);
}

function byOldestFirst(a: MyDayItem, b: MyDayItem): number {
  return a.firstSeenAt.localeCompare(b.firstSeenAt);
}

function bySnoozeEnd(a: MyDayItem, b: MyDayItem): number {
  return (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? '');
}

/** The number on the nav: what's his move now, nothing he put off. */
export function yourMoveCount(day: MyDay | null, now = Date.now()): number {
  return day ? yourMove(day.items, now).count : 0;
}

/** Splits triage's "question? I'd say yes." into the question and its suggestion. */
export function splitNextStep(text: string | null): { question: string; suggestion: string | null } {
  const value = (text ?? '').trim();
  const match = /(?:^|\s)(I'd|I would)\s+(.+?)\s*$/i.exec(value);
  if (!match || match.index === 0) return { question: value, suggestion: null };
  const question = value.slice(0, match.index).trim();
  const rest = match[2].replace(/^say\s+/i, '').trim();
  const suggestion = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null;
  return { question, suggestion };
}

/**
 * A reply as he'll send it, readable: mentions by name, and every link with its
 * real address showing. The text came through an agent that read Slack, so a
 * label is never allowed to stand in for where a link goes.
 */
export function readableReply(text: string, names: Record<string, string>): string {
  return text
    .replace(/<([^<>\n]+)>/g, (_whole, body: string) => {
      const bar = body.indexOf('|');
      const target = bar === -1 ? body : body.slice(0, bar);
      const label = bar === -1 ? '' : body.slice(bar + 1);
      if (target.startsWith('@')) return `@${label || names[target.slice(1)] || target.slice(1)}`;
      if (target.startsWith('#')) return `#${label || target.slice(1)}`;
      if (target.startsWith('!')) return `@${(label || target.slice(1)).replace(/^@/, '')}`;
      return label && label !== target ? `${label} (${target})` : target;
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A reply still naming a PR that hasn't been opened isn't one yet. */
export function usableReply(item: MyDayItem): string | null {
  return item.replyText && !item.replyText.includes('{PR_URL}') ? item.replyText : null;
}

/**
 * A PR's short name. The owner is left out only for a PR checked as one of the org's
 * (it has PR info): a link from Slack can name any owner's repo of the same name.
 */
export function prLabel(url: string, checked = false): string {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) return url;
  return checked ? `${match[2]}#${match[3]}` : `${match[1]}/${match[2]}#${match[3]}`;
}

export function repoOf(url: string): string {
  return /github\.com\/[^/]+\/([^/]+)\/pull/.exec(url)?.[1] ?? url;
}

/** The folder a session ran in, by its last part: usually the repo. */
export function sessionRepo(item: MyDayItem): string | null {
  const parts = (item.sessionCwd ?? '').split('/').filter(Boolean);
  const worktree = parts.indexOf('worktrees');
  // `.claude/worktrees/<name>` belongs to the repo above `.claude`.
  if (worktree > 1 && parts[worktree - 1] === '.claude') return parts[worktree - 2] ?? null;
  return parts.at(-1) ?? null;
}

/** A session's reasons, as short chips. */
export function sessionReasons(item: MyDayItem): string[] {
  const text = item.doneSummary ?? '';
  const chips: string[] = [];
  if (/question you never answered/i.test(text)) chips.push('Unanswered question');
  const uncommitted = /(\d+) uncommitted files?/i.exec(text);
  if (uncommitted) chips.push(`${uncommitted[1]} uncommitted`);
  const unpushed = /(\d+) commits? on \S+ not pushed/i.exec(text);
  if (unpushed) chips.push(`${unpushed[1]} unpushed`);
  return chips;
}

export type Tap = { kind: 'merge' | 'approve' | 'deploy'; url: string; head?: string };

/** What can be pressed for one PR. Only ever from what was looked up, never from the item's text. */
export function tapsFor(item: MyDayItem, url: string): Tap[] {
  const info = item.prInfo[url];
  if (!info || isSession(item)) return [];
  if (info.state === 'merged') return info.deployable ? [{ kind: 'deploy', url }] : [];
  // A closed item keeps Deploy, for something merged and waiting, but asks nothing more of the PR.
  if (info.state !== 'open' || !info.head || info.draft || item.ownerClosed) return [];
  const taps: Tap[] = [{ kind: 'merge', url, head: info.head }];
  if (!info.mine) taps.push({ kind: 'approve', url, head: info.head });
  return taps;
}

export const TAP_LABELS: Record<Tap['kind'], string> = { merge: 'Merge', approve: 'Approve', deploy: 'Deploy' };

export function tapQuestion(tap: Tap, info: MyDayPrInfo | undefined): string {
  // Taps exist only for PRs with PR info: checked as the org's.
  const label = prLabel(tap.url, true);
  const at = tap.head ? ` at ${tap.head.slice(0, 7)}` : '';
  // From GitHub: the item's own words came through Slack and needn't describe this PR.
  const about = [
    info?.title && `"${info.title}"`,
    info?.author && `by ${info.author}`,
    info?.base && `into ${info.base}`,
  ]
    .filter(Boolean)
    .join(' ');
  const what = about ? `${label}${at}, ${about}` : `${label}${at}`;
  if (tap.kind === 'merge') return `Merge ${what}?`;
  if (tap.kind === 'approve') return `Approve ${what}, under your name?`;
  const waiting = info?.undeployedCommits ? ` ${info.undeployedCommits} commits are waiting to ship.` : '';
  return `Deploy ${repoOf(tap.url)} to production for ${what}?${waiting} It ships the newest good commit, so other merged work may go too, and it still asks you to reply \`confirm deploy\` before anything happens.`;
}

export function prStateLabel(item: MyDayItem, url: string): string {
  const state = item.prInfo[url]?.state ?? item.prStates[url];
  const parts = [
    state,
    item.prInfo[url]?.draft ? 'draft' : null,
    item.prInfo[url]?.deployUnknown ? 'not sure if live' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// What miniOG did

export type DidWho = 'night' | 'live' | 'drafted' | 'you' | 'others';

export type DidEntry = {
  item: MyDayItem;
  who: DidWho;
  verb: string;
  /** How it ended, for its mark: done, a reply to send, still going, or back to him. */
  outcome: 'done' | 'ready' | 'working' | 'needs_you';
  at: string;
};

const NIGHT_VERBS: Record<DidEntry['outcome'], Record<string, string>> = {
  done: { review_pr: 'Reviewed', re_review_pr: 'Re-reviewed', fix_own_pr: 'Pushed fixes', open_pr: 'Opened a PR' },
  ready: { review_pr: 'Reviewed', re_review_pr: 'Re-reviewed', fix_own_pr: 'Pushed fixes', open_pr: 'Opened a PR' },
  working: {
    review_pr: 'Reviewing',
    re_review_pr: 'Re-reviewing',
    fix_own_pr: 'Pushing fixes',
    open_pr: 'Making the change',
  },
  needs_you: {
    review_pr: "Couldn't finish a review",
    re_review_pr: "Couldn't finish a re-review",
    fix_own_pr: "Couldn't push fixes",
    open_pr: "Couldn't open the PR",
  },
};

const LIVE_VERBS: Record<string, string> = {
  PR_REVIEW: 'Reviewed',
  IMPLEMENTATION: 'Made the change',
  OWNER_AUTOPILOT: 'Made the change',
  BUG_FIX: 'Fixed it',
  INVESTIGATION: 'Looked into it',
  INFORMATIONAL: 'Answered',
  CONVERSATIONAL: 'Answered',
  DEPLOY: 'Deployed',
};

function outcomeOfState(state: string | null): DidEntry['outcome'] {
  if (state === 'done') return 'done';
  if (state === 'ready') return 'ready';
  if (state === 'working' || state === 'waiting') return 'working';
  return 'needs_you';
}

function outcomeOf(item: MyDayItem): DidEntry['outcome'] {
  return outcomeOfState(item.state);
}

function closedByHim(item: MyDayItem, at: string): DidEntry {
  const verb = item.ownerClosed === 'skipped' ? 'You skipped' : 'You marked done';
  return { item, who: 'you', verb, outcome: 'done', at };
}

/**
 * Who did something about an item, and when. Open items are seen again every night,
 * so their own times move: work is dated by its job, and a draft by when it was found.
 */
function didEntry(item: MyDayItem): DidEntry | null {
  if (isSession(item)) return null;
  const at = item.lastSeenAt || item.firstSeenAt;
  if (item.requestId) {
    // He closed it: miniOG gets the credit only if its work had finished by then.
    if (item.ownerClosed) {
      const before = outcomeOfState(item.closedFrom);
      if (before !== 'done' && before !== 'ready') return closedByHim(item, at);
      const verb = NIGHT_VERBS.done[item.action ?? ''] ?? 'Worked on it';
      return { item, who: 'night', verb, outcome: 'done', at: item.jobUpdatedAt ?? at };
    }
    const outcome = outcomeOf(item);
    // A review that found nothing new since the last one checked, and reviewed nothing.
    const checked = outcome === 'done' && /^No new commits|already merged or closed/i.test(item.doneSummary ?? '');
    const verb = checked ? 'Checked: nothing new' : (NIGHT_VERBS[outcome][item.action ?? ''] ?? 'Worked on it');
    return { item, who: 'night', verb, outcome, at: item.jobUpdatedAt ?? at };
  }
  if (item.state === 'ready' && item.draftStatus === 'saved') {
    return { item, who: 'drafted', verb: 'Drafted a reply', outcome: 'ready', at: item.firstSeenAt };
  }
  if (item.state !== 'done') return null;
  if (item.ownerClosed) return closedByHim(item, at);
  if (item.jobId && /miniOG/i.test(item.doneSummary ?? '')) {
    const verb = LIVE_VERBS[item.jobWorkflow ?? ''] ?? 'Handled it';
    return { item, who: 'live', verb, outcome: 'done', at: item.jobUpdatedAt ?? at };
  }
  return { item, who: 'others', verb: 'Closed on Slack', outcome: 'done', at };
}

export function isMiniog(entry: DidEntry): boolean {
  return entry.who === 'night' || entry.who === 'live' || entry.who === 'drafted';
}

/** Everything done in the window, newest first. */
export function didFeed(items: MyDayItem[]): DidEntry[] {
  return items
    .map(didEntry)
    .filter((entry): entry is DidEntry => entry !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** What miniOG did in the last day, live in Slack or overnight. */
export function didRecently(items: MyDayItem[], now: number): DidEntry[] {
  const since = new Date(now - DAY_MS).toISOString();
  return didFeed(items).filter(entry => isMiniog(entry) && entry.outcome !== 'needs_you' && entry.at >= since);
}

export function didBreakdown(entries: DidEntry[]): string {
  const reviews = entries.filter(entry => entry.who !== 'drafted' && /^Re-?reviewed|^Reviewed/.test(entry.verb)).length;
  const prs = entries.filter(entry => /^(Opened a PR|Pushed fixes|Made the change|Fixed it)/.test(entry.verb)).length;
  const drafts = entries.filter(entry => entry.who === 'drafted').length;
  const checked = entries.filter(entry => entry.verb.startsWith('Checked')).length;
  const other = entries.length - reviews - prs - drafts - checked;
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return [
    reviews ? plural(reviews, 'review', 'reviews') : '',
    prs ? plural(prs, 'change', 'changes') : '',
    drafts ? plural(drafts, 'draft', 'drafts') : '',
    checked ? `${checked} checked` : '',
    other ? `${other} more` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Today", "Yesterday", or the date, for grouping a feed by day. */
export function dayLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const start = (value: number) => {
    const day = new Date(value);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  const diff = Math.round((start(now) - start(date.getTime())) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

export function groupByDay<T extends { at: string }>(
  entries: T[],
  now: number,
): Array<{ label: string; entries: T[] }> {
  const groups: Array<{ label: string; entries: T[] }> = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The run, in words

export type RunTone = 'ok' | 'running' | 'failed' | 'partial' | 'never';

/** A time said the short way: "today 22:07", "yesterday 22:07", "Tue 22:07". */
export function shortWhen(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = dayLabel(iso, now);
  if (day === 'Today') return `today ${time}`;
  if (day === 'Yesterday') return `yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function runStatus(day: MyDay | null, now: number): { tone: RunTone; text: string } {
  const run = day?.lastRun ?? null;
  if (day?.runQueued) return { tone: 'running', text: 'A sweep is about to start' };
  if (!run) return { tone: 'never', text: "Hasn't swept yet" };
  if (run.status === 'RUNNING') {
    const minutes = Math.max(0, Math.round((now - Date.parse(run.startedAt)) / 60_000));
    return { tone: 'running', text: `Sweeping your Slack and GitHub now, for ${minutes} min so far` };
  }
  const at = shortWhen(run.finishedAt ?? run.startedAt, now);
  if (run.status === 'FAILED') return { tone: 'failed', text: `The sweep ${at} failed` };
  if (run.status === 'PARTIAL') return { tone: 'partial', text: `Swept ${at}, but missed a source` };
  return { tone: 'ok', text: `Swept ${at}` };
}

/** The sidecar waits this long after any sweep before the next (`personal/schedule.ts`). */
const MIN_GAP_MS = 12 * 60 * 60 * 1000;

/**
 * When the nightly sweep will next start, the way the sidecar's `isRunDue` decides:
 * the latest run time that passed after both the last sweep and the schedule's
 * baseline, and never within 12 hours of the last sweep.
 */
export function nextSweepAt(day: MyDay, now: number): number | null {
  if (!day.enabled) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(day.runTime);
  const [hours, minutes] = match ? [Number(match[1]), Number(match[2])] : [22, 0];
  const passed = new Date(now);
  passed.setHours(hours, minutes, 0, 0);
  if (passed.getTime() > now) passed.setDate(passed.getDate() - 1);
  const last = Date.parse(day.lastRun?.startedAt ?? '');
  const baseline = Date.parse(day.enabledAt ?? '');
  const coveredAlready =
    (Number.isFinite(last) && last >= passed.getTime()) || (Number.isFinite(baseline) && baseline >= passed.getTime());
  const candidate = new Date(passed);
  if (coveredAlready) candidate.setDate(candidate.getDate() + 1);
  return Math.max(candidate.getTime(), Number.isFinite(last) ? last + MIN_GAP_MS : -Infinity);
}

/** When the next scheduled sweep is, in words, or that there isn't one. */
export function nextRunText(day: MyDay | null, now: number): string {
  const at = day ? nextSweepAt(day, now) : null;
  if (at === null) return 'Nightly sweep is off';
  if (at <= now) return 'Next sweep any minute';
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = calendarDaysAhead(at, now);
  if (days === 0) return `Next sweep ${date.getHours() >= 18 ? 'tonight' : 'today'} at ${time}`;
  if (days === 1) return `Next sweep tomorrow at ${time}`;
  return `Next sweep ${date.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Snoozing

/** The morning (09:00 local) `days` from now. */
export function morningIn(days: number, now: number): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date;
}

/** Next Monday morning; from a Monday, the one after. */
export function nextMonday(now: number): Date {
  const date = new Date(now);
  const ahead = (8 - date.getDay()) % 7 || 7;
  return morningIn(ahead, now);
}

export type SnoozeOption = { label: string; until: Date };

export function snoozeOptions(now: number): SnoozeOption[] {
  const monday = nextMonday(now);
  const options: SnoozeOption[] = [{ label: 'Tomorrow morning', until: morningIn(1, now) }];
  // On a Sunday, Monday is tomorrow already.
  if (monday.getTime() !== morningIn(1, now).getTime()) options.push({ label: 'Monday morning', until: monday });
  options.push({ label: 'In a week', until: morningIn(7, now) });
  return options;
}

/** Whole calendar days from `now` to `at`, in local time: 1 is tomorrow, whatever the hour. */
export function calendarDaysAhead(at: number, now: number): number {
  const start = (value: number) => {
    const day = new Date(value);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  return Math.round((start(at) - start(now)) / DAY_MS);
}

export function untilLabel(iso: string | null, now: number): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = calendarDaysAhead(date.getTime(), now);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function choiceSnoozeUntil(choice: MyDayChoice, now: number): Date {
  return morningIn(Math.min(Math.max(choice.days ?? 1, 1), 30), now);
}
