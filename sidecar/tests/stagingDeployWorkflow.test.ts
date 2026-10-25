/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import { LOW_CONFIDENCE_STAGING_QUESTION } from '../src/router/routeClarify.js';
import type { AppConfig, NormalizedTask, PrTarget } from '../src/types/contracts.js';
import { __ghCli, __deployTiming, DEPLOY_DRY_RUN_STATE_KEY } from '../src/workflows/shared/githubActionsRun.js';
import {
  __stagingDeps,
  routeForAppPage,
  routesForChangedFiles,
  runStagingDeployWorkflow,
  stagingHeadsUp,
  MAIN_LATER_REPLY,
  STAGING_HEADS_UP_WINDOW_MS,
  STAGING_PROD_WORD_REPLY,
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
interface FakeRun {
  id: number;
  branch: string;
  headSha?: string;
  status: string;
  conclusion?: string;
}

/**
 * A scripted `gh` that honours its arguments: PRs, branches, what a branch
 * changes against main, and a list of staging runs that `run list` filters
 * by `--branch`, `--status` and `--limit`. Dispatching adds a run.
 */
function fakeGh(
  opts: {
    prs?: Record<number, FakePr>;
    branches?: string[];
    files?: string[];
    runs?: FakeRun[];
    conclusion?: string;
    /** Polls of the new run before it shows up in `run list`. */
    appearAfterPolls?: number;
    /** `run view` keeps saying in_progress; called on each view. */
    stuck?: () => void;
    dispatchError?: string;
    apiError?: string;
    compareError?: string;
    runNeverAppears?: boolean;
    /** The commit a branch was pushed to between the check and the dispatch. */
    pushedSha?: Record<string, string>;
  } = {},
) {
  const runs: FakeRun[] = [...(opts.runs ?? [])];
  let newRun: FakeRun | undefined;
  let pollsAfterDispatch = 0;
  const exec = vi.fn(async (args: string[]) => {
    const [cmd, sub] = args;
    if (cmd === 'api') {
      const route = args[1];
      if (/\/compare\//.test(route)) {
        if (opts.compareError) throw new Error(opts.compareError);
        return (opts.files ?? []).join('\n');
      }
      if (opts.apiError) throw new Error(opts.apiError);
      const pr = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(route);
      if (pr) {
        const found = opts.prs?.[Number(pr[1])];
        if (!found) throw new Error('gh: Not Found (HTTP 404)');
        return JSON.stringify({
          html_url: prUrl(Number(pr[1])),
          number: Number(pr[1]),
          state: found.state ?? 'open',
          merged: found.merged ?? false,
          head: {
            ref: found.head,
            sha: `sha-${found.head}`,
            repo: found.headRepo === null ? null : { full_name: found.headRepo ?? SLUG },
          },
          base: { repo: { full_name: SLUG } },
        });
      }
      const branch = /^repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(route);
      if (branch) {
        if (!opts.branches?.includes(branch[1])) throw new Error('gh: Branch not found (HTTP 404)');
        return JSON.stringify({ name: branch[1], commit: { sha: `sha-${branch[1]}` } });
      }
      throw new Error(`unexpected api ${route}`);
    }
    if (cmd === 'workflow' && sub === 'run') {
      if (opts.dispatchError) throw new Error(opts.dispatchError);
      const ref = args[args.indexOf('--ref') + 1];
      newRun = {
        id: Math.max(100, ...runs.map(run => run.id)) + 1,
        branch: ref,
        headSha: opts.pushedSha?.[ref] ?? `sha-${ref}`,
        status: 'queued',
      };
      if (!opts.runNeverAppears) runs.push(newRun);
      return '';
    }
    if (cmd === 'run' && sub === 'list') {
      const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      const branch = flag('--branch');
      const status = flag('--status');
      const limit = Number(flag('--limit') ?? 20);
      if (newRun) pollsAfterDispatch += 1;
      const visible = runs
        .filter(run => run !== newRun || pollsAfterDispatch > (opts.appearAfterPolls ?? 0))
        .filter(run => !branch || run.branch === branch)
        .filter(run => !status || run.conclusion === status)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return JSON.stringify(
        visible.map(run => ({
          databaseId: run.id,
          headBranch: run.branch,
          headSha: run.headSha,
          url: `https://github.com/x/actions/runs/${run.id}`,
          status: run.status,
          conclusion: run.conclusion,
        })),
      );
    }
    if (cmd === 'run' && sub === 'view') {
      const id = Number(args[2]);
      const run = runs.find(entry => entry.id === id);
      if (opts.stuck) {
        opts.stuck();
        return JSON.stringify({ status: 'in_progress', url: `https://github.com/x/actions/runs/${id}` });
      }
      if (run) {
        run.status = 'completed';
        run.conclusion = opts.conclusion ?? 'success';
      }
      return JSON.stringify({
        status: 'completed',
        conclusion: opts.conclusion ?? 'success',
        url: `https://github.com/x/actions/runs/${id}`,
      });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  __ghCli.exec = exec as any;
  return Object.assign(exec, { runs });
}

const dispatchedRef = (gh: ReturnType<typeof fakeGh>) => {
  const call = gh.mock.calls.find(entry => entry[0][0] === 'workflow');
  return call ? call[0][call[0].indexOf('--ref') + 1] : undefined;
};

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

async function run(task: NormalizedTask, store = makeStore(), signal?: AbortSignal) {
  const slack = makeSlack();
  const result = await runStagingDeployWorkflow({ task, config, slack: slack as any, store, signal });
  return { result, slack, texts: posted(slack).map(post => post.text), store };
}

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

describe('runStagingDeployWorkflow: which branch', () => {
  it('puts the thread PR branch on staging and links the page it changes', async () => {
    const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } }, files: ['src/features/ds-v4/sections/hero.tsx'] });
    const { result, texts, store } = await run(
      makeTask('<@UBOT1> give me a testing link', { prContexts: [prTarget(12, 'thread')] }),
    );

    expect(result).toMatchObject({ workflow: 'STAGING_DEPLOY', status: 'SUCCESS' });
    expect(gh).toHaveBeenCalledWith(['workflow', 'run', 'deploy-staging.yml', '--ref', 'feat/hero'], CLONE, 60_000);
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
    await run(
      makeTask('<@UBOT1> testing link for this one', { prContexts: [prTarget(13, 'trigger'), prTarget(12, 'thread')] }),
    );
    expect(dispatchedRef(gh)).toBe('feat/new');
  });

  it('never reads main mentioned in passing as the branch to deploy', async () => {
    for (const text of [
      '<@UBOT1> give me a testing link before I push to main',
      '<@UBOT1> give me a testing link, is main on staging?',
      '<@UBOT1> deploy this to staging, then ship to main',
      '<@UBOT1> push marketing to staging then reset to main',
    ]) {
      const gh = fakeGh({ prs: { 1484: { head: 'feat/hero' } } });
      await run(makeTask(text, { prContexts: [prTarget(1484, 'thread')] }));
      expect(dispatchedRef(gh), text).toBe('feat/hero');
    }
  });

  it('lets a PR named in the message beat a main mention', async () => {
    const gh = fakeGh({ prs: { 1484: { head: 'feat/hero' } } });
    await run(makeTask('<@UBOT1> put PR #1484 on staging and then push to main'));
    expect(dispatchedRef(gh)).toBe('feat/hero');
  });

  it('deploys main when main is what goes on staging, without looking it up or comparing', async () => {
    for (const text of [
      '<@UBOT1> deploy marketing main to staging',
      '<@UBOT1> put main back on staging',
      '<@UBOT1> restore staging to main',
      '<@UBOT1> staging back to main please',
      '<@UBOT1> main to staging',
    ]) {
      const gh = fakeGh();
      const { texts } = await run(makeTask(text, { prContexts: [prTarget(1484, 'thread')] }));
      expect(dispatchedRef(gh), text).toBe('main');
      expect(gh.mock.calls.some(call => call[0][0] === 'api')).toBe(false);
      expect(texts.at(-1)).toContain('<https://staging-marketing-web.newtonschool.co/>');
    }
  });

  it('deploys a named branch that exists, and tries each slash word until one exists', async () => {
    let gh = fakeGh({ branches: ['fix/hero'] });
    await run(makeTask('<@UBOT1> put my branch fix/hero on marketing staging'));
    expect(dispatchedRef(gh)).toBe('fix/hero');

    gh = fakeGh({ branches: ['feat/hero'] });
    await run(makeTask('<@UBOT1> the UI/UX fix is on feat/hero, give me a testing link'));
    expect(dispatchedRef(gh)).toBe('feat/hero');

    gh = fakeGh({ branches: ['feat/x'] });
    await run(makeTask('<@UBOT1> deploy marketing to staging -- branch is feat/x'));
    expect(dispatchedRef(gh)).toBe('feat/x');
  });

  it('says so when a named branch does not exist, and deploys nothing', async () => {
    const gh = fakeGh({ branches: [] });
    const { result, texts } = await run(makeTask('<@UBOT1> deploy marketing branch fix/nope to staging'));
    expect(result.status).toBe('SKIPPED');
    expect(texts[0]).toBe("I can't find a branch named `fix/nope` in newton-marketing-web.");
    expect(dispatchedRef(gh)).toBeUndefined();
  });

  it('tells a GitHub failure apart from a real 404, and posts no raw error', async () => {
    let gh = fakeGh({ apiError: 'spawn gh ENOENT' });
    let outcome = await run(makeTask('<@UBOT1> give me a testing link', { prContexts: [prTarget(1484, 'thread')] }));
    expect(outcome.result.status).toBe('FAILED');
    expect(outcome.texts[0]).toBe(
      "I couldn't reach GitHub to check that, so I haven't put anything on staging. Try again in a bit.",
    );
    expect(dispatchedRef(gh)).toBeUndefined();

    gh = fakeGh({ apiError: 'HTTP 502: Bad Gateway (https://api.github.com/repos/x/branches/fix/hero)' });
    outcome = await run(makeTask('<@UBOT1> put branch fix/hero on staging'));
    expect(outcome.texts[0]).toMatch(/^I couldn't reach GitHub/);
    expect(outcome.texts[0]).not.toContain('502');

    fakeGh({ prs: {} });
    outcome = await run(makeTask('<@UBOT1> put PR #1484 on staging'));
    expect(outcome.texts[0]).toBe("I couldn't find PR #1484 in newton-marketing-web.");
  });

  it('does not read a bare #N in an ask as a PR', async () => {
    const gh = fakeGh({ prs: { 702: { head: 'wrong/pr' }, 12: { head: 'feat/hero' } } });
    await run(makeTask('<@UBOT1> give me a testing link, this fixes #702', { prContexts: [prTarget(12, 'thread')] }));
    expect(dispatchedRef(gh)).toBe('feat/hero');
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
      expect(dispatchedRef(gh)).toBeUndefined();
    }
  });

  it('asks its question even when the message answered some other question', async () => {
    fakeGh();
    const { result, texts } = await run(
      makeTask('<@UBOT1> a testing link for my marketing change', {
        clarification: {
          question: "I'm not sure what you'd like me to do here. What do you need?",
          askedText: 'staging?',
        },
      }),
    );
    expect(result.status).toBe('PAUSED');
    expect(texts[0]).toBe(`<@UBUILDER> ${STAGING_TARGET_QUESTION}`);
  });

  it('reads the answer to its question: a branch, a bare number, #N or main', async () => {
    const clarification = { question: STAGING_TARGET_QUESTION, askedText: 'give me a testing link' };
    const prContexts = [prTarget(1484, 'thread'), prTarget(1490, 'thread')];
    const cases: Array<[string, string]> = [
      ['feat/answer', 'feat/answer'],
      ['1490', 'feat/x'],
      ['#1490', 'feat/x'],
      ['PR 1490', 'feat/x'],
      ['main', 'main'],
    ];
    for (const [reply, ref] of cases) {
      const gh = fakeGh({ branches: ['feat/answer'], prs: { 1484: { head: 'feat/hero' }, 1490: { head: 'feat/x' } } });
      await run(makeTask(reply, { clarification, prContexts }));
      expect(dispatchedRef(gh), reply).toBe(ref);
    }
  });

  it('gives up on a second unclear reply to its own question or to the router staging question', async () => {
    for (const question of [STAGING_TARGET_QUESTION, LOW_CONFIDENCE_STAGING_QUESTION]) {
      fakeGh();
      const { result, texts } = await run(
        makeTask('the hero one', { clarification: { question, askedText: 'give me a testing link' } }),
      );
      expect(result.status).toBe('SKIPPED');
      expect(texts[0]).toBe(STAGING_TARGET_GIVE_UP);
    }
  });

  it("reads a yes to the router's staging question as the PR in the thread, not a branch called yes", async () => {
    const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } } });
    await run(
      makeTask('yes', {
        clarification: { question: LOW_CONFIDENCE_STAGING_QUESTION, askedText: 'can I see it?' },
        prContexts: [prTarget(12, 'thread')],
      }),
    );
    expect(dispatchedRef(gh)).toBe('feat/hero');
    expect(gh.mock.calls.some(call => String(call[0][1]).endsWith('/branches/yes'))).toBe(false);
  });
});

describe('runStagingDeployWorkflow: round-2 review', () => {
  const thread = [prTarget(1484, 'thread')];
  const prs = { 1484: { head: 'feat/a' }, 1490: { head: 'feat/b' } };

  it('reads a reply on its own first: what it names outranks the message it answers', async () => {
    const cases: Array<[string, string, string, Partial<NormalizedTask>]> = [
      ['no, put main on staging instead', LOW_CONFIDENCE_STAGING_QUESTION, 'maybe put PR #1484 on staging?', {}],
      ['no, PR #1490', LOW_CONFIDENCE_STAGING_QUESTION, 'maybe put PR #1484 on staging?', {}],
      ['no, PR #1490 instead', LOW_CONFIDENCE_STAGING_QUESTION, 'maybe put branch feat/x on staging?', {}],
      ['1490', STAGING_TARGET_QUESTION, 'testing links for PR #1484 and PR #1490 please', {}],
      ['main', STAGING_TARGET_QUESTION, 'testing links for PR #1484 and PR #1490 please', {}],
      [
        '<https://github.com/Newton-School/newton-marketing-web/pull/1490>',
        STAGING_TARGET_QUESTION,
        'testing links for PR #1484 and PR #1490 please',
        { prContexts: [prTarget(1490, 'trigger')] },
      ],
    ];
    const expected = ['main', 'feat/b', 'feat/b', 'feat/b', 'main', 'feat/b'];
    for (const [index, [reply, question, askedText, extra]] of cases.entries()) {
      const gh = fakeGh({ prs, branches: ['feat/x'] });
      await run(makeTask(reply, { clarification: { question, askedText }, ...extra }));
      expect(dispatchedRef(gh), reply).toBe(expected[index]);
    }
  });

  it('falls back to the message a reply answers only when the reply names nothing', async () => {
    const gh = fakeGh({ prs });
    await run(
      makeTask('yes please', {
        clarification: { question: LOW_CONFIDENCE_STAGING_QUESTION, askedText: 'maybe put PR #1484 on staging?' },
      }),
    );
    expect(dispatchedRef(gh)).toBe('feat/a');
  });

  it('passes over "the branch is ready" in silence and uses the thread PR', async () => {
    for (const text of [
      '<@UBOT1> the branch is ready for testing, can I get a staging link?',
      '<@UBOT1> can I get a testing link? the branch was rebased',
      '<@UBOT1> testing link please, branch has the hero fix',
    ]) {
      const gh = fakeGh({ prs });
      const { texts } = await run(makeTask(text, { prContexts: thread }));
      expect(dispatchedRef(gh), text).toBe('feat/a');
      expect(texts.join('\n')).not.toContain("can't find a branch");
    }
  });

  it('checks a head branch named Master or MAIN like any other branch', async () => {
    for (const head of ['Master', 'MAIN', 'master']) {
      const gh = fakeGh({ prs: { 77: { head } }, files: ['.github/workflows/deploy-staging.yml'] });
      const { result, texts } = await run(makeTask('<@UBOT1> testing link for PR #77'));
      expect(result.status, head).toBe('SKIPPED');
      expect(texts[0]).toContain('changes files under .github/');
      expect(gh.mock.calls.some(call => /\/compare\//.test(String(call[0][1])))).toBe(true);
      expect(dispatchedRef(gh)).toBeUndefined();
    }
  });

  it('compares the exact commit it was given', async () => {
    const gh = fakeGh({ prs });
    await run(makeTask('<@UBOT1> testing link for PR #1490'));
    expect(gh.mock.calls.find(call => /\/compare\//.test(String(call[0][1])))?.[0][1]).toBe(
      'repos/Newton-School/newton-marketing-web/compare/main...sha-feat/b',
    );
  });

  it('says so when staging got a newer push than the commit it checked', async () => {
    const logStep = vi.fn();
    fakeGh({ prs, pushedSha: { 'feat/b': 'sha-newer' } });
    const slack = makeSlack();
    await runStagingDeployWorkflow({
      task: makeTask('<@UBOT1> testing link for PR #1490'),
      config,
      slack: slack as any,
      store: makeStore(),
      logStep,
    });
    expect(posted(slack).at(-1)?.text).toMatch(
      /is on staging.*`feat\/b` got a newer push after I checked it, so staging runs a commit I didn't check\.$/,
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'staging.sha_mismatch',
        data: expect.objectContaining({ checkedSha: 'sha-feat/b', ranSha: 'sha-newer' }),
      }),
    );
  });

  it('reads prod and other apps in the words only, never in branch names or side remarks', async () => {
    for (const [text, branch] of [
      ['<@UBOT1> put branch fix/prod-banner on staging', 'fix/prod-banner'],
      ['<@UBOT1> put branch fix/backend-copy on staging', 'fix/backend-copy'],
    ]) {
      const gh = fakeGh({ branches: [branch] });
      await run(makeTask(text));
      expect(dispatchedRef(gh), text).toBe(branch);
    }
    for (const text of [
      '<@UBOT1> testing link please, the api change is merged already',
      '<@UBOT1> can I get a testing link? the backend part is already live',
      '<@UBOT1> give me a testing link for the pre-prod check',
    ]) {
      const gh = fakeGh({ prs });
      await run(makeTask(text, { prContexts: thread }));
      expect(dispatchedRef(gh), text).toBe('feat/a');
    }
  });

  it('deploys nothing when main is asked for later, not the thread PR (round 3)', async () => {
    for (const text of [
      '<@UBOT1> switch staging back to main tomorrow',
      '<@UBOT1> restore staging to main once QA is done',
    ]) {
      const gh = fakeGh({ prs });
      const { result, texts } = await run(makeTask(text, { prContexts: thread }));
      expect(dispatchedRef(gh), text).toBeUndefined();
      expect(result.status).toBe('SKIPPED');
      expect(texts).toEqual([MAIN_LATER_REPLY]);
    }
  });
});

describe('runStagingDeployWorkflow: round-3 review', () => {
  const thread = [prTarget(1484, 'thread')];
  const prs = { 1484: { head: 'feat/a' }, 1490: { head: 'feat/b' } };

  it('puts main back for a polite main ask in a PR thread', async () => {
    for (const text of [
      '<@UBOT1> can you put main back on staging when you get a chance?',
      '<@UBOT1> done testing, put main back on staging so the next person can test',
      '<@UBOT1> put main on staging and send me the staging link',
      '<@UBOT1> put main back on staging and then send me the link',
    ]) {
      const gh = fakeGh({ prs });
      await run(makeTask(text, { prContexts: thread }));
      expect(dispatchedRef(gh), text).toBe('main');
    }
  });

  it('reads a number after a lead-in word as the PR, never as a branch', async () => {
    const clarification = { question: STAGING_TARGET_QUESTION, askedText: 'testing links for PR #1484 and PR #1490' };
    for (const reply of ["it's 1490", 'use 1490', 'try 1490', 'its #1490', 'use PR 1490', 'PR-1490', 'the 1490 one']) {
      const gh = fakeGh({ prs });
      const { texts } = await run(makeTask(reply, { clarification }));
      expect(dispatchedRef(gh), reply).toBe('feat/b');
      expect(texts.join('\n')).not.toContain("can't find a branch");
    }
  });

  it('says a branch named right after "branch" does not exist, instead of using the thread PR', async () => {
    let gh = fakeGh({ prs, branches: [] });
    let outcome = await run(makeTask('<@UBOT1> put branch redesign on staging', { prContexts: thread }));
    expect(outcome.texts[0]).toBe("I can't find a branch named `redesign` in newton-marketing-web.");
    expect(dispatchedRef(gh)).toBeUndefined();

    gh = fakeGh({ prs, branches: ['redesign'] });
    await run(makeTask('<@UBOT1> put branch redesign on staging', { prContexts: thread }));
    expect(dispatchedRef(gh)).toBe('redesign');

    // "the branch looks good" says something about a branch; it names none.
    gh = fakeGh({ prs });
    outcome = await run(makeTask('<@UBOT1> the branch looks good, testing link please', { prContexts: thread }));
    expect(dispatchedRef(gh)).toBe('feat/a');
  });

  it('still deploys the thread PR for a testing-link ask beside "main tomorrow"', async () => {
    const gh = fakeGh({ prs });
    await run(
      makeTask('<@UBOT1> give me a testing link, and switch staging back to main tomorrow', { prContexts: thread }),
    );
    expect(dispatchedRef(gh)).toBe('feat/a');
  });

  it('posts nothing about putting it on staging when stopped during the check', async () => {
    const controller = new AbortController();
    const gh = fakeGh({ branches: ['feat/x'] });
    const original = gh.getMockImplementation() as any;
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api' && /\/compare\//.test(args[1])) controller.abort();
      return original(args);
    });
    const { result, texts } = await run(
      makeTask('<@UBOT1> put branch feat/x on staging'),
      makeStore(),
      controller.signal,
    );
    expect(result.status).toBe('CANCELLED');
    expect(texts).toEqual([]);
    expect(dispatchedRef(gh)).toBeUndefined();
  });
});

describe('runStagingDeployWorkflow: refusals', () => {
  it('refuses a merged PR, a closed PR and a fork PR', async () => {
    const cases: Array<[FakePr, RegExp]> = [
      [{ head: 'a/b', merged: true, state: 'closed' }, /is already merged\. Ask me to put main on staging/],
      [{ head: 'a/b', state: 'closed' }, /is closed/],
      [{ head: 'a/b', headRepo: 'someone/newton-marketing-web' }, /comes from a fork/],
      [{ head: 'a/b', headRepo: null }, /comes from a fork/],
    ];
    for (const [pr, expected] of cases) {
      const gh = fakeGh({ prs: { 12: pr } });
      const { result, texts } = await run(
        makeTask('<@UBOT1> testing link please', { prContexts: [prTarget(12, 'thread')] }),
      );
      expect(result.status).toBe('SKIPPED');
      expect(texts[0]).toMatch(expected);
      expect(dispatchedRef(gh)).toBeUndefined();
    }
  });

  it('refuses an ask about another repo instead of falling back to the thread marketing PR', async () => {
    const cases: Array<[NormalizedTask, RegExp]> = [
      [
        makeTask('<@UBOT1> testing link for <https://github.com/Newton-School/newton-web/pull/9040>', {
          prContexts: [prTarget(9040, 'trigger', 'newton-web'), prTarget(1484, 'thread')],
        }),
        /^I only put newton-marketing-web changes on staging, and <[^|]+\|that PR> is in newton-web\.$/,
      ],
      [
        makeTask('<@UBOT1> deploy newton-web to staging', { prContexts: [prTarget(1484, 'thread')] }),
        /^I only put newton-marketing-web changes on staging\.$/,
      ],
      [
        makeTask('<@UBOT1> put the newton api fix on staging'),
        /^I only put newton-marketing-web changes on staging\.$/,
      ],
      [
        makeTask('<@UBOT1> testing link', { prContexts: [prTarget(9433, 'thread', 'newton-web')] }),
        /that PR> is in newton-web/,
      ],
    ];
    for (const [task, expected] of cases) {
      const gh = fakeGh({ prs: { 1484: { head: 'feat/hero' } } });
      const { result, texts } = await run(task);
      expect(result.status).toBe('SKIPPED');
      expect(texts[0]).toMatch(expected);
      expect(dispatchedRef(gh)).toBeUndefined();
    }
  });

  it('never puts anything on staging from a message that says prod', async () => {
    for (const text of [
      '<@UBOT1> deploy marketing main to prod',
      '<@UBOT1> give me a testing link before production',
    ]) {
      const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } } });
      const { result, texts } = await run(makeTask(text, { prContexts: [prTarget(12, 'thread')] }));
      expect(result.status).toBe('SKIPPED');
      expect(texts).toEqual([STAGING_PROD_WORD_REPLY]);
      expect(gh).not.toHaveBeenCalled();
    }
    // A link that says production is not the message saying it.
    const gh = fakeGh({ prs: { 12: { head: 'feat/hero' } } });
    await run(
      makeTask(
        '<@UBOT1> testing link for <https://github.com/Newton-School/newton-marketing-web/pull/12|fix production banner>',
        {
          prContexts: [prTarget(12, 'trigger')],
        },
      ),
    );
    expect(dispatchedRef(gh)).toBe('feat/hero');
  });

  it('refuses a branch that changes anything under .github/, or that it cannot compare', async () => {
    let gh = fakeGh({ branches: ['feat/x'], files: ['src/app/page.tsx', '.github/workflows/deploy-staging.yml'] });
    let outcome = await run(makeTask('<@UBOT1> put branch feat/x on staging'));
    expect(outcome.result.status).toBe('SKIPPED');
    expect(outcome.texts[0]).toMatch(/^`feat\/x` changes files under \.github\/.*I haven't put it on staging/);
    expect(dispatchedRef(gh)).toBeUndefined();

    gh = fakeGh({ branches: ['feat/x'], compareError: 'HTTP 500' });
    outcome = await run(makeTask('<@UBOT1> put branch feat/x on staging'));
    expect(outcome.texts[0]).toBe(
      "I couldn't check what `feat/x` changes, so I haven't put it on staging. Try again in a bit.",
    );
    // Like GitHub being unreachable: it couldn't be checked.
    expect(outcome.result).toMatchObject({ status: 'FAILED', notifyDesktop: true });
    expect(dispatchedRef(gh)).toBeUndefined();

    gh = fakeGh({ branches: ['feat/x'], files: Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`) });
    outcome = await run(makeTask('<@UBOT1> put branch feat/x on staging'));
    expect(outcome.texts[0]).toMatch(/changes too many files for me to check/);
    expect(dispatchedRef(gh)).toBeUndefined();
  });

  it('refuses a PR whose branch name is not safe to pass on or show', async () => {
    for (const head of ['feat/`x`', 'feat/<x>', 'a&b', '-x', 'a..b']) {
      const gh = fakeGh({ prs: { 12: { head } } });
      const { result, texts } = await run(makeTask('<@UBOT1> testing link', { prContexts: [prTarget(12, 'thread')] }));
      expect(result.status, head).toBe('SKIPPED');
      expect(texts[0]).toBe(
        "That PR's branch name has characters I can't pass on safely, so I haven't put it on staging.",
      );
      expect(texts[0]).not.toContain(head);
      expect(dispatchedRef(gh)).toBeUndefined();
    }
  });

  it('tells a viewer it is not for them, but lets a run on the owner’s lent authority through', async () => {
    let gh = fakeGh();
    let outcome = await run(makeTask('<@UBOT1> deploy marketing main to staging', {}, 'UVIEWER'));
    expect(outcome.result.status).toBe('SKIPPED');
    expect(gh).not.toHaveBeenCalled();

    gh = fakeGh();
    outcome = await run(
      makeTask(
        'main',
        {
          delegatedByOwnerId: 'UOWNER1',
          clarification: { question: STAGING_TARGET_QUESTION, askedText: 'testing link' },
        },
        'USTRANGER',
      ),
    );
    expect(dispatchedRef(gh)).toBe('main');
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
});

describe('runStagingDeployWorkflow: the run', () => {
  it('finds the new run among this branch’s runs only, newer than the anchor', async () => {
    const gh = fakeGh({
      branches: ['feat/hero'],
      runs: [
        { id: 50, branch: 'feat/hero', status: 'completed', conclusion: 'failure' },
        { id: 90, branch: 'main', status: 'completed', conclusion: 'success' },
      ],
      appearAfterPolls: 2,
    });
    const { result, texts } = await run(makeTask('<@UBOT1> put branch feat/hero on staging'));
    const lists = gh.mock.calls.filter(call => call[0][0] === 'run' && call[0][1] === 'list').map(call => call[0]);
    expect(lists[0]).toEqual([
      'run',
      'list',
      '--workflow=deploy-staging.yml',
      '--branch',
      'feat/hero',
      '--limit',
      '1',
      '--json',
      'databaseId,url,status,conclusion,headSha',
    ]);
    // Neither the anchor (50, a failure) nor main's newer run (90) is reported as this one.
    const views = gh.mock.calls.filter(call => call[0][0] === 'run' && call[0][1] === 'view').map(call => call[0][2]);
    expect(views).toEqual(['101']);
    expect(result.status).toBe('SUCCESS');
    expect(texts.at(-1)).toMatch(/^`feat\/hero` is on staging/);
  });

  it('reports a failed, unfollowable or undispatchable deploy without raw errors, and records none of the failures', async () => {
    const cases: Array<[Parameters<typeof fakeGh>[0], string, RegExp, boolean]> = [
      [
        { conclusion: 'failure' },
        'FAILED',
        /^The staging deploy of `main` failed\. Run: https:\/\/github.com\/x\/actions\/runs\/101$/,
        false,
      ],
      [{ runNeverAppears: true }, 'SUCCESS', /couldn't find its run to follow/, true],
      [
        { dispatchError: 'HTTP 422: Workflow does not have workflow_dispatch trigger (https://api.github.com/...)' },
        'FAILED',
        /^Couldn't start the staging deploy of `main`\. Check the Deploy → staging workflow in GitHub Actions\.$/,
        false,
      ],
    ];
    for (const [opts, status, expected, recorded] of cases) {
      fakeGh(opts);
      const { result, texts, store } = await run(makeTask('<@UBOT1> deploy marketing main to staging'));
      expect(result.status, JSON.stringify(opts)).toBe(status);
      expect(texts.at(-1)).toMatch(expected);
      expect(texts.join('\n')).not.toContain('HTTP');
      expect(store.setState.mock.calls.length > 0, JSON.stringify(opts)).toBe(recorded);
    }
  });

  it('says what cancelled a run when it can tell, and calls it skipped, not failed', async () => {
    let gh = fakeGh({ conclusion: 'cancelled' });
    // Someone dispatched feat/other after this run started.
    const original = gh.getMockImplementation() as any;
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'view') gh.runs.push({ id: 150, branch: 'feat/other', status: 'queued' });
      return original(args);
    });
    let outcome = await run(makeTask('<@UBOT1> deploy marketing main to staging'));
    expect(outcome.result.status).toBe('SKIPPED');
    expect(outcome.result.notifyDesktop).toBe(false);
    expect(outcome.texts.at(-1)).toMatch(
      /^The staging deploy of `main` was cancelled: a newer staging deploy of `feat\/other` replaced it\./,
    );
    expect(outcome.store.setState).not.toHaveBeenCalled();

    gh = fakeGh({ conclusion: 'cancelled' });
    outcome = await run(makeTask('<@UBOT1> deploy marketing main to staging'));
    expect(outcome.result.status).toBe('SKIPPED');
    expect(outcome.texts.at(-1)).toMatch(/^The staging deploy of `main` was cancelled in GitHub\./);
  });

  it('after a stop mid-watch, says the deploy carries on and keeps the record true', async () => {
    const controller = new AbortController();
    fakeGh({ stuck: () => controller.abort() });
    const { result, texts, store } = await run(
      makeTask('<@UBOT1> deploy marketing main to staging'),
      makeStore(),
      controller.signal,
    );
    expect(result.status).toBe('CANCELLED');
    expect(result.slackPosted).toBe(true);
    expect(texts.at(-1)).toBe(
      "The staging deploy of `main` had already started, so it carries on in GitHub Actions and will replace what's on staging. Run: https://github.com/x/actions/runs/101",
    );
    expect(JSON.parse(store.state.get(STAGING_STATE_KEY) ?? '{}').branch).toBe('main');
  });

  it('dispatches nothing when stopped before the dispatch', async () => {
    const controller = new AbortController();
    const gh = fakeGh({ branches: ['feat/x'] });
    const original = gh.getMockImplementation() as any;
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] === 'run' && args[1] === 'list') controller.abort();
      return original(args);
    });
    const { result, texts } = await run(
      makeTask('<@UBOT1> put branch feat/x on staging'),
      makeStore(),
      controller.signal,
    );
    expect(result.status).toBe('CANCELLED');
    expect(dispatchedRef(gh)).toBeUndefined();
    // The stop itself says "Stopped."; this corrects "Putting … on staging".
    expect(texts.at(-1)).toBe('Nothing was put on staging: it stopped before the deploy started.');
    expect(texts.join('\n')).not.toMatch(/^Stopped/m);
  });

  it('in dry-run mode reports instead of deploying', async () => {
    const gh = fakeGh();
    const { result, texts } = await run(
      makeTask('<@UBOT1> deploy marketing main to staging'),
      makeStore({ [DEPLOY_DRY_RUN_STATE_KEY]: '1' }),
    );
    expect(result.status).toBe('SUCCESS');
    expect(texts[0]).toBe('Dry run: this is where I would put `main` on staging. Nothing was deployed.');
    expect(dispatchedRef(gh)).toBeUndefined();
  });
});

describe('runStagingDeployWorkflow: the shared-staging heads-up', () => {
  const previous = {
    branch: 'feat/a',
    channelId: 'C-BUILD',
    channelType: 'channel',
    threadTs: '100.1',
    atMs: NOW - 600_000,
  };

  it('tells the thread whose branch it replaced, without tagging anyone', async () => {
    fakeGh({ branches: ['feat/b'], runs: [{ id: 95, branch: 'feat/a', status: 'completed', conclusion: 'success' }] });
    const store = makeStore({ [STAGING_STATE_KEY]: JSON.stringify(previous) });
    const { slack } = await run(makeTask('<@UBOT1> put branch feat/b on staging'), store);
    const headsUp = posted(slack).find(post => post.thread_ts === '100.1');
    expect(headsUp?.text).toMatch(/^Heads-up: staging now shows `feat\/b` \(asked in <https:\/\/.+\|another thread>\)/);
    expect(headsUp?.text).not.toContain('<@');
    expect(JSON.parse(store.state.get(STAGING_STATE_KEY) ?? '{}').branch).toBe('feat/b');
  });

  it('stays quiet when someone deployed another branch from GitHub since the record', async () => {
    fakeGh({
      branches: ['feat/b'],
      runs: [
        { id: 95, branch: 'feat/a', status: 'completed', conclusion: 'success' },
        { id: 97, branch: 'feat/manual', status: 'completed', conclusion: 'success' },
      ],
    });
    const store = makeStore({ [STAGING_STATE_KEY]: JSON.stringify(previous) });
    const { slack } = await run(makeTask('<@UBOT1> put branch feat/b on staging'), store);
    expect(posted(slack).some(post => post.thread_ts === '100.1')).toBe(false);
  });
});
