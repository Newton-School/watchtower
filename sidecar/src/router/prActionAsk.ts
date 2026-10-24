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
 * the planner's to read, so every other word has to come from a short list.
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
  'can',
  'could',
  'would',
  'will',
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
  'for',
  'me',
  'us',
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
  // "squash and merge", "merge it into main", "sync it with master", "sync the branch up".
  'squash',
  'into',
  'with',
  'branch',
  'main',
  'master',
  'base',
  'latest',
  'up',
]);

export type PrActionAsk = { action: PrActionVerb; pr: PrContext };

/**
 * The operation and its pull request when the message is only that, else
 * undefined. The pull request is the one named by number, else the one
 * linked in the message, else the thread's only one; two candidates and no
 * way to tell them apart leave it to the planner.
 */
export function readPrActionAsk(
  task: Pick<NormalizedTask, 'event' | 'prContext' | 'prContexts'>,
): PrActionAsk | undefined {
  // Links and channel references are not words of the ask; mentions and the
  // "Sent using" footer go in normalizeControlText.
  const text = task.event.text.replace(/<(?!@)[^>]*>/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const actions = new Set<PrActionVerb>();
  const numbers = new Set<number>();
  for (const word of normalizeControlText(text).split(' ').filter(Boolean)) {
    const action = ACTIONS.get(word);
    if (action) actions.add(action);
    else if (/^\d+$/.test(word)) numbers.add(Number(word));
    else if (!FILLER.has(word)) return undefined;
  }
  if (actions.size !== 1 || numbers.size > 1) return undefined;
  const pr = targetPr(task, numbers.size === 1 ? [...numbers][0] : undefined);
  return pr ? { action: [...actions][0], pr } : undefined;
}

function targetPr(task: Pick<NormalizedTask, 'prContext' | 'prContexts'>, number?: number): PrContext | undefined {
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
