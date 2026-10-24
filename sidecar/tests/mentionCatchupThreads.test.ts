import { describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import {
  newCatchupState,
  runMentionCatchup,
  runThreadSweep,
  skipWhileRunning,
  type CatchupState,
} from '../src/slack/mentionCatchup.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

// Issue #587 (RCA 2026-07-29): conversations.history never returns plain
// thread replies, so an @mention posted inside a thread while the socket was
// down — a "stop", a follow-up, a review ask — was silently dropped. Every
// scan now reads the threads miniOG has a running, paused or recent job in;
// after a gap (a sleep, a dead socket, a restart) it sweeps every thread with
// replies since then.

const BOT = 'UBOT';
const OWNER = 'UOWNER';
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

type Message = Record<string, unknown>;

const at = (agoSeconds: number, seq = 100) => `${NOW - agoSeconds}.${String(seq).padStart(6, '0')}`;

function makeConfig(): AppConfig {
  return {
    botUserId: BOT,
    ownerSlackUserIds: [OWNER],
    allowedChannelsForBugFix: [],
    bundles: [],
  } as unknown as AppConfig;
}

function makeStore(
  opts: {
    cursor?: number;
    jobThreads?: Array<{ channelId: string; threadTs: string; active: boolean }>;
    jobEventTs?: string[];
    knownEvents?: string[];
  } = {},
) {
  const events = new Set(opts.knownEvents ?? []);
  const recorded: string[] = [];
  const jobTs = new Set(opts.jobEventTs ?? []);
  const store = {
    getState: () => String(opts.cursor ?? NOW - 120),
    setState: () => {},
    hasEvent: (eventId: string) => events.has(eventId),
    recordEvent: (eventId: string) => {
      recorded.push(eventId);
      events.add(eventId);
    },
    hasJobForEventTs: (_channelId: string, eventTs: string) => jobTs.has(eventTs),
    listKnownChannels: () => ['C1'],
    threadsWithRecentJobs: () => opts.jobThreads ?? [],
    pausedRouteQuestions: () => [],
  };
  return { store, recorded };
}

function makeSlack(history: Message[], threads: Record<string, Message[]>) {
  const repliesAsked: string[] = [];
  const client = {
    users: { conversations: async () => ({ channels: [], response_metadata: {} }) },
    conversations: {
      history: async ({ oldest }: { oldest: string }) => ({
        messages: history.filter(m => Number(m.ts) > Number(oldest)),
        response_metadata: {},
      }),
      replies: async ({ ts, oldest }: { ts: string; oldest?: string }) => {
        repliesAsked.push(ts);
        const all = threads[ts] ?? [];
        return { messages: oldest ? all.filter(m => Number(m.ts) > Number(oldest)) : all, response_metadata: {} };
      },
    },
  } as unknown as WebClient;
  return { client, repliesAsked };
}

async function scan(
  slack: WebClient,
  store: ReturnType<typeof makeStore>['store'],
  opts: { state?: CatchupState; deliveredLive?: (channelId: string, ts: string) => boolean } = {},
) {
  const queued: SlackEventEnvelope[] = [];
  await runMentionCatchup(
    {
      webClient: slack,
      config: makeConfig(),
      store: store as never,
      enqueue: async event => {
        queued.push(event);
      },
      deliveredLive: opts.deliveredLive,
      nowMs: () => NOW_MS,
    },
    opts.state ?? newCatchupState(),
  );
  return queued;
}

async function sweep(
  slack: WebClient,
  store: ReturnType<typeof makeStore>['store'],
  since: number,
  state: CatchupState = newCatchupState(),
) {
  const queued: SlackEventEnvelope[] = [];
  await runThreadSweep(
    {
      webClient: slack,
      config: makeConfig(),
      store: store as never,
      enqueue: async event => {
        queued.push(event);
      },
      nowMs: () => NOW_MS,
      paceMs: 0,
    },
    state,
    since,
  );
  return queued;
}

describe('mention catch-up: threads miniOG has jobs in', () => {
  const parent = at(1800);

  it('recovers "@miniOG stop" in a running job thread, though miniOG posted progress after it', async () => {
    const stop = at(60);
    const { store } = makeStore({ jobThreads: [{ channelId: 'C1', threadTs: parent, active: true }] });
    const { client } = makeSlack([], {
      [parent]: [
        { ts: parent, user: 'U1', text: `<@${BOT}> fix the banner` },
        { ts: stop, user: 'U1', text: `<@${BOT}> stop` },
        { ts: at(30), user: BOT, text: 'Coder is on step 3 of 5…' },
      ],
    });

    const queued = await scan(client, store);

    expect(queued.map(e => [e.eventId, e.threadTs, e.eventTs, e.text])).toEqual([
      [`replay:C1:${stop}`, parent, stop, `<@${BOT}> stop`],
    ]);
  });

  it('records, not queues, a follow-up miniOG already answered; queues one it did not', async () => {
    const answered = at(100, 1);
    const unanswered = at(50, 2);
    const { store, recorded } = makeStore({ jobThreads: [{ channelId: 'C1', threadTs: parent, active: false }] });
    const { client } = makeSlack([], {
      [parent]: [
        { ts: answered, user: 'U1', text: `<@${BOT}> and the footer?` },
        { ts: at(80, 3), user: BOT, text: 'Done.' },
        { ts: unanswered, user: 'U2', text: `<@${BOT}> can you review this too?` },
      ],
    });

    const queued = await scan(client, store);

    expect(queued.map(e => e.eventTs)).toEqual([unanswered]);
    expect(recorded).toEqual([`replay:C1:${answered}`]);
  });

  it('skips replies the socket delivered, ones already handled, and tags of the owner', async () => {
    const live = at(90, 1);
    const handled = at(80, 2);
    const jobbed = at(70, 3);
    const ownerTag = at(60, 4);
    const { store } = makeStore({
      jobThreads: [{ channelId: 'C1', threadTs: parent, active: true }],
      knownEvents: [`replay:C1:${handled}`],
      jobEventTs: [jobbed],
    });
    const { client } = makeSlack([], {
      [parent]: [
        { ts: live, user: 'U1', text: `<@${BOT}> one` },
        { ts: handled, user: 'U1', text: `<@${BOT}> two` },
        { ts: jobbed, user: 'U1', text: `<@${BOT}> three` },
        { ts: ownerTag, user: 'U1', text: `<@${OWNER}> is this right?` },
      ],
    });

    const queued = await scan(client, store, { deliveredLive: (_c, ts) => ts === live });

    expect(queued).toEqual([]);
  });

  it('queues a reply once, even when the intake leaves no record of it', async () => {
    const reply = at(60);
    const { store } = makeStore({ jobThreads: [{ channelId: 'C1', threadTs: parent, active: true }] });
    const { client } = makeSlack([], { [parent]: [{ ts: reply, user: 'U1', text: `<@${BOT}> and this?` }] });
    const state = newCatchupState();

    expect((await scan(client, store, { state })).length).toBe(1);
    expect((await scan(client, store, { state })).length).toBe(0);
  });

  it('reads only replies after the cursor', async () => {
    const old = at(600);
    const { store } = makeStore({
      cursor: NOW - 120,
      jobThreads: [{ channelId: 'C1', threadTs: parent, active: false }],
    });
    const { client } = makeSlack([], { [parent]: [{ ts: old, user: 'U1', text: `<@${BOT}> earlier ask` }] });
    expect(await scan(client, store)).toEqual([]);
  });
});

describe('mention catch-up: sweep after a gap', () => {
  const parent = at(5 * 3600);
  const reply = at(1200);
  const history = [
    { ts: parent, user: 'U1', text: 'PR is up: https://github.com/o/r/pull/1', reply_count: 3, latest_reply: reply },
  ];
  const thread = {
    [parent]: [
      { ts: parent, user: 'U1', text: 'PR is up: https://github.com/o/r/pull/1' },
      { ts: reply, user: 'U2', text: `<@${BOT}> please review.` },
    ],
  };

  it('finds a mention in a thread miniOG has no job in; the regular scan does not open such threads', async () => {
    const { store } = makeStore();
    const { client, repliesAsked } = makeSlack(history, thread);
    const state = newCatchupState();

    expect(await scan(client, store, { state })).toEqual([]);
    expect(repliesAsked).toEqual([]);

    const queued = await sweep(client, store, NOW - 3600, state);
    expect(queued.map(e => [e.eventId, e.threadTs])).toEqual([[`replay:C1:${reply}`, parent]]);
  });

  it('skips threads with no replies since the gap', async () => {
    const { store } = makeStore();
    const { client, repliesAsked } = makeSlack(history, thread);
    expect(await sweep(client, store, NOW - 600)).toEqual([]); // the reply is from before the gap
    expect(repliesAsked).toEqual([]);
  });

  it('opens at most 40 threads, the most recently active first', async () => {
    const parents = Array.from({ length: 45 }, (_unused, i) => ({
      ts: at(7200 + i, i),
      user: 'U1',
      text: `thread ${i}`,
      reply_count: 1,
      latest_reply: at(100 + i * 10, i),
    }));
    const { store } = makeStore();
    const { client, repliesAsked } = makeSlack(parents, {});
    await sweep(client, store, NOW - 3600);
    expect(repliesAsked.length).toBe(40);
    expect(repliesAsked[0]).toBe(parents[0].ts);
    expect(repliesAsked).not.toContain(parents[44].ts);
  });

  it("treats a stop in a running job's thread as a stop", async () => {
    const stop = at(300);
    const jobParent = at(3000);
    const { store } = makeStore({ jobThreads: [{ channelId: 'C1', threadTs: jobParent, active: true }] });
    const { client } = makeSlack(
      [{ ts: jobParent, user: 'U1', text: `<@${BOT}> fix it`, reply_count: 2, latest_reply: at(200) }],
      {
        [jobParent]: [
          { ts: stop, user: 'U1', text: `<@${BOT}> stop` },
          { ts: at(200), user: BOT, text: 'Still working…' },
        ],
      },
    );
    const queued = await sweep(client, store, NOW - 3600);
    expect(queued.map(e => e.eventTs)).toEqual([stop]);
  });

  it('still recovers unanswered top-level mentions after the cursor', async () => {
    const top = at(60);
    const { store } = makeStore();
    const { client } = makeSlack([{ ts: top, user: 'U3', text: `<@${BOT}> fresh question` }], {
      [top]: [{ ts: top, user: 'U3', text: `<@${BOT}> fresh question` }],
    });
    const queued = await scan(client, store);
    expect(queued.map(e => [e.eventId, e.threadTs])).toEqual([[`replay:C1:${top}`, top]]);
  });
});

describe('skipWhileRunning', () => {
  it('skips a call while the last one runs, and runs again once it is done', async () => {
    let release: () => void = () => {};
    let runs = 0;
    const run = skipWhileRunning(async () => {
      runs += 1;
      await new Promise<void>(resolve => {
        release = resolve;
      });
    }, 'test');

    const first = run();
    await run();
    expect(runs).toBe(1);
    release();
    await first;

    const second = run();
    expect(runs).toBe(2);
    release();
    await second;
  });

  it('keeps going after a run throws', async () => {
    let runs = 0;
    const run = skipWhileRunning(async () => {
      runs += 1;
      throw new Error('slack down');
    }, 'test');
    await run();
    await run();
    expect(runs).toBe(2);
  });
});
