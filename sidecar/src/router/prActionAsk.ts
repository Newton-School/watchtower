import type { NormalizedTask, PrContext } from '../types/contracts.js';
import { normalizeControlText } from './stopIntent.js';

/**
 * A request that is nothing but an operation on one pull request (issue #605).
 *
 * "merge the pr" ran the planner for three and a half minutes to learn that
 * no code was needed, and only then asked for the confirmation. A message
 * that is only the operation, with the one pull request it means known, now
 * goes straight to the quick action and its gates. Anything more ("merge it
 * and fix the typo", "merge once CI is green", "should we merge?") is still
 * the planner's to read, so every other word has to come from a short list,
 * and anything that could change the meaning sends it there too: a link that
 * is not the PR, someone else mentioned, a question not put to miniOG, words
 * in another script.
 *
 * "revert" is left out on purpose: undoing a merged change can mean a code
 * change, and the planner decides that.
 */
export type PrActionVerb = 'merge' | 'close' | 'sync';

const ACTIONS = new Map<string, PrActionVerb>([
  ['merge', 'merge'],
  ['close', 'close'],
  ['sync', 'sync'],
]);

/** Politeness, pronouns and the pull request's own name: words that add no instruction. */
const FILLER = new Set([
  'please',
  'pls',
  'plz',
  'kindly',
  'you',
  'u',
  'go',
  'ahead',
  'and',
  'now',
  'just',
  'the',
  'this',
  'that',
  'it',
  'pr',
  'pull',
  'request',
  'thanks',
  'thank',
  'thx',
  'ty',
  'ok',
  'okay',
  'hey',
  'hi',
  'lgtm',
  'looks',
  'good',
  'miniog',
  'squash',
  'branch',
]);

/** "can you merge it": a modal is a request only when it is put to miniOG. */
const MODALS = new Set(['can', 'could', 'would', 'will']);
const ADDRESSEE = new Set(['you', 'u']);
/** "merge it into main", "sync it with the base branch": a preposition only before a branch name. */
const PREPOSITIONS = new Set(['with', 'into', 'to']);
const BRANCH_NAMES = new Set(['main', 'master', 'base', 'latest']);
/** "merge it for me". */
const BENEFICIARIES = new Set(['me', 'us']);

const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;

// The other ways people ask for a sync (issue #719), read on normalizeControlText's
// output: "bring that PR's branch up to date with master" arrives as "bring that prs
// branch up to date with master", and a link to the pull request as "this pr"
// (prPlaceholders). Each object is the pull request or its branch, so "update the
// copy" or "get the docs up to date" is never a sync.
const DET = '(?:the|this|that|its|my|our|your)';
const PR_NOUN = '(?:prs|pr|pull requests|pull request)';
const SYNC_OBJECT = `(?:it|this|that|${DET} ${PR_NOUN} branch|${DET} branch|${DET} ${PR_NOUN}|${PR_NOUN} branch|branch)`;
/** The pull request an "update the branch of …" names. */
const PR_REF = `(?:it|this|that|${DET} ${PR_NOUN}|${PR_NOUN})`;
const BASE_BRANCH = '(?:(?:the )?(?:latest )?(?:origin )?(?:base(?: branch)?|master|main)|latest)';
/** Where a phrase has to stop, so "update the branch name" or "rebase it interactively" is not a sync. */
const PHRASE_END = '(?=$| please| pls| now| thanks| thank you)';
const SYNC_PHRASES = [
  // "bring it up to date (with master)", "get up to date with main": an object or a base branch.
  new RegExp(`\\b(?:bring|get) ${SYNC_OBJECT} up to date(?: with ${BASE_BRANCH})?\\b`, 'g'),
  new RegExp(`\\b(?:bring|get) up to date with ${BASE_BRANCH}\\b`, 'g'),
  new RegExp(
    `\\bupdate (?:${DET} )?(?:${PR_NOUN} )?branch(?: (?:of|on|for|in) ${PR_REF})? with ${BASE_BRANCH}\\b`,
    'g',
  ),
  new RegExp(`\\bupdate (?:${DET} )?(?:${PR_NOUN} )?branch(?: (?:of|on|for|in) ${PR_REF})?${PHRASE_END}`, 'g'),
  new RegExp(`\\bupdate ${PR_REF} with ${BASE_BRANCH}\\b`, 'g'),
  // "merge master into it", "merge in main", "merge from master", "pull master into this pr".
  new RegExp(`\\b(?:merge|pull) (?:from |in )?${BASE_BRANCH} (?:into|in to|to) ${SYNC_OBJECT}\\b`, 'g'),
  new RegExp(`\\b(?:merge|pull) (?:in ${BASE_BRANCH}|${BASE_BRANCH} in|from ${BASE_BRANCH})${PHRASE_END}`, 'g'),
  new RegExp(`\\bcatch ${SYNC_OBJECT} up with ${BASE_BRANCH}\\b`, 'g'),
  new RegExp(`\\bcatch up with ${BASE_BRANCH}\\b`, 'g'),
];
/** miniOG merges the base in and never rebases a branch with an open PR: a rebase ask is a sync. */
const REBASE_PHRASES = [
  new RegExp(`\\brebase(?: ${SYNC_OBJECT})? (?:on|onto|with|against) ${BASE_BRANCH}\\b`, 'g'),
  new RegExp(`\\brebase ${SYNC_OBJECT}(?=$| please| pls| now| thanks| thank you| and squash)`, 'g'),
  new RegExp(`\\brebase${PHRASE_END}`, 'g'),
];
/** "don't", "no rush", "never", "merge mat karo": with a negation anywhere, the words name no operation. */
const NEGATION = /\b(?:dont|do not|donot|dnt|never|not|no|nope|nah|without|hold|wait|stop|mat|nahi|nahin)\b/;
const PR_URL_IN_TEXT_RE =
  /<https?:\/\/(?:www\.)?github\.com\/[^/\s|>]+\/[^/\s|>]+\/pull\/\d+[^|>]*(?:\|[^>]*)?>|https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*/gi;

/**
 * Links to pull requests replaced by "this pr", so "merge master into <link>"
 * reads like "merge master into this pr", and "origin/master" written as
 * "origin master", so a caller that drops slash words (typed branch names)
 * keeps it. Other links are left to the caller.
 */
export function prPlaceholders(text: string): string {
  return text
    .replace(PR_URL_IN_TEXT_RE, ' this pr ')
    .replace(/\b(?:origin|upstream)\/(master|main)\b/gi, (_match, branch: string) => `origin ${branch}`);
}

export interface SyncPhrase {
  /** The text with each sync phrasing replaced by "sync it". */
  text: string;
  sync: boolean;
  /** The person asked for a rebase; the sync merges the base in instead. */
  rebase: boolean;
}

/**
 * Reads "bring it up to date with master", "update the branch", "merge main
 * into it", "catch up with master" and "rebase on master" as a sync. Anything
 * with a negation is left as it is: "don't rebase, merge it" is not a sync.
 */
export function readSyncPhrase(text: string): SyncPhrase {
  const normalized = normalizeControlText(prPlaceholders(text));
  if (NEGATION.test(normalized)) return { text: normalized, sync: false, rebase: false };
  let rewritten = normalized;
  for (const phrase of SYNC_PHRASES) rewritten = rewritten.replace(phrase, 'sync it');
  const beforeRebase = rewritten;
  for (const phrase of REBASE_PHRASES) rewritten = rewritten.replace(phrase, 'sync it');
  const rebase = rewritten !== beforeRebase;
  return { text: rewritten, sync: rewritten !== normalized, rebase };
}

export type QuickOperation =
  | { kind: 'operation'; action: PrActionVerb | 'revert'; rebase: boolean }
  /** The words name no pull-request operation. */
  | { kind: 'none' }
  /** They name one but can't be read safely: a negation, two operations, or "merge" next to the base branch. */
  | { kind: 'unclear'; reason: 'negation' | 'several' | 'base_branch_merge' }
  /** A question about the pull request, not a request ("did you merge it?"). */
  | { kind: 'question' };

const OPERATION_WORDS = /\b(merge|close|revert|sync)\b/g;
/** "merge master", "merge it with main": the base branch next to "merge" is never a merge of the pull request. */
const MERGE_WITH_BASE = new RegExp(`\\bmerge(?: ${SYNC_OBJECT})? (?:with |from |in )?${BASE_BRANCH}\\b`);
/** "can you merge it?": a question put to miniOG is a request. */
const REQUEST_QUESTION = /\b(?:can|could|would|will) (?:you|u)\b/;
const QUESTION_MARK = /[?？؟¿]/;

/**
 * The pull-request operation a quick action may run, read from the words of
 * the message (links, code and typed names already taken out by the caller).
 * Only one plainly named operation is picked: anything that could mean
 * something else is "unclear", and the caller asks instead of guessing (#719).
 */
export function readQuickOperation(words: string): QuickOperation {
  // Struck-through words were taken back.
  const kept = words.replace(/~[^~]+~/g, ' ');
  const sync = readSyncPhrase(kept);
  const plain = sync.text;
  const named = new Set([...plain.matchAll(OPERATION_WORDS)].map(match => match[1] as PrActionVerb | 'revert'));
  // "sync up with me" is a meeting.
  if (!sync.sync && /\bsync up\b/.test(plain)) named.delete('sync');
  if (named.size === 0) return { kind: 'none' };
  if (QUESTION_MARK.test(kept) && !REQUEST_QUESTION.test(plain)) return { kind: 'question' };
  if (NEGATION.test(plain)) return { kind: 'unclear', reason: 'negation' };
  if (named.size > 1) return { kind: 'unclear', reason: 'several' };
  if (MERGE_WITH_BASE.test(plain)) return { kind: 'unclear', reason: 'base_branch_merge' };
  return { kind: 'operation', action: [...named][0], rebase: sync.rebase };
}

export type PrActionAsk = { action: PrActionVerb; pr: PrContext };

/** Who the message may mention: miniOG, and the owner when tagging the owner is how the ask reached it. */
export type PrActionAddressees = { botUserId: string; ownerUserIds: string[] };

type AskTask = Pick<NormalizedTask, 'event' | 'prContext' | 'prContexts' | 'mentionType'>;

/**
 * The operation and its pull request when the message is only that, else
 * undefined. The pull request is the one named by number, else the one
 * linked in the message, else the thread's only one; two candidates and no
 * way to tell them apart leave it to the planner.
 */
export function readPrActionAsk(task: AskTask, addressees: PrActionAddressees): PrActionAsk | undefined {
  const text = stripAllowedTokens(task, addressees);
  if (text === undefined) return undefined;
  // "merge मत करो" is "don't merge"; normalizeControlText would keep only "merge".
  if (/[^\P{L}a-zA-Z]/u.test(text)) return undefined;
  // "~merge it~": taken back, and normalizeControlText would drop the tildes.
  if (/~[^~]+~/.test(text)) return undefined;
  // "bring it up to date with master" and the like are a sync (issue #719).
  const words = readSyncPhrase(text).text.split(' ').filter(Boolean);
  // "merge it?", "you merge it?": a question, unless it is put to miniOG ("can you merge it?").
  if (QUESTION_MARK.test(text) && !REQUEST_QUESTION.test(words.join(' '))) return undefined;

  const actions = new Set<PrActionVerb>();
  const numbers = new Set<number>();
  let withBranch = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const action = ACTIONS.get(word);
    if (action) {
      actions.add(action);
    } else if (/^\d+$/.test(word)) {
      numbers.add(Number(word));
    } else if (MODALS.has(word)) {
      if (!ADDRESSEE.has(words[i + 1] ?? '')) return undefined;
    } else if (PREPOSITIONS.has(word)) {
      // "with main", "into the base branch"; "sync up with me" is a meeting.
      let next = i + 1;
      if (words[next] === 'the') next++;
      if (!BRANCH_NAMES.has(words[next] ?? '')) return undefined;
      if (word === 'with') withBranch = true;
      i = words[next + 1] === 'branch' ? next + 1 : next;
    } else if (word === 'for') {
      if (!BENEFICIARIES.has(words[i + 1] ?? '')) return undefined;
      i++;
    } else if (!FILLER.has(word)) {
      return undefined;
    }
  }
  if (actions.size !== 1 || numbers.size > 1) return undefined;
  const action = [...actions][0];
  // "merge it with master" could mean either way round: the router reads it.
  if (action === 'merge' && withBranch) return undefined;
  const pr = targetPr(task, numbers.size === 1 ? [...numbers][0] : undefined);
  return pr ? { action, pr } : undefined;
}

/**
 * The text with the "Sent using" footer, the allowed mentions and the PR's
 * own links taken out, or undefined when something in it is not allowed: a
 * mention of anyone else, a channel or group, or a link that is not one of the
 * pull requests the message itself links (an issue, a branch, a ticket).
 */
function stripAllowedTokens(task: AskTask, addressees: PrActionAddressees): string | undefined {
  const allowedMentions = new Set([
    addressees.botUserId,
    ...(task.mentionType === 'owner' ? addressees.ownerUserIds : []),
  ]);
  const linkedPrs = (task.prContexts ?? (task.prContext ? [task.prContext] : [])).filter(
    pr => !('source' in pr) || pr.source === 'trigger',
  );
  const isLinkedPr = (url: string) => {
    const match = PR_URL_RE.exec(url);
    return Boolean(
      match &&
      linkedPrs.some(
        pr =>
          pr.owner.toLowerCase() === match[1].toLowerCase() &&
          pr.repo.toLowerCase() === match[2].toLowerCase() &&
          pr.number === Number(match[3]),
      ),
    );
  };

  let allowed = true;
  const text = task.event.text
    .replace(/\*sent using\*[\s\S]*$/i, '')
    // Slack's markup: <@U…|name>, <https://…|label>, <#C…|channel>, <!here>.
    // The pull request's own link reads as "this pr", so "merge master into <link>"
    // is read like "merge master into this pr" (issue #719).
    .replace(/<([^>]*)>/g, (_token, inner: string) => {
      const target = inner.split('|')[0];
      const mention = /^@([A-Z0-9]+)$/i.exec(target);
      if (mention ? !allowedMentions.has(mention[1]) : !isLinkedPr(target)) allowed = false;
      return mention ? ' ' : ' this pr ';
    })
    .replace(/https?:\/\/\S+/gi, url => {
      // A full stop or comma after a pasted link is the sentence's, not the link's.
      if (!isLinkedPr(url.replace(/[.,!?;:)]+$/, ''))) allowed = false;
      return ' this pr ';
    })
    // Emoji shortcodes (":pray:") carry no instruction.
    .replace(/:[a-z0-9_+'-]+:/gi, ' ');
  return allowed ? text : undefined;
}

function targetPr(task: AskTask, number?: number): PrContext | undefined {
  const known: Array<PrContext & { source?: 'trigger' | 'thread' }> =
    task.prContexts ?? (task.prContext ? [task.prContext] : []);
  const prs = [...new Map(known.map(pr => [pr.url, pr])).values()];
  const only = (candidates: typeof prs) => (candidates.length === 1 ? strip(candidates[0]) : undefined);
  if (number !== undefined) return only(prs.filter(pr => pr.number === number));
  const inMessage = prs.filter(pr => pr.source === 'trigger');
  return inMessage.length > 0 ? only(inMessage) : only(prs);
}

function strip(pr: PrContext): PrContext {
  return { url: pr.url, owner: pr.owner, repo: pr.repo, number: pr.number };
}
