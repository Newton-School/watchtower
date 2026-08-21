import type { WebClient } from '@slack/web-api';
import type { SlackFileAttachment } from './imageDownloader.js';

export type ThreadMessage = {
  text: string;
  user: string;
  ts: string;
  /** Slack message subtype (e.g. 'bot_message'), when present. */
  subtype?: string;
  /** Slack bot_id for integration-posted messages, when present. */
  botId?: string;
  files?: SlackFileAttachment[];
};

function mapSlackMessage(message: Record<string, unknown>): ThreadMessage {
  const rawFiles = message.files as Array<Record<string, unknown>> | undefined;

  const files: SlackFileAttachment[] | undefined = rawFiles
    ?.filter(
      f =>
        typeof f.id === 'string' &&
        typeof f.name === 'string' &&
        typeof f.mimetype === 'string' &&
        typeof f.url_private_download === 'string',
    )
    .map(f => ({
      id: f.id as string,
      name: f.name as string,
      mimetype: f.mimetype as string,
      url_private_download: f.url_private_download as string,
    }));

  return {
    text: typeof message.text === 'string' ? message.text : '',
    user: typeof message.user === 'string' ? message.user : '',
    ts: typeof message.ts === 'string' ? message.ts : '',
    subtype: typeof message.subtype === 'string' ? message.subtype : undefined,
    botId: typeof message.bot_id === 'string' ? message.bot_id : undefined,
    files: files && files.length > 0 ? files : undefined,
  };
}

/**
 * Returns `false` if Slack reports the thread parent does not exist
 * (`thread_not_found`), `true` otherwise. Used by long-running workflows
 * (planner, multi-agent pipelines) to short-circuit before doing expensive
 * work whose output would be orphaned by a deleted parent — Slack silently
 * promotes thread-less replies to channel root, which manifests as junk
 * sitting at the top of the channel with no source mention above it.
 *
 * Any error OTHER than `thread_not_found` is re-thrown so we don't silently
 * swallow rate limits, auth failures, or network blips as "parent gone".
 */
export async function assertThreadParentExists(client: WebClient, channel: string, threadTs: string): Promise<boolean> {
  try {
    await client.conversations.replies({ channel, ts: threadTs, inclusive: true, limit: 1 });
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object'
        ? ((error as { data?: { error?: unknown } }).data?.error as string | undefined)
        : undefined;
    if (code === 'thread_not_found' || code === 'message_not_found') {
      return false;
    }
    throw error;
  }
}

export async function fetchThreadContext(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const response = await client.conversations.replies({
    channel,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });

  const messages = response.messages ?? [];
  return messages.map(message => mapSlackMessage(message as unknown as Record<string, unknown>));
}

/**
 * Fetch every thread reply strictly newer than `oldestTs`, paginating past the
 * single-page 200-message ceiling of `fetchThreadContext`. Used by the
 * conversation-capture sweeper to pick up messages posted after the last
 * captured one (pass `oldestTs = '0'` for a full-thread walk). Returns
 * oldest-first. Errors propagate to the caller — the sweeper decides whether a
 * failed thread is retried next tick.
 */
export async function fetchThreadRepliesSince(
  client: WebClient,
  channel: string,
  threadTs: string,
  oldestTs: string,
): Promise<ThreadMessage[]> {
  const collected: ThreadMessage[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      oldest: oldestTs === '0' ? undefined : oldestTs,
      inclusive: false,
      limit: 200,
      cursor,
    });
    for (const message of response.messages ?? []) {
      collected.push(mapSlackMessage(message as unknown as Record<string, unknown>));
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // `oldest` + inclusive:false still returns the thread parent on the first
  // page in some Slack API versions; drop anything at or below the cursor.
  const floor = Number(oldestTs);
  return collected
    .filter(m => m.ts && (!Number.isFinite(floor) || floor <= 0 || Number(m.ts) > floor))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}
