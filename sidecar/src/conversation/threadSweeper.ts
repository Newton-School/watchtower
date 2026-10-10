import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import type { JobStore } from '../state/jobStore.js';
import type { AppConfig } from '../types/contracts.js';
import { fetchThreadRepliesSince } from '../slack/threadContext.js';
import { captureThreadFromMessages } from './threadCapture.js';

/**
 * Reconciliation sweeper for the conversation store (pattern: mentionCatchup).
 * The live tap only sees messages while the sidecar is up and the socket is
 * healthy; this sweeper periodically re-fetches recently-active tracked
 * threads from Slack so downtime and dropped events can't leave holes in the
 * transcript. Idempotent by construction — every write dedupes on
 * (channel_id, thread_ts, message_ts).
 *
 * It also owns the active → idle flip: a thread quiet for IDLE_AFTER_MINUTES
 * leaves the sweep set (and becomes eligible for optional message pruning).
 */

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_MAX_AGE_DAYS = 7;
export const SWEEP_STALE_CAPTURE_MINUTES = 30;
export const SWEEP_THREADS_PER_TICK = 30;
export const IDLE_AFTER_MINUTES = 360;
/** conversations.replies is Tier 3 (~50 req/min) — stay well under it. */
const SWEEP_REQUEST_GAP_MS = 1300;

export interface ThreadSweeperDeps {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
}

let sweeperTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runThreadSweepOnce(
  deps: ThreadSweeperDeps,
  opts?: { now?: Date; requestGapMs?: number },
): Promise<{ swept: number; appended: number; idled: number }> {
  const { webClient, config, store } = deps;
  const now = opts?.now ?? new Date();
  const requestGapMs = opts?.requestGapMs ?? SWEEP_REQUEST_GAP_MS;

  const conversations = store.conversationStore();

  // Threads that went quiet beyond the sweep window (e.g. during sidecar
  // downtime) will never be visited below — flip them idle in bulk so they
  // leave the active set and become eligible for optional message pruning.
  const staleFlipped = conversations.markStaleThreadsIdle(SWEEP_MAX_AGE_DAYS, now);
  if (staleFlipped > 0) {
    logger.info({ staleFlipped }, 'thread sweeper: flipped stale active threads to idle');
  }

  const threads = conversations.listActiveThreadsForSweep({
    maxAgeDays: SWEEP_MAX_AGE_DAYS,
    staleCaptureMinutes: SWEEP_STALE_CAPTURE_MINUTES,
    limit: SWEEP_THREADS_PER_TICK,
    now,
  });

  let appended = 0;
  let idled = 0;

  for (const thread of threads) {
    let fetchFailed = false;
    try {
      const replies = await fetchThreadRepliesSince(
        webClient,
        thread.channelId,
        thread.threadTs,
        thread.lastActivityTs ?? '0',
      );
      const result = await captureThreadFromMessages({
        client: webClient,
        store,
        config,
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        channelType: thread.channelType,
        messages: replies,
      });
      if (result && !('skipped' in result)) {
        appended += result.inserted;
      }
    } catch (err) {
      fetchFailed = true;
      logger.warn(
        { channelId: thread.channelId, threadTs: thread.threadTs, err: String(err) },
        'thread sweeper: re-fetch failed; will retry after the stale window',
      );
      // Advance last_captured_at even on failure: a permanently-failing
      // thread (bot kicked, channel archived → channel_not_found forever)
      // must rotate to the back of the last_captured_at-ordered batch instead
      // of starving every tick's LIMIT with guaranteed failures.
      conversations.touchCaptured(thread.id);
    }

    // Idle flip: re-read after the capture so a thread that just gained
    // messages stays active. Skipped on a failed fetch — we could not observe
    // recent activity, so we must not conclude the thread is quiet.
    if (!fetchFailed) {
      const fresh = conversations.getThread(thread.channelId, thread.threadTs);
      const lastActivityEpoch = Number(fresh?.lastActivityTs ?? thread.lastActivityTs ?? 0);
      if (
        fresh?.status === 'active' &&
        Number.isFinite(lastActivityEpoch) &&
        lastActivityEpoch > 0 &&
        now.getTime() / 1000 - lastActivityEpoch > IDLE_AFTER_MINUTES * 60
      ) {
        conversations.markIdle(fresh.id);
        idled += 1;
      }
    }

    if (requestGapMs > 0) {
      await sleep(requestGapMs);
    }
  }

  if (threads.length > 0) {
    logger.info({ swept: threads.length, appended, idled }, 'thread sweeper: tick complete');
  }
  return { swept: threads.length, appended, idled };
}

export function startThreadSweeper(deps: ThreadSweeperDeps): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    void runThreadSweepOnce(deps).catch(err => logger.warn({ err: String(err) }, 'thread sweeper tick failed'));
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeperTimer.unref === 'function') sweeperTimer.unref();
  logger.info('thread sweeper started');
}

export function stopThreadSweeper(): void {
  if (!sweeperTimer) return;
  clearInterval(sweeperTimer);
  sweeperTimer = null;
}

/** Test-only helper. */
export function __resetThreadSweeperForTests(): void {
  sweeperTimer = null;
}
