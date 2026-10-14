import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { isRouteQuestionExpired, type PendingRouteQuestion } from '../router/routeClarify.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import { fetchThreadRepliesSince } from './threadContext.js';

/**
 * Answers to a question miniOG asked that the live socket never delivered
 * (issue #431).
 *
 * When miniOG asks the requester a question it parks the job and treats
 * their next reply in the thread as the answer, mention or not. A reply with
 * no mention reaches the sidecar only through the live socket. If the app was
 * restarting (or the socket was down) when it was sent, nothing ever saw it:
 * the mention catch-up scans for mentions only, and the job sat parked until
 * it expired.
 *
 * This looks at each parked question's thread for a reply from the person it
 * was asked of, and queues the first one it finds the way the socket would
 * have. The intake then resumes the job as for a live reply.
 */

interface ParkedQuestion {
  id: string;
  channelId: string;
  threadTs: string;
  pending: PendingRouteQuestion;
}

export async function catchUpParkedAnswers(deps: {
  webClient: WebClient;
  config: Pick<AppConfig, 'botUserId'>;
  store: {
    pausedRouteQuestions(): ParkedQuestion[];
    hasEvent(eventId: string): boolean;
    hasJobForEventTs(channelId: string, eventTs: string): boolean;
  };
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup') => Promise<void>;
  nowMs?: number;
  fetchReplies?: typeof fetchThreadRepliesSince;
}): Promise<number> {
  const { webClient, config, store, enqueue } = deps;
  const nowMs = deps.nowMs ?? Date.now();
  const fetchReplies = deps.fetchReplies ?? fetchThreadRepliesSince;
  let recovered = 0;

  for (const parked of store.pausedRouteQuestions()) {
    if (isRouteQuestionExpired(parked.pending, nowMs)) continue;
    const askedTs = (parked.pending.askedAtMs / 1000).toFixed(6);
    let replies: Awaited<ReturnType<typeof fetchThreadRepliesSince>>;
    try {
      replies = await fetchReplies(webClient, parked.channelId, parked.threadTs, askedTs);
    } catch (error) {
      logger.warn({ jobId: parked.id, error: String(error) }, 'parked-answer catch-up: could not read the thread');
      continue;
    }
    // The first reply from the person the question was asked of. A reply that
    // mentions miniOG is the mention catch-up's to recover.
    const answer = replies.find(
      reply =>
        reply.user === parked.pending.requesterId &&
        Boolean(reply.text?.trim()) &&
        !reply.subtype &&
        !(config.botUserId && reply.text.includes(`<@${config.botUserId}>`)),
    );
    if (!answer) continue;

    const eventId = `replay:${parked.channelId}:${answer.ts}`;
    if (store.hasEvent(eventId) || store.hasJobForEventTs(parked.channelId, answer.ts)) continue;

    const envelope: SlackEventEnvelope = {
      eventId,
      channelId: parked.channelId,
      threadTs: parked.threadTs,
      eventTs: answer.ts,
      userId: answer.user,
      text: answer.text,
      rawEvent: { ts: answer.ts, user: answer.user, text: answer.text, thread_ts: parked.threadTs },
    };
    logger.info(
      { jobId: parked.id, channelId: parked.channelId, threadTs: parked.threadTs, answerTs: answer.ts },
      'parked-answer catch-up: found an answer the socket missed — queueing it',
    );
    await enqueue(envelope, webClient, 'catchup');
    recovered += 1;
  }
  return recovered;
}
