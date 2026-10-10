/** Active jobs tracked for cancellation support. Maps jobId → AbortController. */
const activeJobs = new Map<string, AbortController>();

export function registerActiveJob(jobId: string, controller: AbortController): void {
  activeJobs.set(jobId, controller);
}

export function unregisterActiveJob(jobId: string): void {
  activeJobs.delete(jobId);
}

/** Who cancelled a job. Decides what, if anything, the thread is told. */
export type CancelSource = 'ui' | 'source_deleted';

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
