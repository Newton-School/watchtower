import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import type { SlackEventEnvelope } from '../types/contracts.js';
import { postInParts, REST_IN_FILE } from './replyParts.js';

export function extractSlackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const maybeData = (error as { data?: { error?: unknown } }).data;
  if (maybeData && typeof maybeData.error === 'string') {
    return maybeData.error;
  }
  return undefined;
}

async function postViaResponseUrl(params: { responseUrl: string; text: string; threadTs?: string }): Promise<void> {
  const { responseUrl, text, threadTs } = params;
  const payload: Record<string, unknown> = {
    response_type: 'in_channel',
    replace_original: false,
    text,
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`response_url post failed (${response.status}): ${body}`);
  }
}

/** A thread reply Slack moved to the channel root because its parent was deleted; the post was undone. */
export interface OrphanPromotion {
  channelId: string;
  requestedThreadTs: string;
  actualThreadTs: string | null;
  orphanTs: string;
  eventTs: string;
}

/**
 * The Slack client a job posts through. Its `chat.postMessage`:
 * - posts through the event's response_url when the bot is not in the channel;
 * - undoes a thread reply Slack moved to the channel root (`onOrphanPromoted`
 *   cancels the job);
 * - posts a long reply in parts cut where they read whole (issue #623), each
 *   part with the handling above. After a first part that went through the
 *   response_url, which allows five posts, the other parts go as one; what
 *   does not fit in the most parts a reply may take goes in a file.
 */
export function buildEventAwareClient(
  client: WebClient,
  event: SlackEventEnvelope,
  hooks: { onOrphanPromoted: (orphan: OrphanPromotion) => void },
): WebClient {
  const wrappedClient = Object.create(client) as WebClient;
  const originalPostMessage = client.chat.postMessage.bind(client.chat);
  const originalDelete = client.chat.delete.bind(client.chat);
  const wrappedChat = Object.create(client.chat) as typeof client.chat;
  type PostArgs = Parameters<typeof client.chat.postMessage>[0];
  type PostResponse = Awaited<ReturnType<typeof client.chat.postMessage>>;
  const viaResponseUrl = new WeakSet<PostResponse>();

  const postOne = async (args: PostArgs): Promise<PostResponse> => {
    const payload = (args ?? {}) as {
      channel?: string;
      thread_ts?: string;
      text?: string;
    };
    let response: PostResponse;
    try {
      response = await originalPostMessage(args);
    } catch (error) {
      const errorCode = extractSlackErrorCode(error);
      const sameChannel = payload.channel === event.channelId;
      const sameThread = !payload.thread_ts || payload.thread_ts === event.threadTs;

      if (errorCode === 'not_in_channel' && sameChannel && sameThread && event.responseUrl) {
        await postViaResponseUrl({
          responseUrl: event.responseUrl,
          text: String(payload.text ?? ''),
          threadTs: payload.thread_ts ?? event.threadTs,
        });
        const fallback = {
          ok: true,
          ts: payload.thread_ts ?? event.threadTs,
          channel: event.channelId,
        } as PostResponse;
        viaResponseUrl.add(fallback);
        return fallback;
      }
      throw error;
    }

    // Detect Slack's silent orphan-promotion. When we ask to post into a
    // thread whose parent was just deleted, Slack accepts the call but
    // strips `thread_ts` and lands the message at channel root — confusing
    // junk that no human asked for. Compare the requested thread_ts to the
    // one Slack actually stamped on the response and undo the post if they
    // diverged. RCA: Slack thread 1779174569.451259 (2026-05-19).
    const requestedThreadTs = payload.thread_ts;
    if (requestedThreadTs && response?.ok && response?.ts && payload.channel) {
      const responseMessage = (response as { message?: { thread_ts?: string } }).message;
      const actualThreadTs = responseMessage?.thread_ts;
      if (actualThreadTs !== requestedThreadTs) {
        const orphanTs = response.ts;
        // Best-effort delete of the orphan. If this itself fails (e.g. token
        // can't delete its own bot post), we still log+cancel so observers
        // can see what happened.
        try {
          await originalDelete({ channel: payload.channel, ts: orphanTs });
        } catch (deleteError) {
          logger.warn(
            { channel: payload.channel, orphanTs, error: String(deleteError) },
            'failed to delete orphan-promoted post (non-fatal)',
          );
        }
        logger.warn(
          {
            channel: payload.channel,
            requestedThreadTs,
            actualThreadTs: actualThreadTs ?? null,
            orphanTs,
            eventTs: event.eventTs,
          },
          'slack.post.orphan_promoted: parent deleted mid-flight; deleted the orphan and cancelling job',
        );
        hooks.onOrphanPromoted({
          channelId: payload.channel,
          requestedThreadTs,
          actualThreadTs: actualThreadTs ?? null,
          orphanTs,
          eventTs: event.eventTs,
        });
        // Synthesize an "ok: false" return so callers see the post as a
        // no-op rather than a successful publish. Workflows already wrap
        // postMessage in .catch(() => {}); throwing here would surprise.
        return {
          ok: false,
          error: 'thread_parent_deleted',
        } as unknown as PostResponse;
      }
    }

    return response;
  };

  const fileRest = async (rest: string, args: PostArgs): Promise<boolean> => {
    const { channel, thread_ts: threadTs } = args as { channel?: string; thread_ts?: string };
    if (!channel || !threadTs) return false;
    await client.filesUploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: Buffer.from(rest, 'utf8'),
      filename: 'reply-continued.md',
      title: 'The rest of the reply',
      initial_comment: REST_IN_FILE,
    });
    return true;
  };

  wrappedChat.postMessage = async (...args: Parameters<typeof client.chat.postMessage>) =>
    postInParts(postOne, args[0], { joinRest: first => viaResponseUrl.has(first), fileRest });

  (wrappedClient as unknown as { chat: typeof client.chat }).chat = wrappedChat;
  return wrappedClient;
}
