import type { WebClient } from '@slack/web-api';
import { getConfiguredAccessControl } from '../access/control.js';
import { detectMention } from '../router/intentParser.js';
import { logger } from '../logging/logger.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';

const CATCHUP_STATE_KEY = 'mention_catchup_cursor_ts';
const CATCHUP_INTERVAL_MS = 2 * 60 * 1000;
const CATCHUP_LOOKBACK_SECONDS = 60 * 60 * 24;
const CATCHUP_PAGE_SIZE = 200;
// Hard ceiling on how many messages we accumulate in memory per channel per
// scan. Every tick fetches the full lookback window (we need old parents'
// reply metadata to spot fresh thread activity), so the cap bounds a very busy
// channel's backlog. conversations.history returns newest-first, so the most
// recent (most likely still-actionable) mentions are the ones we keep.
const CATCHUP_MAX_MESSAGES_PER_CHANNEL = 1000;
// Same bound for one thread's replies. conversations.replies pages
// oldest-first, so a pathological >cap thread keeps its oldest replies and can
// miss the newest — the warn line in fetchThreadReplies makes that visible.
const CATCHUP_MAX_REPLIES_PER_THREAD = 1000;
// Catchup is a recovery scanner — it walks `conversations.history` and replays
// mentions whose live socket delivery we may have missed. Deletions only flow
// through the live socket path (where processMessageDeleted reacts); a
// deletion that landed while the sidecar was down can't be retroactively
// resurrected from history anyway, so this scanner intentionally still skips
// `message_deleted` rows it stumbles across.
const NON_ACTIONABLE_SUBTYPES = new Set(['message_changed', 'message_deleted', 'bot_message']);

type CatchupDeps = {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup') => Promise<void>;
};

export function startMentionCatchup(deps: CatchupDeps): void {
  void runMentionCatchup(deps);
  setInterval(() => {
    void runMentionCatchup(deps);
  }, CATCHUP_INTERVAL_MS);
}

// Exported for unit testing of the scan passes; production entry is
// startMentionCatchup.
export async function runMentionCatchup(deps: CatchupDeps): Promise<void> {
  const { webClient, config, store, enqueue } = deps;
  const nowTs = Math.floor(Date.now() / 1000);
  const storedCursorRaw = store.getState(CATCHUP_STATE_KEY);
  const storedCursor = storedCursorRaw ? Number(storedCursorRaw) : 0;
  const cursorBoundary =
    Number.isFinite(storedCursor) && storedCursor > 0
      ? Math.max(0, storedCursor - 5)
      : nowTs - CATCHUP_LOOKBACK_SECONDS;

  logger.info(
    {
      component: 'slack-catchup',
      cursorBoundary,
      cursorTs: storedCursor || null,
    },
    'starting missed mention catch-up scan',
  );

  const channelIds = await discoverChannels(webClient, store, config);
  logger.info(
    {
      component: 'slack-catchup',
      channels: channelIds.length,
    },
    'resolved channels for missed mention catch-up',
  );

  let recovered = 0;
  let scannedMessages = 0;
  let maxSeenTs = cursorBoundary;
  const enqueuedThisScan = new Set<string>();

  for (const channelId of channelIds) {
    // Fetch the full lookback window rather than just the cursor delta: plain
    // thread replies never appear in conversations.history, so fresh thread
    // activity is only visible through the *parent* row's reply metadata —
    // and that parent can be much older than the last scan. Idempotency comes
    // from the event/job dedup gates below, not from a narrow fetch window.
    const historyMessages = await fetchChannelHistory(webClient, channelId, nowTs - CATCHUP_LOOKBACK_SECONDS);
    if (historyMessages.length === 0) {
      continue;
    }

    const ordered = historyMessages
      .filter(message => typeof message.ts === 'string' && message.ts.length > 0)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    for (const message of ordered) {
      const eventTs = String(message.ts ?? '');
      if (!eventTs) {
        continue;
      }

      scannedMessages += 1;
      maxSeenTs = Math.max(maxSeenTs, toEpochSeconds(eventTs));

      const candidate = extractActionableMention(message, config);
      if (!candidate) {
        continue;
      }

      const replayEventId = `replay:${channelId}:${eventTs}`;
      if (
        enqueuedThisScan.has(replayEventId) ||
        store.hasEvent(replayEventId) ||
        store.hasJobForEventTs(channelId, eventTs)
      ) {
        continue;
      }

      const threadTs = String(message.thread_ts ?? message.ts ?? '');
      const alreadyResponded = await hasBotResponseAfterMention(
        webClient,
        channelId,
        threadTs,
        eventTs,
        config.botUserId,
      );
      if (alreadyResponded) {
        store.recordEvent(replayEventId, channelId, threadTs);
        continue;
      }

      const envelope: SlackEventEnvelope = {
        eventId: replayEventId,
        channelId,
        threadTs,
        eventTs,
        userId: candidate.userId,
        text: candidate.text,
        messageSubtype: candidate.subtype || undefined,
        rawEvent: message as Record<string, unknown>,
      };

      await enqueue(envelope, webClient, 'catchup');
      enqueuedThisScan.add(replayEventId);
      recovered += 1;
    }

    // Second pass: thread replies. conversations.history never returns plain
    // thread replies, so before this pass an @mention posted inside a thread
    // was invisible to catch-up and silently dropped whenever live socket
    // delivery was down (RCA 2026-07-29). Parents carry reply metadata, so we
    // fetch replies only for threads with activity since the last scan.
    for (const message of ordered) {
      const parentTs = String(message.ts ?? '');
      const replyCount = Number(message.reply_count ?? 0);
      const latestReplyEpoch = toEpochSeconds(String(message.latest_reply ?? ''));
      if (!parentTs || replyCount <= 0 || latestReplyEpoch <= cursorBoundary) {
        continue;
      }

      const replies = await fetchThreadReplies(webClient, channelId, parentTs);
      for (const reply of replies) {
        const replyTs = String(reply.ts ?? '');
        if (!replyTs || replyTs === parentTs) {
          continue;
        }

        scannedMessages += 1;

        const candidate = extractActionableMention(reply, config);
        if (!candidate) {
          continue;
        }

        const replayEventId = `replay:${channelId}:${replyTs}`;
        if (
          enqueuedThisScan.has(replayEventId) ||
          store.hasEvent(replayEventId) ||
          store.hasJobForEventTs(channelId, replyTs)
        ) {
          continue;
        }

        // We already hold the full reply list — check for a bot response
        // in-place instead of a second conversations.replies round-trip.
        const replyEpoch = toEpochSeconds(replyTs);
        const botRespondedLater = replies.some(
          other => String(other.user ?? '') === config.botUserId && toEpochSeconds(String(other.ts ?? '')) > replyEpoch,
        );
        if (botRespondedLater) {
          store.recordEvent(replayEventId, channelId, parentTs);
          continue;
        }

        const envelope: SlackEventEnvelope = {
          eventId: replayEventId,
          channelId,
          threadTs: parentTs,
          eventTs: replyTs,
          userId: candidate.userId,
          text: candidate.text,
          messageSubtype: candidate.subtype || undefined,
          rawEvent: reply,
        };

        await enqueue(envelope, webClient, 'catchup');
        enqueuedThisScan.add(replayEventId);
        recovered += 1;
      }
    }
  }

  const nextCursor = Math.max(nowTs, maxSeenTs);
  store.setState(CATCHUP_STATE_KEY, String(nextCursor));

  logger.info(
    {
      component: 'slack-catchup',
      recovered,
      scannedMessages,
      nextCursor,
    },
    'completed missed mention catch-up scan',
  );
}

type ActionableMention = { text: string; userId: string; subtype: string };

/**
 * Shared actionability gate for both scan passes: skip non-actionable
 * subtypes, bot-authored and empty messages, and anything without a detected
 * mention. Dedup against prior processing stays with the callers because the
 * two passes record events with different thread anchors.
 */
function extractActionableMention(message: Record<string, unknown>, config: AppConfig): ActionableMention | null {
  const subtype = message.subtype ? String(message.subtype) : '';
  if (subtype && NON_ACTIONABLE_SUBTYPES.has(subtype)) {
    return null;
  }

  const text = String(message.text ?? '');
  const userId = String(message.user ?? '');
  if (!text || !userId || userId === config.botUserId) {
    return null;
  }

  if (!detectMention(text, config).detected) {
    return null;
  }

  return { text, userId, subtype };
}

async function discoverChannels(client: WebClient, store: JobStore, config: AppConfig): Promise<string[]> {
  const accessChannels = Object.values(getConfiguredAccessControl(config).groups).flatMap(
    group => group.resolvedChannelIds,
  );
  const channelSet = new Set<string>([
    ...store.listKnownChannels(500),
    ...config.allowedChannelsForBugFix,
    ...accessChannels,
  ]);

  let cursor: string | undefined;
  try {
    do {
      const response = await client.users.conversations({
        cursor,
        limit: 200,
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
      });

      const channels = response.channels ?? [];
      for (const channel of channels) {
        if (channel.id) {
          channelSet.add(channel.id);
        }
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        error: String(error),
      },
      'failed to enumerate channels via users.conversations; falling back to known channels',
    );
  }

  return Array.from(channelSet);
}

// Exported for unit testing of the per-channel accumulation cap.
export async function fetchChannelHistory(
  client: WebClient,
  channelId: string,
  oldestTs: number,
): Promise<Array<Record<string, unknown>>> {
  const oldest = String(oldestTs);
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.history({
        channel: channelId,
        oldest,
        inclusive: false,
        limit: CATCHUP_PAGE_SIZE,
        cursor,
      });

      for (const message of response.messages ?? []) {
        messages.push(message as unknown as Record<string, unknown>);
      }

      cursor = response.response_metadata?.next_cursor || undefined;

      // Bound the in-memory accumulation. Once we hit the per-channel cap, stop
      // paginating rather than walking the entire backlog of a busy channel
      // into a single array. Newest-first ordering means we've kept the most
      // recent messages; older ones are left for the live socket (or are stale
      // anyway, since the cursor advances to "now" after every scan).
      if (cursor && messages.length >= CATCHUP_MAX_MESSAGES_PER_CHANNEL) {
        logger.warn(
          {
            component: 'slack-catchup',
            channelId,
            accumulated: messages.length,
            cap: CATCHUP_MAX_MESSAGES_PER_CHANNEL,
          },
          'channel history hit per-channel cap during catch-up; stopping pagination',
        );
        break;
      }
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        error: String(error),
      },
      'failed to fetch channel history during missed mention catch-up',
    );
  }

  return messages;
}

// Exported for unit testing of the per-thread accumulation cap.
export async function fetchThreadReplies(
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        inclusive: true,
        limit: CATCHUP_PAGE_SIZE,
        cursor,
      });

      for (const message of response.messages ?? []) {
        messages.push(message as unknown as Record<string, unknown>);
      }

      cursor = response.response_metadata?.next_cursor || undefined;

      if (cursor && messages.length >= CATCHUP_MAX_REPLIES_PER_THREAD) {
        logger.warn(
          {
            component: 'slack-catchup',
            channelId,
            threadTs,
            accumulated: messages.length,
            cap: CATCHUP_MAX_REPLIES_PER_THREAD,
          },
          'thread replies hit per-thread cap during catch-up; stopping pagination',
        );
        break;
      }
    } while (cursor);
  } catch (error) {
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        threadTs,
        error: String(error),
      },
      'failed to fetch thread replies during missed mention catch-up',
    );
  }

  return messages;
}

async function hasBotResponseAfterMention(
  client: WebClient,
  channelId: string,
  threadTs: string,
  mentionTs: string,
  botUserId: string,
): Promise<boolean> {
  try {
    const response = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: 200,
    });
    const mentionEpoch = toEpochSeconds(mentionTs);
    for (const message of response.messages ?? []) {
      const ts = String(message.ts ?? '');
      if (!ts) {
        continue;
      }
      if (String(message.user ?? '') === botUserId && toEpochSeconds(ts) > mentionEpoch) {
        return true;
      }
    }
    return false;
  } catch (error) {
    // Don't collapse a transient conversations.replies failure into "yes
    // already responded" — that previously caused catch-up to record the
    // replay marker and silently drop the mention forever. Returning false
    // here lets catch-up enqueue the replayed mention; processEvent's
    // hasJobForEventTs dedup gate will still suppress an actual double-run
    // if the bot did in fact reply.
    logger.warn(
      {
        component: 'slack-catchup',
        channelId,
        threadTs,
        error: String(error),
      },
      'failed to inspect thread replies while checking missed mention response status; treating as not-yet-responded so catch-up retries',
    );
    return false;
  }
}

function toEpochSeconds(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? value : 0;
}
