import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * Minimum gap between two `assistant.threads.setStatus` calls. Slack allows 600
 * req/min, so this is not about the rate limit — a status line that changes ten
 * times a second is unreadable. Updates inside the window coalesce and only the
 * newest text is sent (trailing edge).
 */
const MIN_INTERVAL_MS = 800;

/**
 * Slack expires a thread status after ~2 minutes. Re-send the current text
 * before that so a long silent stretch (a multi-minute agent run between two
 * logStep calls) does not look like miniOG died.
 */
const KEEPALIVE_MS = 90_000;

/** Consecutive transport failures tolerated before the status latch trips. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Errors that can never succeed on retry for this thread — missing scope, a bad
 * channel, a deleted parent. Latch off immediately rather than burning a call
 * per logStep for the rest of the job.
 */
const FATAL_SLACK_ERRORS = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'channel_not_found',
  'not_in_channel',
  'invalid_thread_ts',
  'thread_not_found',
  'method_deprecated',
  'deprecated_endpoint',
]);

export interface ThreadStatus {
  /**
   * Request a new status line. Fire-and-forget: never throws, never returns a
   * promise, so synchronous call sites (`logStep`) stay synchronous.
   */
  set(text: string): void;
  /**
   * Keep the current text but stop refreshing it. For human-wait gates
   * (approval, clarification) that idle for hours — the status expires
   * naturally instead of being pinned. The next `set()` resumes refreshing.
   */
  suspend(): void;
  /** Clear the status now. Slack also clears it whenever the app posts a message. */
  clear(): Promise<void>;
  /** Release timers. Must be called on every terminal path or the keepalive leaks. */
  dispose(): void;
}

/**
 * Live "miniOG is reading src/foo.ts…" status for a Slack thread, backed by
 * `assistant.threads.setStatus`.
 *
 * Slack renders the status as `<App Name> <status text>`, so callers pass a
 * verb phrase ("is reading …"), not a sentence.
 *
 * Every failure mode is swallowed. Status is decoration: it must never abort a
 * job, and there is no config flag for this feature, so the internal latch is
 * the kill switch — one WARN `logStep` when it trips, silence afterwards.
 *
 * NOTE: `buildEventAwareClient` in index.ts only patches `chat.postMessage`, so
 * none of its `not_in_channel` / deleted-parent handling applies here. This
 * module owns its own error handling.
 */
export function createThreadStatus(params: {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  logStep: WorkflowStepLogger;
}): ThreadStatus {
  const { slack, channelId, threadTs, logStep } = params;

  let disabled = false;
  let disposed = false;
  /** Newest requested text not yet accepted by Slack. */
  let desired: string | undefined;
  /** Last text Slack accepted — what the keepalive re-sends. */
  let lastSent: string | undefined;
  let sending = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = 0;
  let consecutiveFailures = 0;

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  }

  function armKeepalive(): void {
    if (disabled || disposed) return;
    stopKeepalive();
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = undefined;
      if (disabled || disposed || lastSent === undefined || lastSent === '') return;
      // Re-assert the same text; Slack treats it as a fresh 2-minute window.
      desired = lastSent;
      void flush(true);
    }, KEEPALIVE_MS);
    // A pending keepalive must not hold the process open — the sidecar is long
    // running, but a leaked ref would also pin the WebClient and the job.
    keepaliveTimer.unref?.();
  }

  function disable(reason: string, detail: string): void {
    if (disabled) return;
    disabled = true;
    clearFlushTimer();
    stopKeepalive();
    desired = undefined;
    logStep({
      level: 'WARN',
      stage: 'slack.status.disabled',
      message: `Live thread status turned off for this job (${reason}).`,
      data: { reason, detail },
    });
  }

  /** Pull the Slack error code out of whatever the SDK threw. */
  function slackErrorCode(error: unknown): string {
    const data = (error as { data?: { error?: unknown } } | undefined)?.data;
    if (data && typeof data.error === 'string') return data.error;
    const code = (error as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string') return code;
    return String(error);
  }

  /** `Retry-After` seconds from a rate-limit rejection, if present. */
  function retryAfterMs(error: unknown): number | undefined {
    const retryAfter = (error as { retryAfter?: unknown } | undefined)?.retryAfter;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) return retryAfter * 1000;
    const headers = (error as { data?: { response_metadata?: { retry_after?: unknown } } } | undefined)?.data
      ?.response_metadata?.retry_after;
    if (typeof headers === 'number' && Number.isFinite(headers)) return headers * 1000;
    return undefined;
  }

  function scheduleFlush(): void {
    if (disabled || disposed || sending || flushTimer || desired === undefined) return;
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSentAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush(false);
    }, wait);
    flushTimer.unref?.();
  }

  async function flush(isKeepalive: boolean): Promise<void> {
    if (disabled || disposed || sending) return;
    const text = desired;
    if (text === undefined) return;
    // Skip no-op repeats, but never skip a keepalive: re-sending identical text
    // is exactly how the 2-minute expiry is beaten.
    if (!isKeepalive && text === lastSent) {
      desired = undefined;
      return;
    }

    sending = true;
    desired = undefined;
    try {
      await slack.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: text,
      });
      lastSent = text;
      lastSentAt = Date.now();
      consecutiveFailures = 0;
      if (text === '') {
        stopKeepalive();
      } else {
        armKeepalive();
      }
    } catch (error) {
      const code = slackErrorCode(error);
      if (FATAL_SLACK_ERRORS.has(code)) {
        disable(code, String(error));
        return;
      }
      if (code === 'ratelimited' || code === 'rate_limited') {
        // Put the text back and retry after the server-specified delay.
        desired = desired ?? text;
        lastSentAt = Date.now() + (retryAfterMs(error) ?? 1000) - MIN_INTERVAL_MS;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        disable('repeated transport failures', String(error));
      }
    } finally {
      sending = false;
      scheduleFlush();
    }
  }

  return {
    set(text: string): void {
      if (disabled || disposed) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      desired = trimmed;
      scheduleFlush();
    },

    suspend(): void {
      stopKeepalive();
    },

    async clear(): Promise<void> {
      if (disabled || disposed) return;
      // Nothing was ever shown — no point posting an empty status.
      if (lastSent === undefined || lastSent === '') {
        stopKeepalive();
        return;
      }
      clearFlushTimer();
      stopKeepalive();
      // Bypass the throttle: clearing is terminal and must not be coalesced away.
      desired = '';
      lastSentAt = 0;
      await flush(false);
    },

    dispose(): void {
      disposed = true;
      clearFlushTimer();
      stopKeepalive();
      desired = undefined;
    },
  };
}
