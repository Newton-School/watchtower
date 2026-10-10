/** Active jobs tracked for cancellation support. Maps jobId → AbortController. */
const activeJobs = new Map<string, AbortController>();

/**
 * The Slack thread each in-flight job owns, held from register to unregister.
 * A cancel does not release it: the job still owns the thread (and its
 * worktree) until its finalizer has cleaned up.
 */
const jobThreads = new Map<string, { key: string; requestedBy?: string }>();

const threadKey = (channelId: string, threadTs: string): string => `${channelId}:${threadTs}`;

export function registerActiveJob(
  jobId: string,
  controller: AbortController,
  thread?: { channelId: string; threadTs: string; requestedBy?: string },
): void {
  activeJobs.set(jobId, controller);
  if (thread) {
    jobThreads.set(jobId, {
      key: threadKey(thread.channelId, thread.threadTs),
      requestedBy: thread.requestedBy,
    });
  }
}

export function unregisterActiveJob(jobId: string): void {
  activeJobs.delete(jobId);
  jobThreads.delete(jobId);
}

/**
 * The in-flight job that owns a Slack thread, if any (issue #261).
 *
 * This is the same-thread lock. It used to be a query for a RUNNING row
 * updated in the last 45 minutes, and jobs.updated_at is only written on a
 * status change, so the lock lapsed under any long job and a second mention
 * started a duplicate in the same workspace. (The comparison was also between
 * an ISO timestamp and SQLite's `datetime()` text, so "45 minutes" really
 * meant "since UTC midnight".) Only this process runs jobs, so what it has
 * registered is the truth; a RUNNING row it does not know is an orphan that
 * startup cleanup handles.
 */
export function activeJobIdForThread(channelId: string, threadTs: string): string | undefined {
  return activeJobForThread(channelId, threadTs)?.jobId;
}

/** The in-flight job that owns a thread, with who asked for it (they may stop it — issue #435). */
export function activeJobForThread(
  channelId: string,
  threadTs: string,
): { jobId: string; requestedBy?: string } | undefined {
  const key = threadKey(channelId, threadTs);
  for (const [jobId, owned] of jobThreads) {
    if (owned.key === key) return { jobId, requestedBy: owned.requestedBy };
  }
  return undefined;
}

/** Who cancelled a job. Decides what, if anything, the thread is told. */
export type CancelSource = 'ui' | 'source_deleted' | 'slack_stop';

export interface CancelReason {
  source: CancelSource;
  /** Stored on the job row as the reason. */
  message: string;
}

/** Why a job was aborted, kept until its finalizer reads it (issue #438). */
const cancelReasons = new Map<string, CancelReason>();

export function cancelJob(jobId: string, reason?: CancelReason): boolean {
  const abort = (key: string, controller: AbortController): true => {
    // Recorded before the abort: abort listeners run synchronously.
    if (reason) cancelReasons.set(key, reason);
    controller.abort();
    activeJobs.delete(key);
    return true;
  };
  // Exact match first
  const exactMatch = activeJobs.get(jobId);
  if (exactMatch) return abort(jobId, exactMatch);
  // Try prefix match (same pattern as resolveJobId in jobStore)
  for (const [key, controller] of activeJobs) {
    if (key.startsWith(jobId)) return abort(key, controller);
  }
  return false;
}

/** Reads and clears the reason a job was cancelled. */
export function takeCancelReason(jobId: string): CancelReason | undefined {
  const reason = cancelReasons.get(jobId);
  cancelReasons.delete(jobId);
  return reason;
}

export function getActiveJobIds(): string[] {
  return Array.from(activeJobs.keys());
}
