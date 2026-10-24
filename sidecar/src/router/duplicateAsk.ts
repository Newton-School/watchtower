import type { NormalizedTask, WorkflowIntent } from '../types/contracts.js';
import { requesterOf } from '../workflows/shared/requester.js';
import { RESTART_EVENT_PREFIX } from '../runtime/restartRecovery.js';
import type { AskKind, WorkEntry } from '../state/workLedger.js';

/**
 * The same ask sent twice (issue #602).
 *
 * A requester who posts a request in one channel and, a few minutes later,
 * the same request in another (or tags the owner with it) got two jobs: two
 * plans, two approvals, two PRs. A new request from the same person that
 * matches one of their runs still in flight, or one that opened a PR in the
 * last 15 minutes, is pointed at that thread instead.
 *
 * Text is matched, not meaning, so the match is deliberately narrow: two asks
 * are the same only when nearly every word of the shorter one is in the
 * longer one AND every link, number and quoted phrase of the shorter one is
 * in the longer one too. Requests to the same page that change different
 * numbers, or the same request template for a different page, are different
 * asks. The longer one may add detail (more pages, another variant): that is
 * still the same piece of work, and the details belong in its thread.
 */

/** How long after the first ask a matching one counts as the same ask sent again. */
export const DUPLICATE_ASK_WINDOW_MS = 15 * 60_000;

/**
 * A change ask is the same when this share of the shorter one's words is in
 * the longer one, and the longer one is at least LONGER_BY times as long: it
 * restates the shorter one with more detail. Two asks of about the same
 * length must share every word of the shorter one ("the pune campus section"
 * and "the delhi campus section" are different asks).
 */
const CHANGE_CONTAINMENT = 0.75;
const LONGER_BY = 1.5;
/** A lookup is cheap to run twice and easy to rephrase into a different question: near-identical only. */
const LOOKUP_JACCARD = 0.85;
/** Fewer words than this carry too little to match on ("check now", "yes"). */
const MIN_WORDS = 5;

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for from with without into onto over under as is are was ' +
    'were be been being am do does did done have has had having it its this that these those there here i me my ' +
    'we our you your he she they them their his her can could would should will shall may might must please pls ' +
    'kindly also just so very too not no yes ok okay hi hey hello thanks thank miniog what which who whom when ' +
    'where why how all any some each every both few more most other such only own same than up down out off ' +
    'again further once about above below between through during before after while because until against'
  ).split(' '),
);

export interface AskFeatures {
  words: Set<string>;
  /** Links (host and path), numbers of two digits or more, and double-quoted phrases. */
  specifics: Set<string>;
}

/** The request without mentions, Slack's "Sent using" footer, or HTML entities. */
export function cleanAskText(text: string): string {
  return text
    .replace(/\*Sent using\*[\s\S]*$/, '')
    .replace(/<[@#!][^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, '').toLowerCase();
    // A design link names its frame in the query; anything else there is tracking.
    const node = url.searchParams.get('node-id');
    return `${host}${pathname}${node ? `#${node}` : ''}`;
  } catch {
    return undefined;
  }
}

function stem(word: string): string {
  const bare = word.replace(/['’]s$/, '');
  return bare.length > 3 && bare.endsWith('s') && !bare.endsWith('ss') ? bare.slice(0, -1) : bare;
}

export function askFeatures(text: string): AskFeatures {
  const specifics = new Set<string>();
  let rest = cleanAskText(text);

  // Slack links arrive as <url|label> or <url>; take them out before reading words.
  rest = rest.replace(/<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>/g, (_match, url: string) => {
    const normalized = normalizeUrl(url);
    if (normalized) specifics.add(`link:${normalized}`);
    return ' ';
  });
  rest = rest.replace(/https?:\/\/[^\s<>]+/g, url => {
    const normalized = normalizeUrl(url);
    if (normalized) specifics.add(`link:${normalized}`);
    return ' ';
  });
  for (const match of rest.matchAll(/["“”]([^"“”]{1,120})["“”]/g)) {
    const phrase = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (phrase) specifics.add(`quote:${phrase}`);
  }
  // "23,364" and "23364" are one number; a single digit is usually a list marker.
  for (const match of rest.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const value = match[0].replace(/,/g, '');
    if (value.replace(/\D/g, '').length >= 2) specifics.add(`num:${value}`);
  }

  const words = new Set<string>();
  for (const token of rest.toLowerCase().split(/[^a-z0-9_'’-]+/)) {
    const word = stem(token.replace(/^['’-]+|['’-]+$/g, ''));
    if (word.length < 2 || /\d/.test(word) || STOPWORDS.has(word)) continue;
    words.add(word);
  }
  return { words, specifics };
}

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared;
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** Whether two asks of the same kind, from the same person, are the same request. */
export function isSameAsk(kind: AskKind, a: string, b: string): boolean {
  const first = askFeatures(a);
  const second = askFeatures(b);
  const [shorter, longer] = first.words.size <= second.words.size ? [first, second] : [second, first];
  if (shorter.words.size < MIN_WORDS) return false;
  if (kind === 'lookup') {
    const shared = overlap(first.words, second.words);
    const union = first.words.size + second.words.size - shared;
    return (
      shared / union >= LOOKUP_JACCARD &&
      isSubset(first.specifics, second.specifics) &&
      isSubset(second.specifics, first.specifics)
    );
  }
  const needed = longer.words.size >= shorter.words.size * LONGER_BY ? CHANGE_CONTAINMENT : 1;
  return (
    overlap(shorter.words, longer.words) / shorter.words.size >= needed && isSubset(shorter.specifics, longer.specifics)
  );
}

/** The kind of work a routed intent is, for the intents a duplicate is checked for. */
export function askKindOf(intent: WorkflowIntent): AskKind | undefined {
  if (intent === 'IMPLEMENTATION' || intent === 'OWNER_AUTOPILOT') return 'change';
  if (intent === 'INFORMATIONAL' || intent === 'INVESTIGATION') return 'lookup';
  return undefined;
}

/**
 * What the message asks for. A reply to a question miniOG asked ("yes") is
 * read with the message the question was about, as the router reads it.
 */
export function askTextOf(task: NormalizedTask): string {
  const own = cleanAskText(task.event.text ?? '');
  return task.clarification ? `${cleanAskText(task.clarification.askedText)}\n${own}` : own;
}

/** Ends the line posted for a duplicate. Seen in a thread, it means the requester was already told once. */
const DIFFERENT_REQUEST_HINT = 'mention me here if this is a different request';

/**
 * Whether a message may be checked at all. A deliberate re-run (a retrigger
 * from the app, a restart replay) is never a duplicate, an owner repeating a
 * request means it, and a message with files can't be compared by its text.
 * Nor is a thread checked twice: once told, a requester who mentions miniOG
 * there again is saying it is a different request.
 */
export function mayCheckForDuplicate(task: NormalizedTask): boolean {
  if (task.isOwnerAuthor) return false;
  if (task.event.ingestSource === 'launchpad' || task.event.eventId.startsWith(RESTART_EVENT_PREFIX)) return false;
  const rawFiles = (task.event.rawEvent as { files?: unknown } | undefined)?.files;
  if (Array.isArray(rawFiles) && rawFiles.length > 0) return false;
  const thread = task.threadMessages ?? [];
  if (thread.some(message => message.ts === task.event.eventTs && (message.files?.length ?? 0) > 0)) return false;
  return !thread.some(message => message.text.includes(DIFFERENT_REQUEST_HINT));
}

/**
 * The earlier run this request repeats, if any: the same requester and kind,
 * another thread, still in flight and asked in the last 15 minutes, or ended
 * with a PR in the last 15 minutes.
 */
export function findDuplicateAsk(params: {
  task: NormalizedTask;
  kind: AskKind;
  jobId?: string;
  work: WorkEntry[];
  nowMs?: number;
}): WorkEntry | undefined {
  const { task, kind, jobId, work } = params;
  const nowMs = params.nowMs ?? Date.now();
  const requesterId = requesterOf(task);
  const text = askTextOf(task);
  return work
    .filter(
      entry =>
        entry.jobId !== jobId &&
        entry.requesterId === requesterId &&
        entry.kind === kind &&
        !(entry.channelId === task.event.channelId && entry.threadTs === task.event.threadTs) &&
        (entry.endedAtMs === undefined
          ? nowMs - entry.startedAtMs <= DUPLICATE_ASK_WINDOW_MS
          : nowMs - entry.endedAtMs <= DUPLICATE_ASK_WINDOW_MS),
    )
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
    .find(entry => isSameAsk(kind, entry.text, text));
}

/** The one line posted instead of starting a second run. */
export function duplicateAskReply(first: WorkEntry, threadLink: string): string {
  const elsewhere = first.prUrl
    ? `I opened <${first.prUrl}|a PR> for this a few minutes ago, in <${threadLink}|this thread>.`
    : `I'm already working on this in <${threadLink}|this thread>.`;
  return `${elsewhere} Add anything new there, or ${DIFFERENT_REQUEST_HINT}.`;
}
