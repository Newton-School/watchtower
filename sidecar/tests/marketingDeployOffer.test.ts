import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, NormalizedTask, PrContext } from '../src/types/contracts.js';
import { __deployTiming, __ghCli, DEPLOY_DRY_RUN_STATE_KEY } from '../src/workflows/shared/githubActionsRun.js';
import {
  __deployOffer,
  __deployOfferGh,
  __deployOfferTiming,
  DEPLOY_OFFER_DECLINED,
  DEPLOY_OFFER_EXPIRED,
  DEPLOY_OFFER_LINE,
  DEPLOY_OFFER_SUPERSEDED,
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

// Issue #703: after miniOG merges a marketing PR it offers the prod deploy in
// the thread, and someone from core-dev taps to deploy (the owner's decision:
// a prod deploy needs a tap from core-dev, it is not automatic).

const CLONE = '/clones/newton-marketing-web';
const MARKETING_PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1490';
const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/9300';
const PROMPT_TS = '500.000100';
const MERGED_AT = '2026-10-25T10:00:00Z';
const MERGED_AT_MS = Date.parse(MERGED_AT);

const bundle = (name: string, userIds: string[], capabilities: string[], channels = ['C1']) => ({
  name,
  manualUserIds: userIds.join(','),
  resolvedUserIds: userIds,
  capabilities,
  allowedChannelIds: channels,
  allowIm: false,
  allowMpim: false,
});

const config = {
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  repoPaths: { newtonWeb: '/clones/newton-web', newtonApi: '/clones/newton-api', newtonMarketingWeb: CLONE },
  accessControl: { mode: 'enforce' },
  bundles: [
    bundle('viewer', ['UVIEWER'], ['query_codebase', 'chat']),
    bundle('builder', ['UBUILDER'], ['query_codebase', 'chat', 'start_implementation']),
    bundle('admin', ['UADMIN', 'UBOT1'], ['query_codebase', 'chat', 'start_implementation', 'deploy_prod']),
    bundle('admin-elsewhere', ['UFARADMIN'], ['deploy_prod'], ['C9']),
  ],
} as unknown as AppConfig;

const prOf = (url: string): PrContext => {
  const [, owner, repo, , number] = new URL(url).pathname.split('/');
  return { url, owner, repo, number: Number(number) } as PrContext;
};

function makeTask(userId = 'UBUILDER'): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      channelType: 'channel',
      threadTs: '400.1',
      eventTs: '400.1',
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
function fakeSlack(replies: Reply[] | (() => Reply[]) = []) {
  const posted: { text: string; blocks?: unknown }[] = [];
  const slack = {
    chat: {
      postMessage: vi.fn(async (args: { text: string; blocks?: unknown }) => {
        posted.push({ text: args.text, blocks: args.blocks });
        return { ok: true, ts: posted.length === 1 ? PROMPT_TS : `600.${posted.length}` };
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
function fakeActions(runs: FakeRun[], opts: { conclusion?: string } = {}) {
  const calls: string[][] = [];
  let nextId = 1000;
  __ghCli.exec = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'workflow' && args[1] === 'run') {
      const workflow = args[2] as FakeRun['workflow'];
      const ref = args[args.indexOf('--ref') + 1];
      runs.unshift({
        id: (nextId += 1),
        workflow,
        branch: ref,
        status: 'completed',
        conclusion: opts.conclusion ?? 'success',
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

const realWait = __deployOffer.wait;
const realRestore = __deployOffer.restoreStaging;
const restoreMock = vi.fn(async () => {});

beforeEach(() => {
  __deployOfferTiming.pollMs = 1;
  __deployOfferTiming.deadlineMs = 5_000;
  __deployTiming.resolvePollMs = 1;
  __deployTiming.watchPollMs = 1;
  __deployTiming.resolveTimeoutMs = 2_000;
  __deployTiming.watchTimeoutMs = 2_000;
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
  store?: Record<string, string>;
  signal?: AbortSignal;
}) {
  const { slack, posted, raw } = fakeSlack(opts.replies ?? []);
  const calls = fakeActions(opts.runs ?? [], { conclusion: opts.conclusion });
  const logs: { stage: string; data?: Record<string, unknown> }[] = [];
  const state = { ...(opts.store ?? {}) };
  const result = await offerMarketingProdDeploy({
    task: makeTask(opts.requester),
    config,
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

const tap = (user: string, text = 'deploy it', ts = '501.0'): Reply => ({ user, text, ts });

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
  ])('reads %j as a tap', text => expect(isDeployTap(text)).toBe(true));

  it.each(['yes', 'ok', 'looks good', 'deploy it tomorrow', 'should we deploy it?x', 'can you deploy newton-web'])(
    'does not read %j as a tap',
    text => expect(isDeployTap(text)).toBe(false),
  );

  it.each(['no', 'not now', 'not yet', 'later', "don't deploy", 'hold off'])('reads %j as a decline', text =>
    expect(isDeployDecline(text)).toBe(true),
  );
});

describe('who may tap', () => {
  it('is whoever may deploy to production in the channel: the owner and core-dev, never a bot', () => {
    expect(deployTappers(config, 'C1', 'channel').sort()).toEqual(['UADMIN', 'UOWNER1']);
  });

  it('leaves out core-dev people whose bundle is not enabled in the channel', () => {
    expect(deployTappers(config, 'C1', 'channel')).not.toContain('UFARADMIN');
    expect(deployTappers(config, 'C9', 'channel')).toContain('UFARADMIN');
  });
});

describe('the deploy offer after a merge (#703)', () => {
  it('posts one offer, the merge reply first, tagging nobody', async () => {
    const lead = `Merged ${MARKETING_PR}: it only changes text and numbers.`;
    const { posted } = await offer({ lead, replies: [tap('UADMIN')] });

    expect(posted[0]).toBe(`${lead} ${DEPLOY_OFFER_LINE}`);
    expect(posted[0]).not.toContain('<@');
  });

  it('deploys on a tap by core-dev, with the prod deploy arguments, and reports it as the prod deploy does', async () => {
    const { result, posted, calls, logs } = await offer({ replies: [tap('UADMIN')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toEqual([
      ['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy'],
    ]);
    expect(posted).toContain(':rocket: Dispatching the *newton-marketing-web* production deploy (GitHub Actions)…');
    expect(posted.at(-1)).toMatch(/^:white_check_mark: newton-marketing-web production deploy succeeded/);
    expect(logs.find(entry => entry.stage === 'deploy_offer.tapped')?.data).toMatchObject({ userId: 'UADMIN' });
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('deploys on the owner’s tap', async () => {
    const { calls } = await offer({ replies: [tap('UOWNER1', 'Deploy it.')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  it('counts the button as the tap', async () => {
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
    recordButtonReply({ channelId: 'C1', messageTs: PROMPT_TS, userId: 'UADMIN', value: 'deploy it' });
    const result = await run;

    expect(result).toMatchObject({ status: 'SUCCESS' });
    expect(posted.at(-1)?.text).toMatch(/production deploy succeeded/);
  });

  it.each([
    ['the builder who asked', 'UBUILDER'],
    ['a viewer', 'UVIEWER'],
    ['core-dev from another channel', 'UFARADMIN'],
  ])('ignores a tap by %s and says only core-dev can, without tagging core-dev', async (_who, user) => {
    __deployOfferTiming.deadlineMs = 50;
    const { result, posted, calls } = await offer({ replies: [tap(user)] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    const toldOff = posted.filter(text => text.includes('only someone from core-dev'));
    expect(toldOff).toEqual([`<@${user}> only someone from core-dev can put it live.`]);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
    expect(result).toMatchObject({ status: 'SUCCESS', message: DEPLOY_OFFER_EXPIRED });
  });

  it('never takes a tap from a bot, even one on the core-dev list', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { calls } = await offer({
      replies: [tap('UBOT1'), { user: 'UOTHERBOT', text: 'deploy it', ts: '502.0', bot_id: 'B1' }],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
  });

  it('says it is already live when a prod deploy after the merge succeeded, and does not deploy again', async () => {
    const { posted, calls, result } = await offer({
      replies: [tap('UADMIN')],
      runs: [
        {
          id: 9,
          workflow: 'deploy-prod.yml',
          branch: 'main',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-25T10:05:00Z',
          url: 'https://github.com/run/9',
        },
      ],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe('Already live: https://github.com/run/9');
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('deploys when the last successful prod deploy is from before the merge', async () => {
    const { calls } = await offer({
      replies: [tap('UADMIN')],
      runs: [
        {
          id: 8,
          workflow: 'deploy-prod.yml',
          branch: 'main',
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-10-25T09:55:00Z',
        },
      ],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(1);
  });

  it('points at a prod deploy started after the merge that is still running', async () => {
    const { posted, calls } = await offer({
      replies: [tap('UADMIN')],
      runs: [
        {
          id: 9,
          workflow: 'deploy-prod.yml',
          branch: 'main',
          status: 'in_progress',
          createdAt: '2026-10-25T10:01:00Z',
          url: 'https://github.com/run/9',
        },
      ],
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(
      'A production deploy that started after the merge is already running: https://github.com/run/9',
    );
  });

  it('closes the offer after 2 hours with nothing deployed', async () => {
    __deployOfferTiming.deadlineMs = 30;
    const { posted, calls, result } = await offer({});

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['core-dev', 'UADMIN'],
    ['the requester', 'UBUILDER'],
  ])('closes the offer politely when %s says not now', async (_who, user) => {
    const { posted, calls, result } = await offer({ replies: [tap(user, 'not now')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_DECLINED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('ignores chatter and a "no" from a bystander', async () => {
    __deployOfferTiming.deadlineMs = 50;
    const { posted } = await offer({ replies: [tap('UVIEWER', 'no'), tap('UADMIN', 'nice work', '503.0')] });

    expect(posted.at(-1)).toBe(DEPLOY_OFFER_EXPIRED);
  });

  it('closes the offer, and says so, when someone mentions miniOG with something else', async () => {
    const { posted, calls, result } = await offer({ replies: [tap('UBUILDER', '<@UBOT1> also change the heading')] });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(DEPLOY_OFFER_SUPERSEDED);
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('ends cleanly with nothing deployed when the run is stopped while it waits', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { posted, calls, result } = await offer({ signal: controller.signal });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(result).toMatchObject({ status: 'CANCELLED', slackPosted: false });
  });

  it('honours the deploy dry-run switch', async () => {
    const { posted, calls, result } = await offer({
      replies: [tap('UADMIN')],
      store: { [DEPLOY_DRY_RUN_STATE_KEY]: '1' },
    });

    expect(dispatches(calls, 'deploy-prod.yml')).toHaveLength(0);
    expect(posted.at(-1)).toBe(
      'Dry run: this is where I would deploy *newton-marketing-web* to production. Nothing was deployed.',
    );
    expect(result).toMatchObject({ status: 'SUCCESS' });
  });

  it('fails the run when the deploy it started failed', async () => {
    const { posted, result } = await offer({ replies: [tap('UADMIN')], conclusion: 'failure' });

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

  describe('which merges get an offer', () => {
    it('offers after an agent’s merge that GitHub shows as merged into main during the run', async () => {
      const { posted } = await offer({
        merged: [{ url: MARKETING_PR, knownMerged: false }],
        replies: [tap('UADMIN', 'not now')],
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
      const { posted } = await offer({ replies: [tap('UADMIN', 'not now')] });

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
    const { slack } = fakeSlack([tap('UADMIN', 'deploy it', '499.0')]);
    __deployOfferTiming.deadlineMs = 30;

    const result = await waitForDeployTap({
      slack,
      channelId: 'C1',
      threadTs: '400.1',
      promptTs: PROMPT_TS,
      allowedUserIds: ['UADMIN'],
      requesterId: 'UBUILDER',
      botUserId: 'UBOT1',
    });

    expect(result.outcome).toBe('expired');
  });
});

describe('putting main back on staging after a merge (#703)', () => {
  async function restore(runs: FakeRun[], store: Record<string, string> = {}) {
    const { slack, posted } = fakeSlack();
    const calls = fakeActions(runs);
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
