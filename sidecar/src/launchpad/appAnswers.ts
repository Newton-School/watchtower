import { logger } from '../logging/logger.js';
import { recordButtonReply } from '../slack/buttonReplies.js';
import type { JobStore } from '../state/jobStore.js';
import type { LaunchpadRequestRecord } from '../types/contracts.js';
import { startLaunchpadRequest, takeBackPostedAsk, type LaunchpadIntake } from './launchpadIntake.js';

const APP_ANSWER_POLL_INTERVAL_MS = 2_000;

/** Where an answer from the app goes, given the run it answers as that run is now. */
export type AppAnswerRoute =
  | { kind: 'gate'; jobId: string; channelId: string; promptTs: string }
  | { kind: 'resume' }
  | { kind: 'drop'; reason: string };

/**
 * A gate waiting mid-run gets the answer, but only the question it was
 * written for. A run paused on its question is picked up again by a run
 * started from the answer, as a reply in the thread does.
 */
export function routeAppAnswer(
  store: Pick<JobStore, 'getJobSummary' | 'humanWaitFor'>,
  request: Pick<LaunchpadRequestRecord, 'answerForJobId' | 'answerPromptTs'>,
): AppAnswerRoute {
  const jobId = request.answerForJobId;
  const status = jobId ? store.getJobSummary(jobId)?.status : undefined;
  if (!jobId || !status) return { kind: 'drop', reason: 'That run is gone.' };
  if (status === 'PAUSED') return { kind: 'resume' };
  if (status !== 'RUNNING') return { kind: 'drop', reason: 'The run ended before your answer reached it.' };
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
        });
        store.appendJobLog({
          jobId: route.jobId,
          stage: 'watchtower.answer.received',
          message: `<@${request.ownerUserId}> answered from Watchtower: "${request.prompt}"`,
          data: { requestId: request.id, promptTs: route.promptTs },
        });
        logger.info({ requestId: request.id, jobId: route.jobId }, 'answer from the app handed to its gate');
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
