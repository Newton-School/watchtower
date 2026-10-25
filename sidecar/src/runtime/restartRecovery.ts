import type { SlackEventEnvelope } from '../types/contracts.js';
import { buildRestartNotice, DEPLOY_TAP_PHRASE, humanGateForStage, type HumanGate } from './restartNotice.js';

/**
 * What happens to a job that was running when the sidecar went away
 * (issue #589).
 *
 * Only jobs waiting on a person used to be told. A PR review lost mid-run said
 * nothing, and its author told the admins they were still waiting for it. Now
 * every lost job's thread is told, and a PR review is run again: a second
 * review of the same PR is a follow-up, so running it twice is safe.
 */

export interface LostJob {
  id: string;
  channelId: string;
  threadTs: string;
  requestedBy?: string;
  lastStage?: string;
  workflow?: string;
  eventId?: string;
  text?: string;
  eventTs?: string;
  /** The gate the job was waiting at, from its open wait. */
  openWait?: { kind: string; promptTs: string; expects?: string };
}

/** The event id of a job re-run after a restart. A re-run is never re-run again. */
export const RESTART_EVENT_PREFIX = 'restart:';

export interface Recovery {
  /** What to post in the job's thread. */
  notice: string;
  /** The request to run again, for a PR review that has not been retried yet. */
  requeue?: SlackEventEnvelope;
  kind: 'waiting' | 'review_rerun' | 'lost';
  /** A deploy offer whose message should stop looking open (issue #703). */
  closeDeployOffer?: { promptTs: string };
}

/**
 * The gate a job was waiting at. Its open wait says so whatever it logged
 * last: the deploy offer goes on logging (staging going back to main) while
 * it waits (issue #703).
 */
function gateOf(job: LostJob): HumanGate | undefined {
  if (job.openWait?.kind === 'confirm' && job.openWait.expects === DEPLOY_TAP_PHRASE) return 'deploy_offer';
  return humanGateForStage(job.lastStage);
}

export function recoveryFor(job: LostJob): Recovery {
  const gate = gateOf(job);
  if (gate === 'deploy_offer') {
    return {
      kind: 'waiting',
      notice: buildRestartNotice({ gate }),
      ...(job.openWait ? { closeDeployOffer: { promptTs: job.openWait.promptTs } } : {}),
    };
  }
  if (gate) {
    return { kind: 'waiting', notice: buildRestartNotice({ gate, requestedBy: job.requestedBy }) };
  }
  const isReview = job.workflow === 'PR_REVIEW';
  const retriedAlready = job.eventId?.startsWith(RESTART_EVENT_PREFIX) ?? false;
  if (isReview && !retriedAlready && job.text && job.eventTs && job.requestedBy) {
    return {
      kind: 'review_rerun',
      notice: 'I was restarted in the middle of this review, so I am running it again.',
      requeue: {
        eventId: `${RESTART_EVENT_PREFIX}${job.id}`,
        channelId: job.channelId,
        threadTs: job.threadTs,
        eventTs: job.eventTs,
        userId: job.requestedBy,
        text: job.text,
        ingestSource: 'catchup',
        rawEvent: {
          type: 'message',
          channel: job.channelId,
          user: job.requestedBy,
          text: job.text,
          ts: job.eventTs,
          thread_ts: job.threadTs,
        },
      },
    };
  }
  const who = job.requestedBy ? `<@${job.requestedBy}>, ` : '';
  return {
    kind: 'lost',
    notice: isReview
      ? `I was restarted in the middle of this review again, so I've stopped. ${who}mention me to run it once more.`
      : `I was restarted while working on this, so the run was lost. ${who}mention me again to retry; anything already pushed is still on its branch.`,
  };
}
