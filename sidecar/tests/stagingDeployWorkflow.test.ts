/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import type { AppConfig, NormalizedTask, PrTarget } from '../src/types/contracts.js';
import { __ghCli, __deployTiming, DEPLOY_DRY_RUN_STATE_KEY } from '../src/workflows/shared/githubActionsRun.js';
import {
  __stagingDeps,
  namedPrNumbers,
  namedStagingBranch,
  routeForAppPage,
  routesForChangedFiles,
  runStagingDeployWorkflow,
  stagingHeadsUp,
  STAGING_HEADS_UP_WINDOW_MS,
  STAGING_STATE_KEY,
  STAGING_TARGET_GIVE_UP,
  STAGING_TARGET_QUESTION,
} from '../src/workflows/stagingDeployWorkflow.js';

const CLONE = '/clones/newton-marketing-web';
const SLUG = 'Newton-School/newton-marketing-web';
const NOW = 1_800_000_000_000;

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C-BUILD',
  allowedChannelsForBugFix: ['C-BUILD'],
  repoPaths: { newtonWeb: '/clones/newton-web', newtonApi: '/clones/newton-api', newtonMarketingWeb: CLONE },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'claude-code',
  prReviewTimeoutMs: 120_000,
  bugFixTimeoutMs: 120_000,
  pmTaskTimeoutMs: 120_000,
  accessControl: toResolvedAccessControlConfig(
    {
      mode: 'enforce',
      groups: {
        viewer: { manualUserIds: 'UVIEWER', allowedChannelIds: 'C-BUILD', allowIm: false, allowMpim: false },
        reviewer: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
        builder: { manualUserIds: 'UBUILDER', allowedChannelIds: 'C-BUILD', allowIm: false, allowMpim: false },
        admin: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
        owner: { manualUserIds: '', allowedChannelIds: '', allowIm: false, allowMpim: false },
      },
    },
    ['UOWNER1'],
  ),
};

const prUrl = (n: number, repo = 'newton-marketing-web') => `https://github.com/Newton-School/${repo}/pull/${n}`;
const prTarget = (n: number, source: PrTarget['source'], repo = 'newton-marketing-web'): PrTarget => ({
  url: prUrl(n, repo),
  owner: 'Newton-School',
  repo,
  number: n,
  source,
});

function makeTask(text: string, extra: Partial<NormalizedTask> = {}, userId = 'UBUILDER'): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C-BUILD',
      channelType: 'channel',
      threadTs: '200.1',
      eventTs: '200.1',
      userId,
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: userId === 'UOWNER1',
    isCoreDevAuthor: false,
    intent: 'STAGING_DEPLOY',
    ...extra,
  };
}

interface FakePr {
  head: string;
  headRepo?: string | null;
  state?: string;
  merged?: boolean;
}

/** A scripted `gh`: PRs, branches, changed files and one staging run. */
function fakeGh(
  opts: {
    prs?: Record<number, FakePr>;
    branches?: string[];
    files?: string[];
    conclusion?: string;
    dispatchError?: string;
    runNeverAppears?: boolean;
  } = {},
) {
  let dispatched = false;
  const exec = vi.fn(async (args: string[]) => {
    const [cmd, sub] = args;
    if (cmd === 'api') {
      const route = args[1];
      const pr = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(route);
      if (pr) {
        const found = opts.prs?.[Number(pr[1])];
        if (!found) throw new Error('HTTP 404');
        return JSON.stringify({
          html_url: prUrl(Number(pr[1])),
          number: Number(pr[1]),
          state: found.state ?? 'open',
          merged: found.merged ?? false,
          head: { ref: found.head, repo: found.headRepo === null ? null : { full_name: found.headRepo ?? SLUG } },
          base: { repo: { full_name: SLUG } },
        });
      }
      const branch = /^repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(route);
      if (branch) {
        if (!opts.branches?.includes(branch[1])) throw new Error('HTTP 404');
        return JSON.stringify({ name: branch[1] });
      }
      if (/\/files\?per_page=100$/.test(route) || /\/compare\//.test(route)) return (opts.files ?? []).join('\n');
      throw new Error(`unexpected api ${route}`);
    }
    if (cmd === 'workflow' && sub === 'run') {
      if (opts.dispatchError) throw new Error(opts.dispatchError);
      dispatched = true;
      return '';
    }
    if (cmd === 'run' && sub === 'list') {
      if (!dispatched || opts.runNeverAppears) return '[]';
      return JSON.stringify([{ databaseId: 77, url: 'https://github.com/x/actions/runs/77', status: 'queued' }]);
    }
    if (cmd === 'run' && sub === 'view') {
      return JSON.stringify({
        status: 'completed',
        conclusion: opts.conclusion ?? 'success',
        url: 'https://github.com/x/actions/runs/77',
      });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  __ghCli.exec = exec as any;
  return exec;
}

function makeStore(initial: Record<string, string> = {}) {
  const state = new Map(Object.entries(initial));
  return {
    state,
    getState: (key: string) => state.get(key),
    setState: vi.fn((key: string, value: string) => void state.set(key, value)),
  };
}

const makeSlack = () => ({ chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '300.1' }) } });
const posted = (slack: ReturnType<typeof makeSlack>) =>
  slack.chat.postMessage.mock.calls.map(call => call[0] as { channel: string; thread_ts: string; text: string });

beforeEach(() => {
  __deployTiming.resolvePollMs = 1;
  __deployTiming.resolveTimeoutMs = 100;
  __deployTiming.watchPollMs = 1;
  __deployTiming.watchTimeoutMs = 100;
  __stagingDeps.now = () => NOW;
  __stagingDeps.listAppPages = async () => [
    {
      file: 'src/app/(landing)/courses/data-science/page.tsx',
      source: "import Hero from '@/features/ds-v4/sections/hero';",
    },
    { file: 'src/app/(landing)/courses/data-science-v2/page.tsx', source: "import X from '@/features/ds-v4';" },
    { file: 'src/app/(landing)/nst/page.tsx', source: "import Nav from '@/features/nst-shell/sections/nav';" },
  ];
});

describe('namedStagingBranch', () => {
  it('reads a branch named in the message', () => {
    expect(namedStagingBranch('<@UBOT1> deploy marketing branch fix/hero-v2.1 to staging')).toEqual({
      branch: 'fix/hero-v2.1',
      explicit: true,
    });
    expect(namedStagingBranch('put `feat/nst-hire` on staging')).toEqual({ branch: 'feat/nst-hire', explicit: true });
    expect(namedStagingBranch('can you put my fix/hero on marketing staging?')).toEqual({
      branch: 'fix/hero',
      explicit: false,
    });
  });

  it('reads main when main is what goes on staging', () => {
    for (const text of [
      'deploy marketing main to staging',
      'put main back on staging',
      'restore staging to main',
      'staging back to main please',
      'main to staging',
    ]) {
      expect(namedStagingBranch(text)?.branch, text).toBe('main');
    }
  });

  it('does not read a branch where there is none', () => {
    for (const text of [
      'give me a testing link',
      'deploy the main banner change to staging',
      'put my branch on staging',
      'this is and/or that on staging',
      'deploy it to staging in 24/7 mode',
      'see https://github.com/Newton-School/newton-marketing-web/tree/fix/hero',
    ]) {
      expect(namedStagingBranch(text), text).toBeUndefined();
    }
  });

  it('reads a reply that is only a name as that branch', () => {
    expect(namedStagingBranch('fix-hero', { answering: true })).toEqual({ branch: 'fix-hero', explicit: true });
    expect(namedStagingBranch('main', { answering: true })).toEqual({ branch: 'main', explicit: true });
    expect(namedStagingBranch('1484', { answering: true })).toBeUndefined();
  });
});

describe('namedPrNumbers', () => {
  it('reads PR numbers written without a link', () => {
    expect(namedPrNumbers('put PR #1484 on staging')).toEqual([1484]);
    expect(namedPrNumbers('staging for pull request 12 please')).toEqual([12]);
    expect(namedPrNumbers('#1484 and #1485')).toEqual([1484, 1485]);
    expect(namedPrNumbers('put it on staging in 5 minutes')).toEqual([]);
  });
});

describe('routes', () => {
  it('derives the route an app page serves', () => {
    expect(routeForAppPage('src/app/(landing)/courses/data-science/page.tsx')).toBe('/courses/data-science');
    expect(routeForAppPage('src/app/page.tsx')).toBe('/');
    expect(routeForAppPage('src/app/(landing)/blog/[slug]/page.tsx')).toBeUndefined();
    expect(routeForAppPage('src/app/(landing)/courses/layout.tsx')).toBeUndefined();
    expect(routeForAppPage('src/features/ds-v4/content.ts')).toBeUndefined();
  });

  it('uses edited pages first, else the pages that import an edited feature, at most two', async () => {
    const pages = await __stagingDeps.listAppPages(CLONE);
    expect(routesForChangedFiles(['src/app/(landing)/nst/page.tsx', 'src/features/ds-v4/content.ts'], pages)).toEqual([
      '/nst',
    ]);
    expect(routesForChangedFiles(['src/features/ds-v4/content.ts'], pages)).toEqual([
      '/courses/data-science',
      '/courses/data-science-v2',
    ]);
    expect(routesForChangedFiles(['src/features/ds-v4/content.ts'], pages, 1)).toEqual(['/courses/data-science']);
    expect(routesForChangedFiles(['src/components/forms/apply-form.tsx'], pages)).toEqual([]);
    // A feature whose name is a prefix of another is not that one.
    expect(routesForChangedFiles(['src/features/ds/content.ts'], pages)).toEqual([]);
  });
});

describe('stagingHeadsUp', () => {
  const next = { branch: 'feat/b', channelId: 'C-BUILD', channelType: 'channel', threadTs: '200.1' };
  const previous = {
    branch: 'feat/a',
    channelId: 'C-BUILD',
    channelType: 'channel',
    threadTs: '100.1',
    atMs: NOW - 60_000,
  };

  it('links the new thread when both are in the same channel', () => {
    const line = stagingHeadsUp({ previous, next, nowMs: NOW });
    expect(line).toMatchObject({ channelId: 'C-BUILD', threadTs: '100.1' });
    expect(line?.text).toMatch(
      /^Heads-up: staging now shows `feat\/b` \(asked in <https:\/\/[^|]+\|another thread>\)\./,
    );
    expect(line?.text).toContain('Ask me again when you need your link.');
    expect(line?.text).not.toMatch(/<@/);
  });

  it('gives no link across channels or from a DM', () => {
    expect(stagingHeadsUp({ previous: { ...previous, channelId: 'C-OTHER' }, next, nowMs: NOW })?.text).toContain(
      '`feat/b` for another request.',
    );
    expect(stagingHeadsUp({ previous, next: { ...next, channelType: 'im' }, nowMs: NOW })?.text).toContain(
      'for another request',
    );
  });

  it('says nothing for main, the same branch, the same thread, or a branch put there two hours ago', () => {
    expect(stagingHeadsUp({ previous: { ...previous, branch: 'main' }, next, nowMs: NOW })).toBeUndefined();
    expect(stagingHeadsUp({ previous: { ...previous, branch: 'feat/b' }, next, nowMs: NOW })).toBeUndefined();
    expect(stagingHeadsUp({ previous: { ...previous, threadTs: '200.1' }, next, nowMs: NOW })).toBeUndefined();
    expect(
      stagingHeadsUp({ previous: { ...previous, atMs: NOW - STAGING_HEADS_UP_WINDOW_MS }, next, nowMs: NOW }),
    ).toBeUndefined();
    expect(stagingHeadsUp({ previous: undefined, next, nowMs: NOW })).toBeUndefined();
  });
});

describe('runStagingDeployWorkflow', () => {
  it('puts the thread PR branch on staging and links the page it changes', async () => {
    const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } }, files: ['src/features/ds-v4/sections/hero.tsx'] });
    const slack = makeSlack();
    const store = makeStore();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> give me a testing link', { prContexts: [prTarget(12, 'thread')] }),
      config,
      slack: slack as any,
      store,
    });

    expect(result).toMatchObject({ workflow: 'STAGING_DEPLOY', status: 'SUCCESS' });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'feat/hero'], CLONE, 60_000);
    // The new run is found among this branch's runs only.
    expect(gh).toHaveBeenCalledWith(
      [
        'run',
        'list',
        '--workflow=deploy-staging.yml',
        '--branch',
        'feat/hero',
        '--limit',
        '1',
        '--json',
        'databaseId,url,status,conclusion',
      ],
      CLONE,
      30_000,
    );
    const texts = posted(slack).map(post => post.text);
    expect(texts[0]).toBe('Putting `feat/hero` on staging, about 3 minutes.');
    expect(texts[1]).toBe(
      '`feat/hero` is on staging: <https://staging-marketing-web.newtonschool.co/courses/data-science> and <https://staging-marketing-web.newtonschool.co/courses/data-science-v2>. Staging is shared, so the next staging deploy replaces it.',
    );
    expect(JSON.parse(store.state.get(STAGING_STATE_KEY) ?? '{}')).toMatchObject({
      branch: 'feat/hero',
      prUrl: prUrl(12),
      channelId: 'C-BUILD',
      threadTs: '200.1',
      atMs: NOW,
    });
  });

  it('prefers a PR in the message over one earlier in the thread', async () => {
    const gh = fakeGh({ prs: { 12: { head: 'feat/old' }, 13: { head: 'feat/new' } } });
    await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> testing link for this one', {
        prContexts: [prTarget(13, 'trigger'), prTarget(12, 'thread')],
      }),
      config,
      slack: makeSlack() as any,
      store: makeStore(),
    });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'feat/new'], CLONE, 60_000);
  });

  it('deploys a named branch that exists, and main without looking it up', async () => {
    let gh = fakeGh({ branches: ['fix/hero'] });
    await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> put my branch fix/hero on marketing staging'),
      config,
      slack: makeSlack() as any,
      store: makeStore(),
    });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'fix/hero'], CLONE, 60_000);

    gh = fakeGh();
    const slack = makeSlack();
    await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy marketing main to staging'),
      config,
      slack: slack as any,
      store: makeStore(),
    });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'main'], CLONE, 60_000);
    expect(gh.mock.calls.some(call => String(call[0][1]).includes('/branches/'))).toBe(false);
    expect(posted(slack)[1].text).toContain('<https://staging-marketing-web.newtonschool.co/>');
  });

  it('says so when a named branch does not exist, and deploys nothing', async () => {
    const gh = fakeGh({ branches: [] });
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy marketing branch fix/nope to staging'),
      config,
      slack: slack as any,
      store: makeStore(),
    });
    expect(result.status).toBe('SKIPPED');
    expect(posted(slack)[0].text).toBe("I can't find a branch named `fix/nope` in newton-marketing-web.");
    expect(gh.mock.calls.some(call => call[0][0] === 'workflow')).toBe(false);
  });

  it('asks which one, and parks the job, when it cannot tell or there are several PRs', async () => {
    for (const prContexts of [undefined, [prTarget(12, 'thread'), prTarget(13, 'thread')]]) {
      const gh = fakeGh({ prs: { 12: { head: 'a/b' }, 13: { head: 'c/d' } } });
      const slack = makeSlack();
      const logStep = vi.fn();
      const result = await runStagingDeployWorkflow({
        task: makeTask('<@UBOT1> give me a testing link', { prContexts }),
        config,
        slack: slack as any,
        store: makeStore(),
        logStep,
      });
      expect(result).toMatchObject({ workflow: 'STAGING_DEPLOY', status: 'PAUSED' });
      expect(posted(slack)[0].text).toBe(`<@UBUILDER> ${STAGING_TARGET_QUESTION}`);
      expect(logStep).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'router.clarify.asked',
          data: expect.objectContaining({ reason: 'staging_target' }),
        }),
      );
      expect(gh.mock.calls.some(call => call[0][0] === 'workflow')).toBe(false);
    }
  });

  it('reads the answer to its question, and does not ask twice', async () => {
    const gh = fakeGh({ branches: ['feat/answer'] });
    const clarification = { question: STAGING_TARGET_QUESTION, askedText: 'give me a testing link' };
    await runStagingDeployWorkflow({
      task: makeTask('feat/answer', { clarification }),
      config,
      slack: makeSlack() as any,
      store: makeStore(),
    });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'feat/answer'], CLONE, 60_000);

    fakeGh();
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('the hero one', { clarification }),
      config,
      slack: slack as any,
      store: makeStore(),
    });
    expect(result.status).toBe('SKIPPED');
    expect(posted(slack)[0].text).toBe(STAGING_TARGET_GIVE_UP);
  });

  it("reads a yes to the router's staging question as the PR in the thread, not a branch called yes", async () => {
    const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } } });
    await runStagingDeployWorkflow({
      task: makeTask('yes', {
        clarification: {
          question: 'Do you want me to put this on the marketing staging site?',
          askedText: 'can I see it?',
        },
        prContexts: [prTarget(12, 'thread')],
      }),
      config,
      slack: makeSlack() as any,
      store: makeStore(),
    });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'feat/hero'], CLONE, 60_000);
    expect(gh.mock.calls.some(call => String(call[0][1]).endsWith('/branches/yes'))).toBe(false);
  });

  it('refuses a merged PR, a closed PR, a fork PR, and a PR of another repo', async () => {
    const cases: Array<[FakePr | undefined, PrTarget, RegExp]> = [
      [
        { head: 'a/b', merged: true, state: 'closed' },
        prTarget(12, 'thread'),
        /is already merged\. Ask me to put main on staging/,
      ],
      [{ head: 'a/b', state: 'closed' }, prTarget(12, 'thread'), /is closed/],
      [{ head: 'a/b', headRepo: 'someone/newton-marketing-web' }, prTarget(12, 'thread'), /comes from a fork/],
      [{ head: 'a/b', headRepo: null }, prTarget(12, 'thread'), /comes from a fork/],
      [
        undefined,
        prTarget(9433, 'thread', 'newton-web'),
        /^I only put newton-marketing-web changes on staging, and <[^|]+\|that PR> is in newton-web\.$/,
      ],
    ];
    for (const [pr, target, expected] of cases) {
      const gh = fakeGh({ prs: pr ? { 12: pr } : {} });
      const slack = makeSlack();
      const result = await runStagingDeployWorkflow({
        task: makeTask('<@UBOT1> testing link please', { prContexts: [target] }),
        config,
        slack: slack as any,
        store: makeStore(),
      });
      expect(result.status).toBe('SKIPPED');
      expect(posted(slack)[0].text).toMatch(expected);
      expect(gh.mock.calls.some(call => call[0][0] === 'workflow')).toBe(false);
    }
  });

  it('refuses a staging ask for another app instead of asking which branch', async () => {
    fakeGh();
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy newton-web to staging'),
      config,
      slack: slack as any,
      store: makeStore(),
    });
    expect(result.status).toBe('SKIPPED');
    expect(posted(slack)[0].text).toBe('I only put newton-marketing-web changes on staging.');
  });

  it('tells a viewer it is not for them', async () => {
    const gh = fakeGh();
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy marketing main to staging', {}, 'UVIEWER'),
      config,
      slack: slack as any,
      store: makeStore(),
    });
    expect(result.status).toBe('SKIPPED');
    expect(gh).not.toHaveBeenCalled();
  });

  it('says the clone is missing on a host without it', async () => {
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy marketing main to staging'),
      config: { ...config, repoPaths: { newtonWeb: '/a', newtonApi: '/b' } },
      slack: slack as any,
    });
    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain("clone isn't configured");
  });

  it('reports a failed, cancelled, unfollowable or undispatchable deploy', async () => {
    const cases: Array<[Parameters<typeof fakeGh>[0], string, RegExp]> = [
      [
        { conclusion: 'failure' },
        'FAILED',
        /^The staging deploy of `main` failed\. Run: https:\/\/github.com\/x\/actions\/runs\/77$/,
      ],
      [{ conclusion: 'cancelled' }, 'FAILED', /was cancelled: a newer staging deploy started before it finished/],
      [{ runNeverAppears: true }, 'SUCCESS', /couldn't find its run to follow/],
      [{ dispatchError: 'HTTP 422' }, 'FAILED', /^Couldn't start the staging deploy of `main`: HTTP 422$/],
    ];
    for (const [opts, status, expected] of cases) {
      fakeGh(opts);
      const slack = makeSlack();
      const store = makeStore();
      const result = await runStagingDeployWorkflow({
        task: makeTask('<@UBOT1> deploy marketing main to staging'),
        config,
        slack: slack as any,
        store,
      });
      expect(result.status, JSON.stringify(opts)).toBe(status);
      expect(posted(slack).at(-1)?.text).toMatch(expected);
      // Only a deploy that went live is recorded.
      expect(store.setState).not.toHaveBeenCalled();
    }
  });

  it('in dry-run mode reports instead of deploying', async () => {
    const gh = fakeGh();
    const slack = makeSlack();
    const result = await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> deploy marketing main to staging'),
      config,
      slack: slack as any,
      store: makeStore({ [DEPLOY_DRY_RUN_STATE_KEY]: '1' }),
    });
    expect(result.status).toBe('SUCCESS');
    expect(posted(slack)[0].text).toBe('Dry run: this is where I would put `main` on staging. Nothing was deployed.');
    expect(gh.mock.calls.some(call => call[0][0] === 'workflow')).toBe(false);
  });

  it('tells the thread whose branch it replaced, without tagging anyone', async () => {
    fakeGh({ branches: ['feat/b'] });
    const slack = makeSlack();
    const previous = {
      branch: 'feat/a',
      channelId: 'C-BUILD',
      channelType: 'channel',
      threadTs: '100.1',
      atMs: NOW - 600_000,
    };
    const store = makeStore({ [STAGING_STATE_KEY]: JSON.stringify(previous) });
    await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> put branch feat/b on staging'),
      config,
      slack: slack as any,
      store,
    });
    const headsUp = posted(slack).find(post => post.thread_ts === '100.1');
    expect(headsUp?.text).toMatch(/^Heads-up: staging now shows `feat\/b` \(asked in <https:\/\/.+\|another thread>\)/);
    expect(headsUp?.text).not.toContain('<@');
    expect(JSON.parse(store.state.get(STAGING_STATE_KEY) ?? '{}').branch).toBe('feat/b');
  });
});
