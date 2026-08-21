import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { JobStore } from '../src/state/jobStore.js';
import { runThreadSweepOnce, IDLE_AFTER_MINUTES } from '../src/conversation/threadSweeper.js';
import { __resetThreadCaptureCachesForTests } from '../src/conversation/threadCapture.js';
import type { AppConfig } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-sweeper-')), 'watchtower.db');
}

const config = { botUserId: 'UBOT' } as AppConfig;

type RepliesArgs = { channel: string; ts: string; oldest?: string; cursor?: string };
type RepliesPage = {
  messages: Array<{ ts: string; user?: string; text?: string }>;
  response_metadata?: { next_cursor?: string };
};

/**
 * WebClient stub for the sweeper: conversations.replies is the injectable
 * fixture; conversations.info and users.info return plausible defaults so the
 * capture path (channel meta + display-name resolution) succeeds.
 */
function makeClient(repliesImpl: (args: RepliesArgs) => Promise<RepliesPage>) {
  const replies = vi.fn(repliesImpl);
  const info = vi.fn(async (args: { channel: string }) => ({
    channel: { name: `chan-${args.channel}`, is_private: false, is_im: false, is_mpim: false },
  }));
  const usersInfo = vi.fn(async (args: { user: string }) => ({
    user: { name: `user-${args.user}`, real_name: `User ${args.user}` },
  }));
  const client = { conversations: { replies, info }, users: { info: usersInfo } } as unknown as WebClient;
  return { client, replies, info, usersInfo };
}

describe('runThreadSweepOnce', () => {
  let dbPath: string;
  let store: JobStore;
  // Epoch seconds "now" for building realistic Slack ts values.
  const base = Math.floor(Date.now() / 1000);
  // One hour in the future: makes every freshly-recorded thread look
  // stale-captured (last_captured_at is written with the real clock) without
  // touching rows by hand, while staying inside the 7-day activity window.
  const futureNow = new Date((base + 3600) * 1000);

  function seedThread(channelId: string, threadTs: string, messageTs: string[]): number {
    const result = store.conversationStore().recordMessages({
      channelId,
      threadTs,
      channelType: 'channel',
      visibility: 'org',
      messages: messageTs.map((ts, i) => ({
        messageTs: ts,
        userId: i === 0 ? 'UASKER' : 'UOTHER',
        isBot: false,
        text: `seed message ${i}`,
      })),
    });
    if ('skipped' in result) throw new Error('seed thread unexpectedly skipped');
    return result.threadId;
  }

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new JobStore(dbPath);
    __resetThreadCaptureCachesForTests();
  });

  afterEach(() => {
    store.close();
  });

  it('fetches replies newer than lastActivityTs with pagination and appends them dedupe-safe', async () => {
    const t0 = `${base - 600}.000100`;
    const t1 = `${base - 500}.000200`;
    const t2 = `${base - 400}.000300`;
    const tNew1 = `${base - 300}.000400`;
    const tNew2 = `${base - 200}.000500`;
    const threadId = seedThread('CPAGE', t0, [t0, t1, t2]);

    // Rewind last_activity_ts to the parent ts via a second raw handle, so the
    // sweep re-fetches a window that includes already-captured messages —
    // Slack re-returning t1/t2 must not duplicate them.
    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE conversation_threads SET last_activity_ts = ? WHERE channel_id = ? AND thread_ts = ?')
      .run(t0, 'CPAGE', t0);
    raw.close();

    const stub = makeClient(async args => {
      if (args.cursor === 'cursor-1') {
        return { messages: [{ ts: tNew2, user: 'UNEW', text: 'second page reply' }], response_metadata: {} };
      }
      return {
        // Deliberately out of order, with known messages mixed in.
        messages: [
          { ts: tNew1, user: 'UNEW', text: 'first page reply' },
          { ts: t1, user: 'UOTHER', text: 'seed message 1' },
          { ts: t2, user: 'UOTHER', text: 'seed message 2' },
        ],
        response_metadata: { next_cursor: 'cursor-1' },
      };
    });

    const result = await runThreadSweepOnce(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, now: futureNow },
    );
    expect(result).toEqual({ swept: 1, appended: 2, idled: 0 });

    // Pagination: two calls, second one carrying the cursor; oldest is the
    // (rewound) lastActivityTs.
    expect(stub.replies).toHaveBeenCalledTimes(2);
    expect(stub.replies.mock.calls[0][0]).toMatchObject({ channel: 'CPAGE', ts: t0, oldest: t0, inclusive: false });
    expect(stub.replies.mock.calls[0][0].cursor).toBeUndefined();
    expect(stub.replies.mock.calls[1][0]).toMatchObject({ channel: 'CPAGE', cursor: 'cursor-1' });

    // No duplicates, ascending order, aggregates refreshed.
    const conversations = store.conversationStore();
    const messages = conversations.getMessages(threadId);
    expect(messages.map(m => m.messageTs)).toEqual([t0, t1, t2, tNew1, tNew2]);
    const thread = conversations.getThread('CPAGE', t0);
    expect(thread?.messageCount).toBe(5);
    expect(thread?.lastActivityTs).toBe(tNew2);
    expect(thread?.status).toBe('active');
  });

  it('flips quiet threads to idle while a thread with fresh replies stays active', async () => {
    const quietTs = `${base - IDLE_AFTER_MINUTES * 60 - 2 * 3600}.000100`;
    const freshTs = `${base - 1800}.000100`;
    const freshReplyTs = `${base - 60}.000200`;
    seedThread('CQUIET', quietTs, [quietTs]);
    seedThread('CFRESH', freshTs, [freshTs]);

    const stub = makeClient(async args => {
      if (args.channel === 'CQUIET') return { messages: [], response_metadata: {} };
      return { messages: [{ ts: freshReplyTs, user: 'UNEW', text: 'fresh reply' }], response_metadata: {} };
    });

    const result = await runThreadSweepOnce(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, now: futureNow },
    );
    expect(result).toEqual({ swept: 2, appended: 1, idled: 1 });

    const conversations = store.conversationStore();
    expect(conversations.getThread('CQUIET', quietTs)?.status).toBe('idle');
    const fresh = conversations.getThread('CFRESH', freshTs);
    expect(fresh?.status).toBe('active');
    expect(fresh?.messageCount).toBe(2);
  });

  it('a replies failure on one thread does not abort the sweep and leaves it active for retry', async () => {
    const failTs = `${base - IDLE_AFTER_MINUTES * 60 - 2 * 3600}.000100`;
    const okTs = `${base - 600}.000100`;
    const okReplyTs = `${base - 60}.000200`;
    seedThread('CFAIL', failTs, [failTs]);
    seedThread('COK', okTs, [okTs]);

    // Backdate the failing thread's last_captured_at so it sorts first in the
    // sweep — proving the error does not stop later threads.
    const olderIso = new Date(Date.now() - 3600 * 1000).toISOString();
    const raw = new Database(dbPath);
    raw.prepare('UPDATE conversation_threads SET last_captured_at = ? WHERE channel_id = ?').run(olderIso, 'CFAIL');
    raw.close();

    const stub = makeClient(async args => {
      if (args.channel === 'CFAIL') throw new Error('ratelimited');
      return { messages: [{ ts: okReplyTs, user: 'UNEW', text: 'later reply' }], response_metadata: {} };
    });

    const result = await runThreadSweepOnce(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, now: futureNow },
    );
    expect(result).toEqual({ swept: 2, appended: 1, idled: 0 });

    const channels = stub.replies.mock.calls.map(call => call[0].channel);
    expect(channels).toEqual(['CFAIL', 'COK']);

    const conversations = store.conversationStore();
    const failed = conversations.getThread('CFAIL', failTs);
    // Quiet long past the idle horizon, but the failed fetch must NOT idle it
    // (we could not observe activity). Its capture timestamp IS advanced so a
    // permanently-failing thread rotates to the back of the batch instead of
    // starving every tick; the stale-capture window will retry it.
    expect(failed?.status).toBe('active');
    expect(failed?.lastCapturedAt).not.toBe(olderIso);
    expect(new Date(failed?.lastCapturedAt ?? 0).getTime()).toBeGreaterThan(new Date(olderIso).getTime());
    expect(failed?.messageCount).toBe(1);
    expect(conversations.getThread('COK', okTs)?.messageCount).toBe(2);
  });

  it('does nothing when no threads are stale', async () => {
    const ts = `${base - 300}.000100`;
    seedThread('CIDLE', ts, [ts]);

    const stub = makeClient(async () => ({ messages: [], response_metadata: {} }));
    // Real "now": the thread was captured milliseconds ago, well inside the
    // stale-capture window, so the sweep set is empty.
    const result = await runThreadSweepOnce(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, now: new Date() },
    );
    expect(result).toEqual({ swept: 0, appended: 0, idled: 0 });
    expect(stub.replies).not.toHaveBeenCalled();
    expect(stub.info).not.toHaveBeenCalled();
  });
});
