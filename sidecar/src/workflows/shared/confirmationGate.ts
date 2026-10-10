import type { WebClient } from '@slack/web-api';
import { fetchThreadRepliesSince, type ThreadMessage } from '../../slack/threadContext.js';
import type { WorkflowStepLogger } from '../../types/contracts.js';

/**
 * Confirmation for an action that cannot be undone (a production deploy, a
 * merge). Deliberately stricter than the plan-approval wait:
 *
 * - Only an exact phrase counts. A "yes" typed to a colleague in the same
 *   thread must not deploy (issue #428).
 * - Only replies after the prompt count, and only from the allowed users.
 * - It expires. No answer means no action.
 * - It runs in-process, so a restart drops it and nothing resumes into the
 *   action later.
 */
export type ConfirmationOutcome = 'confirmed' | 'declined' | 'expired' | 'cancelled';

export interface ConfirmationResult {
  outcome: ConfirmationOutcome;
  userId?: string;
  replyTs?: string;
}

/** Poll/deadline knobs — a test seam so suites never sleep for real. */
export const __confirmationTiming = {
  pollMs: 5_000,
  deadlineMs: 10 * 60 * 1000,
};

const DECLINE_RE = /^(no|nope|cancel|stop|abort|dont)$/;

/** Mentions, formatting marks and trailing punctuation don't change what was typed. */
export function normalizeConfirmationReply(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/[`*_~"'“”‘’.!,]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function waitForExactConfirmation(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  /** ts of the prompt message; earlier replies never count. */
  promptTs: string;
  /** Lowercase phrase the reply must equal, e.g. "confirm deploy". */
  phrase: string;
  allowedUserIds: string[];
  botUserId?: string;
  /** job_logs stage prefix, e.g. "deploy.confirm". */
  stagePrefix: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<ConfirmationResult> {
  const { slack, channelId, threadTs, promptTs, phrase, allowedUserIds, botUserId, stagePrefix, logStep, signal } =
    params;
  const deadline = Date.now() + __confirmationTiming.deadlineMs;
  const toldOff = new Set<string>();

  logStep?.({
    stage: `${stagePrefix}.waiting`,
    message: `Waiting for "${phrase}" before acting.`,
    data: { allowedUserIds, deadlineMs: __confirmationTiming.deadlineMs },
  });

  for (;;) {
    if (signal?.aborted) {
      logStep?.({ stage: `${stagePrefix}.cancelled`, message: 'Cancelled while waiting for confirmation.' });
      return { outcome: 'cancelled' };
    }
    if (Date.now() >= deadline) {
      logStep?.({ stage: `${stagePrefix}.expired`, message: 'No confirmation before the deadline.', level: 'WARN' });
      return { outcome: 'expired' };
    }
    await sleep(__confirmationTiming.pollMs, signal);

    // Only replies after the prompt, paginated: in a long thread a single
    // 200-message page would never reach the confirmation.
    let messages: ThreadMessage[];
    try {
      messages = await fetchThreadRepliesSince(slack, channelId, threadTs, promptTs);
    } catch {
      // Transient Slack error — retry on the next tick, still bounded by the deadline.
      continue;
    }

    for (const reply of messages) {
      if (!(Number(reply.ts) > Number(promptTs)) || reply.user === botUserId) continue;
      const text = normalizeConfirmationReply(reply.text);
      const allowed = allowedUserIds.includes(reply.user);

      if (text === phrase) {
        if (allowed) {
          logStep?.({
            stage: `${stagePrefix}.confirmed`,
            message: `<@${reply.user}> confirmed with "${phrase}".`,
            data: { userId: reply.user, replyTs: reply.ts },
          });
          return { outcome: 'confirmed', userId: reply.user, replyTs: reply.ts };
        }
        if (!toldOff.has(reply.user)) {
          toldOff.add(reply.user);
          logStep?.({
            stage: `${stagePrefix}.unauthorized`,
            message: `<@${reply.user}> sent the confirmation phrase but may not confirm.`,
            level: 'WARN',
            data: { userId: reply.user },
          });
          slack.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `<@${reply.user}> only ${allowedUserIds.map(id => `<@${id}>`).join(' or ')} can confirm this.`,
            })
            .catch(() => {});
        }
        continue;
      }

      if (allowed && DECLINE_RE.test(text)) {
        logStep?.({
          stage: `${stagePrefix}.declined`,
          message: `<@${reply.user}> declined.`,
          data: { userId: reply.user, replyTs: reply.ts },
        });
        return { outcome: 'declined', userId: reply.user, replyTs: reply.ts };
      }
    }
  }
}
