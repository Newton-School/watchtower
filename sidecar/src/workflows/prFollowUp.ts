import type { WebClient } from '@slack/web-api';
import { fetchPrFollowUpState, type Fetcher, type PrFollowUpState } from '../github/prFollowUp.js';
import { logger } from '../logging/logger.js';

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
  requestedBy?: string;
  prUrl: string;
  createdAt: string;
}

/** How far back the job store is read for PRs to follow up. */
export const FOLLOW_UP_WINDOW_DAYS = 21;

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const match = PR_URL_RE.exec(url.trim());
  if (!match) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function daysBetween(fromIso: string, now: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  // Rounded: a PR opened yesterday evening has waited "since yesterday", not "since today".
  return Math.max(0, Math.round((now - from) / 86_400_000));
}

function ageText(days: number): string {
  if (days <= 0) return 'since today';
  if (days === 1) return 'since yesterday';
  return `for ${days} days`;
}

/**
 * The one line for the thread. Who it waits on comes from GitHub: a requested
 * reviewer, a reviewer who asked for changes, or, with an approval and a clean
 * merge, an admin to merge it.
 */
export function buildFollowUpLine(params: {
  prUrl: string;
  state: PrFollowUpState;
  now: number;
  mergeMention: string;
}): string | undefined {
  const { prUrl, state, now, mergeMention } = params;
  if (state.state !== 'open') return undefined;
  const number = parsePrUrl(prUrl)?.number;
  const name = number ? `PR #${number}` : 'The PR';
  const age = state.createdAt ? ageText(daysBetween(state.createdAt, now)) : '';
  const parts: string[] = [`${name} is still open${age ? ` ${age}` : ''}: ${prUrl}`];

  const changesRequested = state.reviews.filter(review => review.state === 'CHANGES_REQUESTED');
  const approved = state.reviews.filter(review => review.state === 'APPROVED');
  const conflicts = state.mergeableState === 'dirty';
  const behind = state.mergeableState === 'behind';

  if (changesRequested.length > 0) {
    parts.push(`Changes were requested by ${changesRequested.map(review => review.login).join(', ')}.`);
  } else if (approved.length > 0) {
    parts.push(`Approved by ${approved.map(review => review.login).join(', ')}.`);
  } else if (state.requestedReviewers.length > 0) {
    parts.push(`Waiting on a review from ${state.requestedReviewers.join(', ')}.`);
  } else {
    parts.push('No review yet.');
  }

  if (conflicts) {
    parts.push(
      `It conflicts with ${state.baseRef ?? 'the base branch'}; reply \`sync it\` and I'll merge ${state.baseRef ?? 'the base branch'} into it.`,
    );
  } else if (behind) {
    parts.push(`It is behind ${state.baseRef ?? 'the base branch'}; reply \`sync it\` and I'll bring it up to date.`);
  } else if (approved.length > 0 && changesRequested.length === 0) {
    parts.push(`${mergeMention} it is ready to merge: reply \`merge it\` when you want it in.`);
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
 * closed is marked done so it is never read again.
 */
export async function runPrFollowUp(params: {
  store: FollowUpStore;
  slack: Pick<WebClient, 'chat'>;
  githubToken?: string;
  mergeMention: string;
  now?: number;
  dateKey: string;
  fetcher?: Fetcher;
}): Promise<{ posted: number; closed: number; skipped: number }> {
  const { store, slack, githubToken, mergeMention, fetcher, dateKey } = params;
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
    const state = await fetchPrFollowUpState({ ...target, githubToken, fetcher });
    if (!state) {
      skipped += 1;
      continue;
    }
    if (state.state !== 'open') {
      store.setState(key, 'done');
      closed += 1;
      continue;
    }
    const line = buildFollowUpLine({ prUrl: tracked.prUrl, state, now, mergeMention });
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
