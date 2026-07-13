/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDeployTarget, isDeployRequest, isMarketingDeployRequest } from '../src/router/intentParser.js';
import { normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, NormalizedTask, SlackEventEnvelope } from '../src/types/contracts.js';
import { runDeployWorkflow, __ghCli, __deployTiming } from '../src/workflows/deployWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
}));

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
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
};

const baseEvent: SlackEventEnvelope = {
  eventId: 'Ev1',
  channelId: 'C01H25RNLJH',
  threadTs: '123.45',
  eventTs: '123.45',
  userId: 'UOWNER1',
  text: '',
  rawEvent: {},
};

describe('isDeployRequest', () => {
  it('matches "deploy newton-web to prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy newton-web to prod')).toBe(true);
  });

  it('matches "deploy to production"', () => {
    expect(isDeployRequest('<@UBOT1> deploy to production')).toBe(true);
  });

  it('matches "deploy prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy prod')).toBe(true);
  });

  it('matches "ship newton-web to production"', () => {
    expect(isDeployRequest('<@UBOT1> ship newton-web to production')).toBe(true);
  });

  it('matches "release newton web to prod"', () => {
    expect(isDeployRequest('<@UBOT1> release newton web to prod')).toBe(true);
  });

  it('matches "push to prod"', () => {
    expect(isDeployRequest('<@UBOT1> push to prod')).toBe(true);
  });

  it('matches "deploy newton-web" without explicit prod mention', () => {
    expect(isDeployRequest('<@UBOT1> deploy newton-web')).toBe(true);
  });

  it('matches "deploy the frontend to prod"', () => {
    expect(isDeployRequest('<@UBOT1> deploy the frontend to prod')).toBe(true);
  });

  it('does not match "deploy" alone without target or app', () => {
    expect(isDeployRequest('<@UBOT1> deploy')).toBe(false);
  });

  it('does not match unrelated messages', () => {
    expect(isDeployRequest('<@UBOT1> fix the login bug')).toBe(false);
  });

  it('does not match "deploy" in unrelated context', () => {
    expect(isDeployRequest('<@UBOT1> how does the deploy pipeline work?')).toBe(false);
  });
});

describe('normalizeTask routes DEPLOY deterministically', () => {
  it('routes "deploy newton-web to prod" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> deploy newton-web to prod' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('routes "deploy to production" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> deploy to production' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('routes "ship prod" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> ship prod' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });

  it('does not route "fix the deploy script" as DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> fix the deploy script' }, config, []);
    expect(task.intent).not.toBe('DEPLOY');
  });

  it('prioritizes DEV_ASSIST prefix over DEPLOY', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> wt deploy prod' }, config, []);
    expect(task.intent).toBe('DEV_ASSIST');
  });
});

describe('marketing deploy gating', () => {
  it('never treats a marketing deploy ask as the newton-web deploy', () => {
    expect(isDeployRequest('<@UBOT1> deploy the marketing site to prod')).toBe(false);
    expect(isDeployRequest('<@UBOT1> deploy newton-marketing-web')).toBe(false);
    expect(isDeployRequest('<@UBOT1> release the webflow migration to prod')).toBe(false);
  });

  it('signals for BOTH repos in one message classify as ambiguous — neither prod deploy is guessed', () => {
    // Review findings (both directions): an incidental mention of the other
    // repo must not pick a winner. "deploy newton-web … marketing …" must not
    // silently deploy either repo, and vice versa.
    for (const text of [
      '<@UBOT1> deploy newton-web to prod — marketing needs the new banner live',
      '<@UBOT1> deploy the marketing site to prod — the newton-web banner is already live',
    ]) {
      expect(classifyDeployTarget(text)).toBe('ambiguous');
      expect(isDeployRequest(text)).toBe(false);
      expect(isMarketingDeployRequest(text)).toBe(false);
    }
  });

  it('ambiguous frontend targets stay in the DEPLOY flow but pin no repo', () => {
    // "landing page" / "homepage" / "newton school" describe screens in both
    // frontends — a prod deploy must not be guessed from them, but the ask is
    // still deploy-shaped: only the deterministic gate can produce DEPLOY, so
    // these must not leak into the implementation pipeline.
    for (const text of [
      '<@UBOT1> ship the landing pages to production',
      '<@UBOT1> deploy the landing page changes to prod',
      '<@UBOT1> ship the homepage to production',
      '<@UBOT1> deploy the newton school site',
    ]) {
      expect(classifyDeployTarget(text)).toBe('ambiguous');
      expect(isDeployRequest(text)).toBe(false);
      expect(isMarketingDeployRequest(text)).toBe(false);
      const task = normalizeTask({ ...baseEvent, text }, config, []);
      expect(task.intent).toBe('DEPLOY');
    }
  });

  it('detects marketing deploy asks', () => {
    expect(isMarketingDeployRequest('<@UBOT1> deploy the marketing site to prod')).toBe(true);
    expect(isMarketingDeployRequest('<@UBOT1> deploy marketing')).toBe(true);
    expect(isMarketingDeployRequest('<@UBOT1> release the webflow migration to prod')).toBe(true);
    expect(isMarketingDeployRequest('<@UBOT1> deploy newton-web to prod')).toBe(false);
    expect(isMarketingDeployRequest('<@UBOT1> the marketing page is broken')).toBe(false);
  });

  it('routes marketing deploy asks to DEPLOY deterministically', () => {
    const task = normalizeTask({ ...baseEvent, text: '<@UBOT1> deploy the marketing site to prod' }, config, []);
    expect(task.intent).toBe('DEPLOY');
  });
});

describe('runDeployWorkflow marketing branch', () => {
  function marketingTask(text = '<@UBOT1> deploy the marketing site to prod'): NormalizedTask {
    return {
      event: {
        eventId: 'Ev-mkt-deploy',
        channelId: 'C-DEPLOY',
        threadTs: '888.77',
        eventTs: '888.77',
        userId: 'UOWNER1',
        text,
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: true,
      isCoreDevAuthor: true,
      intent: 'DEPLOY',
    };
  }

  const marketingConfig: AppConfig = {
    ...config,
    repoPaths: { ...config.repoPaths, newtonMarketingWeb: '/Users/dipesh/code/mini-og/newton-marketing-web' },
  };

  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    __ghCli.exec = vi.fn().mockResolvedValue('');
    // Never sleep for real in tests.
    __deployTiming.resolvePollMs = 1;
    __deployTiming.resolveTimeoutMs = 200;
    __deployTiming.watchPollMs = 1;
    __deployTiming.watchTimeoutMs = 200;
  });

  it('skips with guidance when the marketing clone is not configured — and never runs gh or the newton-web skill', async () => {
    const ghExec = vi.fn();
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config, slack });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('newton_marketing_web_path');
    expect(ghExec).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('explains that staging needs no trigger', async () => {
    const ghExec = vi.fn();
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({
      task: marketingTask('<@UBOT1> deploy marketing to staging'),
      config: marketingConfig,
      slack,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('Nothing to trigger');
    expect(ghExec).not.toHaveBeenCalled();
  });

  it('dispatches the GitHub Actions prod deploy and reports the completed run', async () => {
    const ghExec = vi
      .fn()
      .mockResolvedValueOnce('[]') // pre-dispatch anchor read (no prior runs)
      .mockResolvedValueOnce('') // workflow run dispatch
      .mockResolvedValueOnce(
        // resolve the new run
        JSON.stringify([
          {
            databaseId: 42,
            url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/42',
            status: 'in_progress',
          },
        ]),
      )
      .mockResolvedValueOnce(
        // watch that run by id
        JSON.stringify({
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/42',
        }),
      );
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('actions/runs/42');
    expect(ghExec).toHaveBeenNthCalledWith(
      2,
      ['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy'],
      '/Users/dipesh/code/mini-og/newton-marketing-web',
      60_000,
    );
    expect(ghExec).toHaveBeenNthCalledWith(
      4,
      ['run', 'view', '42', '--json', 'status,conclusion,url'],
      expect.any(String),
      30_000,
    );
    // The newton-web prod skill must never run for a marketing deploy.
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("never reports the PREVIOUS run's outcome as this deploy's result (anchor race)", async () => {
    // Review finding: gh workflow run returns before GitHub materializes the
    // new run; the first post-dispatch poll can still see the previous
    // (completed) run. The watcher must anchor on the pre-dispatch run id and
    // wait for a DIFFERENT id.
    const oldRun = {
      databaseId: 41,
      url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/41',
      status: 'completed',
      conclusion: 'success',
    };
    __ghCli.exec = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([oldRun])) // anchor read → run 41
      .mockResolvedValueOnce('') // dispatch
      .mockResolvedValueOnce(JSON.stringify([oldRun])) // new run not materialized yet — must NOT be reported
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            databaseId: 42,
            url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/42',
            status: 'queued',
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/42',
        }),
      );
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    // It reports run 42's real outcome (failure) — never run 41's stale success.
    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('actions/runs/42');
    expect(result.message).not.toContain('actions/runs/41');
  });

  it('reports the approval hold when the run is waiting on the production environment', async () => {
    __ghCli.exec = vi
      .fn()
      .mockResolvedValueOnce('[]') // anchor
      .mockResolvedValueOnce('') // dispatch
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            databaseId: 43,
            url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/43',
            status: 'waiting',
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          status: 'waiting',
          url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/43',
        }),
      );
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('waiting for the production-environment approval');
  });

  it('an ambiguous deploy ask on a marketing-enabled host asks for the target instead of deploying', async () => {
    const ghExec = vi.fn();
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({
      task: marketingTask('<@UBOT1> ship the landing pages to production'),
      config: marketingConfig,
      slack,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('could mean');
    expect(ghExec).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('an ambiguous deploy ask without the marketing clone falls through to the newton-web deploy (pre-stack behavior)', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Deploy succeeded.',
      parsedJson: undefined,
    } as any);
    const ghExec = vi.fn();
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({
      task: marketingTask('<@UBOT1> ship the landing pages to production'),
      config, // no marketing path — only one deployable frontend on this host
      slack,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(ghExec).not.toHaveBeenCalled();
  });

  it('skips run-watching (no stale-run report) when the pre-dispatch anchor read fails', async () => {
    // Review finding: a failed anchor read must not collapse into "no prior
    // runs" — with an unknown anchor the watcher could pick up the PREVIOUS
    // deploy's run and report its outcome as this one's.
    const ghExec = vi
      .fn()
      .mockRejectedValueOnce(new Error('gh timeout')) // anchor read fails
      .mockResolvedValueOnce(''); // dispatch succeeds
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain("couldn't establish a pre-dispatch baseline");
    // Exactly two gh calls: anchor attempt + dispatch. No run list/view polling.
    expect(ghExec).toHaveBeenCalledTimes(2);
  });

  it('fails cleanly when the dispatch itself errors', async () => {
    __ghCli.exec = vi
      .fn()
      .mockResolvedValueOnce('[]') // anchor read succeeds
      .mockRejectedValueOnce(new Error('gh: workflow not found')); // dispatch fails
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain("Couldn't dispatch");
    expect(runCodex).not.toHaveBeenCalled();
  });
});

describe('runDeployWorkflow idempotency on Slack post failure', () => {
  function deployTask(): NormalizedTask {
    return {
      event: {
        eventId: 'Ev-deploy',
        channelId: 'C-DEPLOY',
        threadTs: '999.88',
        eventTs: '999.88',
        userId: 'UOWNER1',
        text: '<@UBOT1> deploy newton-web to prod',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: true,
      isCoreDevAuthor: true,
      intent: 'DEPLOY',
    };
  }

  it('runs the deploy codex exactly once even when the final Slack reply throws transiently', async () => {
    // Regression for #287: a transient slack.chat.postMessage failure (ETIMEDOUT etc.)
    // used to escape the workflow and trip the index.ts retry loop, which re-entered
    // the deploy workflow and called runCodex again. A flaky notification could
    // duplicate a production deploy up to 3 times.
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Deploy succeeded. v1.2.3 live.',
      parsedJson: undefined,
    });

    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1.0' }) // ack post ("Deploying newton-web to production...")
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const slack = { chat: { postMessage } } as any;
    const result = await runDeployWorkflow({ task: deployTask(), config, slack });

    // The deploy itself must run exactly once.
    expect(runCodex).toHaveBeenCalledTimes(1);
    // The workflow must NOT throw — that's what would trigger the index.ts retry loop.
    expect(result.status).toBe('SUCCESS');
    expect(result.slackPosted).toBe(false);
    // The ack + 3 final-reply attempts = 4 calls total.
    expect(postMessage).toHaveBeenCalledTimes(4);
  });

  it('returns SUCCESS and slackPosted=true when the final reply lands on a later retry', async () => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: 'Deploy succeeded.',
      parsedJson: undefined,
    });

    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: '1.0' }) // ack post
      .mockRejectedValueOnce(new Error('ECONNRESET')) // first reply attempt
      .mockResolvedValueOnce({ ok: true, ts: '2.0' }); // second attempt succeeds

    const slack = { chat: { postMessage } } as any;
    const result = await runDeployWorkflow({ task: deployTask(), config, slack });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
    expect(result.slackPosted).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(3);
  });
});
