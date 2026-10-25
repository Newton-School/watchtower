import type { NormalizedTask, PrContext } from '../types/contracts.js';
import { stagingPlainText } from './stagingTarget.js';
import { normalizeControlText } from './stopIntent.js';

/**
 * Reading a pull-request operation (merge, close, sync) from a message, in two
 * places that differ in how much they may trust the words.
 *
 * The gate (`readPrActionAsk`, issues #605 and #719) skips the router and the
 * planner, and the owner's ask runs with no confirmation. So it acts only on a
 * message that is one of a few exact sentences ("merge it", "sync <PR link>
 * with master", "bring the branch up to date"), after a mention, the PR's link
 * and a little politeness at either end are taken off. A word list was tried
 * first and kept letting reports through ("thanks, the merge looks good"); a
 * template either matches the whole message or the router reads it.
 *
 * After the router and planner, the quick action (`readQuickOperation`) reads
 * looser phrasing, but every merge, close or revert it finds is confirmed with
 * `confirm <op>` before it runs, the owner's included: there the reading only
 * decides what to ask, and anything unclear is asked about instead.
 *
 * "revert" is never the gate's: undoing a merged change can mean a code change,
 * and the planner decides that.
 */
export type PrActionVerb = 'merge' | 'close' | 'sync';

const PR_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i;
const PR_URL_IN_TEXT_RE =
  /<https?:\/\/(?:www\.)?github\.com\/[^/\s|>]+\/[^/\s|>]+\/pull\/\d+[^|>]*(?:\|[^>]*)?>|https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\S*/gi;
/** "origin/master" read as "origin master", so it survives dropping slash words. */
const REMOTE_BASE_RE = /\b(?:origin|upstream)\/(master|main)\b/gi;

/**
 * Links to pull requests replaced by "this pr", so "merge master into <link>"
 * reads like "merge master into this pr", and "origin/master" written as
 * "origin master". Other links are left to the caller.
 */
export function prPlaceholders(text: string): string {
  return text
    .replace(PR_URL_IN_TEXT_RE, ' this pr ')
    .replace(REMOTE_BASE_RE, (_match, branch: string) => `origin ${branch}`);
}

// ---------------------------------------------------------------------------
// The gate: exact sentences only.

const GATE_OBJECT =
  '(?:it|this|this pr|the pr|that pr|this pull request|the pull request|that pull request|(?:pr |pull request )?#?(\\d+))';
const GATE_BRANCH = '(?:(?:the|this|its) branch|branch|(?:the|this|that) (?:pr|prs|pull request) branch)';
const GATE_BASE = '(?:master|main)';
const GATE_TEMPLATES: Array<{ re: RegExp; action?: PrActionVerb; intoBase?: true }> = [
  // "merge it", "close this pr", "sync 1404"; the verb is the action.
  { re: new RegExp(`^(merge|close|sync)(?: ${GATE_OBJECT})?$`) },
  // Only when that is the PR's base branch: the change workflow checks it on GitHub.
  { re: new RegExp(`^merge(?: ${GATE_OBJECT})? (?:into|to) ${GATE_BASE}$`), action: 'merge', intoBase: true },
  { re: new RegExp(`^squash and merge(?: ${GATE_OBJECT})?$`), action: 'merge' },
  // The sync sentences: always the pull request or its branch, and its base branch.
  {
    re: new RegExp(`^sync(?: (?:${GATE_OBJECT}|${GATE_BRANCH}))? with (?:the )?(?:master|main|base|base branch)$`),
    action: 'sync',
  },
  { re: new RegExp(`^bring (?:${GATE_OBJECT}|${GATE_BRANCH}) up to date(?: with ${GATE_BASE})?$`), action: 'sync' },
  { re: new RegExp(`^update ${GATE_BRANCH}(?: (?:of|on) ${GATE_OBJECT})?(?: with ${GATE_BASE})?$`), action: 'sync' },
  { re: new RegExp(`^update ${GATE_OBJECT} with ${GATE_BASE}$`), action: 'sync' },
  {
    re: new RegExp(`^merge (?:origin )?${GATE_BASE} into (?:${GATE_OBJECT}|${GATE_BRANCH})$`),
    action: 'sync',
  },
];
/**
 * Taken off the start: a short approval ("looks good on staging, merge it",
 * "perfect, go ahead and merge it"), please, and a request put to miniOG
 * ("can you …"). Only at the start: "the merge looks good" is a report.
 */
const GATE_LEAD =
  /^(?:(?:looks good(?: on staging)?|lgtm|great|perfect|nice|awesome|ok|okay|cool|thanks|thank you|thx|ty) )?(?:(?:please|pls|plz|kindly) )?(?:go ahead and )?(?:((?:can|could|would|will) (?:you|u)) )?(?:(?:please|pls|plz|kindly) )?/;
const GATE_TAIL = /(?: (?:please|pls|plz|thanks|thank you|thx|ty|now|asap))+$/;
/**
 * Anything that may change what the words mean sends the message to the
 * router: code, struck-through or quoted text, emphasis, emoji, an ampersand
 * ("merge it & close the ticket"), words in another script.
 */
const GATE_REFUSES = [
  /`/,
  /~/,
  /["“”]/,
  /(?<![a-z])['‘’]|['‘’](?![a-z])/i,
  /&|^\s*>/,
  /[*_]/,
  /:[a-z0-9_+'-]+:/i,
  /\p{Extended_Pictographic}/u,
  /[^\P{L}a-zA-Z]/u,
];

export type PrActionAsk = { action: PrActionVerb; pr: PrContext; intoBase?: 'master' | 'main' };

/** Who the message may mention: miniOG, and the owner when tagging the owner is how the ask reached it. */
export type PrActionAddressees = { botUserId: string; ownerUserIds: string[] };

type AskTask = Pick<NormalizedTask, 'event' | 'prContext' | 'prContexts' | 'mentionType'>;

/**
 * The operation and its pull request when the whole message is one of the
 * gate's sentences, else undefined. The pull request is the one named by
 * number, else the one linked in the message, else the thread's only one;
 * two candidates and no way to tell them apart leave it to the router.
 */
export function readPrActionAsk(task: AskTask, addressees: PrActionAddressees): PrActionAsk | undefined {
  const text = stripAllowedTokens(task, addressees);
  if (text === undefined) return undefined;
  if (GATE_REFUSES.some(pattern => pattern.test(text))) return undefined;
  let core = text
    .replace(REMOTE_BASE_RE, (_match, branch: string) => `origin ${branch}`)
    .toLowerCase()
    // "that PR's branch" reads as "that prs branch".
    .replace(/([a-z])['‘’]([a-z])/g, '$1$2')
    .replace(/[.,!]+/g, ' ');
  const question = /[?？]/.test(core);
  core = core.replace(/[?？]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[^a-z0-9# ]/.test(core)) return undefined;

  const lead = GATE_LEAD.exec(core);
  // A question is a request only when it is put to miniOG: "can you merge it?", not "merge it?".
  if (question && !lead?.[1]) return undefined;
  core = core
    .slice(lead?.[0].length ?? 0)
    .replace(GATE_TAIL, '')
    .trim();

  for (const template of GATE_TEMPLATES) {
    const match = template.re.exec(core);
    if (!match) continue;
    const action = template.action ?? (match[1] as PrActionVerb);
    const number = match.slice(1).find(group => group !== undefined && /^\d+$/.test(group));
    const pr = targetPr(task, number === undefined ? undefined : Number(number));
    if (!pr) return undefined;
    return template.intoBase ? { action, pr, intoBase: core.endsWith('main') ? 'main' : 'master' } : { action, pr };
  }
  return undefined;
}

/**
 * The text with the "Sent using" footer and the allowed mentions taken out
 * and the PR's own links read as "this pr", or undefined when something in it
 * is not allowed: a mention of anyone else, a channel or group, or a link that
 * is not one of the pull requests the message itself links (an issue, a
 * branch, a ticket).
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
    });
  return allowed ? text : undefined;
}

function targetPr(task: AskTask, number?: number): PrContext | undefined {
  return pickPr(task.prContexts ?? (task.prContext ? [task.prContext] : []), number);
}

/**
 * The one pull request meant: the one named by number, else the only one the
 * message links, else the only one known. Undefined when that is not one.
 */
export function pickPr(
  known: ReadonlyArray<PrContext & { source?: 'trigger' | 'thread' }>,
  number?: number,
): PrContext | undefined {
  const prs = [...new Map(known.map(pr => [pr.url, pr])).values()];
  const only = (candidates: typeof prs) => (candidates.length === 1 ? strip(candidates[0]) : undefined);
  if (number !== undefined) return only(prs.filter(pr => pr.number === number));
  const inMessage = prs.filter(pr => pr.source === 'trigger');
  return inMessage.length > 0 ? only(inMessage) : only(prs);
}

function strip(pr: PrContext): PrContext {
  return { url: pr.url, owner: pr.owner, repo: pr.repo, number: pr.number };
}

// ---------------------------------------------------------------------------
// After the planner: looser phrasing, every merge/close/revert confirmed.

// The other ways people ask for a sync, read on normalizeControlText's output:
// "bring that PR's branch up to date with master" arrives as "bring that prs
// branch up to date with master", and a link to the pull request as "this pr".
// Each object is the pull request or its branch, so "update the copy" or "get
// the docs up to date" is never a sync.
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
  // "merge master into it", "pull master into this pr".
  new RegExp(`\\b(?:merge|pull) ${BASE_BRANCH} (?:into|in to|to) ${SYNC_OBJECT}\\b`, 'g'),
  new RegExp(`\\bcatch ${SYNC_OBJECT} up with ${BASE_BRANCH}\\b`, 'g'),
  new RegExp(`\\bcatch up with ${BASE_BRANCH}\\b`, 'g'),
];
/** miniOG merges the base in and never rebases a branch with an open PR: a rebase ask is a sync. */
const REBASE_PHRASES = [
  new RegExp(`\\brebase(?: ${SYNC_OBJECT})? (?:on|onto|with|against) ${BASE_BRANCH}\\b`, 'g'),
  new RegExp(`\\brebase ${SYNC_OBJECT}(?=$| please| pls| now| thanks| thank you| and squash)`, 'g'),
  new RegExp(`\\brebase${PHRASE_END}`, 'g'),
];
/**
 * "don't", "won't", "never", "no need to", "cancel": a negation blocks the
 * operation only when it governs the verb, with nothing but small words
 * between ("do not merge it", "no need to close"). "We don't need this
 * anymore, close it" and "it doesn't work, close it" negate something else.
 * Contractions are spelled out because a bare "nt" ending would also catch
 * "comment" and "content". Every merge, close or revert this reads is still
 * confirmed (#719), so this is a net for the obvious cases, not the guard.
 */
const NEGATION_WORD =
  /^(?:(?:do|does|did|wo|ca|should|would|could|is|are|was|were|has|have|had|must|need)nt|dnt|donot|never|not|no|nope|nah|without|hold|wait|stop|avoid|cancel|skip|abort)$/;
/** Words that may stand between a negation and the verb it governs. */
const NEGATION_LINKS = new Set([
  'to',
  'the',
  'it',
  'this',
  'that',
  'pr',
  'please',
  'pls',
  'just',
  'yet',
  'need',
  'needs',
  'you',
  'u',
  'we',
  'i',
  'really',
  'even',
  'ever',
  'be',
  'get',
  'go',
  'ahead',
  'and',
  'dare',
  'gonna',
  'going',
  'want',
  'wanna',
  'do',
  'a',
  'off',
  'on',
]);
/** Hinglish puts the negation after the verb: "merge mat karo", "close na karo", "merge nahi". */
const HINGLISH_NEGATION = /^(?:mat|mt|na|nhi|nai|nahi|nahin)$/;
const HINGLISH_LINKS = new Set(['kar', 'karo', 'karna', 'krna', 'kro', 'do', 'ye', 'isko', 'abhi', 'ko', 'se']);
/** "merge it after QA", "close it if it's stale", "once approved, merge": a condition near the verb is not an order now. */
const CONDITION_WORD =
  /^(?:later|yet|until|till|after|once|if|unless|before|when|whenever|tomorrow|tonight|eod|baad|pehle|kal|ruk|ruko)$/;
/** How far from the verb a negation, condition or reporting subject still governs it. */
const GOVERNING_WINDOW = 3;
/** "close it, it's not needed" negates the PR, not the verb. */
const NOT_NEEDED = /\b(?:(?:it is|its|is|isnt|is not) )?(?:not|no longer) needed(?: anymore)?\b/g;
/** Nouns, not orders: "the merge request looks good", "fix the merge conflict", "thanks for the merge". */
const OPERATION_NOUNS = [
  /\b(?:(?:merge|pull) requests?|merge (?:conflicts?|button|queue|commit))\b/g,
  /\b(?:the|that|this|a) (?:merge|sync|close)\b/g,
  /\b(?:merge|sync|close) (?=(?:looks?|is|was|failed|fails|worked|works|went|button)\b)/g,
];
/** "is it safe to merge", "should I merge it", "what does close do": a question, with or without the mark. */
const QUESTION_START =
  /^(?:is|are|was|were|should|can we|could we|what|why|how|when|where|does|do(?! not\b)|did|has|have|which|who)\b/;
/** "I'll merge it myself", "Shiv said merge it", "someone should merge it": a report, not an order to miniOG. */
const REPORT_SUBJECT =
  /\b(?:i|ill|im|ive|we|well|he|she|they|someone|somebody|let me|said|says|asked|will|should|would|youd|wants|wanted)\b/;
/** "> merge it", "\"merge it\" is what the bot said": quoted words are someone else's. */
const QUOTED = /&gt;|^\s*>|["“”]/;

export interface SyncPhrase {
  /** The text with each sync phrasing replaced by "sync it". */
  text: string;
  sync: boolean;
  /** The person asked for a rebase; the sync merges the base in instead. */
  rebase: boolean;
}

/**
 * Reads "bring it up to date with master", "update the branch", "merge main
 * into it", "catch up with master" and "rebase on master" as a sync. A phrase
 * a negation governs is left as it is: "don't merge master into it" is no sync.
 */
export function readSyncPhrase(text: string): SyncPhrase {
  const normalized = normalizeControlText(prPlaceholders(text));
  // A phrase a negation governs stays as it is: "don't merge master into it" is no sync.
  const unlessNegated = (...args: unknown[]): string => {
    const [phrase, offset, whole] = [
      args[0] as string,
      args[args.length - 2] as number,
      args[args.length - 1] as string,
    ];
    const before = whole.slice(0, offset).trim().split(' ').filter(Boolean);
    return negationGoverns([...before, 'sync'], before.length) ? phrase : 'sync it';
  };
  let rewritten = normalized;
  for (const phrase of SYNC_PHRASES) rewritten = rewritten.replace(phrase, unlessNegated);
  const beforeRebase = rewritten;
  for (const phrase of REBASE_PHRASES) rewritten = rewritten.replace(phrase, unlessNegated);
  const rebase = rewritten !== beforeRebase;
  return { text: rewritten, sync: rewritten !== normalized, rebase };
}

/**
 * The words a quick action reads: links to the PR as "this pr", other links
 * gone, and code, typed branch names and file names left as placeholders, so
 * "merge `main` into it" or "merge release/1.2 into it" still says something
 * stands between "merge" and "into".
 */
export function quickActionWords(text: string): string {
  return stagingPlainText(prPlaceholders(text))
    .replace(/`[^`]*`/g, ' codeword ')
    .replace(/\S*\/\S*/g, ' slashword ')
    .replace(/\S+\.[a-z0-9]{1,6}\b\S*/gi, ' fileword ')
    .toLowerCase();
}

export type QuickOperation =
  | { kind: 'operation'; action: PrActionVerb | 'revert'; rebase: boolean }
  /** The words name no pull-request operation. */
  | { kind: 'none' }
  /** They name one but can't be read safely. */
  | {
      kind: 'unclear';
      reason: 'negation' | 'condition' | 'several' | 'base_branch_merge' | 'other_script' | 'quoted' | 'report';
    }
  /** A question about the pull request, not a request ("did you merge it?"). */
  | { kind: 'question' };

const OPERATION_WORDS = /\b(merge|close|revert|sync)\b/g;
/** Whatever "merge" is followed by, only these are the pull request itself. */
const MERGE_OF_THE_PR =
  /^merge(?: (?:it|this|this pr|the pr|that pr|this pull request|the pull request))?(?: (?:into|to) (?:master|main))?(?: (?:please|pls|now|thanks|thank you))*$/;
/** A branch or source other than the pull request: "merge master", "master merge kar do", "merge `main`". */
const BASE_WORDS =
  /\b(?:master|main|develop|dev|staging|upstream|release|origin|latest|base|target|default|codeword|slashword)\b/;
/** Something other than the pull request stands next to "merge": another branch, code, a source. */
const MERGE_SOURCE = new RegExp(
  `${BASE_WORDS.source}|\\bmerge (?:(?:it|this|this pr|the pr) )?(?:in|from)\\b|\\bchanges from\\b`,
);
const OPERATION_WORD = /\b(?:merge|close|revert|sync)\b/;
/** "can you merge it?": a question put to miniOG is a request. */
const REQUEST_QUESTION = /\b(?:can|could|would|will) (?:you|u)\b/;
const QUESTION_MARK = /[?？؟¿]/;

/**
 * The pull-request operation a quick action may run, read from
 * `quickActionWords`. Only one plainly named operation is picked: anything that
 * could mean something else is "unclear", and the caller asks instead of
 * guessing. The caller still confirms every merge, close or revert (#719).
 */
export function readQuickOperation(words: string): QuickOperation {
  if (/[^\P{L}a-zA-Z]/u.test(words)) {
    return ANY_OPERATION_WORD.test(words) ? { kind: 'unclear', reason: 'other_script' } : { kind: 'none' };
  }
  // Struck-through words were taken back.
  const kept = words.replace(/~[^~]+~/g, ' ');
  if (QUOTED.test(kept) && ANY_OPERATION_WORD.test(kept)) return { kind: 'unclear', reason: 'quoted' };
  let cleaned = normalizeControlText(kept).replace(NOT_NEEDED, ' ');
  for (const noun of OPERATION_NOUNS) cleaned = cleaned.replace(noun, ' ').replace(/\s+/g, ' ').trim();
  const sync = readSyncPhrase(cleaned);
  const plain = sync.text;
  const named = new Set([...plain.matchAll(OPERATION_WORDS)].map(match => match[1] as PrActionVerb | 'revert'));
  // "sync up with me" is a meeting; "sync the copy with the doc" is about the page.
  if (
    !sync.sync &&
    /\bsync (?:up\b|(?!(?:it|this|that|the pr|this pr|that pr|the branch|this branch|its branch|branch|with|to|please|pls|now|thanks)\b)\w)/.test(
      plain,
    )
  ) {
    named.delete('sync');
  }
  if (named.size === 0) return { kind: 'none' };
  if ((QUESTION_MARK.test(kept) || QUESTION_START.test(plain)) && !REQUEST_QUESTION.test(plain)) {
    return { kind: 'question' };
  }
  const tokens = plain.split(' ');
  const verbIndex = tokens.findIndex(token => OPERATION_WORD.test(token));
  if (negationGoverns(tokens, verbIndex)) return { kind: 'unclear', reason: 'negation' };
  if (conditionGoverns(tokens, verbIndex)) return { kind: 'unclear', reason: 'condition' };
  if (named.size > 1) return { kind: 'unclear', reason: 'several' };
  const verbAt = plain.search(OPERATION_WORD);
  const leadIn = tokens.slice(Math.max(0, verbIndex - GOVERNING_WINDOW), verbIndex).join(' ');
  if (REPORT_SUBJECT.test(leadIn.replace(REQUEST_QUESTION, ' '))) return { kind: 'unclear', reason: 'report' };
  if (named.has('merge')) {
    const fromMerge = plain.slice(plain.search(/\bmerge\b/)).trim();
    const ofThePr = MERGE_OF_THE_PR.test(fromMerge) && !BASE_WORDS.test(plain.slice(0, verbAt));
    if (!ofThePr && MERGE_SOURCE.test(plain)) return { kind: 'unclear', reason: 'base_branch_merge' };
    // "merge <something> into it", "merge into it": it goes into the PR, not the PR into its base.
    const into =
      /\bmerge (?:(.+?) )?(?:into|in to|to) (?:it|this|this pr|the pr|that pr|the branch|this branch)\b/.exec(
        fromMerge,
      );
    if (into && !/^(?:it|this|this pr|the pr|that pr)$/.test(into[1] ?? '')) {
      return { kind: 'unclear', reason: 'base_branch_merge' };
    }
  }
  return { kind: 'operation', action: [...named][0], rebase: sync.rebase };
}

/** A negation right before the verb with only small words between, or Hinglish's right after it. */
function negationGoverns(tokens: string[], verbIndex: number): boolean {
  for (let i = verbIndex - 1; i >= Math.max(0, verbIndex - GOVERNING_WINDOW - 1); i--) {
    if (NEGATION_WORD.test(tokens[i])) return true;
    if (!NEGATION_LINKS.has(tokens[i])) break;
  }
  for (let i = verbIndex + 1; i <= Math.min(tokens.length - 1, verbIndex + GOVERNING_WINDOW); i++) {
    if (HINGLISH_NEGATION.test(tokens[i])) return true;
    if (!HINGLISH_LINKS.has(tokens[i])) break;
  }
  return false;
}

/** A condition within a few words of the verb, on either side. */
function conditionGoverns(tokens: string[], verbIndex: number): boolean {
  const near = tokens.slice(Math.max(0, verbIndex - GOVERNING_WINDOW), verbIndex + GOVERNING_WINDOW + 1);
  return near.some(token => CONDITION_WORD.test(token));
}

/** Words that name a pull-request operation in any form: the agent never runs one that wasn't confirmed. */
export const ANY_OPERATION_WORD = /\b(?:merg|clos|revert|sync|squash|rebas)\w*/i;
