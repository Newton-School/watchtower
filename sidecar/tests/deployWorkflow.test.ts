/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isDeployRequest, isMarketingDeployRequest } from '../src/router/intentParser.js';
import { normalizeTask } from '../src/router/intentParser.js';
import type { AppConfig, NormalizedTask, SlackEventEnvelope } from '../src/types/contracts.js';
import { runDeployWorkflow, __ghCli } from '../src/workflows/deployWorkflow.js';
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
    expect(isDeployRequest('<@UBOT1> ship the landing pages to production')).toBe(false);
    expect(isDeployRequest('<@UBOT1> deploy newton-marketing-web')).toBe(false);
    expect(isDeployRequest('<@UBOT1> release the webflow migration to prod')).toBe(false);
  });

  it('no longer treats "newton school" as a deterministic newton-web reference', () => {
    // With two frontends, "the newton school site" is genuinely ambiguous.
    expect(isDeployRequest('<@UBOT1> deploy the newton school site')).toBe(false);
  });

  it('detects marketing deploy asks', () => {
    expect(isMarketingDeployRequest('<@UBOT1> deploy the marketing site to prod')).toBe(true);
    expect(isMarketingDeployRequest('<@UBOT1> deploy marketing')).toBe(true);
    expect(isMarketingDeployRequest('<@UBOT1> ship the landing pages to production')).toBe(true);
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
      .mockResolvedValueOnce('') // workflow run dispatch
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            databaseId: 42,
            url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/42',
            status: 'completed',
            conclusion: 'success',
          },
        ]),
      );
    __ghCli.exec = ghExec;
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('actions/runs/42');
    expect(ghExec).toHaveBeenNthCalledWith(
      1,
      ['workflow', 'run', 'deploy-prod.yml', '--ref', 'main', '-f', 'confirm=deploy'],
      '/Users/dipesh/code/mini-og/newton-marketing-web',
      60_000,
    );
    // The newton-web prod skill must never run for a marketing deploy.
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('reports the approval hold when the run is waiting on the production environment', async () => {
    __ghCli.exec = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            databaseId: 43,
            url: 'https://github.com/Newton-School/newton-marketing-web/actions/runs/43',
            status: 'waiting',
          },
        ]),
      );
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.0' });
    const slack = { chat: { postMessage } } as any;

    const result = await runDeployWorkflow({ task: marketingTask(), config: marketingConfig, slack });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('waiting for the production-environment approval');
  });

  it('fails cleanly when the dispatch itself errors', async () => {
    __ghCli.exec = vi.fn().mockRejectedValueOnce(new Error('gh: workflow not found'));
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
