import { describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runMentionCatchup } from '../src/slack/mentionCatchup.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';
import type { JobStore } from '../src/state/jobStore.js';

// Regression tests for the catch-up thread-reply pass (RCA 2026-07-29):
// conversations.history never returns plain thread replies, so an @mention
// posted inside a thread while live socket delivery was down used to be
// silently dropped. Catch-up must spot fresh thread activity via the parent's
// reply metadata and scan conversations.replies for missed mentions.

const BOT = 'UBOT';

type HistoryMessage = Record<string, unknown>;

function makeConfig(): AppConfig {
  return {
    botUserId: BOT,
    ownerSlackUserIds: [],
    allowedChannelsForBugFix: [],
    accessControl: { groups: {} },
  } as unknown as AppConfig;
}

function makeStore(opts?: { cursor?: number; jobEventTs?: string[]; knownEvents?: string[] }) {
  const recordedEvents: Array<{ eventId: string; threadTs: string }> = [];
  const stateWrites: string[] = [];
  const events = new Set(opts?.knownEvents ?? []);
  const jobTs = new Set(opts?.jobEventTs ?? []);
  const store = {
    getState: () => (opts?.cursor ? String(opts.cursor) : undefined),
    setState: (_key: string, value: string) => {
      stateWrites.push(value);
    },
    hasEvent: (eventId: string) => events.has(eventId),
    recordEvent: (eventId: string, _channelId: string, threadTs: string) => {
      recordedEvents.push({ eventId, threadTs });
      events.add(eventId);
    },
    hasJobForEventTs: (_channelId: string, eventTs: string) => jobTs.has(eventTs),
    listKnownChannels: () => ['C1'],
  } as unknown as JobStore;
  return { store, recordedEvents, stateWrites };
}

function makeWebClient(history: HistoryMessage[], repliesByThread: Record<string, HistoryMessage[]>) {
  let repliesCalls = 0;
  const client = {
    users: {
      conversations: async () => ({ channels: [], response_metadata: {} }),
    },
    conversations: {
      history: async () => ({ messages: history, response_metadata: {} }),
      replies: async ({ ts }: { ts: string }) => {
        repliesCalls += 1;
        return { messages: repliesByThread[ts] ?? [], response_metadata: {} };
      },
    },
  } as unknown as WebClient;
  return { client, repliesCalls: () => repliesCalls };
}

function runCatchup(client: WebClient, store: JobStore) {
  const enqueued: SlackEventEnvelope[] = [];
  const enqueue = async (event: SlackEventEnvelope) => {
    enqueued.push(event);
  };
  return runMentionCatchup({ webClient: client, config: makeConfig(), store, enqueue }).then(() => enqueued);
}

describe('mention catch-up thread-reply pass', () => {
  const now = Math.floor(Date.now() / 1000);
  const parentTs = `${now - 1800}.000100`;
  const replyTs = `${now - 300}.000200`;
  const cursor = now - 900;

  it('recovers an unanswered @mention posted as a thread reply', async () => {
    // The RCA shape: parent mention already answered (job exists), follow-up
    // mention inside the thread never processed.
    const { store } = makeStore({ cursor, jobEventTs: [parentTs] });
    const { client } = makeWebClient(
      [{ ts: parentTs, text: `<@${BOT}> original question`, user: 'U1', reply_count: 2, latest_reply: replyTs }],
      {
        [parentTs]: [
          { ts: parentTs, text: `<@${BOT}> original question`, user: 'U1' },
          { ts: `${now - 1500}.000150`, text: 'first answer', user: BOT },
          { ts: replyTs, text: `<@${BOT}> follow-up question`, user: 'U1' },
        ],
      },
    );

    const enqueued = await runCatchup(client, store);

    expect(enqueued.length).toBe(1);
    expect(enqueued[0].eventId).toBe(`replay:C1:${replyTs}`);
    expect(enqueued[0].threadTs).toBe(parentTs);
    expect(enqueued[0].eventTs).toBe(replyTs);
    expect(enqueued[0].userId).toBe('U1');
  });

  it('records instead of enqueuing when the bot already replied after the mention', async () => {
    const { store, recordedEvents } = makeStore({ cursor, jobEventTs: [parentTs] });
    const { client } = makeWebClient(
      [{ ts: parentTs, text: `<@${BOT}> original question`, user: 'U1', reply_count: 3, latest_reply: replyTs }],
      {
        [parentTs]: [
          { ts: parentTs, text: `<@${BOT}> original question`, user: 'U1' },
          { ts: replyTs, text: `<@${BOT}> follow-up question`, user: 'U1' },
          { ts: `${now - 100}.000300`, text: 'the answer', user: BOT },
        ],
      },
    );

    const enqueued = await runCatchup(client, store);

    expect(enqueued.length).toBe(0);
    expect(recordedEvents).toEqual([{ eventId: `replay:C1:${replyTs}`, threadTs: parentTs }]);
  });

  it('skips reply fetching for threads without activity since the cursor', async () => {
    const staleReply = `${cursor - 600}.000200`;
    const { store } = makeStore({ cursor, jobEventTs: [parentTs] });
    const { client, repliesCalls } = makeWebClient(
      [{ ts: parentTs, text: `<@${BOT}> original question`, user: 'U1', reply_count: 1, latest_reply: staleReply }],
      {},
    );

    const enqueued = await runCatchup(client, store);

    expect(enqueued.length).toBe(0);
    expect(repliesCalls()).toBe(0);
  });

  it('does not re-enqueue a reply mention that already has a job', async () => {
    const { store } = makeStore({ cursor, jobEventTs: [parentTs, replyTs] });
    const { client } = makeWebClient(
      [{ ts: parentTs, text: `<@${BOT}> original question`, user: 'U1', reply_count: 2, latest_reply: replyTs }],
      {
        [parentTs]: [
          { ts: parentTs, text: `<@${BOT}> original question`, user: 'U1' },
          { ts: replyTs, text: `<@${BOT}> follow-up question`, user: 'U1' },
        ],
      },
    );

    const enqueued = await runCatchup(client, store);
    expect(enqueued.length).toBe(0);
  });

  it('still recovers unanswered top-level mentions (first pass unchanged)', async () => {
    const topLevelTs = `${now - 120}.000400`;
    const { store } = makeStore({ cursor });
    const { client } = makeWebClient(
      [{ ts: topLevelTs, text: `<@${BOT}> fresh question`, user: 'U2' }],
      // hasBotResponseAfterMention consults replies for the mention's thread.
      { [topLevelTs]: [{ ts: topLevelTs, text: `<@${BOT}> fresh question`, user: 'U2' }] },
    );

    const enqueued = await runCatchup(client, store);

    expect(enqueued.length).toBe(1);
    expect(enqueued[0].eventId).toBe(`replay:C1:${topLevelTs}`);
    expect(enqueued[0].threadTs).toBe(topLevelTs);
  });
});
