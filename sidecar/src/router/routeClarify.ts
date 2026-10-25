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
/** Staging is shared: a deploy the router was unsure of would replace someone's test for nothing. */
export const LOW_CONFIDENCE_STAGING_QUESTION =
  'Do you want me to put this on the marketing staging site and send you the link? Say which PR or branch if it is not the one here.';
/** Not a question to answer in the thread: a deploy is never started from a reply. */
export const DEPLOY_NEEDS_ONE_MESSAGE_REPLY =
  'If you want a production deploy, say which app in one message to me, for example `deploy newton-web to production`. I can deploy newton-web or the marketing site.';
/** Asked of someone who tagged the owner with what reads as a change request, before any work starts. */
export const OWNER_MENTION_CHANGE_QUESTION =
  "Want me to pick this up and make the change? Reply yes and I'll start with a plan, or tell me what you need instead.";
export const CLARIFY_GIVE_UP_REPLY =
  "I still can't tell what you need. Mention me again with the full request and I'll pick it up.";

/** The question a parked job is waiting on, as logged under ROUTE_CLARIFY_STAGE. */
export interface PendingRouteQuestion {
  question: string;
  requesterId: string;
  askedAtMs: number;
  /** The message that prompted the question, mentions removed. */
  askedText: string;
  /** The owner whose authority the question was asked on, when it was (issue #398). */
  delegatedByOwnerId?: string;
}

export type ClarifyAction =
  /** Act on the decision as given. */
  | { kind: 'run' }
  | {
      kind: 'ask';
      question: string;
      reason: ClarifyReason;
      /** false: say it, but wait for no reply. */ park?: boolean;
    }
  /** Already asked once in this chain: say so and stop. */
  | { kind: 'give_up'; reason: ClarifyReason }
  /** A reply to the question that asks for nothing. */
  | { kind: 'silent' };

export type ClarifyReason =
  | 'router_asked'
  | 'silenced_direct_mention'
  | 'low_confidence_change'
  | 'floor_hold'
  | 'deploy_without_target'
  | 'owner_mention_change'
  | 'low_confidence_staging'
  /** The staging tool could not tell which PR or branch to deploy (issue #702). */
  | 'staging_target';

/**
 * What to do with a router decision that should not be acted on as given.
 * Pure: the model proposes, this decides.
 *
 * Only direct mentions are asked, with one exception. A message that tags
 * the owner and reads as a change request was written to a person: starting
 * code-changing work on it is a guess about what they wanted from miniOG, so
 * the requester is asked first (the owner's rule of 2026-10-09, issue #430).
 * Anything else on an owner mention runs as decided or stays silent.
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
  /** For `deploy`: code agrees a deploy may start. */
  deployAllowed?: boolean;
  /** The message names staging as where the deploy goes: not a production deploy to ask about. */
  stagingAsk?: boolean;
}): ClarifyAction {
  const { tool, confidence, addressing, answering, heldByFloor, confidenceFloor } = params;
  if (addressing === 'owner_mention' && tool === 'change_code' && !answering) {
    return { kind: 'ask', question: OWNER_MENTION_CHANGE_QUESTION, reason: 'owner_mention_change' };
  }
  if (addressing !== 'direct') return { kind: 'run' };

  let ask: { question: string; reason: ClarifyReason; park?: boolean } | undefined;
  if (tool === 'deploy' && !params.deployAllowed && params.stagingAsk) {
    // Not a production deploy to ask about. The router has a staging tool for
    // a marketing staging ask (issue #702); a deploy pick for one falls back to
    // a lookup, which says how staging works.
    return { kind: 'run' };
  } else if (tool === 'deploy' && !params.deployAllowed) {
    // The model read a deploy ask where code found no target, or in a reply to
    // a question. Neither may deploy; say how to ask, and wait for nothing.
    ask = { question: DEPLOY_NEEDS_ONE_MESSAGE_REPLY, reason: 'deploy_without_target', park: false };
  } else if (tool === 'ask_user') {
    ask = { question: params.question ?? DEFAULT_CLARIFY_QUESTION, reason: 'router_asked' };
  } else if (tool === 'stay_silent') {
    // The model may not silence someone who addressed miniOG, except to let a question drop.
    if (answering) return { kind: 'silent' };
    ask = { question: DEFAULT_CLARIFY_QUESTION, reason: 'silenced_direct_mention' };
  } else if (tool === 'change_code' && confidence < confidenceFloor) {
    ask = { question: LOW_CONFIDENCE_CHANGE_QUESTION, reason: 'low_confidence_change' };
  } else if (tool === 'deploy_staging' && confidence < confidenceFloor) {
    ask = { question: LOW_CONFIDENCE_STAGING_QUESTION, reason: 'low_confidence_staging' };
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
    ...(typeof record.delegatedByOwnerId === 'string' ? { delegatedByOwnerId: record.delegatedByOwnerId } : {}),
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
  /** false: post it, but do not treat the next reply as an answer. */
  park?: boolean;
  logStep?: WorkflowStepLogger;
  nowMs?: number;
}): Promise<WorkflowResult> {
  const { slack, store, task, userMessage, question, reason, logStep } = params;
  const { channelId, threadTs, userId } = task.event;

  await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `<@${userId}> ${question}` });

  let otherParked = params.park === false;
  try {
    otherParked ||= Boolean(store.pausedJobForThread?.(channelId, threadTs));
  } catch {
    // The lookup is advisory: when it fails, park as usual.
  }
  const pending: PendingRouteQuestion = {
    question,
    requesterId: userId,
    askedAtMs: params.nowMs ?? Date.now(),
    askedText: userMessage,
    ...(task.delegatedByOwnerId ? { delegatedByOwnerId: task.delegatedByOwnerId } : {}),
  };
  logStep?.({
    stage: otherParked ? 'router.clarify.asked_unparked' : ROUTE_CLARIFY_STAGE,
    message: otherParked
      ? 'Replied to the requester without parking the job: a follow-up needs a mention.'
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
