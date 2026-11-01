import type { MiniogJob, PersonalItemState } from '../state/personalStore.js';

/** Runs that decided there was nothing to do say nothing about whether an ask was handled. */
const NOT_HANDLING_WORKFLOWS = new Set(['NONE', 'UNKNOWN']);

export interface StandDownResult {
  state: PersonalItemState;
  jobId?: string;
  doneSummary?: string;
}

function slackTsToMs(ts: string | undefined): number | undefined {
  const seconds = ts ? Number(ts) : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * miniOG keeps the live requests, so the nightly run only works on what it
 * didn't finish. A run in the ask's thread, started after the ask, decides:
 * succeeded means handled, still going means waiting on miniOG, and anything
 * else (failed, cancelled, skipped) leaves the ask open, because that's a
 * missed ask. An item already done stays done.
 */
export function standDownForMiniog(
  item: { state: PersonalItemState; channelId?: string; threadTs?: string; messageTs?: string },
  jobs: MiniogJob[],
): StandDownResult {
  const unchanged: StandDownResult = { state: item.state };
  if (item.state === 'done' || !item.channelId || !item.threadTs) return unchanged;
  const askedMs = slackTsToMs(item.messageTs ?? item.threadTs) ?? 0;
  const inThread = jobs.filter(
    job =>
      job.channelId === item.channelId &&
      job.threadTs === item.threadTs &&
      !NOT_HANDLING_WORKFLOWS.has(job.workflow) &&
      Date.parse(job.createdAt) >= askedMs,
  );
  const running = inThread.find(job => job.status === 'RUNNING' || job.status === 'PAUSED');
  if (running) return { state: 'waiting', jobId: running.id };
  const succeeded = [...inThread].reverse().find(job => job.status === 'SUCCESS');
  if (succeeded) return { state: 'done', jobId: succeeded.id, doneSummary: 'miniOG handled this.' };
  return unchanged;
}
