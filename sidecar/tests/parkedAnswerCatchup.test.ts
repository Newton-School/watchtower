import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { catchUpParkedAnswers } from '../src/slack/parkedAnswerCatchup.js';
import { ROUTE_CLARIFY_TTL_MS } from '../src/router/routeClarify.js';

const NOW = 1_791_000_600_000;
const ASKED = NOW - 5 * 60_000;

function parked(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    channelId: 'C1',
    threadTs: '1791000000.000100',
    pending: { question: 'What should I check?', requesterId: 'UREQ', askedAtMs: ASKED, askedText: 'check now' },
    ...overrides,
  };
}

function setup(options: { questions?: ReturnType<typeof parked>[]; replies?: unknown[]; seen?: string[] } = {}) {
  const enqueue = vi.fn(async () => {});
  const fetchReplies = vi.fn(async () => (options.replies ?? []) as never);
  const store = {
    pausedRouteQuestions: () => options.questions ?? [parked()],
    hasEvent: (eventId: string) => (options.seen ?? []).includes(eventId),
    hasJobForEventTs: () => false,
  };
  const run = () =>
    catchUpParkedAnswers({
      webClient: {} as WebClient,
      config: { botUserId: 'UBOT' },
      store,
      enqueue,
      nowMs: NOW,
      fetchReplies,
    });
  return { run, enqueue, fetchReplies };
}

// Issue #431: a plain reply to a question miniOG asked reaches the sidecar
// only through the live socket. Sent while the app was restarting, it was
// never seen and the job sat parked until it expired.
describe('catchUpParkedAnswers', () => {
  it("queues the requester's reply the socket missed, as the socket would have", async () => {
    const { run, enqueue, fetchReplies } = setup({
      replies: [
        { user: 'UOTHER', text: 'not me', ts: '1791000400.000100' },
        { user: 'UREQ', text: 'the login redirect', ts: '1791000450.000100' },
        { user: 'UREQ', text: 'and the signup one', ts: '1791000460.000100' },
      ],
    });

    await expect(run()).resolves.toBe(1);

    expect(fetchReplies).toHaveBeenCalledWith({}, 'C1', '1791000000.000100', (ASKED / 1000).toFixed(6));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      eventId: 'replay:C1:1791000450.000100',
      channelId: 'C1',
      threadTs: '1791000000.000100',
      eventTs: '1791000450.000100',
      userId: 'UREQ',
      text: 'the login redirect',
    });
    expect(enqueue.mock.calls[0][2]).toBe('catchup');
  });

  it('leaves a reply that mentions miniOG to the mention catch-up', async () => {
    const { run, enqueue } = setup({ replies: [{ user: 'UREQ', text: '<@UBOT> the login redirect', ts: '1.1' }] });
    await expect(run()).resolves.toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing when there is no reply yet, or it was already handled', async () => {
    expect(await setup({ replies: [] }).run()).toBe(0);
    const handled = setup({ replies: [{ user: 'UREQ', text: 'yes', ts: '2.2' }], seen: ['replay:C1:2.2'] });
    expect(await handled.run()).toBe(0);
    expect(handled.enqueue).not.toHaveBeenCalled();
  });

  it('skips an expired question without reading its thread', async () => {
    const expired = parked({ pending: { ...parked().pending, askedAtMs: NOW - ROUTE_CLARIFY_TTL_MS - 1 } });
    const { run, fetchReplies } = setup({ questions: [expired], replies: [{ user: 'UREQ', text: 'yes', ts: '3.3' }] });
    expect(await run()).toBe(0);
    expect(fetchReplies).not.toHaveBeenCalled();
  });

  it('moves on to the next question when a thread cannot be read', async () => {
    const enqueue = vi.fn(async () => {});
    const fetchReplies = vi
      .fn()
      .mockRejectedValueOnce(new Error('ratelimited'))
      .mockResolvedValueOnce([{ user: 'UREQ', text: 'yes', ts: '4.4' }]);
    const recovered = await catchUpParkedAnswers({
      webClient: {} as WebClient,
      config: { botUserId: 'UBOT' },
      store: {
        pausedRouteQuestions: () => [parked({ id: 'a' }), parked({ id: 'b', threadTs: '1791000000.000200' })],
        hasEvent: () => false,
        hasJobForEventTs: () => false,
      },
      enqueue,
      nowMs: NOW,
      fetchReplies,
    });
    expect(recovered).toBe(1);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ threadTs: '1791000000.000200', eventTs: '4.4' });
  });
});
