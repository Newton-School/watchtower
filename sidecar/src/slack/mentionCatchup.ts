import type { WebClient } from '@slack/web-api';
import { getBundlesForConfig } from '../access/control.js';
import { detectMention } from '../router/intentParser.js';
import { isStopCommand } from '../router/stopIntent.js';
import { logger } from '../logging/logger.js';
import type { AppConfig, SlackEventEnvelope } from '../types/contracts.js';
import type { JobStore } from '../state/jobStore.js';
import { catchUpParkedAnswers } from './parkedAnswerCatchup.js';

const CATCHUP_STATE_KEY = 'mention_catchup_cursor_ts';
const CATCHUP_INTERVAL_MS = 2 * 60 * 1000;
const CATCHUP_LOOKBACK_SECONDS = 60 * 60 * 24;
const CATCHUP_PAGE_SIZE = 200;
// Hard ceiling on how many messages we accumulate in memory per channel per
// scan. Steady-state ticks cover ~2-minute windows (far below this), so the cap
// only ever engages on the first run or after a long downtime in a very busy
// channel — exactly the case where unbounded `do/while(cursor)` pagination
// would balloon the array. conversations.history returns newest-first, so the
// most recent (most likely still-actionable) mentions are the ones we keep.
const CATCHUP_MAX_MESSAGES_PER_CHANNEL = 1000;
// Same bound for one thread's replies. conversations.replies pages
// oldest-first, so a pathological >cap thread keeps its oldest replies and can
// miss the newest — the warn line in fetchThreadReplies makes that visible.
const CATCHUP_MAX_REPLIES_PER_THREAD = 1000;
// A thread whose job finished this recently is still read every scan: a
// follow-up there is the likeliest mention to arrive as a thread reply.
const RECENT_JOB_THREAD_HOURS = 6;
// Replay ids queued in this process, so a reply the intake drops without a
// record (no job, no event row) is not queued again on every scan.
const REPLAYED_MEMORY = 2000;
// Threads read in one scan, sweep included: a sweep after a long sleep must
// not turn into hundreds of conversations.replies calls at once.
const CATCHUP_MAX_THREADS_PER_SCAN = 150;
// Catchup is a recovery scanner — it walks `conversations.history` and replays
// mentions whose live socket delivery we may have missed. Deletions only flow
// through the live socket path (where processMessageDeleted reacts); a
// deletion that landed while the sidecar was down can't be retroactively
// resurrected from history anyway, so this scanner intentionally still skips
// `message_deleted` rows it stumbles across.
const NON_ACTIONABLE_SUBTYPES = new Set(['message_changed', 'message_deleted', 'bot_message']);

/**
 * Window start for a catch-up scan. Normally we resume a few seconds before the
 * stored cursor. But the cursor only ever moves forward, so a single jump of the
 * system clock into the future (or a future-dated message) parks it ahead of
 * real time *permanently* — and a future cursor makes `oldest` skip every real
 * message until the wall clock catches up, silently blinding catch-up for the
 * whole gap. When the stored cursor is ahead of `nowTs`, treat it as corrupt and
 * fall back to the lookback window so the scanner self-heals. (RCA: a clock
 * bounce parked the cursor ~6 days ahead and dropped a PR-review mention.)
 */
export function effectiveOldestTs(storedCursor: number, nowTs: number, lookbackSeconds: number): number {
  const valid = Number.isFinite(storedCursor) && storedCursor > 0 && storedCursor <= nowTs;
  return valid ? Math.max(0, storedCursor - 5) : nowTs - lookbackSeconds;
}

type CatchupStore = Pick<
  JobStore,
  | 'getState'
  | 'setState'
  | 'hasEvent'
  | 'recordEvent'
  | 'hasJobForEventTs'
  | 'listKnownChannels'
  | 'threadsWithRecentJobs'
> &
  Parameters<typeof catchUpParkedAnswers>[0]['store'];

type CatchupDeps = {
  webClient: WebClient;
  config: AppConfig;
  store: CatchupStore;
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'socket' | 'catchup') => Promise<void>;
  /** Messages the live socket delivered in this process: already handled, never replayed. */
  deliveredLive?: (channelId: string, ts: string) => boolean;
  nowMs?: () => number;
};

/** What a scan carries over to the next. */
export type CatchupState = {
  /** Read every thread with replies since then (epoch seconds), on the next scan only. */
  sweepSince: number | null;
  replayed: Set<string>;
};

export function newCatchupState(): CatchupState {
  return { sweepSince: null, replayed: new Set() };
}

export interface MentionCatchup {
  /**
   * The socket may have missed messages since then (the host slept, or the
   * socket was dead): the next scan reads every recent thread with replies
   * since that time, not just the threads miniOG has jobs in.
   */
  sweepThreadsSince(epochSeconds: number): void;
}

export function startMentionCatchup(deps: CatchupDeps): MentionCatchup {
  const state = newCatchupState();
  // While the sidecar was down nothing at all was delivered, thread replies
  // included: the first scan sweeps threads from the last scan before it.
  const storedCursor = Number(deps.store.getState(CATCHUP_STATE_KEY) ?? 0);
  state.sweepSince = effectiveOldestTs(storedCursor, Math.floor(now(deps) / 1000), CATCHUP_LOOKBACK_SECONDS);
  // A sweep can outlast the interval; two scans at once would queue the same
  // reply twice, so a tick that finds one running skips.
  let running = false;
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      await runMentionCatchup(deps, state);
    } catch (error) {
      logger.warn({ component: 'slack-catchup', error: String(error) }, 'missed mention catch-up scan failed');
    } finally {
      running = false;
    }
  };
  void scan();
  setInterval(() => void scan(), CATCHUP_INTERVAL_MS);
  return {
    sweepThreadsSince(epochSeconds) {
      state.sweepSince = state.sweepSince === null ? epochSeconds : Math.min(state.sweepSince, epochSeconds);
    },
  };
}

function now(deps: Pick<CatchupDeps, 'nowMs'>): number {
  return deps.nowMs ? deps.nowMs() : Date.now();
}

// Exported for unit tests; production runs it through startMentionCatchup.
export async function runMentionCatchup(deps: CatchupDeps, state: CatchupState = newCatchupState()): Promise<void> {
  const { webClient, config, store, enqueue } = deps;
  const nowTs = Math.floor(now(deps) / 1000);
  const storedCursorRaw = store.getState(CATCHUP_STATE_KEY);
  const storedCursor = storedCursorRaw ? Number(storedCursorRaw) : 0;
  const oldestTs = effectiveOldestTs(storedCursor, nowTs, CATCHUP_LOOKBACK_SECONDS);
  // A sweep reaches back to the gap, never past the lookback window.
  const sweepSince =
    state.sweepSince === null ? null : Math.max(nowTs - CATCHUP_LOOKBACK_SECONDS, Math.min(state.sweepSince, oldestTs));
  state.sweepSince = null;
  const replyBoundary = sweepSince ?? oldestTs;
  const seen = (channelId: string, ts: string, replayEventId: string) =>
    state.replayed.has(replayEventId) ||
    Boolean(deps.deliveredLive?.(channelId, ts)) ||
    store.hasEvent(replayEventId) ||
    store.hasJobForEventTs(channelId, ts);
  const remember = (replayEventId: string) => {
    state.replayed.add(replayEventId);
    if (state.replayed.size > REPLAYED_MEMORY) {
      state.replayed.delete(state.replayed.values().next().value as string);
    }
  };

  /**
   * Queue the bot mentions among a thread's replies that nothing has handled.
   * Only mentions of miniOG: an owner tag in a thread reply never reached the
   * intake live either. A reply miniOG answered later is recorded instead,
   * except a stop while the thread's job still runs: its later posts are
   * progress, not an answer to the stop.
   */
  const recoverThreadMentions = async (
    channelId: string,
    parentTs: string,
    replies: Array<Record<string, unknown>>,
    threadActive: boolean,
  ): Promise<number> => {
    let queued = 0;
    for (const reply of replies) {
      const replyTs = String(reply.ts ?? '');
      if (!replyTs || replyTs === parentTs) continue;
      const candidate = actionableMention(reply, config);
      if (!candidate || candidate.type !== 'bot') continue;
      const replayEventId = `replay:${channelId}:${replyTs}`;
      if (seen(channelId, replyTs, replayEventId)) continue;

      const replyEpoch = toEpochSeconds(replyTs);
      const answeredLater = replies.some(
        other => String(other.user ?? '') === config.botUserId && toEpochSeconds(String(other.ts ?? '')) > replyEpoch,
      );
      if (answeredLater && !(threadActive && isStopCommand(candidate.text))) {
        store.recordEvent(replayEventId, channelId, parentTs);
        continue;
      }

      await enqueue(
        {
          eventId: replayEventId,
          channelId,
          threadTs: parentTs,
          eventTs: replyTs,
          userId: candidate.userId,
          text: candidate.text,
          messageSubtype: candidate.subtype || undefined,
          rawEvent: reply,
        },
        webClient,
        'catchup',
      );
      remember(replayEventId);
      queued += 1;
    }
    return queued;
  };
  if (storedCursor > nowTs) {
    logger.warn(
      { component: 'slack-catchup', storedCursor, nowTs },
      'catch-up cursor is ahead of the clock (clock skew?) — resetting to the lookback window so recovery self-heals',
    );
  }

  logger.info(
    {
      component: 'slack-catchup',
      oldestTs,
      cursorTs: storedCursor || null,
      sweepSince,
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
  const threadsRead = new Set<string>();

  // Thread replies never appear in conversations.history, so an @mention
  // posted inside a thread was invisible here whenever the socket was down:
  // a "stop", a follow-up, a review ask (RCA 2026-07-29, issue #587). Every
  // scan reads the threads miniOG has a running, paused or recent job in.
  const recentSince = new Date(now(deps) - RECENT_JOB_THREAD_HOURS * 60 * 60 * 1000).toISOString();
  for (const thread of store.threadsWithRecentJobs(recentSince)) {
    threadsRead.add(`${thread.channelId}:${thread.threadTs}`);
    const replies = await fetchThreadReplies(webClient, thread.channelId, thread.threadTs, replyBoundary);
    scannedMessages += replies.length;
    recovered += await recoverThreadMentions(thread.channelId, thread.threadTs, replies, thread.active);
  }

  for (const channelId of channelIds) {
    // A sweep needs parents up to the lookback old: a fresh reply shows only
    // as its parent's reply metadata.
    const historyMessages = await fetchChannelHistory(
      webClient,
      channelId,
      sweepSince === null ? oldestTs : nowTs - CATCHUP_LOOKBACK_SECONDS,
    );
    if (historyMessages.length === 0) {
      continue;
    }

    const ordered = historyMessages
      .filter(message => typeof message.ts === 'string' && message.ts.length > 0)
      .sort((a, b) => Number(a.ts) - Number(b.ts));

    for (const message of ordered) {
      const eventTs = String(message.ts ?? '');
      if (!eventTs || toEpochSeconds(eventTs) <= oldestTs) {
        continue;
      }

      scannedMessages += 1;

      const candidate = actionableMention(message, config);
      if (!candidate) {
        continue;
      }
      const { text, userId, subtype } = candidate;

      const replayEventId = `replay:${channelId}:${eventTs}`;
      if (seen(channelId, eventTs, replayEventId)) {
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
        userId,
        text,
        messageSubtype: subtype || undefined,
        rawEvent: message as Record<string, unknown>,
      };

      await enqueue(envelope, webClient, 'catchup');
      remember(replayEventId);
      recovered += 1;
    }

    if (sweepSince === null) continue;
    // Sweep: every other thread with replies since the gap, latest first.
    const active = ordered
      .filter(parent => Number(parent.reply_count ?? 0) > 0)
      .filter(parent => toEpochSeconds(String(parent.latest_reply ?? '')) > sweepSince)
      .sort((a, b) => toEpochSeconds(String(b.latest_reply)) - toEpochSeconds(String(a.latest_reply)));
    for (const parent of active) {
      const parentTs = String(parent.ts ?? '');
      const key = `${channelId}:${parentTs}`;
      if (threadsRead.has(key)) continue;
      if (threadsRead.size >= CATCHUP_MAX_THREADS_PER_SCAN) {
        logger.warn(
          { component: 'slack-catchup', channelId, cap: CATCHUP_MAX_THREADS_PER_SCAN },
          'thread sweep hit its per-scan cap; older threads are left out',
        );
        break;
      }
      threadsRead.add(key);
      const replies = await fetchThreadReplies(webClient, channelId, parentTs, sweepSince);
      scannedMessages += replies.length;
      recovered += await recoverThreadMentions(channelId, parentTs, replies, false);
    }
  }

  // Advance to "now" only — never to a future-dated message timestamp. Combined
  // with the future-cursor self-heal in effectiveOldestTs, this keeps a clock
  // skew or stray future-dated message from permanently parking the cursor ahead
  // of real time and blinding the scanner.
  const nextCursor = nowTs;
  store.setState(CATCHUP_STATE_KEY, String(nextCursor));

  // Plain replies to a question miniOG asked are invisible to the scan above,
  // which looks for mentions; a restart used to lose them (issue #431).
  let answersRecovered = 0;
  try {
    answersRecovered = await catchUpParkedAnswers({ webClient, config, store, enqueue });
  } catch (error) {
    logger.warn({ component: 'slack-catchup', error: String(error) }, 'parked-answer catch-up failed');
  }

  logger.info(
    {
      component: 'slack-catchup',
      recovered,
      answersRecovered,
      scannedMessages,
      nextCursor,
    },
    'completed missed mention catch-up scan',
  );
}

type ActionableMention = { text: string; userId: string; subtype: string; type: 'bot' | 'owner' };

/**
 * The gate both passes share: no edits, deletions or bot posts, nothing from
 * miniOG itself, and a mention of miniOG or an owner. Whether it was handled
 * already is the caller's to check.
 */
function actionableMention(message: Record<string, unknown>, config: AppConfig): ActionableMention | null {
  const subtype = message.subtype ? String(message.subtype) : '';
  if (subtype && NON_ACTIONABLE_SUBTYPES.has(subtype)) {
    return null;
  }
  const text = String(message.text ?? '');
  const userId = String(message.user ?? '');
  if (!text || !userId || userId === config.botUserId) {
    return null;
  }
  const mention = detectMention(text, config);
  if (mention.type !== 'bot' && mention.type !== 'owner') {
    return null;
  }
  return { text, userId, subtype, type: mention.type };
}

async function discoverChannels(client: WebClient, store: CatchupStore, config: AppConfig): Promise<string[]> {
  const accessChannels = getBundlesForConfig(config).flatMap(bundle => bundle.allowedChannelIds);
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
  oldestTs: number,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        oldest: String(oldestTs),
        inclusive: false,
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
    // A thread in a channel the token can't read (no groups:history) or one
    // that is gone fails the same way every scan: not worth a warning each time.
    const code = (error as { data?: { error?: string } }).data?.error ?? '';
    const quiet = ['missing_scope', 'not_in_channel', 'channel_not_found', 'thread_not_found'].includes(code);
    (quiet ? logger.debug.bind(logger) : logger.warn.bind(logger))(
      { component: 'slack-catchup', channelId, threadTs, error: String(error) },
      'failed to fetch thread replies during missed mention catch-up',
    );
  }

  // `oldest` + inclusive:false can still return the parent; keep replies after the boundary.
  return messages.filter(message => toEpochSeconds(String(message.ts ?? '')) > oldestTs);
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
