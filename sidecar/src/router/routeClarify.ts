import type { WebClient } from '@slack/web-api';
import type { NormalizedTask, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';
import type { RouterFacts, RouterTool } from './toolRouter.js';

/**
 * Asking instead of guessing (issue #431).
 *
 * A message with nothing to act on ("no", "check now", "cc:") used to keep the
 * keyword seed and run the change pipeline, which then pinged the admins with
 * "which repo?". With the tool-router on, miniOG asks the requester one
 * question instead, parks the job, and treats the requester's next reply in
 * the thread as the answer, mention or not.
 *
 * It is a question, never a confirmation: nothing irreversible may hang on
 * the reply. One round only, so two unreadable messages cannot become a loop.
 */

/** Logged when a question is asked and the job is parked. Read back to find the pending question. */
export const ROUTE_CLARIFY_STAGE = 'router.clarify.asked';

/** How long the requester's next reply in the thread counts as the answer. */
export const ROUTE_CLARIFY_TTL_MS = 30 * 60_000;

export const DEFAULT_CLARIFY_QUESTION = "I'm not sure what you'd like me to do here. What do you need?";
export const LOW_CONFIDENCE_CHANGE_QUESTION =
  'Do you want me to change something here, or only look into it? Tell me what should change and where.';
export const CLARIFY_GIVE_UP_REPLY =
  "I still can't tell what you need. Mention me again with the full request and I'll pick it up.";

/** The question a parked job is waiting on, as logged under ROUTE_CLARIFY_STAGE. */
export interface PendingRouteQuestion {
  question: string;
  requesterId: string;
  askedAtMs: number;
  /** The message that prompted the question, mentions removed. */
  askedText: string;
}

export type ClarifyAction =
  /** Act on the decision as given. */
  | { kind: 'run' }
  | { kind: 'ask'; question: string; reason: ClarifyReason }
  /** Already asked once in this chain: say so and stop. */
  | { kind: 'give_up'; reason: ClarifyReason }
  /** A reply to the question that asks for nothing. */
  | { kind: 'silent' };

export type ClarifyReason = 'router_asked' | 'silenced_direct_mention' | 'low_confidence_change' | 'floor_hold';

/**
 * What to do with a router decision that should not be acted on as given.
 * Pure: the model proposes, this decides.
 *
 * Only direct mentions are asked. A message that merely tags the owner is
 * never answered with a question.
 */
export function decideClarify(params: {
  tool: RouterTool;
  confidence: number;
  question?: string;
  addressing: RouterFacts['addressing'];
  /** This message is the requester's reply to a question miniOG asked. */
  answering: boolean;
  /** The confidence floor would have kept the keyword seed over this decision. */
  heldByFloor: boolean;
  confidenceFloor: number;
}): ClarifyAction {
  const { tool, confidence, addressing, answering, heldByFloor, confidenceFloor } = params;
  if (addressing !== 'direct') return { kind: 'run' };

  let ask: { question: string; reason: ClarifyReason } | undefined;
  if (tool === 'ask_user') {
    ask = { question: params.question ?? DEFAULT_CLARIFY_QUESTION, reason: 'router_asked' };
  } else if (tool === 'stay_silent') {
    // The model may not silence someone who addressed miniOG, except to let a question drop.
    if (answering) return { kind: 'silent' };
    ask = { question: DEFAULT_CLARIFY_QUESTION, reason: 'silenced_direct_mention' };
  } else if (tool === 'change_code' && confidence < confidenceFloor) {
    ask = { question: LOW_CONFIDENCE_CHANGE_QUESTION, reason: 'low_confidence_change' };
  } else if (heldByFloor) {
    ask = { question: DEFAULT_CLARIFY_QUESTION, reason: 'floor_hold' };
  }

  if (!ask) return { kind: 'run' };
  return answering ? { kind: 'give_up', reason: ask.reason } : { kind: 'ask', ...ask };
}

/** Whether a reply in the thread is the answer the parked job is waiting for. */
export function isRouteAnswer(params: { pending: PendingRouteQuestion; senderId: string; nowMs: number }): boolean {
  const { pending, senderId, nowMs } = params;
  return senderId === pending.requesterId && !isRouteQuestionExpired(pending, nowMs);
}

export function isRouteQuestionExpired(pending: PendingRouteQuestion, nowMs: number): boolean {
  return nowMs - pending.askedAtMs > ROUTE_CLARIFY_TTL_MS;
}

/** Reads a ROUTE_CLARIFY_STAGE log payload back. Anything malformed is no pending question. */
export function parsePendingRouteQuestion(data: unknown): PendingRouteQuestion | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (
    typeof record.question !== 'string' ||
    typeof record.requesterId !== 'string' ||
    typeof record.askedAtMs !== 'number' ||
    !Number.isFinite(record.askedAtMs)
  ) {
    return undefined;
  }
  return {
    question: record.question,
    requesterId: record.requesterId,
    askedAtMs: record.askedAtMs,
    askedText: typeof record.askedText === 'string' ? record.askedText : '',
  };
}

/**
 * Posts the question to the requester and parks the job. If another job is
 * already parked in the thread, "the next reply" belongs to it, so this one
 * asks without parking: the answer then needs a mention.
 */
export async function askRequester(params: {
  slack: WebClient;
  store: { pausedJobForThread?: (channelId: string, threadTs: string) => unknown };
  task: NormalizedTask;
  userMessage: string;
  question: string;
  reason: ClarifyReason;
  logStep?: WorkflowStepLogger;
  nowMs?: number;
}): Promise<WorkflowResult> {
  const { slack, store, task, userMessage, question, reason, logStep } = params;
  const { channelId, threadTs, userId } = task.event;

  await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `<@${userId}> ${question}` });

  let otherParked = false;
  try {
    otherParked = Boolean(store.pausedJobForThread?.(channelId, threadTs));
  } catch {
    // The lookup is advisory: when it fails, park as usual.
  }
  const pending: PendingRouteQuestion = {
    question,
    requesterId: userId,
    askedAtMs: params.nowMs ?? Date.now(),
    askedText: userMessage,
  };
  logStep?.({
    stage: otherParked ? 'router.clarify.asked_unparked' : ROUTE_CLARIFY_STAGE,
    message: otherParked
      ? 'Asked the requester a question. Another job is parked in this thread, so the answer needs a mention.'
      : 'Asked the requester a question and parked the job until they reply.',
    data: { ...pending, reason },
  });

  return {
    workflow: 'UNKNOWN',
    status: otherParked ? 'SKIPPED' : 'PAUSED',
    message: `Asked the requester: ${question}`,
    notifyDesktop: false,
    slackPosted: true,
  };
}

/** The reply when a second message in a row leaves nothing to act on. */
export async function giveUpOnClarify(params: {
  slack: WebClient;
  task: NormalizedTask;
  reason: ClarifyReason;
  logStep?: WorkflowStepLogger;
}): Promise<WorkflowResult> {
  const { slack, task, reason, logStep } = params;
  await slack.chat.postMessage({
    channel: task.event.channelId,
    thread_ts: task.event.threadTs,
    text: CLARIFY_GIVE_UP_REPLY,
  });
  logStep?.({
    stage: 'router.clarify.gave_up',
    message: 'The reply to the question still left nothing to act on — said so and stopped, without asking again.',
    data: { reason },
  });
  return {
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: 'Asked once already; the reply still left nothing to act on.',
    notifyDesktop: false,
    slackPosted: true,
  };
}
