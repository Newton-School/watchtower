import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, NormalizedTask, PrContext } from '../src/types/contracts.js';
import { __deployTiming, __ghCli, DEPLOY_DRY_RUN_STATE_KEY } from '../src/workflows/shared/githubActionsRun.js';
import {
  __deployOffer,
  __deployOfferClock,
  __deployOfferGh,
  __deployOfferTiming,
  closeDeployOfferAfterRestart,
  DEPLOY_OFFER_DECLINED,
  DEPLOY_OFFER_DM_LINE,
  DEPLOY_OFFER_EXPIRED,
  DEPLOY_OFFER_LINE,
  DEPLOY_OFFER_SUPERSEDED,
  DEPLOY_OFFER_DECLINED_WITH_ASK,
  DEPLOY_OFFER_STATUS,
  DEPLOY_TAP_QUEUED_FOR_SLOT,
  deployTappers,
  isDeployDecline,
  isDeployTap,
  offerMarketingProdDeploy,
  waitForDeployTap,
} from '../src/workflows/marketingDeployOffer.js';
import {
  __stagingDeps,
  putMainBackOnStagingAfterMerge,
  STAGING_BACK_ON_MAIN,
  STAGING_STATE_KEY,
} from '../src/workflows/stagingDeployWorkflow.js';
import { __resetButtonRepliesForTests, recordButtonReply } from '../src/slack/buttonReplies.js';
import { jobSlots } from '../src/runtime/jobSlots.js';
import { dispatchMarketingProdDeploy, oneMarketingProdDeployAtATime } from '../src/workflows/deployWorkflow.js';

// Issue #703: after miniOG merges a marketing PR it offers the prod deploy in
// the thread, and someone from core-dev taps to deploy (the owner's decision:
// a prod deploy needs a tap from core-dev, it is not automatic).

const CLONE = '/clones/newton-marketing-web';
const MARKETING_PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1490';
const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/9300';
const PROMPT_TS = '500.000100';
const MERGED_AT = '2026-10-25T10:00:00Z';
const MERGED_AT_MS = Date.parse(MERGED_AT);
/** "Now", for aging taps: just after the replies below (ts 501–510). */
const NOW_MS = 520_000;
const AFTER_MERGE = '2026-10-25T10:05:00Z';
const BEFORE_MERGE = '2026-10-25T09:55:00Z';

const bundle = (name: string, userIds: string[], capabilities: string[], channels = ['C1']) => ({
  name,
  manualUserIds: userIds.join(','),
  resolvedUserIds: userIds,
  capabilities,
  allowedChannelIds: channels,
  allowIm: false,
  allowMpim: false,
});

function makeConfig(): AppConfig {
  return {
    ownerSlackUserIds: ['UOWNER1'],
    coreDevSlackUserIds: ['UOWNER1'],
    botUserId: 'UBOT1',
    repoPaths: { newtonWeb: '/clones/newton-web', newtonApi: '/clones/newton-api', newtonMarketingWeb: CLONE },
    accessControl: { mode: 'enforce' },
    bundles: [
      bundle('viewer', ['UVIEWER'], ['query_codebase', 'chat']),
      bundle('builder', ['UBUILDER'], ['query_codebase', 'chat', 'start_implementation']),
      bundle(
        'admin',
        ['UADMIN', 'UADMIN2', 'UBOT1'],
        ['query_codebase', 'chat', 'start_implementation', 'deploy_prod'],
      ),
      bundle('admin-elsewhere', ['UFARADMIN'], ['deploy_prod'], ['C9']),
    ],
  } as unknown as AppConfig;
}
const config = makeConfig();

const prOf = (url: string): PrContext => {
  const [, owner, repo, , number] = new URL(url).pathname.split('/');
  return { url, owner, repo, number: Number(number) } as PrContext;
};

function makeTask(userId = 'UBUILDER', channelType = 'channel', threadTs = '400.1'): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      channelType,
      threadTs,
      eventTs: threadTs,
      userId,
      text: '<@UBOT1> merge it',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: userId === 'UOWNER1',
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION',
  } as NormalizedTask;
}

type Reply = { user: string; text: string; ts: string; bot_id?: string; subtype?: string };

/** Slack: posts get a ts; the thread's replies after the offer come from `replies`. */
function fakeSlack(replies: Reply[] | (() => Reply[]) = [], promptTs = PROMPT_TS) {
  const posted: { text: string; blocks?: unknown }[] = [];
  const slack = {
    chat: {
      postMessage: vi.fn(async (args: { text: string; blocks?: unknown }) => {
        posted.push({ text: args.text, blocks: args.blocks });
        return { ok: true, ts: posted.length === 1 ? promptTs : `700.${posted.length}` };
      }),
      update: vi.fn(async () => ({ ok: true })),
    },
    conversations: {
      replies: vi.fn(async () => ({
        messages: typeof replies === 'function' ? replies() : replies,
        response_metadata: {},
      })),
    },
  };
  return { slack: slack as unknown as import('@slack/web-api').WebClient, posted, raw: slack };
}

interface FakeRun {
  id: number;
  workflow: 'deploy-prod.yml' | 'deploy-staging.yml';
  branch: string;
  status: string;
  conclusion?: string;
  createdAt?: string;
  url?: string;
}

/** `gh` for GitHub Actions: lists runs per workflow (honours --branch/--limit), dispatching adds one. */
function fakeActions(runs: FakeRun[], opts: { conclusion?: string; onView?: () => void } = {}) {
  const calls: string[][] = [];
  let nextId = 1000;
  __ghCli.exec = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'workflow' && args[1] === 'run') {
      const workflow = args[2] as FakeRun['workflow'];
      const ref = args[args.indexOf('--ref') + 1];
      nextId += 1;
      runs.unshift({
        id: nextId,
        workflow,
        branch: ref,
        status: 'completed',
        conclusion: opts.conclusion ?? 'success',
        // A run dispatched now started after the merge.
        createdAt: new Date(Math.max(Date.now(), MERGED_AT_MS + 60_000)).toISOString(),
        url: `https://github.com/run/${nextId}`,
      });
      return '';
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const workflow = (args.find(arg => arg.startsWith('--workflow=')) ?? '').slice('--workflow='.length);
      const branch = args.includes('--branch') ? args[args.indexOf('--branch') + 1] : undefined;
      const limit = Number(args[args.indexOf('--limit') + 1]);
      const rows = runs
        .filter(run => run.workflow === workflow && (!branch || run.branch === branch))
        .slice(0, limit)
        .map(run => ({
          databaseId: run.id,
          headBranch: run.branch,
          status: run.status,
          conclusion: run.conclusion,
          createdAt: run.createdAt,
          url: run.url,
        }));
      return JSON.stringify(rows);
    }
    if (args[0] === 'run' && args[1] === 'view') {
      opts.onView?.();
      const run = runs.find(r => String(r.id) === args[2]);
      return JSON.stringify({ status: run?.status, conclusion: run?.conclusion, url: run?.url });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  }) as typeof __ghCli.exec;
  return calls;
}

const dispatches = (calls: string[][], workflow: string) =>
  calls.filter(args => args[0] === 'workflow' && args[1] === 'run' && args[2] === workflow);

/** `gh pr view` for the merged PR. */
function fakePrView(info: Record<string, unknown> | Error) {
  __deployOfferGh.exec = vi.fn(async () => {
    if (info instanceof Error) throw info;
    return JSON.stringify(info);
  }) as typeof __deployOfferGh.exec;
}

const MERGED_INFO = { state: 'MERGED', mergedAt: MERGED_AT, headRefName: 'copy/hero', baseRefName: 'main' };
const prodRun = (over: Partial<FakeRun>): FakeRun => ({
  id: 9,
  workflow: 'deploy-prod.yml',
  branch: 'main',
  status: 'completed',
  conclusion: 'success',
  createdAt: AFTER_MERGE,
  url: 'https://github.com/run/9',
  ...over,
});

const realWait = __deployOffer.wait;
const realRestore = __deployOffer.restoreStaging;
const restoreMock = vi.fn(async () => {});

beforeEach(() => {
  __deployOfferTiming.pollMs = 1;
  __deployOfferTiming.fastWindowMs = 60_000;
  __deployOfferTiming.slowPollMs = 1;
  __deployOfferTiming.deadlineMs = 5_000;
  __deployTiming.resolvePollMs = 1;
  __deployTiming.watchPollMs = 1;
  __deployTiming.resolveTimeoutMs = 2_000;
  __deployTiming.watchTimeoutMs = 2_000;
  __deployOfferClock.now = () => NOW_MS;
  __deployOffer.wait = realWait;
  restoreMock.mockReset().mockResolvedValue(undefined);
  __deployOffer.restoreStaging = restoreMock;
  fakePrView(MERGED_INFO);
  __resetButtonRepliesForTests();
});
afterEach(() => {
  __deployOffer.restoreStaging = realRestore;
  vi.clearAllMocks();
});

async function offer(opts: {
  replies?: Reply[] | (() => Reply[]);
  runs?: FakeRun[];
  conclusion?: string;
  merged?: { url: string; knownMerged: boolean }[];
  startedAtMs?: number;
  lead?: string;
  requester?: string;
  channelType?: string;
  store?: Record<string, string>;
  signal?: AbortSignal;
  cfg?: AppConfig;
}) {
  const { slack, posted, raw } = fakeSlack(opts.replies ?? []);
  const calls = fakeActions(opts.runs ?? [], { conclusion: opts.conclusion });
  const logs: { stage: string; data?: Record<string, unknown> }[] = [];
  const state = { ...(opts.store ?? {}) };
  const result = await offerMarketingProdDeploy({
    task: makeTask(opts.requester, opts.channelType),
    config: opts.cfg ?? config,
    slack,
    store: { getState: key => state[key], setState: (key, value) => void (state[key] = value) },
    githubToken: 'ghs_test',
    merged: (opts.merged ?? [{ url: MARKETING_PR, knownMerged: true }]).map(m => ({
      pr: prOf(m.url),
      knownMerged: m.knownMerged,
    })),
    startedAtMs: opts.startedAtMs ?? MERGED_AT_MS - 5_000,
    lead: opts.lead,
    logStep: entry => logs.push(entry),
    signal: opts.signal,
  });
  return { result, posted: posted.map(p => p.text), calls, logs, raw, state };
}

const say = (user: string, text = 'deploy it', ts = '501.0'): Reply => ({ user, text, ts });

describe('reading a tap', () => {
  it.each([
    'deploy it',
    'Deploy it!',
    '<@UBOT1> deploy it',
    'deploy',
    'confirm deploy',
    'ship it',
    'please deploy it',
    'ok deploy it now',
    'deploy marketing to prod',
    '_deploy it_',
    // Pleasantries and emoji around the deploy phrase don't change it.
    'LGTM, deploy it',
    'Looks good! Deploy it.',
    'yes please deploy',
    'Deploy it 🚀',
    'deploy it :rocket:',
  ])('reads %j as a tap', text => expect(isDeployTap(text, 'UBOT1')).toBe(true));

  it.each([
    'yes',
    'ok',
    'looks good',
    'deploy it?',
    'deploy it later',
    'deploy it after QA',
    'can you deploy newton-web',
    // Aimed at someone else, or a group.
    '<@UADMIN2> deploy it',
    '<@UADMIN2|ravi> deploy it',
    '<!subteam^S1|core-dev> deploy it',
    // Taken back, or quoted.
    '~deploy it~',
    '&gt; deploy it',
    // Pleasantries alone, or a go-ahead without the deploy phrase.
    'lgtm',
    'looks good',
    'go ahead',
    'approved',
    '<!here> deploy it',
  ])('does not read %j as a tap', text => expect(isDeployTap(text, 'UBOT1')).toBe(false));

  it.each([
    'no',
    'not now',
    'not yet',
    'later',
    "don't deploy",
    'hold off',
    "wait, don't deploy yet, the hero image is broken",
    'no, deploy it',
    '<@UADMIN2> don’t deploy it',
    "we shouldn't deploy it yet",
    "won't deploy it till marketing signs off",
    "can't go live like this",
    'never mind, the copy is wrong',
    'nevermind',
    'not until QA passes',
    'please stop',
    'one sec, checking the copy',
    'hang on, hero image is off',
    'deploy it after the copy fix',
  ])('reads %j as holding the deploy back', text => expect(isDeployDecline(text, 'UBOT1')).toBe(true));
});

describe('who may tap', () => {
  it('is whoever may deploy to production in the channel: the owner and core-dev, never a bot', () => {
    expect(deployTappers(config, 'C1', 'channel').sort()).toEqual(['UADMIN', 'UADMIN2', 'UOWNER1']);
  });

  it('leaves out core-dev people whose bundle is not enabled in the channel', () => {
    expect(deployTappers(config, 'C1', 'channel')).not.toContain('UFARADMIN');
    expect(deployTappers(config, 'C9', 'channel')).toContain('UFARADMIN');
  });
});

describe('the deploy offer after a merge (#703)', () => {
  it('posts one offer, the merge reply first, tagging nobody', async () => {
    const lead = `Merged ${MARKETING_PR}: it only changes text and numbers.`;
    const { posted } = await offer({ lead, replies: [say('UADMIN')] });

    expect(posted[0]).toBe(`${lead} ${DEPLOY_OFFER_LINE}`);
    expect(posted[0]).not.toContain('<@');
  });

  it('deploys on a tap by core-dev, with the prod deploy arguments, and reports it as the prod deploy does', async () => {
    const { result, posted, calls, logs } = await offer({ replies: [say('UADMIN')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toEqual([
      ['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy'],
    ]);
    expect(posted).toContain(':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…');
    expect(posted.at(-1)).toMatch(/^:white_check_mark: newton-marketing-web production deploy succeeded/);
    expect(logs.find(entry => entry.stage === 'deploy_offer.tapped')?.data).toMatchObject({ userId: 'UADMIN' });
    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(result?.message.startsWith(`Merged ${MARKETING_PR}.`)).toBe(true);
  });

  it('deploys on the owner’s tap', async () => {
    const { calls } = await offer({ replies: [say('UOWNER1', 'Deploy it.')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  it('counts the button as the tap, and not a bystander’s Cancel', async () => {
    const { slack, posted } = fakeSlack(() => []);
    fakeActions([]);
    const run = offerMarketingProdDeploy({
      task: makeTask(),
      config,
      slack,
      merged: [{ pr: prOf(MARKETING_PR), knownMerged: true }],
      startedAtMs: MERGED_AT_MS,
    });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    __deployOfferClock.now = () => Date.now();
    recordButtonReply({ channelId: 'C1', messageTs: PROMPT_TS, userId: 'UVIEWER', value: 'cancel' });
    await new Promise(resolve => setTimeout(resolve, 20));
    recordButtonReply({ channelId: 'C1', messageTs: PROMPT_TS, userId: 'UADMIN', value: 'deploy it' });
    const result = await run;

    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(posted.at(-1)?.text).toMatch(/production deploy succeeded/);
  });

  it.each([
    ['the builder who asked', 'UBUILDER', 'only someone from core-dev can put it live.'],
    ['a viewer', 'UVIEWER', 'only someone from core-dev can put it live.'],
    ['core-dev, from a channel their bundle is not enabled in', 'UFARADMIN', "you can't deploy from this channel."],
  ])('ignores a tap by %s and says why, without tagging core-dev', async (_who, user, why) => {
    __deployOfferTiming.deadlineMs = 50;
    const { result, posted, calls } = await offer({ replies: [say(user)] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.filter(text => text.startsWith(`<@${user}>`))).toEqual([`<@${user}> ${why}`]);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('never takes a tap from a bot, even one on the core-dev list', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { calls } = await offer({
      replies: [say('UBOT1'), { user: 'UOTHERBOT', text: 'deploy it', ts: '502.0', bot_id: 'B1' }],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
  });

  it('does not take a tap aimed at someone else, or struck through', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { calls, posted } = await offer({
      replies: [say('UADMIN', '<@UBUILDER> deploy it'), say('UADMIN', '~deploy it~', '502.0')],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
  });

  it('checks access when the tap comes, not only when the offer went up', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const cfg = makeConfig();
    const { calls, posted } = await offer({
      cfg,
      replies: () => {
        // Removed from core-dev while the offer was open.
        const admin = (cfg.bundles ?? []).find(b => b.name === 'admin');
        if (admin) admin.resolvedUserIds = ['UADMIN2'];
        return [say('UADMIN')];
      },
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted).toContain('<@UADMIN> only someone from core-dev can put it live.');
  });

  it('does not act on a tap first seen long after it was sent, and keeps the offer open', async () => {
    let polls = 0;
    // The host slept: the first tap is 16 minutes old when miniOG first reads it.
    const old = say('UADMIN', 'deploy it', '501.0');
    const fresh = say('UADMIN', 'deploy it', String(501 + 16 * 60));
    __deployOfferClock.now = () => (501 + 16 * 60 + 2) * 1000;
    const { posted, calls, logs } = await offer({ replies: () => (++polls < 3 ? [old] : [old, fresh]) });

    expect(posted.find(text => text.includes('I only just saw that'))).toMatch(
      /from 16 minutes ago, so I haven't deployed\. The offer is still open/,
    );
    expect(logs.some(entry => entry.stage === 'deploy_offer.stale_tap')).toBe(true);
    // The fresh tap still deploys.
    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  describe('a deploy that already carries the merge', () => {
    it('says it is already live when a prod deploy of main after the merge succeeded, and does not deploy again', async () => {
      const { posted, calls, result } = await offer({ replies: [say('UADMIN')], runs: [prodRun({})] });

      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
      expect(posted.at(-1)).toBe('Already live: https://github.com/run/9');
      expect(result).toMatchObject({ status: 'SUCCESS' });
    });

    it('does not count a prod run of another branch, or one from before the merge', async () => {
      const { calls } = await offer({
        replies: [say('UADMIN')],
        runs: [prodRun({ id: 11, branch: 'hotfix/rollback' }), prodRun({ id: 8, createdAt: BEFORE_MERGE })],
      });

      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
    });

    it('points at a prod deploy of main started after the merge that is still running', async () => {
      const { posted, calls } = await offer({
        replies: [say('UADMIN')],
        runs: [prodRun({ status: 'in_progress', conclusion: undefined })],
      });

      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
      expect(posted.at(-1)).toBe(
        'A production deploy that started after the merge is already running: https://github.com/run/9',
      );
    });

    it('ignores a still-running prod run of another branch', async () => {
      const { calls } = await offer({
        replies: [say('UADMIN')],
        runs: [prodRun({ branch: 'hotfix/x', status: 'in_progress', conclusion: undefined })],
      });

      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
    });

    it.each([
      ['expires', [] as Reply[]],
      ['is turned down', [say('UADMIN', 'not now')]],
    ])(
      'says it is already live instead when the offer %s after core-dev deployed main from GitHub',
      async (_c, replies) => {
        __deployOfferTiming.deadlineMs = 50;
        const { posted } = await offer({ replies, runs: [prodRun({})] });

        expect(posted.at(-1)).toBe('Already live: https://github.com/run/9');
      },
    );

    it('skips the shortcut when the merge time is unknown: a tap deploys, an expiry says so', async () => {
      fakePrView(new Error('gh: HTTP 502'));
      const tapped = await offer({ replies: [say('UADMIN')], runs: [prodRun({})] });
      expect(dispatches(tapped.calls, 'deploy-prod.yml')).toHaveLength(1);

      __deployOfferTiming.deadlineMs = 50;
      const expired = await offer({ runs: [prodRun({})] });
      expect(expired.posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
    });
  });

  it('dispatches once for two taps in two threads: the second finds the first deploy', async () => {
    const runs: FakeRun[] = [];
    const calls = fakeActions(runs);
    const one = fakeSlack([say('UADMIN')], '500.1');
    const two = fakeSlack([say('UADMIN2')], '500.2');
    const start = (slack: typeof one.slack, threadTs: string) =>
      offerMarketingProdDeploy({
        task: makeTask('UBUILDER', 'channel', threadTs),
        config,
        slack,
        merged: [{ pr: prOf(MARKETING_PR), knownMerged: true }],
        startedAtMs: MERGED_AT_MS,
      });

    const results = await Promise.all([start(one.slack, '400.1'), start(two.slack, '400.2')]);

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
    const lasts = [one.posted.at(-1)?.text, two.posted.at(-1)?.text];
    expect(lasts.filter(text => text?.startsWith('Already live:'))).toHaveLength(1);
    expect(lasts.filter(text => text?.includes('production deploy succeeded'))).toHaveLength(1);
    expect(results.every(result => result?.status === 'SUCCESS')).toBe(true);
  });

  it('closes the offer after 2 hours with nothing deployed', async () => {
    __deployOfferTiming.deadlineMs = 30;
    const { posted, calls, result } = await offer({});

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['core-dev', 'UADMIN', 'not now'],
    ['the requester', 'UBUILDER', 'not now'],
    ['core-dev, loosely', 'UOWNER1', "wait, don't deploy yet, the hero image is broken"],
  ])('closes the offer when %s holds it back, and a later tap deploys nothing', async (_who, user, text) => {
    const { posted, calls, result } = await offer({ replies: [say(user, text), say('UADMIN2', 'deploy it', '502.0')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_DECLINED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('ignores chatter, a bystander’s "no", and thanks', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { posted } = await offer({
      replies: [
        say('UVIEWER', 'no'),
        say('UADMIN', 'nice work', '502.0'),
        say('UBUILDER', 'thanks <@UBOT1>!', '503.0'),
        say('UADMIN', '<@UBOT1> :tada:', '504.0'),
      ],
    });

    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
  });

  it('tells a bystander who mentions miniOG to ask in a new thread, once, and keeps the offer open', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { posted } = await offer({
      replies: [say('UVIEWER', '<@UBOT1> no'), say('UVIEWER', '<@UBOT1> what changed?', '502.0')],
    });

    expect(posted.filter(text => text.startsWith('<@UVIEWER>'))).toEqual([
      "<@UVIEWER> I'm holding this thread for a deploy tap, so I can't take new asks here for now. Ask me in a new thread.",
    ]);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
  });

  it.each([
    ['the requester', 'UBUILDER', '<@UBOT1> also change the heading'],
    ['core-dev', 'UADMIN', '<@UBOT1> what else changed here?'],
  ])('closes the offer for a new ask from %s and asks for it again, once', async (_who, user, text) => {
    const { posted, calls, result } = await offer({ replies: [say(user, text, '505.0')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.slice(1)).toEqual([DEPLOY_OFFER_SUPERSEDED]);
    expect(DEPLOY_OFFER_SUPERSEDED).toBe(
      "That closes the deploy offer. Mention me again with your message and I'll pick it up now.",
    );
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['a decline', [say('UBUILDER', 'not now')], DEPLOY_OFFER_DECLINED],
    [
      'a hold that also asks for something',
      [say('UBUILDER', '<@UBOT1> wait, can you also change the footer link to /apply?')],
      DEPLOY_OFFER_DECLINED_WITH_ASK,
    ],
    ['a new ask', [say('UBUILDER', '<@UBOT1> also change the heading')], DEPLOY_OFFER_SUPERSEDED],
    ['expiry', [] as Reply[], DEPLOY_OFFER_EXPIRED],
  ])(
    'lets the thread go at once after %s, without waiting for staging to go back to main',
    async (_c, replies, line) => {
      __deployOfferTiming.deadlineMs = 50;
      let finishRestore!: () => void;
      restoreMock.mockImplementation(() => new Promise<void>(resolve => (finishRestore = resolve)));

      // Staging never finishes here: the offer must end anyway.
      const { result, posted } = await offer({ replies });

      expect(posted.at(-1)).toBe(line);
      expect(result).toMatchObject({ status: 'SUCCESS' });
      finishRestore();
    },
  );

  it('ends cleanly with nothing deployed when the run is stopped while it waits, and still records the merge', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { posted, calls, result } = await offer({ signal: controller.signal });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(result).toMatchObject({ status: 'CANCELLED', slackPosted: false });
    expect(result?.message).toBe(`Merged ${MARKETING_PR}. Stopped before anyone tapped deploy; nothing was deployed.`);
  });

  it('removes its abort listener after every poll', async () => {
    __deployOfferTiming.deadlineMs = 30;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const { slack } = fakeSlack();

    await waitForDeployTap({
      slack,
      channelId: 'C1',
      threadTs: '400.1',
      promptTs: PROMPT_TS,
      allowedUserIds: ['UADMIN'],
      access: () => ({ allowed: true, elsewhere: false }),
      requesterId: 'UBUILDER',
      botUserId: 'UBOT1',
      signal: controller.signal,
    });

    expect(remove).toHaveBeenCalled();
  });

  it('reads the thread less often after the first minutes', async () => {
    __deployOfferTiming.fastWindowMs = 10;
    __deployOfferTiming.slowPollMs = 60;
    __deployOfferTiming.deadlineMs = 250;
    const { slack, raw } = fakeSlack();

    await waitForDeployTap({
      slack,
      channelId: 'C1',
      threadTs: '400.1',
      promptTs: PROMPT_TS,
      allowedUserIds: [],
      access: () => ({ allowed: false, elsewhere: false }),
      requesterId: 'UBUILDER',
    });

    // ~10 fast reads, then a handful of slow ones; at 1 ms throughout it would be ~250.
    expect(raw.conversations.replies.mock.calls.length).toBeLessThan(40);
  });

  it('says so when a tap has to wait for a free job slot', async () => {
    jobSlots.configure({ max: () => 1, onFree: () => {} });
    expect(jobSlots.tryAcquire()).toBe(true);
    let otherJob: Promise<void> | undefined;
    let polls = 0;
    const { slack, posted } = fakeSlack(() => {
      polls += 1;
      // While the offer waits its slot is free; another job takes it, then the tap comes.
      if (!otherJob && jobSlots.tryAcquire()) {
        otherJob = jobSlots.run(() => new Promise<void>(resolve => setTimeout(resolve, 40)));
      }
      return polls > 2 ? [say('UADMIN')] : [];
    });
    fakeActions([]);

    const result = await jobSlots.run(() =>
      offerMarketingProdDeploy({
        task: makeTask(),
        config,
        slack,
        merged: [{ pr: prOf(MARKETING_PR), knownMerged: true }],
        startedAtMs: MERGED_AT_MS,
      }),
    );
    await otherJob;
    jobSlots.configure({ max: () => Number.POSITIVE_INFINITY, onFree: () => {} });

    expect(posted.map(p => p.text)).toContain(DEPLOY_TAP_QUEUED_FOR_SLOT);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('only deploys on a tap: anything else the wait returns deploys nothing', async () => {
    __deployOffer.wait = vi.fn(async () => ({ outcome: 'expired' as const, userId: 'UADMIN' }));
    const expired = await offer({});
    expect(dispatches(expired.calls, 'deploy-prod.yml')).toHaveLength(0);

    __deployOffer.wait = vi.fn(async () => ({ outcome: 'tapped' as const, userId: 'UVIEWER' }));
    const forged = await offer({});
    expect(dispatches(forged.calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(forged.posted.at(-1)).toBe(
      'That tap came from someone who can no longer deploy here, so nothing was deployed.',
    );
  });

  it('honours the deploy dry-run switch', async () => {
    const { posted, calls, result } = await offer({
      replies: [say('UADMIN')],
      store: { [DEPLOY_DRY_RUN_STATE_KEY]: '1' },
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(
      'Dry run: this is where I would deploy *newton-marketing-web* to production. Nothing was deployed.',
    );
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('fails the run when the deploy it started failed', async () => {
    const { posted, result } = await offer({ replies: [say('UADMIN')], conclusion: 'failure' });

    expect(posted.at(-1)).toMatch(/^:x: newton-marketing-web production deploy finished with \*failure\*/);
    expect(result).toMatchObject({ status: 'FAILED' });
  });

  it('puts main back on staging for the merged branch right away, not after the tap', async () => {
    let restoreCalledBeforeWaitEnded = false;
    __deployOffer.wait = vi.fn(async () => {
      restoreCalledBeforeWaitEnded = restoreMock.mock.calls.length > 0;
      return { outcome: 'declined' as const, userId: 'UADMIN' };
    });

    await offer({});

    expect(restoreCalledBeforeWaitEnded).toBe(true);
    expect(restoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ mergedBranches: ['copy/hero'], channelId: 'C1', threadTs: '400.1' }),
    );
  });

  it.each([
    ['a DM', 'im'],
    ['a group DM', 'mpim'],
  ])(
    'makes no offer in %s: says core-dev can ask in a channel, and still puts main back on staging',
    async (_c, channelType) => {
      const lead = `Merged ${MARKETING_PR}: it only changes text and numbers.`;
      const { posted, calls, result, raw } = await offer({ lead, channelType });

      expect(posted).toEqual([`${lead} ${DEPLOY_OFFER_DM_LINE}`]);
      expect(raw.conversations.replies).not.toHaveBeenCalled();
      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
      expect(restoreMock).toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'SUCCESS' });
    },
  );

  describe('which merges get an offer', () => {
    it('offers after an agent’s merge that GitHub shows as merged into main during the run', async () => {
      const { posted } = await offer({
        merged: [{ url: MARKETING_PR, knownMerged: false }],
        replies: [say('UADMIN', 'not now')],
      });

      expect(posted[0]).toBe(DEPLOY_OFFER_LINE);
    });

    it.each([
      ['still open', { ...MERGED_INFO, state: 'OPEN', mergedAt: null }],
      ['merged into another branch', { ...MERGED_INFO, baseRefName: 'release' }],
      ['merged before the run began', { ...MERGED_INFO, mergedAt: '2026-10-25T09:00:00Z' }],
    ])('offers nothing after an agent’s run when the PR is %s', async (_case, info) => {
      fakePrView(info);
      const { result, posted } = await offer({ merged: [{ url: MARKETING_PR, knownMerged: false }] });

      expect(result).toBeUndefined();
      expect(posted).toEqual([]);
    });

    it('offers nothing after an agent’s run when GitHub cannot say it merged', async () => {
      fakePrView(new Error('gh: HTTP 502'));
      const { result, posted } = await offer({ merged: [{ url: MARKETING_PR, knownMerged: false }] });

      expect(result).toBeUndefined();
      expect(posted).toEqual([]);
    });

    it('still offers after its own merge when GitHub cannot be read back', async () => {
      fakePrView(new Error('gh: HTTP 502'));
      const { posted } = await offer({ replies: [say('UADMIN', 'not now')] });

      expect(posted[0]).toBe(DEPLOY_OFFER_LINE);
      expect(restoreMock).toHaveBeenCalledWith(expect.objectContaining({ mergedBranches: [] }));
    });

    it('offers nothing for another repo and never asks GitHub about it', async () => {
      const { result, posted } = await offer({ merged: [{ url: WEB_PR, knownMerged: true }] });

      expect(result).toBeUndefined();
      expect(posted).toEqual([]);
      expect(__deployOfferGh.exec).not.toHaveBeenCalled();
    });

    it('offers nothing when the marketing clone is not set up here', async () => {
      const { slack, posted } = fakeSlack();
      const result = await offerMarketingProdDeploy({
        task: makeTask(),
        config: { ...config, repoPaths: { ...config.repoPaths, newtonMarketingWeb: '' } } as AppConfig,
        slack,
        merged: [{ pr: prOf(MARKETING_PR), knownMerged: true }],
        startedAtMs: MERGED_AT_MS,
      });

      expect(result).toBeUndefined();
      expect(posted).toEqual([]);
    });
  });
});

describe('waiting for the tap', () => {
  it('only reads replies after the offer', async () => {
    const { slack } = fakeSlack([say('UADMIN', 'deploy it', '499.0')]);
    __deployOfferTiming.deadlineMs = 30;

    const result = await waitForDeployTap({
      slack,
      channelId: 'C1',
      threadTs: '400.1',
      promptTs: PROMPT_TS,
      allowedUserIds: ['UADMIN'],
      access: () => ({ allowed: true, elsewhere: false }),
      requesterId: 'UBUILDER',
      botUserId: 'UBOT1',
    });

    expect(result.outcome).toBe('expired');
  });
});

describe('closing the offer after a restart (#703)', () => {
  it('marks its message closed and takes the button away', async () => {
    const { slack, raw } = fakeSlack([{ user: 'UBOT1', text: `Merged x. ${DEPLOY_OFFER_LINE}`, ts: PROMPT_TS }]);

    await closeDeployOfferAfterRestart(slack, { channelId: 'C1', threadTs: '400.1', promptTs: PROMPT_TS });

    expect(raw.chat.update).toHaveBeenCalledWith({
      channel: 'C1',
      ts: PROMPT_TS,
      text: `Merged x. ${DEPLOY_OFFER_LINE}\n_Closed: I was restarted, so nothing was deployed._`,
      blocks: [],
    });
  });

  it('never throws', async () => {
    const { slack, raw } = fakeSlack();
    raw.conversations.replies.mockRejectedValue(new Error('ratelimited'));

    await expect(
      closeDeployOfferAfterRestart(slack, { channelId: 'C1', threadTs: '400.1', promptTs: PROMPT_TS }),
    ).resolves.toBeUndefined();
  });
});

describe('putting main back on staging after a merge (#703)', () => {
  async function restore(
    runs: FakeRun[],
    store: Record<string, string> = {},
    opts: { signal?: AbortSignal; onView?: () => void } = {},
  ) {
    const { slack, posted } = fakeSlack();
    const calls = fakeActions(runs, { onView: opts.onView });
    const state = { ...store };
    vi.spyOn(__stagingDeps, 'now').mockReturnValue(1_800_000_000_000);
    await putMainBackOnStagingAfterMerge({
      config,
      slack,
      store: { getState: key => state[key], setState: (key, value) => void (state[key] = value) },
      channelId: 'C1',
      channelType: 'channel',
      threadTs: '400.1',
      mergedBranches: ['copy/hero'],
      signal: opts.signal,
    });
    return { posted: posted.map(p => p.text), calls, state };
  }
  const stagingRun = (branch: string, status = 'completed', conclusion: string | undefined = 'success'): FakeRun => ({
    id: 50,
    workflow: 'deploy-staging.yml',
    branch,
    status,
    conclusion,
  });

  it('puts main back when staging shows the merged branch, records it and says so', async () => {
    const { posted, calls, state } = await restore([stagingRun('copy/hero')]);

    expect(dispatches(calls, 'deploy-staging.yml')).toEqual([
      ['workflow', 'run', 'deploy-staging.yml', '--ref', 'main'],
    ]);
    expect(posted).toEqual([STAGING_BACK_ON_MAIN]);
    expect(JSON.parse(state[STAGING_STATE_KEY])).toMatchObject({ branch: 'main', channelId: 'C1', threadTs: '400.1' });
  });

  it('sends no "ask me again for your link" heads-up to the thread whose branch was merged', async () => {
    const previous = { branch: 'copy/hero', channelId: 'C1', threadTs: '300.1', atMs: 1_800_000_000_000 - 60_000 };
    const { posted } = await restore([stagingRun('copy/hero')], { [STAGING_STATE_KEY]: JSON.stringify(previous) });

    expect(posted).toEqual([STAGING_BACK_ON_MAIN]);
  });

  it('still records main when a stop lands after the dispatch', async () => {
    const controller = new AbortController();
    const runs = [stagingRun('copy/hero')];
    const { posted, state } = await restore(
      runs,
      {},
      {
        signal: controller.signal,
        onView: () => {
          controller.abort();
          runs[0].status = 'in_progress';
          runs[0].conclusion = undefined;
        },
      },
    );

    expect(posted).toEqual([]);
    expect(JSON.parse(state[STAGING_STATE_KEY])).toMatchObject({ branch: 'main' });
  });

  it.each([
    ['another branch', stagingRun('feat/other')],
    ['the merged branch, still deploying', stagingRun('copy/hero', 'in_progress', undefined)],
    ['the merged branch, but that deploy failed', stagingRun('copy/hero', 'completed', 'failure')],
    ['main already', stagingRun('main')],
  ])('leaves staging alone when its last deploy is %s', async (_case, run) => {
    const { posted, calls } = await restore([run]);

    expect(dispatches(calls, 'deploy-staging.yml')).toHaveLength(0);
    expect(posted).toEqual([]);
  });

  it('honours the deploy dry-run switch', async () => {
    const { posted, calls } = await restore([stagingRun('copy/hero')], { [DEPLOY_DRY_RUN_STATE_KEY]: '1' });

    expect(dispatches(calls, 'deploy-staging.yml')).toHaveLength(0);
    expect(posted).toEqual(['Dry run: this is where I would put main back on staging. Nothing was deployed.']);
  });
});

describe('round-2 review of the offer (#703)', () => {
  it('holds the deploy back and asks for the rest of a message that also asks for something', async () => {
    const text = '<@UBOT1> wait, can you also change the footer link to /apply?';
    const { posted, calls } = await offer({
      replies: [say('UBUILDER', text, '505.0'), say('UADMIN', 'deploy it', '506.0')],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.slice(1)).toEqual([
      "Okay, not deploying it now. Mention me again with the rest of your message and I'll pick it up.",
    ]);
  });

  it.each([
    "<@UBOT1> don't deploy this until marketing signs off",
    '<@UBOT1> hold off on the deploy for now',
    "<@UBOT1> no, don't deploy it yet please",
    '<@UBOT1> not yet, waiting on the legal review',
    '<@UBOT1> wait',
  ])('says only "Okay, not deploying it now." to the plain decline %j', async text => {
    const { posted, calls } = await offer({ replies: [say('UBUILDER', text, '505.0')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.slice(1)).toEqual(['Okay, not deploying it now.']);
  });

  it('answers "can you check if it\'s live?" and keeps the offer open', async () => {
    const { posted, calls } = await offer({
      replies: [say('UBUILDER', "<@UBOT1> can you check if it's live?"), say('UADMIN', 'deploy it', '502.0')],
    });

    expect(posted).toContain(`<@UBUILDER> ${DEPLOY_OFFER_STATUS}`);
    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  it.each(['go ahead and deploy', 'go ahead and deploy it', '<@UBOT1> go ahead and deploy'])(
    'deploys on %j from core-dev',
    async text => {
      const { calls } = await offer({ replies: [say('UADMIN', text)] });

      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
    },
  );

  it.each(['go ahead', '<@UBUILDER> go ahead and deploy it'])('does not deploy on %j', async text => {
    __deployOfferTiming.deadlineMs = 50;
    const { calls } = await offer({ replies: [say('UADMIN', text)] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
  });

  it.each(['<@UBOT1> is it live yet?', '<@UBOT1> when will it go live?', '<@UBOT1> any update on the deploy?'])(
    'answers %j and keeps the offer open for the tap',
    async text => {
      const { posted, calls } = await offer({ replies: [say('UBUILDER', text), say('UADMIN', 'deploy it', '502.0')] });

      expect(posted).toContain(`<@UBUILDER> ${DEPLOY_OFFER_STATUS}`);
      expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
    },
  );

  it('deploys on a near-tap from core-dev', async () => {
    const { calls } = await offer({ replies: [say('UADMIN', 'LGTM, deploy it')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  it('reloads access when the tap comes: someone added to core-dev during the wait can tap', async () => {
    const cfg = makeConfig();
    const refreshAccess = vi.fn(() => {
      const admin = (cfg.bundles ?? []).find(b => b.name === 'admin');
      if (admin && !admin.resolvedUserIds.includes('UNEWADMIN')) admin.resolvedUserIds.push('UNEWADMIN');
    });
    const { slack } = fakeSlack([say('UNEWADMIN')]);
    const calls = fakeActions([]);

    await offerMarketingProdDeploy({
      task: makeTask(),
      config: cfg,
      slack,
      merged: [{ pr: prOf(MARKETING_PR), knownMerged: true }],
      startedAtMs: MERGED_AT_MS,
      refreshAccess,
    });

    expect(refreshAccess).toHaveBeenCalled();
    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });
});

describe('one marketing prod deploy at a time (#703)', () => {
  it('ends a deploy stopped while it waits its turn at once, without running it, and keeps the order', async () => {
    let releaseFirst!: () => void;
    const order: string[] = [];
    const first = oneMarketingProdDeployAtATime(
      () =>
        new Promise<string>(resolve => {
          releaseFirst = () => {
            order.push('first');
            resolve('first');
          };
        }),
    );
    const controller = new AbortController();
    const second = oneMarketingProdDeployAtATime(
      async () => {
        order.push('second');
        return 'second';
      },
      { signal: controller.signal, whenStopped: () => 'stopped' },
    );
    const third = oneMarketingProdDeployAtATime(async () => {
      order.push('third');
      return 'third';
    });

    controller.abort();
    expect(await second).toBe('stopped');
    // The one after the stopped one still waits for the one before it.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    releaseFirst();
    expect(await first).toBe('first');
    expect(await third).toBe('third');
    expect(order).toEqual(['first', 'third']);
  });

  it('does not wait on what it says while queued', async () => {
    let releaseFirst!: () => void;
    const first = oneMarketingProdDeployAtATime(() => new Promise<void>(resolve => (releaseFirst = resolve)));
    const second = oneMarketingProdDeployAtATime(async () => 'second', { onWait: () => new Promise(() => {}) });

    // The first starts on the next tick.
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    releaseFirst();
    await first;
    expect(await second).toBe('second');
  });

  it('releases the queue when a deploy throws', async () => {
    const failed = oneMarketingProdDeployAtATime(async () => {
      throw new Error('boom');
    }).catch(error => String(error));
    const next = oneMarketingProdDeployAtATime(async () => 'next');

    expect(await failed).toContain('boom');
    expect(await next).toBe('next');
  });

  it('says nothing that reads as starting when the run was stopped already', async () => {
    const { slack, posted } = fakeSlack();
    const calls = fakeActions([]);
    const controller = new AbortController();
    controller.abort();

    const result = await dispatchMarketingProdDeploy({
      repoPath: CLONE,
      slack,
      channelId: 'C1',
      threadTs: '400.1',
      signal: controller.signal,
    });

    expect(posted).toEqual([]);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: 'CANCELLED', slackPosted: false });
  });
});

describe('closing the offer after a restart, when Slack returns the thread start too', () => {
  it('finds the offer by its ts', async () => {
    const { slack, raw } = fakeSlack([
      { user: 'UBUILDER', text: 'merge it', ts: '400.1' },
      { user: 'UBOT1', text: 'offer text', ts: PROMPT_TS },
    ]);

    await closeDeployOfferAfterRestart(slack, { channelId: 'C1', threadTs: '400.1', promptTs: PROMPT_TS });

    expect(raw.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: PROMPT_TS, blocks: [] }));
  });
});
