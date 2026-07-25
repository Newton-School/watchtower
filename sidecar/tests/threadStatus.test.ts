import type { WebClient } from '@slack/web-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadStatus } from '../src/slack/threadStatus.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

/** Minimal WebClient stub exposing only assistant.threads.setStatus. */
function fakeSlack(setStatus: ReturnType<typeof vi.fn>): WebClient {
  return { assistant: { threads: { setStatus } } } as unknown as WebClient;
}

/** Slack SDK rejections carry the API error code under `data.error`. */
function slackError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code }, ...extra });
}

function harness(setStatus: ReturnType<typeof vi.fn>): {
  status: ReturnType<typeof createThreadStatus>;
  logs: WorkflowStepLog[];
} {
  const logs: WorkflowStepLog[] = [];
  const status = createThreadStatus({
    slack: fakeSlack(setStatus),
    channelId: 'C1',
    threadTs: '1.1',
    logStep: step => logs.push(step),
  });
  return { status, logs };
}

/** Text of every setStatus call, in order. */
function sentTexts(setStatus: ReturnType<typeof vi.fn>): string[] {
  return setStatus.mock.calls.map(call => (call[0] as { status: string }).status);
}

describe('createThreadStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid updates and sends only the newest text', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is reading a.ts…');
    status.set('is reading b.ts…');
    status.set('is reading c.ts…');
    await vi.advanceTimersByTimeAsync(10);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(sentTexts(setStatus)).toEqual(['is reading c.ts…']);
    expect(setStatus.mock.calls[0][0]).toMatchObject({ channel_id: 'C1', thread_ts: '1.1' });
  });

  it('throttles a burst into spaced calls rather than dropping the tail', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('first');
    await vi.advanceTimersByTimeAsync(10);
    status.set('second');
    // Inside the 800ms window: not sent yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(setStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(800);
    expect(sentTexts(setStatus)).toEqual(['first', 'second']);
  });

  it('does not re-send identical text', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is thinking…');
    await vi.advanceTimersByTimeAsync(10);
    status.set('is thinking…');
    await vi.advanceTimersByTimeAsync(2000);

    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it('re-sends the current text as a keepalive to beat the 2-minute expiry', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is running the review lenses…');
    await vi.advanceTimersByTimeAsync(10);
    expect(setStatus).toHaveBeenCalledTimes(1);

    // Nothing else happens for two minutes — the keepalive must fire inside it.
    await vi.advanceTimersByTimeAsync(95_000);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(sentTexts(setStatus)).toEqual(['is running the review lenses…', 'is running the review lenses…']);
  });

  it('suspend() stops the keepalive without clearing the text', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is waiting for your approval');
    await vi.advanceTimersByTimeAsync(10);
    status.suspend();

    // An approval gate can idle for hours; the status must not be refreshed.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it('latches off after a fatal error and logs exactly one WARN', async () => {
    const setStatus = vi.fn().mockRejectedValue(slackError('missing_scope'));
    const { status, logs } = harness(setStatus);

    status.set('is reading a.ts…');
    await vi.advanceTimersByTimeAsync(10);
    expect(setStatus).toHaveBeenCalledTimes(1);

    // Every later update must be a no-op — no retry storm for the rest of the job.
    for (let i = 0; i < 20; i += 1) {
      status.set(`update ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(setStatus).toHaveBeenCalledTimes(1);

    const disabled = logs.filter(log => log.stage === 'slack.status.disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0].level).toBe('WARN');
    expect(disabled[0].data?.reason).toBe('missing_scope');
  });

  it('tolerates transient failures and only latches off after repeated ones', async () => {
    const setStatus = vi.fn().mockRejectedValue(slackError('service_unavailable'));
    const { status, logs } = harness(setStatus);

    for (let i = 0; i < 3; i += 1) {
      status.set(`update ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(setStatus).toHaveBeenCalledTimes(3);
    expect(logs.filter(log => log.stage === 'slack.status.disabled')).toHaveLength(1);

    // Latched — no further calls.
    status.set('another');
    await vi.advanceTimersByTimeAsync(2000);
    expect(setStatus).toHaveBeenCalledTimes(3);
  });

  it('retries after a rate limit instead of latching off', async () => {
    const setStatus = vi
      .fn()
      .mockRejectedValueOnce(slackError('ratelimited', { retryAfter: 2 }))
      .mockResolvedValue({ ok: true });
    const { status, logs } = harness(setStatus);

    status.set('is querying metabase…');
    await vi.advanceTimersByTimeAsync(10);
    expect(setStatus).toHaveBeenCalledTimes(1);

    // The text is preserved and re-sent once the Retry-After window passes.
    await vi.advanceTimersByTimeAsync(3000);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(sentTexts(setStatus)[1]).toBe('is querying metabase…');
    expect(logs.filter(log => log.stage === 'slack.status.disabled')).toHaveLength(0);
  });

  it('clear() sends an empty status and stops the keepalive', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is writing the reply…');
    await vi.advanceTimersByTimeAsync(10);
    await status.clear();

    expect(sentTexts(setStatus)).toEqual(['is writing the reply…', '']);

    await vi.advanceTimersByTimeAsync(200_000);
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it('clear() is a no-op when no status was ever shown', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    await status.clear();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('dispose() stops all further sends and leaves no pending timer', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('is thinking…');
    await vi.advanceTimersByTimeAsync(10);
    status.dispose();

    status.set('should never send');
    await vi.advanceTimersByTimeAsync(200_000);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never propagates a throwing Slack client', async () => {
    const setStatus = vi.fn().mockImplementation(() => {
      throw new Error('socket exploded');
    });
    const { status } = harness(setStatus);

    expect(() => status.set('is thinking…')).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
    await expect(status.clear()).resolves.toBeUndefined();
  });

  it('ignores empty and whitespace-only updates', async () => {
    const setStatus = vi.fn().mockResolvedValue({ ok: true });
    const { status } = harness(setStatus);

    status.set('');
    status.set('   ');
    await vi.advanceTimersByTimeAsync(10);

    expect(setStatus).not.toHaveBeenCalled();
  });
});
