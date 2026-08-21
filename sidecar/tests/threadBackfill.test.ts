import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { JobStore } from '../src/state/jobStore.js';
import { runConversationBackfill } from '../src/conversation/threadBackfill.js';
import { __resetThreadCaptureCachesForTests } from '../src/conversation/threadCapture.js';
import type { AppConfig } from '../src/types/contracts.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: [],
  repoPaths: {
    newtonWeb: '/tmp/newton-web',
    newtonApi: '/tmp/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'codex',
  prReviewTimeoutMs: 60_000,
  bugFixTimeoutMs: 60_000,
  pmTaskTimeoutMs: 60_000,
  metabaseMcpUrl: '',
};

const PASS1_DONE_KEY = 'conversation_backfill:pass1_done';
const CHANNEL_CURSOR_PREFIX = 'conversation_backfill:channel:';

// Recent epochs so any recency logic comparing against real now stays sane.
const baseEpoch = Math.floor(Date.now() / 1000) - 7200;

function ts(offsetSeconds: number): string {
  return `${baseEpoch + offsetSeconds}.000100`;
}

type SlackMessage = Record<string, unknown>;

interface RepliesArgs {
  channel: string;
  ts: string;
  oldest?: string;
  cursor?: string;
}

interface HistoryArgs {
  channel: string;
  latest?: string;
  inclusive?: boolean;
  limit?: number;
}

interface StubOptions {
  channels?: string[];
  replies?: (args: RepliesArgs) => Promise<{ messages: SlackMessage[]; response_metadata?: { next_cursor?: string } }>;
  history?: (args: HistoryArgs) => Promise<{ messages?: SlackMessage[]; has_more?: boolean }>;
}

/**
 * WebClient stub for the backfill: conversations.replies / conversations.history
 * / users.conversations are the injectable fixtures; conversations.info and
 * users.info return plausible defaults so the capture path (channel meta +
 * display-name resolution) succeeds.
 */
function makeClient(options: StubOptions = {}) {
  const replies = vi.fn(options.replies ?? (async () => ({ messages: [], response_metadata: {} })));
  const history = vi.fn(options.history ?? (async () => ({ messages: [], has_more: false })));
  const usersConversations = vi.fn(async () => ({
    channels: (options.channels ?? []).map(id => ({ id })),
    response_metadata: {},
  }));
  const conversationsInfo = vi.fn(async (args: { channel: string }) => ({
    channel: { name: `chan-${args.channel}`, is_private: false, is_im: false, is_mpim: false },
  }));
  const usersInfo = vi.fn(async (args: { user: string }) => ({
    user: { name: `user-${args.user}`, real_name: `User ${args.user}` },
  }));
  const client = {
    conversations: { replies, history, info: conversationsInfo },
    users: { conversations: usersConversations, info: usersInfo },
  } as unknown as WebClient;
  return { client, replies, history, usersConversations, conversationsInfo, usersInfo };
}

function repliesFor(byThreadTs: Record<string, SlackMessage[]>) {
  return async (args: RepliesArgs) => ({ messages: byThreadTs[args.ts] ?? [], response_metadata: {} });
}

function readCursor(store: JobStore, channelId: string): { oldestReached?: number; done?: boolean } {
  const raw = store.getState(`${CHANNEL_CURSOR_PREFIX}${channelId}`);
  return raw ? (JSON.parse(raw) as { oldestReached?: number; done?: boolean }) : {};
}

describe('runConversationBackfill', () => {
  let dbDir: string;
  let store: JobStore;

  beforeEach(() => {
    __resetThreadCaptureCachesForTests();
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-backfill-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('pass 1 re-fetches known job/event refs, captures them, and never re-runs once done', async () => {
    const t1 = ts(0);
    const t2 = ts(100);
    store.recordEvent('ev-job', 'C1', t1);
    store.createJob({
      id: 'job-1',
      eventId: 'ev-job',
      dedupeKey: `C1:${t1}:PR_REVIEW`,
      workflow: 'PR_REVIEW',
      channelId: 'C1',
      threadTs: t1,
      payload: {},
    });
    store.recordEvent('ev-2', 'C2', t2);
    // Same ref in both jobs and events must be fetched once (DISTINCT union).
    store.recordEvent('ev-dup', 'C1', t1);

    const stub = makeClient({
      replies: repliesFor({
        [t1]: [
          { ts: t1, user: 'UHUMAN', text: 'first thread root' },
          { ts: ts(10), user: 'UBOT', text: 'miniOG reply one' },
        ],
        [t2]: [
          { ts: t2, user: 'UHUMAN', text: 'second thread root' },
          { ts: ts(110), user: 'UBOT', text: 'miniOG reply two' },
        ],
      }),
    });
    const deps = { webClient: stub.client, config, store };

    const result = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 50 });

    expect(result.pass1Threads).toBe(2);
    expect(result.messagesInserted).toBe(4);
    // 2 replies fetches + 1 users.conversations page for the (empty) pass 2.
    expect(result.requestsUsed).toBe(3);
    expect(result.complete).toBe(true);
    expect(store.getState(PASS1_DONE_KEY)).toBe('1');
    expect(stub.replies).toHaveBeenCalledTimes(2);

    const conversations = store.conversationStore();
    const thread1 = conversations.getThread('C1', t1);
    expect(thread1?.messageCount).toBe(2);
    expect(thread1?.visibility).toBe('org');
    expect(conversations.getThread('C2', t2)?.messageCount).toBe(2);

    // Second run: pass 1 is done — the known refs are not re-fetched.
    const again = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 50 });
    expect(again.pass1Threads).toBe(0);
    expect(again.complete).toBe(true);
    expect(stub.replies).toHaveBeenCalledTimes(2);
  });

  it('pass 1 skips D-prefixed channel refs without spending a replies call', async () => {
    store.recordEvent('ev-dm', 'D555', ts(0));

    const stub = makeClient();
    const result = await runConversationBackfill(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, maxRequests: 10 },
    );

    expect(stub.replies).not.toHaveBeenCalled();
    expect(result.pass1Threads).toBe(0);
    // Only the users.conversations page was spent.
    expect(result.requestsUsed).toBe(1);
    expect(result.complete).toBe(true);
    expect(store.getState(PASS1_DONE_KEY)).toBe('1');
    expect(store.conversationStore().getThread('D555', ts(0))).toBeUndefined();
  });

  it('pass 1 never revives a forgotten (tombstoned) thread', async () => {
    const tGone = ts(0);
    const seeded = store.conversationStore().recordMessages({
      channelId: 'C7',
      threadTs: tGone,
      channelType: 'channel',
      visibility: 'org',
      messages: [{ messageTs: tGone, userId: 'UHUMAN', isBot: false, text: 'soon forgotten' }],
    });
    if ('skipped' in seeded) throw new Error('seed thread unexpectedly skipped');
    expect(store.conversationStore().forgetThread('C7', tGone)).toBeDefined();
    store.recordEvent('ev-forgotten', 'C7', tGone);

    const stub = makeClient({
      replies: repliesFor({
        [tGone]: [
          { ts: tGone, user: 'UHUMAN', text: 'soon forgotten' },
          { ts: ts(10), user: 'UBOT', text: 'miniOG once replied' },
        ],
      }),
    });
    const result = await runConversationBackfill(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, maxRequests: 10 },
    );

    expect(stub.replies).not.toHaveBeenCalled();
    expect(result.pass1Threads).toBe(0);
    expect(result.complete).toBe(true);
    const thread = store.conversationStore().getThread('C7', tGone);
    expect(thread?.status).toBe('forgotten');
    expect(thread?.messageCount).toBe(0);
  });

  it('pass 2 captures only threads miniOG participated in and marks the channel cursor done', async () => {
    const tRoot = ts(-100);
    const tMention = ts(-200);
    const tOther = ts(-300);
    const stub = makeClient({
      channels: ['CH1'],
      history: async () => ({
        messages: [
          { ts: tRoot, user: 'UHUMAN', text: 'root the bot replied under', reply_users: ['UBOT'], reply_count: 1 },
          { ts: tMention, user: 'UHUMAN', text: 'hey <@UBOT> can you check this?' },
          { ts: tOther, user: 'UOTHER', text: 'unrelated chatter' },
        ],
        has_more: false,
      }),
      replies: repliesFor({
        [tRoot]: [
          { ts: tRoot, user: 'UHUMAN', text: 'root the bot replied under' },
          { ts: ts(-90), user: 'UBOT', text: 'miniOG answered in-thread' },
        ],
        [tMention]: [
          { ts: tMention, user: 'UHUMAN', text: 'hey <@UBOT> can you check this?' },
          { ts: ts(-190), user: 'UBOT', text: 'on it' },
        ],
      }),
    });
    const deps = { webClient: stub.client, config, store };

    const result = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 50 });

    expect(result.pass2Channels).toBe(1);
    expect(result.pass2Threads).toBe(2);
    expect(result.complete).toBe(true);

    const conversations = store.conversationStore();
    expect(conversations.getThread('CH1', tRoot)?.messageCount).toBe(2);
    expect(conversations.getThread('CH1', tMention)?.messageCount).toBe(2);
    // The unrelated message never becomes a thread and never costs a fetch.
    expect(conversations.getThread('CH1', tOther)).toBeUndefined();
    const requested = stub.replies.mock.calls.map(call => (call[0] as RepliesArgs).ts).sort();
    expect(requested).toEqual([tMention, tRoot].sort());

    const cursor = readCursor(store, 'CH1');
    expect(cursor.done).toBe(true);
    expect(cursor.oldestReached).toBe(Number(tOther));

    // Second run: the done channel is skipped entirely — no history re-walk.
    const again = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 50 });
    expect(again.pass2Channels).toBe(0);
    expect(again.complete).toBe(true);
    expect(stub.history).toHaveBeenCalledTimes(1);
    expect(stub.replies).toHaveBeenCalledTimes(2);
  });

  it('stops when the request budget runs out and resumes from the persisted cursor', async () => {
    const tNew = ts(-50);
    const tOld = ts(-500);
    const stub = makeClient({
      channels: ['CH1'],
      history: async args => {
        if (args.latest === undefined) {
          return {
            messages: [{ ts: tNew, user: 'UHUMAN', text: 'newest root', reply_users: ['UBOT'] }],
            has_more: true,
          };
        }
        return { messages: [{ ts: tOld, user: 'UHUMAN', text: '<@UBOT> older ask' }], has_more: false };
      },
      replies: repliesFor({
        [tNew]: [
          { ts: tNew, user: 'UHUMAN', text: 'newest root' },
          { ts: ts(-40), user: 'UBOT', text: 'newest reply' },
        ],
        [tOld]: [
          { ts: tOld, user: 'UHUMAN', text: '<@UBOT> older ask' },
          { ts: ts(-490), user: 'UBOT', text: 'older answer' },
        ],
      }),
    });
    const deps = { webClient: stub.client, config, store };

    // Budget of 2: users.conversations (1) + one history page (2) → hard stop
    // BEFORE tNew is processed, so the cursor must NOT advance past it.
    const first = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 2 });
    expect(first.requestsUsed).toBe(2);
    expect(first.complete).toBe(false);
    expect(first.pass2Threads).toBe(0);
    expect(stub.replies).not.toHaveBeenCalled();
    // Pass 1 (zero refs) still finished inside the budget.
    expect(store.getState(PASS1_DONE_KEY)).toBe('1');
    const cursor = readCursor(store, 'CH1');
    expect(cursor.done).toBe(false);
    expect(cursor.oldestReached).toBeUndefined();

    // Rerun re-pages from the unadvanced cursor: the budget-boundary message
    // is seen again and captured — nothing is ever silently dropped.
    const second = await runConversationBackfill(deps, { requestGapMs: 0, maxRequests: 20 });
    expect(second.complete).toBe(true);
    expect(second.pass2Threads).toBe(2);
    const latestArgs = stub.history.mock.calls.map(call => (call[0] as HistoryArgs).latest);
    expect(latestArgs).toEqual([undefined, undefined, String(Number(tNew))]);
    expect(readCursor(store, 'CH1').done).toBe(true);
    expect(store.conversationStore().getThread('CH1', tOld)?.messageCount).toBe(2);
    expect(store.conversationStore().getThread('CH1', tNew)?.messageCount).toBe(2);
  });

  it('a history failure (not_in_channel) marks the channel done and the walk continues', async () => {
    const tOk = ts(-100);
    const stub = makeClient({
      channels: ['CERR', 'COK'],
      history: async args => {
        if (args.channel === 'CERR') throw new Error('An API error occurred: not_in_channel');
        return { messages: [{ ts: tOk, user: 'UHUMAN', text: 'root', reply_users: ['UBOT'] }], has_more: false };
      },
      replies: repliesFor({
        [tOk]: [
          { ts: tOk, user: 'UHUMAN', text: 'root' },
          { ts: ts(-90), user: 'UBOT', text: 'miniOG replied' },
        ],
      }),
    });

    const result = await runConversationBackfill(
      { webClient: stub.client, config, store },
      { requestGapMs: 0, maxRequests: 20 },
    );

    expect(result.pass2Channels).toBe(2);
    expect(result.pass2Threads).toBe(1);
    expect(result.complete).toBe(true);
    expect(readCursor(store, 'CERR').done).toBe(true);
    expect(store.conversationStore().getThread('COK', tOk)?.messageCount).toBe(2);
  });
});
