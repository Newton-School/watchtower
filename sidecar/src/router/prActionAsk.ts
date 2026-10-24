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
  const words = normalizeControlText(text).split(' ').filter(Boolean);
  // "merge?", "can it merge?": a question, unless it is put to miniOG ("can you merge it?").
  if (/[?？]/.test(text) && !words.some(word => ADDRESSEE.has(word))) return undefined;

  const actions = new Set<PrActionVerb>();
  const numbers = new Set<number>();
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
      i = words[next + 1] === 'branch' ? next + 1 : next;
    } else if (word === 'for') {
      if (!BENEFICIARIES.has(words[i + 1] ?? '')) return undefined;
      i++;
    } else if (!FILLER.has(word)) {
      return undefined;
    }
  }
  if (actions.size !== 1 || numbers.size > 1) return undefined;
  const pr = targetPr(task, numbers.size === 1 ? [...numbers][0] : undefined);
  return pr ? { action: [...actions][0], pr } : undefined;
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
    .replace(/<([^>]*)>/g, (_token, inner: string) => {
      const target = inner.split('|')[0];
      const mention = /^@([A-Z0-9]+)$/i.exec(target);
      if (mention ? !allowedMentions.has(mention[1]) : !isLinkedPr(target)) allowed = false;
      return ' ';
    })
    .replace(/https?:\/\/\S+/gi, url => {
      // A full stop or comma after a pasted link is the sentence's, not the link's.
      if (!isLinkedPr(url.replace(/[.,!?;:)]+$/, ''))) allowed = false;
      return ' ';
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
