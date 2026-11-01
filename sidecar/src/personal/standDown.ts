import type { MiniogJob, PersonalItemState } from '../state/personalStore.js';

/** Finished runs that decided there was nothing to do say nothing about whether an ask was handled. */
const NOT_HANDLING_WORKFLOWS = new Set(['NONE', 'UNKNOWN']);

export interface StandDownResult {
  state: PersonalItemState;
  jobId?: string;
  doneSummary?: string;
}

/**
 * miniOG keeps the live requests, so the nightly run only works on what it
 * didn't finish. Only the run the ask's own message started decides: another
 * run in the same thread may be someone else asking about something else, and
 * then the triage agent's reading of the thread stands. Succeeded means handled,
 * still going means waiting on miniOG, and anything else (failed, cancelled,
 * skipped) leaves the ask open, because that's a missed ask. An item already
 * done stays done.
 */
export function standDownForMiniog(
  item: { state: PersonalItemState; channelId?: string; threadTs?: string; messageTs?: string },
  jobs: MiniogJob[],
): StandDownResult {
  const unchanged: StandDownResult = { state: item.state };
  const askTs = item.messageTs || item.threadTs;
  if (item.state === 'done' || !item.channelId || !askTs) return unchanged;
  const started = jobs.filter(job => job.channelId === item.channelId && job.eventTs === askTs);
  const running = started.find(job => job.status === 'RUNNING' || job.status === 'PAUSED');
  if (running) return { state: 'waiting', jobId: running.id };
  const succeeded = [...started]
    .reverse()
    .find(job => job.status === 'SUCCESS' && !NOT_HANDLING_WORKFLOWS.has(job.workflow));
  if (succeeded) return { state: 'done', jobId: succeeded.id, doneSummary: 'miniOG handled this.' };
  return unchanged;
}
