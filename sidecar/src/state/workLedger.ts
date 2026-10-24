import { getActiveJobIds } from './activeJobs.js';

/**
 * What each in-flight run is working on, so a new request can be checked
 * against them (issue #602): the same ask sent twice, and two change runs
 * editing the same file.
 *
 * In memory, like the active-jobs registry it leans on: only this process
 * runs jobs, and an entry whose job is no longer active is dropped. A run
 * that succeeded with an open PR stays for a short while after it ends, so
 * "the same ask again, a few minutes after the PR" points at that PR.
 */

export type AskKind = 'change' | 'lookup';

export interface WorkEntry {
  jobId: string;
  /** Who the run is for (`requesterOf`), not who typed the trigger. */
  requesterId: string;
  channelId: string;
  /** Slack's channel type: `im` and `mpim` are DMs. */
  channelType?: string;
  threadTs: string;
  kind: AskKind;
  /** The request as asked, mentions removed (a reply to a question carries the question's message too). */
  text: string;
  startedAtMs: number;
  /** A change run's approved plan: the repo and the files it will edit. */
  plan?: { repo: string; files: string[]; notedAtMs: number };
  /** Set when the run succeeded and left an open PR. */
  prUrl?: string;
  endedAtMs?: number;
}

/** How long a finished run that opened a PR is still matched against new asks. */
export const FINISHED_WITH_PR_TTL_MS = 15 * 60_000;

const entries = new Map<string, WorkEntry>();

export function noteAsk(entry: Omit<WorkEntry, 'plan' | 'prUrl' | 'endedAtMs'>): void {
  const existing = entries.get(entry.jobId);
  // A retry of the same job keeps the plan it already noted.
  entries.set(entry.jobId, { ...entry, ...(existing?.plan ? { plan: existing.plan } : {}) });
}

/**
 * Called once a change run's plan is approved, right before it starts editing.
 * Returns the run's place in line (when its plan was first noted), or
 * undefined for a run the router never noted.
 */
export function notePlannedFiles(jobId: string, repo: string, files: string[], nowMs = Date.now()): number | undefined {
  const entry = entries.get(jobId);
  if (!entry) return undefined;
  // The first note fixes the run's place in line; a second (a retry) keeps it.
  entry.plan = { repo, files, notedAtMs: entry.plan?.notedAtMs ?? nowMs };
  return entry.plan.notedAtMs;
}

/**
 * Called when a job ends. A run that succeeded and left an open PR is kept
 * for a while; anything else (a failed run's leftover PR included) is dropped.
 */
export function finishWork(
  jobId: string,
  outcome: { status: string; prUrl?: string; prState?: string },
  nowMs = Date.now(),
): void {
  const entry = entries.get(jobId);
  if (!entry) return;
  if (outcome.status === 'SUCCESS' && outcome.prUrl && (outcome.prState ?? 'OPEN') === 'OPEN') {
    entry.prUrl = outcome.prUrl;
    entry.endedAtMs = nowMs;
    // The PR's files are on GitHub now.
    delete entry.plan;
  } else {
    entries.delete(jobId);
  }
}

/** Drops a run that no longer counts, e.g. one whose PR was merged or closed since. */
export function forgetWork(jobId: string): void {
  entries.delete(jobId);
}

/** The runs a new request is checked against: in flight, or ended with a PR in the last 15 minutes. */
export function currentWork(nowMs = Date.now()): WorkEntry[] {
  const active = new Set(getActiveJobIds());
  const live: WorkEntry[] = [];
  for (const [jobId, entry] of entries) {
    const finishedRecently = entry.endedAtMs !== undefined && nowMs - entry.endedAtMs <= FINISHED_WITH_PR_TTL_MS;
    if (finishedRecently || (entry.endedAtMs === undefined && active.has(jobId))) {
      live.push(entry);
    } else {
      // Ended, cancelled or paused without a PR, or too long ago.
      entries.delete(jobId);
    }
  }
  return live;
}

export function resetWorkLedgerForTests(): void {
  entries.clear();
}
