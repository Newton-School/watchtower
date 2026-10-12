import { runCodex } from './runCodex.js';
import type { CodexRunRequest, CodexRunResult, WorkflowStepLogger } from '../types/contracts.js';

/**
 * One place that knows what to do when an agent run dies of something that is
 * not the agent's doing (issue #439).
 *
 * The sidecar runs on a laptop. When its network drops, the CLI's final
 * message is "API Error: Can't reach the API server …". That text used to be
 * taken for the agent's output: a planner run that died this way had it
 * posted as a plan for approval, and a coder that had already pushed its
 * commit was marked failed, with no retry in either case.
 *
 * A run that ends in such an error is run again after a wait, up to the
 * number of delays configured. The time lost to it is reported back so a
 * caller with a deadline does not charge it to the work.
 */

/** Waits before each retry. A dropped wifi link is usually back within minutes. */
export const INFRA_RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

/** A resumed session that fails this fast never started: the session could not be found. */
const RESUME_FAILED_FAST_MS = 15_000;

export const RESUME_AFTER_DROP_PROMPT =
  'The connection to the model API dropped and your last turn did not finish. Nothing else has changed. ' +
  'Continue from where you stopped and finish the task, then give your final answer in the format the original instructions asked for.';

function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Test seams: no real CLI and no real waiting in unit tests. */
export const __infraRetry = {
  // Looked up per call, not captured at import: a module that mocks the runner
  // partially must still be able to load this file.
  run: (request: CodexRunRequest): Promise<CodexRunResult> => runCodex(request),
  sleep: abortableSleep,
  delaysMs: INFRA_RETRY_DELAYS_MS,
};

export interface InfraRetryResult extends CodexRunResult {
  /** Time taken by attempts that died on the connection, plus the waits between them. Not the agent's time. */
  infraWaitMs: number;
  /** Retries made after a connection failure. */
  infraRetries: number;
}

const formatDelay = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;

export async function runWithInfraRetry(
  request: CodexRunRequest,
  options: {
    /** What was running, for the log line: "planner", "coder". */
    label: string;
    /**
     * Resume the failed run's session instead of starting over. For a run
     * whose work is on disk and expensive to redo (the coder).
     */
    resume?: boolean;
    logStep?: WorkflowStepLogger;
  },
): Promise<InfraRetryResult> {
  const { label, logStep } = options;
  const delays = __infraRetry.delaysMs;
  let result = await __infraRetry.run(request);
  let infraWaitMs = 0;
  let infraRetries = 0;

  for (const delayMs of delays) {
    if (result.errorKind !== 'API_ERROR' || request.signal?.aborted) break;
    infraWaitMs += result.durationMs ?? 0;
    infraRetries += 1;
    logStep?.({
      stage: 'agent.api_error.retry',
      message: `Lost the connection to the model API during ${label} — retrying in ${formatDelay(delayMs)} (attempt ${infraRetries} of ${delays.length}).`,
      level: 'WARN',
      data: { label, attempt: infraRetries, attempts: delays.length, delayMs, detail: result.apiErrorDetail },
    });

    const waited = await __infraRetry.sleep(delayMs, request.signal);
    infraWaitMs += delayMs;
    if (!waited) break;

    const sessionId = options.resume ? result.sessionId : undefined;
    let next = await __infraRetry.run(
      sessionId ? { ...request, resumeSessionId: sessionId, prompt: RESUME_AFTER_DROP_PROMPT } : request,
    );
    if (sessionId && !next.ok && !next.errorKind && !next.cancelled && (next.durationMs ?? 0) < RESUME_FAILED_FAST_MS) {
      logStep?.({
        stage: 'agent.api_error.resume_failed',
        message: `Could not resume the ${label} session after the connection dropped — starting it again.`,
        level: 'WARN',
        data: { label, sessionId },
      });
      next = await __infraRetry.run(request);
    }
    result = next;
  }

  // Still dead after the last retry: that attempt was lost time too.
  if (result.errorKind === 'API_ERROR') infraWaitMs += result.durationMs ?? 0;
  return { ...result, infraWaitMs, infraRetries };
}

/** What to tell a thread when the connection never came back. `doing` reads after "while". */
export function connectionLostReply(doing: string): string {
  return `I lost my connection to the model while ${doing}, and retrying didn't bring it back. Nothing has been merged. Mention me again in a few minutes and I'll pick it up.`;
}
