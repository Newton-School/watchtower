import { logger } from '../logging/logger.js';
import { recordButtonReply } from '../slack/buttonReplies.js';
import type { JobStore } from '../state/jobStore.js';
import type { LaunchpadRequestRecord } from '../types/contracts.js';
import { startLaunchpadRequest, takeBackPostedAsk, type LaunchpadIntake } from './launchpadIntake.js';

const APP_ANSWER_POLL_INTERVAL_MS = 2_000;
/** A run that has just paused is still putting up its :zzz:; picking it up waits for that. */
const PAUSE_SETTLE_MS = 5_000;

/** Where an answer from the app goes, given the run it answers as that run is now. */
export type AppAnswerRoute =
  | { kind: 'gate'; jobId: string; channelId: string; promptTs: string }
  | { kind: 'resume' }
  | { kind: 'later' }
  | { kind: 'drop'; reason: string };

/**
 * A gate waiting mid-run gets the answer, but only the question it was
 * written for. A run paused on its question is picked up again by a run
 * started from the answer, as a reply in the thread does; an answer written
 * for a question mid-run never picks up the run if it paused meanwhile.
 */
export function routeAppAnswer(
  store: Pick<JobStore, 'getJobSummary' | 'humanWaitFor'>,
  request: Pick<LaunchpadRequestRecord, 'answerForJobId' | 'answerPromptTs'>,
  nowMs = Date.now(),
): AppAnswerRoute {
  const jobId = request.answerForJobId;
  const job = jobId ? store.getJobSummary(jobId) : undefined;
  if (!jobId || !job) return { kind: 'drop', reason: 'That run is gone.' };
  if (job.status === 'PAUSED') {
    if (request.answerPromptTs) {
      return { kind: 'drop', reason: 'miniOG paused before your answer reached it. Answer again to pick it back up.' };
    }
    const pausedAt = Date.parse(job.updatedAt ?? '');
    return Number.isFinite(pausedAt) && nowMs - pausedAt < PAUSE_SETTLE_MS ? { kind: 'later' } : { kind: 'resume' };
  }
  if (job.status !== 'RUNNING') return { kind: 'drop', reason: 'The run ended before your answer reached it.' };
  const wait = store.humanWaitFor(jobId);
  if (!wait) return { kind: 'drop', reason: "miniOG isn't waiting for an answer anymore." };
  if (wait.promptTs !== request.answerPromptTs) {
    return { kind: 'drop', reason: 'miniOG asked something new before your answer reached it.' };
  }
  return { kind: 'gate', jobId, channelId: wait.channelId, promptTs: wait.promptTs };
}

/**
 * Answers from the app's thread view to a run waiting on a person. Each is
 * taken once: the gate's own rules decide what the owner's answer does, the
 * same as their reply in the thread. An answer that reaches nothing is closed
 * with the reason, and its posted copy taken back.
 */
export async function runAppAnswerPoller(params: LaunchpadIntake): Promise<void> {
  const { webClient, store } = params;
  for (const request of store.pendingLaunchpadAnswers()) {
    try {
      const route = routeAppAnswer(store, request);
      if (route.kind === 'gate') {
        if (!store.markLaunchpadAnswerDelivered(request.id, route.jobId)) continue;
        recordButtonReply({
          channelId: route.channelId,
          messageTs: route.promptTs,
          userId: request.ownerUserId,
          value: request.prompt,
          actionTs: replyTsAfter(route.promptTs),
        });
        store.appendJobLog({
          jobId: route.jobId,
          stage: 'watchtower.answer.received',
          message: `<@${request.ownerUserId}> answered from Watchtower: "${request.prompt}"`,
          data: { requestId: request.id, promptTs: route.promptTs },
        });
        logger.info({ requestId: request.id, jobId: route.jobId }, 'answer from the app handed to its gate');
      } else if (route.kind === 'later') {
        continue;
      } else if (route.kind === 'resume') {
        if (!store.claimLaunchpadRequest(request.id)) continue;
        await startLaunchpadRequest(params, { ...request, status: 'CLAIMED' });
      } else {
        if (!store.claimLaunchpadRequest(request.id)) continue;
        const takenBack = await takeBackPostedAsk(webClient, request);
        store.markLaunchpadRequestFinished({
          id: request.id,
          status: 'FAILED',
          errorMessage: takenBack ? `${route.reason} The posted answer was taken back.` : route.reason,
        });
        logger.info({ requestId: request.id, reason: route.reason }, 'answer from the app reached nothing');
      }
    } catch (error) {
      logger.error({ requestId: request.id, error: String(error) }, 'answer from the app failed');
    }
  }
}

/**
 * When the answer counts as written: now, on Slack's clock, but never at or
 * before the question, which a gate would skip as an earlier reply even when
 * this Mac's clock runs behind Slack's.
 */
export function replyTsAfter(promptTs: string, nowMs = Date.now()): string {
  const now = `${Math.floor(nowMs / 1000)}.${String((nowMs % 1000) * 1000).padStart(6, '0')}`;
  const [seconds, fraction = ''] = promptTs.split('.');
  const micros = Number(fraction.padEnd(6, '0').slice(0, 6)) + 1;
  const after = micros >= 1_000_000 ? `${Number(seconds) + 1}.000000` : `${seconds}.${String(micros).padStart(6, '0')}`;
  return Number(now) > Number(after) ? now : after;
}

export function startAppAnswerPoller(params: LaunchpadIntake): void {
  const poll = async (): Promise<void> => {
    try {
      await runAppAnswerPoller(params);
    } catch (error) {
      logger.error({ error: String(error) }, 'app answer poller tick failed');
    }
  };
  void poll();
  setInterval(() => void poll(), APP_ANSWER_POLL_INTERVAL_MS);
}
