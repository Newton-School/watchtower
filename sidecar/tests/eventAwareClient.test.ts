import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { buildEventAwareClient } from '../src/slack/eventAwareClient.js';
import { MAX_REPLY_PARTS, REST_IN_FILE } from '../src/slack/replyParts.js';
import type { SlackEventEnvelope } from '../src/types/contracts.js';

const THREAD = '1700000000.000100';

const event = {
  eventId: 'Ev1',
  channelId: 'C1',
  threadTs: THREAD,
  eventTs: THREAD,
  userId: 'U1',
  text: 'hi',
} as SlackEventEnvelope;

/** A reply of `count` paragraphs of about 1,900 characters each: two to a message. */
function longReply(count: number): string {
  return Array.from({ length: count }, (_, i) => `${Array.from({ length: 300 }, () => `p${i}xx`).join(' ')}.`).join(
    '\n\n',
  );
}

function fakeClient(postMessage: ReturnType<typeof vi.fn>) {
  const remove = vi.fn().mockResolvedValue({ ok: true });
  const filesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
  const client = { chat: { postMessage, delete: remove }, filesUploadV2 } as unknown as WebClient;
  return { client, remove, filesUploadV2 };
}

/** Slack's answer to a reply that landed in the thread. */
function inThread() {
  let n = 0;
  return vi.fn(async () => ({ ok: true, ts: `1700000001.00000${++n}`, message: { thread_ts: THREAD } }));
}

function sent(postMessage: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return postMessage.mock.calls.map(call => (call as unknown[])[0] as Record<string, unknown>);
}

describe('buildEventAwareClient: long replies (issue #623)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts each part in the thread, broadcasts only the first, and answers with its ts', async () => {
    const postMessage = inThread();
    const { client } = fakeClient(postMessage);
    const slack = buildEventAwareClient(client, event, { onOrphanPromoted: vi.fn() });

    const response = await slack.chat.postMessage({
      channel: 'C1',
      thread_ts: THREAD,
      text: longReply(5),
      reply_broadcast: true,
    });

    const calls = sent(postMessage);
    expect(calls.length).toBe(3);
    expect(calls.map(call => call.thread_ts)).toEqual([THREAD, THREAD, THREAD]);
    expect(calls.map(call => call.reply_broadcast)).toEqual([true, false, false]);
    for (const call of calls) expect(String(call.text).length).toBeLessThanOrEqual(3_900);
    expect(response.ts).toBe('1700000001.000001');
  });

  it('stops when Slack moves the first part out of the thread, and reports the orphan', async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1700000001.000001', message: {} });
    const { client, remove } = fakeClient(postMessage);
    const onOrphanPromoted = vi.fn();
    const slack = buildEventAwareClient(client, event, { onOrphanPromoted });

    const response = await slack.chat.postMessage({ channel: 'C1', thread_ts: THREAD, text: longReply(5) });

    expect(response.ok).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ channel: 'C1', ts: '1700000001.000001' });
    expect(onOrphanPromoted).toHaveBeenCalledWith(expect.objectContaining({ orphanTs: '1700000001.000001' }));
  });

  it('logs a later part that fails instead of throwing', async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1700000001.000001', message: { thread_ts: THREAD } })
      .mockRejectedValueOnce(new Error('ratelimited'));
    const { client } = fakeClient(postMessage);
    const slack = buildEventAwareClient(client, event, { onOrphanPromoted: vi.fn() });

    await expect(slack.chat.postMessage({ channel: 'C1', thread_ts: THREAD, text: longReply(5) })).resolves.toEqual(
      expect.objectContaining({ ts: '1700000001.000001' }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('sends the other parts as one response_url post when the bot is not in the channel', async () => {
    const postMessage = vi.fn().mockRejectedValue({ data: { error: 'not_in_channel' } });
    const fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetch);
    const { client } = fakeClient(postMessage);
    const slack = buildEventAwareClient(
      client,
      { ...event, responseUrl: 'https://hooks.slack.test/r' },
      { onOrphanPromoted: vi.fn() },
    );

    const response = await slack.chat.postMessage({ channel: 'C1', thread_ts: THREAD, text: longReply(5) });

    expect(response.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(
      call => JSON.parse(String((call[1] as { body: string }).body)) as { text: string },
    );
    expect(bodies[0].text.startsWith('p0xx')).toBe(true);
    expect(bodies[1].text).toContain('p2xx');
    expect(bodies[1].text).toContain('p4xx');
  });

  it(`posts at most ${MAX_REPLY_PARTS} parts and puts the rest of the reply in a file`, async () => {
    const postMessage = inThread();
    const { client, filesUploadV2 } = fakeClient(postMessage);
    const slack = buildEventAwareClient(client, event, { onOrphanPromoted: vi.fn() });

    await slack.chat.postMessage({ channel: 'C1', thread_ts: THREAD, text: longReply(2 * MAX_REPLY_PARTS + 3) });

    expect(postMessage).toHaveBeenCalledTimes(MAX_REPLY_PARTS);
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    const upload = filesUploadV2.mock.calls[0][0] as { thread_ts: string; initial_comment: string; file: Buffer };
    expect(upload.thread_ts).toBe(THREAD);
    expect(upload.initial_comment).toBe(REST_IN_FILE);
    expect(upload.file.toString('utf8')).toContain(`p${2 * MAX_REPLY_PARTS + 2}xx`);
  });
});
