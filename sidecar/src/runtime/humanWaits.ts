import { logger } from '../logging/logger.js';
import { agentCallContext } from '../state/runContext.js';
import type { HumanWaitKind } from '../types/contracts.js';

/**
 * Runs a gate's wait on a person with the wait written down in `human_waits`
 * for as long as it lasts, so the app's thread view can show that the run
 * waits and answer it. An answer from the app reaches the gate as a reply
 * from the owner, beside the thread's own replies (see launchpad/appAnswers).
 * Outside a job (a test, a tool) it only runs the wait.
 */
export async function whileWaitingForAnswer<T>(
  wait: {
    kind: HumanWaitKind;
    channelId: string;
    threadTs: string;
    promptTs: string;
    allowedUserIds: string[];
  },
  run: () => Promise<T>,
): Promise<T> {
  const context = agentCallContext.getStore();
  if (!context || !wait.promptTs) return run();
  const { jobId, store } = context;
  try {
    store.beginHumanWait({ jobId, ...wait });
  } catch (error) {
    // The app just can't answer this one: the wait itself goes on.
    logger.warn({ jobId, kind: wait.kind, error: String(error) }, 'could not record a wait on a person');
  }
  try {
    return await run();
  } finally {
    try {
      store.endHumanWait(jobId, wait.promptTs);
    } catch (error) {
      logger.warn({ jobId, kind: wait.kind, error: String(error) }, 'could not clear a wait on a person');
    }
  }
}
