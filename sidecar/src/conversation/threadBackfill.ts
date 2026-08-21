import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { fetchThreadRepliesSince } from '../slack/threadContext.js';
import type { JobStore } from '../state/jobStore.js';
import type { AppConfig } from '../types/contracts.js';
import { captureThreadFromMessages, shouldCapture } from './threadCapture.js';

/**
 * One-time (resumable) historical backfill of the conversation store (M5).
 * Slack retains everything; the DB only started capturing when the
 * conversation layer shipped — this walks history and captures every thread
 * miniOG took part in. Operator-triggered: set
 * WATCHTOWER_CONVERSATION_BACKFILL=1 and (re)start the sidecar; progress is
 * cursor-persisted in sidecar_state, so interrupted runs resume.
 *
 * Pass 1 (cheap, high precision): every (channel, thread) still referenced by
 * the jobs/events tables is re-fetched from Slack in full.
 * Pass 2 (broad): walk each channel's history backwards, capturing thread
 * roots miniOG participated in (was mentioned, or replied).
 *
 * Rate discipline: conversations.history/replies are Tier 3 (~50/min) — one
 * request per ~1.3s, with per-run caps so a boot never spends unbounded time.
 * Everything is idempotent (dedupe on message_ts; tombstones never revived).
 */

const PASS1_DONE_KEY = 'conversation_backfill:pass1_done';
const CHANNEL_CURSOR_PREFIX = 'conversation_backfill:channel:';

export const BACKFILL_REQUEST_GAP_MS = 1300;
export const BACKFILL_MAX_REQUESTS_PER_RUN = 400;
export const BACKFILL_HISTORY_PAGE_SIZE = 200;
export const BACKFILL_MAX_PAGES_PER_CHANNEL = 5;

export interface BackfillDeps {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
}

export interface BackfillRunResult {
  pass1Threads: number;
  pass2Channels: number;
  pass2Threads: number;
  messagesInserted: number;
  requestsUsed: number;
  complete: boolean;
}

interface ChannelCursor {
  /** Oldest epoch-seconds ts already examined; the walk continues below it. */
  oldestReached?: number;
  done?: boolean;
}

function readCursor(store: JobStore, channelId: string): ChannelCursor {
  try {
    const raw = store.getState(`${CHANNEL_CURSOR_PREFIX}${channelId}`);
    return raw ? (JSON.parse(raw) as ChannelCursor) : {};
  } catch {
    return {};
  }
}

function writeCursor(store: JobStore, channelId: string, cursor: ChannelCursor): void {
  store.setState(`${CHANNEL_CURSOR_PREFIX}${channelId}`, JSON.stringify(cursor));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function listChannels(client: WebClient): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.users.conversations({
      cursor,
      limit: 200,
      types: 'public_channel,private_channel',
      exclude_archived: true,
    });
    for (const channel of response.channels ?? []) {
      if (channel.id) ids.push(channel.id);
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

function botParticipated(message: Record<string, unknown>, botUserId: string): boolean {
  if (String(message.user ?? '') === botUserId) return true;
  if (String(message.text ?? '').includes(`<@${botUserId}>`)) return true;
  const replyUsers = message.reply_users;
  return Array.isArray(replyUsers) && replyUsers.some(u => String(u) === botUserId);
}

export async function runConversationBackfill(
  deps: BackfillDeps,
  opts?: { requestGapMs?: number; maxRequests?: number },
): Promise<BackfillRunResult> {
  const { webClient, config, store } = deps;
  const gap = opts?.requestGapMs ?? BACKFILL_REQUEST_GAP_MS;
  const maxRequests = opts?.maxRequests ?? BACKFILL_MAX_REQUESTS_PER_RUN;

  let requestsUsed = 0;
  let messagesInserted = 0;
  const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
    requestsUsed += 1;
    const result = await fn();
    if (gap > 0) await sleep(gap);
    return result;
  };

  const captureFullThread = async (channelId: string, threadTs: string): Promise<boolean> => {
    if (shouldCapture(undefined, channelId) === 'skip') return false;
    if (store.conversationStore().getThread(channelId, threadTs)?.status === 'forgotten') return false;
    try {
      const replies = await paced(() => fetchThreadRepliesSince(webClient, channelId, threadTs, '0'));
      if (replies.length === 0) return false;
      const result = await captureThreadFromMessages({
        client: webClient,
        store,
        config,
        channelId,
        threadTs,
        messages: replies,
      });
      if (result && !('skipped' in result)) {
        messagesInserted += result.inserted;
        return true;
      }
    } catch (err) {
      logger.debug({ channelId, threadTs, err: String(err) }, 'conversation backfill: thread fetch failed');
    }
    return false;
  };

  // ── Pass 1: refs the DB already knows about ─────────────────────────────
  let pass1Threads = 0;
  if (store.getState(PASS1_DONE_KEY) !== '1') {
    const refs = store.listKnownThreadRefs();
    logger.info({ refs: refs.length }, 'conversation backfill: pass 1 starting (known thread refs)');
    for (const ref of refs) {
      if (requestsUsed >= maxRequests) break;
      if (await captureFullThread(ref.channelId, ref.threadTs)) pass1Threads += 1;
    }
    if (requestsUsed < maxRequests) {
      store.setState(PASS1_DONE_KEY, '1');
    }
  }

  // ── Pass 2: channel-history walk (resumable per channel) ────────────────
  let pass2Channels = 0;
  let pass2Threads = 0;
  let allChannelsDone = true;
  if (requestsUsed < maxRequests) {
    const channels = (await paced(() => listChannels(webClient))).filter(id => shouldCapture(undefined, id) !== 'skip');
    for (const channelId of channels) {
      if (requestsUsed >= maxRequests) {
        allChannelsDone = false;
        break;
      }
      const cursor = readCursor(store, channelId);
      if (cursor.done) continue;
      pass2Channels += 1;

      let latest = cursor.oldestReached;
      let pages = 0;
      let exhausted = false;
      while (pages < BACKFILL_MAX_PAGES_PER_CHANNEL && requestsUsed < maxRequests) {
        let response;
        try {
          response = await paced(() =>
            webClient.conversations.history({
              channel: channelId,
              latest: latest !== undefined ? String(latest) : undefined,
              inclusive: false,
              limit: BACKFILL_HISTORY_PAGE_SIZE,
            }),
          );
        } catch (err) {
          logger.debug({ channelId, err: String(err) }, 'conversation backfill: history fetch failed');
          exhausted = true; // e.g. not_in_channel — nothing more to do here
          break;
        }
        pages += 1;
        const messages = (response.messages ?? []) as Array<Record<string, unknown>>;
        if (messages.length === 0) {
          exhausted = true;
          break;
        }
        let pageFullyProcessed = true;
        for (const message of messages) {
          const ts = String(message.ts ?? '');
          if (!ts) continue;
          // Budget check BEFORE advancing the cursor past this message: the
          // persisted `oldestReached` is exclusive on resume, so advancing it
          // for a message we did NOT process would drop that message forever.
          if (requestsUsed >= maxRequests) {
            pageFullyProcessed = false;
            break;
          }
          if (botParticipated(message, config.botUserId)) {
            if (await captureFullThread(channelId, ts)) pass2Threads += 1;
          }
          const epoch = Number(ts);
          if (Number.isFinite(epoch)) latest = latest === undefined ? epoch : Math.min(latest, epoch);
        }
        if (!pageFullyProcessed) {
          break;
        }
        if (!response.has_more) {
          exhausted = true;
          break;
        }
      }
      writeCursor(store, channelId, { oldestReached: latest, done: exhausted });
      if (!exhausted) allChannelsDone = false;
    }
  } else {
    allChannelsDone = false;
  }

  const complete = store.getState(PASS1_DONE_KEY) === '1' && allChannelsDone;
  logger.info(
    { pass1Threads, pass2Channels, pass2Threads, messagesInserted, requestsUsed, complete },
    complete
      ? 'conversation backfill: complete'
      : 'conversation backfill: budget spent — rerun (keep WATCHTOWER_CONVERSATION_BACKFILL=1) to continue',
  );
  return { pass1Threads, pass2Channels, pass2Threads, messagesInserted, requestsUsed, complete };
}
