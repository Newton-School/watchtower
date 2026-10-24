import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedTask, WorkflowIntent } from '../types/contracts.js';
import { requesterOf } from '../workflows/shared/requester.js';
import { RESTART_EVENT_PREFIX } from '../runtime/restartRecovery.js';
import { toolchainEnv } from '../backends/codexBackend.js';
import { forgetWork, type AskKind, type WorkEntry } from '../state/workLedger.js';

const execFileAsync = promisify(execFile);

/**
 * The same ask sent twice (issue #602).
 *
 * A requester who posts a request in one channel and, a few minutes later,
 * the same request in another got two jobs: two plans, two approvals, two
 * PRs. A new request from the same person that matches one of their runs
 * still in flight, or one that succeeded with a PR still open in the last 15
 * minutes, is pointed at that thread instead.
 *
 * Text is matched, not meaning, so the match is deliberately narrow: two asks
 * are the same only when EVERY word of the shorter one is in the longer one,
 * and every link, number and quoted phrase of the shorter one is in the
 * longer one too, in the same order. One word apart is a different ask
 * ("pune" and "delhi", "add" and "remove", "red" and "blue"), and so is a
 * swap ('"Apply" to "Enroll"' and back). A rephrased request is not caught;
 * a copy re-posted, or re-posted with more added, is.
 */

/** How long after the first ask a matching one counts as the same ask sent again. */
export const DUPLICATE_ASK_WINDOW_MS = 15 * 60_000;

/** Words that turn a request around when added to it: "show the banner" and "do not show the banner". */
const TURNS_AROUND = new Set(['not', 'no', 'never', "don't", 'dont', 'without', 'except', 'instead', 'undo', 'revert']);

/** A lookup may not add much to the question either: it would be a different question. */
const LOOKUP_JACCARD = 0.85;
/** Fewer words than this carry too little to match on ("check now", "yes"). */
const MIN_WORDS = 5;

// Only words that carry no meaning in a request. Negations, directions and
// quantities ("not", "off", "below", "more", "only") are kept: they change it.
const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in at by for from with as is are was were be been being am do does ' +
    'did done have has had having it its this that these those there here i me my we our you your he she they ' +
    'them their his her can could would should will shall may might must please pls kindly also just so very ' +
    'too yes ok okay hi hey hello thanks thank miniog what which who whom when where why how some each every ' +
    'both such own than about through during while because until'
  ).split(' '),
);

export interface AskFeatures {
  words: Set<string>;
  /** Links (host and path), numbers of two digits or more, and double-quoted phrases, in the order written. */
  specifics: string[];
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
  const found: Array<{ at: number; value: string }> = [];
  const rest = cleanAskText(text)
    // Slack links arrive as <url|label> or <url>; take them out before reading words.
    .replace(
      /<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>|https?:\/\/[^\s<>]+/g,
      (match, slackUrl: string | undefined, at: number) => {
        const normalized = normalizeUrl(slackUrl ?? match);
        if (normalized) found.push({ at, value: `link:${normalized}` });
        return ' '.repeat(match.length);
      },
    );
  for (const match of rest.matchAll(/["“”]([^"“”]{1,120})["“”]/g)) {
    const phrase = match[1].toLowerCase().replace(/\s+/g, ' ').trim();
    if (phrase) found.push({ at: match.index ?? 0, value: `quote:${phrase}` });
  }
  // "23,364" and "23364" are one number; a single digit is usually a list marker.
  for (const match of rest.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const value = match[0].replace(/,/g, '');
    if (value.replace(/\D/g, '').length >= 2) found.push({ at: match.index ?? 0, value: `num:${value}` });
  }

  const words = new Set<string>();
  for (const token of rest.toLowerCase().split(/[^a-z0-9_'’-]+/)) {
    const word = stem(token.replace(/^['’-]+|['’-]+$/g, ''));
    if (word.length < 2 || /\d/.test(word) || STOPWORDS.has(word)) continue;
    words.add(word);
  }
  return { words, specifics: found.sort((a, b) => a.at - b.at).map(item => item.value) };
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/** Whether `inner` appears in `outer` in order, with anything in between. */
function isSubsequence(inner: string[], outer: string[]): boolean {
  let at = 0;
  for (const item of outer) if (item === inner[at]) at += 1;
  return at === inner.length;
}

/** Whether two asks of the same kind, from the same person, are the same request. */
export function isSameAsk(kind: AskKind, a: string, b: string): boolean {
  const first = askFeatures(a);
  const second = askFeatures(b);
  const [shorter, longer] = first.words.size <= second.words.size ? [first, second] : [second, first];
  if (shorter.words.size < MIN_WORDS) return false;
  if (!isSubset(shorter.words, longer.words)) return false;
  for (const word of longer.words) if (TURNS_AROUND.has(word) && !shorter.words.has(word)) return false;
  if (kind === 'lookup') {
    return (
      shorter.words.size / longer.words.size >= LOOKUP_JACCARD &&
      first.specifics.join('\n') === second.specifics.join('\n')
    );
  }
  return isSubsequence(shorter.specifics, longer.specifics);
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

const isDm = (channelType: string | undefined): boolean => channelType === 'im' || channelType === 'mpim';

/**
 * The earlier run this request repeats, if any: the same requester and kind,
 * another thread, still in flight and asked in the last 15 minutes, or ended
 * with an open PR in the last 15 minutes. A DM and a channel are never
 * matched with each other: the reply would link one from the other.
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
  const fromDm = isDm(task.event.channelType);
  return work
    .filter(
      entry =>
        entry.jobId !== jobId &&
        entry.requesterId === requesterId &&
        entry.kind === kind &&
        !(entry.channelId === task.event.channelId && entry.threadTs === task.event.threadTs) &&
        ((!fromDm && !isDm(entry.channelType)) || entry.channelId === task.event.channelId) &&
        (entry.endedAtMs === undefined
          ? nowMs - entry.startedAtMs <= DUPLICATE_ASK_WINDOW_MS
          : nowMs - entry.endedAtMs <= DUPLICATE_ASK_WINDOW_MS),
    )
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
    .find(entry => isSameAsk(kind, entry.text, text));
}

/** Whether a PR is still open. Unknown counts as not: the request then runs. */
export async function isPrOpen(prUrl: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', prUrl, '--json', 'state', '-q', '.state'], {
      timeout: 15_000,
      env: toolchainEnv(),
    });
    return stdout.trim() === 'OPEN';
  } catch {
    return false;
  }
}

/**
 * `findDuplicateAsk`, with a run that ended checked against GitHub: one
 * whose PR was merged or closed since no longer counts, and is forgotten.
 */
export async function resolveDuplicateAsk(params: {
  task: NormalizedTask;
  kind: AskKind;
  jobId?: string;
  work: WorkEntry[];
  prOpen?: (prUrl: string) => Promise<boolean>;
}): Promise<WorkEntry | undefined> {
  const prOpen = params.prOpen ?? isPrOpen;
  let work = params.work;
  for (;;) {
    const first = findDuplicateAsk({ ...params, work });
    if (!first?.prUrl || (await prOpen(first.prUrl))) return first;
    forgetWork(first.jobId);
    work = work.filter(entry => entry !== first);
  }
}

/** The one line posted instead of starting a second run. */
export function duplicateAskReply(first: WorkEntry, threadLink: string): string {
  const elsewhere = first.prUrl
    ? `I opened <${first.prUrl}|a PR> for this a few minutes ago, in <${threadLink}|this thread>.`
    : `I'm already working on this in <${threadLink}|this thread>.`;
  return `${elsewhere} Add anything new there, or ${DIFFERENT_REQUEST_HINT}.`;
}
