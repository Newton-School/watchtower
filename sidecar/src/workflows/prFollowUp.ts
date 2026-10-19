import type { WebClient } from '@slack/web-api';
import { fetchPrFollowUpState, type Fetcher, type PrFollowUpState } from '../github/prFollowUp.js';
import { logger } from '../logging/logger.js';
import { extractPrContext } from '../router/intentParser.js';
import type { PrContext } from '../types/contracts.js';

/**
 * Once a day, each PR miniOG opened and nobody has closed gets one line in the
 * thread it came from (issue #603): its age, its review state, whether it
 * conflicts, and who it waits on. Four of the seven PRs opened in the week of
 * 14 Oct 2026 were still open days later with silent threads, two of them
 * conflicting.
 */

/** A change run's PR, as the job store recorded it. */
export interface TrackedPr {
  jobId: string;
  channelId: string;
  threadTs: string;
  prUrl: string;
  createdAt: string;
}

/** How far back the job store is read for PRs to follow up. */
export const FOLLOW_UP_WINDOW_DAYS = 21;

/** The same PR-URL grammar the router reads. */
export function parsePrUrl(url: string): PrContext | undefined {
  return extractPrContext([url.trim()]);
}

/** Whole calendar days between two instants, in the host's time zone. */
function calendarDaysBetween(fromIso: string, now: number): number {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return 0;
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.max(0, Math.round((start(new Date(now)) - start(from)) / 86_400_000));
}

function ageText(days: number): string {
  if (days <= 0) return 'since today';
  if (days === 1) return 'since yesterday';
  return `for ${days} days`;
}

/**
 * The one line for the thread. Who it waits on comes from GitHub: a requested
 * reviewer or team, a reviewer who asked for changes, or, with an approval and
 * a clean merge, an admin to merge it. The replies it offers carry miniOG's
 * mention: a bare reply in a thread whose job has ended is not read.
 */
export function buildFollowUpLine(params: {
  prUrl: string;
  state: PrFollowUpState;
  now: number;
  mergeMention: string;
  /** miniOG's own mention, e.g. `<@U0AG8P9B3FW>`. */
  botMention: string;
}): string | undefined {
  const { prUrl, state, now, mergeMention, botMention } = params;
  if (state.state !== 'open') return undefined;
  const number = parsePrUrl(prUrl)?.number;
  const name = number ? `PR #${number}` : 'The PR';
  const age = state.createdAt ? ageText(calendarDaysBetween(state.createdAt, now)) : '';
  const parts: string[] = [`${name} is still open${age ? ` ${age}` : ''}: ${prUrl}`];

  const changesRequested = state.reviews.filter(review => review.state === 'CHANGES_REQUESTED');
  const approved = state.reviews.filter(review => review.state === 'APPROVED');
  const base = state.baseRef ?? 'the base branch';

  if (state.draft) {
    parts.push('It is still a draft.');
  } else if (changesRequested.length > 0) {
    parts.push(`Changes were requested by ${changesRequested.map(review => review.login).join(', ')}.`);
  } else if (approved.length > 0) {
    parts.push(`Approved by ${approved.map(review => review.login).join(', ')}.`);
  } else if (state.requestedReviewers.length > 0) {
    parts.push(`Waiting on a review from ${state.requestedReviewers.join(', ')}.`);
  } else {
    parts.push('No review yet.');
  }

  if (state.mergeableState === 'dirty') {
    parts.push(`It conflicts with ${base}; reply \`${botMention} sync it\` and I'll merge ${base} into it.`);
  } else if (state.mergeableState === 'behind') {
    parts.push(`It is behind ${base}; reply \`${botMention} sync it\` and I'll bring it up to date.`);
  } else if (!state.draft && approved.length > 0 && changesRequested.length === 0 && state.mergeableState === 'clean') {
    parts.push(`${mergeMention} it is ready to merge: reply \`${botMention} merge it\` when you want it in.`);
  }
  return parts.join(' ');
}

export interface FollowUpStore {
  listChangeRunPrs(sinceIso: string): TrackedPr[];
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

export function followUpStateKey(prUrl: string): string {
  return `pr_followup:${prUrl}`;
}

/**
 * One pass: every tracked PR not yet looked at today. A PR that is merged or
 * closed is marked done so it is never read again; one GitHub could not
 * describe is logged and left for the next day.
 */
export async function runPrFollowUp(params: {
  store: FollowUpStore;
  slack: Pick<WebClient, 'chat'>;
  githubToken?: string;
  mergeMention: string;
  botMention: string;
  now?: number;
  dateKey: string;
  fetcher?: Fetcher;
}): Promise<{ posted: number; closed: number; skipped: number }> {
  const { store, slack, githubToken, mergeMention, botMention, fetcher, dateKey } = params;
  const now = params.now ?? Date.now();
  const since = new Date(now - FOLLOW_UP_WINDOW_DAYS * 86_400_000).toISOString();
  const seen = new Set<string>();
  let posted = 0;
  let closed = 0;
  let skipped = 0;
  for (const tracked of store.listChangeRunPrs(since)) {
    if (seen.has(tracked.prUrl)) continue;
    seen.add(tracked.prUrl);
    const key = followUpStateKey(tracked.prUrl);
    const last = store.getState(key);
    if (last === 'done' || last === dateKey) {
      skipped += 1;
      continue;
    }
    const target = parsePrUrl(tracked.prUrl);
    if (!target) {
      store.setState(key, 'done');
      continue;
    }
    const state = await fetchPrFollowUpState({
      ...target,
      githubToken,
      fetcher,
      logStep: step => logger.warn({ prUrl: tracked.prUrl, ...step.data }, step.message),
    });
    if (!state) {
      skipped += 1;
      continue;
    }
    if (state.state !== 'open') {
      store.setState(key, 'done');
      closed += 1;
      continue;
    }
    const line = buildFollowUpLine({ prUrl: tracked.prUrl, state, now, mergeMention, botMention });
    if (!line) continue;
    try {
      await slack.chat.postMessage({ channel: tracked.channelId, thread_ts: tracked.threadTs, text: line });
      store.setState(key, dateKey);
      posted += 1;
    } catch (error) {
      logger.warn({ prUrl: tracked.prUrl, err: String(error) }, 'pr follow-up: could not post');
    }
  }
  return { posted, closed, skipped };
}
