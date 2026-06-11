/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgenticPrReview } from '../src/agentic/agenticPrReview.js';
import { resolveGithubTokenForCodex } from '../src/github/githubAuth.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn().mockResolvedValue(undefined),
  githubAuthModeHint: vi.fn().mockReturnValue('none'),
}));

const API_PR = 'https://github.com/Newton-School/newton-api/pull/5781';
const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/8652';

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
    newtonWeb: '/repos/newton-web',
    newtonApi: '/repos/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: true,
  agentBackend: 'codex',
  prReviewTimeoutMs: 120_000,
  bugFixTimeoutMs: 120_000,
  pmTaskTimeoutMs: 120_000,
} as AppConfig;

function makeSlack(threadTexts: string[]) {
  return {
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: threadTexts.map(text => ({ text })) }),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '99.11' }),
    },
  };
}

function makeTask(text: string): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      threadTs: '123.45',
      eventTs: '123.46',
      userId: 'U_AKASH',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'PR_REVIEW',
  };
}

function agentOk(findings: unknown[], summaryNotes: string[] = []) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '{}',
    stderr: '',
    lastMessage: '',
    parsedJson: { findings, summaryNotes, summary: 'done' },
    durationMs: 10,
    backend: 'codex',
  };
}

function agentDead() {
  return {
    ok: false,
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: 'boom',
    lastMessage: '',
    parsedJson: undefined,
    durationMs: 10,
    backend: 'codex',
  };
}

const SUBMIT_OK = {
  submitted: true,
  event: 'COMMENT' as const,
  attemptedComments: 1,
  commentsPosted: 1,
  droppedOutsideDiff: 0,
  fileLevelAttempted: 0,
  fileLevelPosted: 0,
  submissionMode: 'inline' as const,
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchMetadata: vi.fn().mockResolvedValue({ title: 'Add FIB sub-type', headSha: 'metasha' }),
    fetchDiff: vi.fn().mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,2 @@\n line\n+added',
      truncated: false,
      reason: 'ok',
    }),
    resolveHeadSha: vi.fn().mockResolvedValue('feedface'),
    submitReview: vi.fn().mockResolvedValue(SUBMIT_OK),
    checkoutPr: vi.fn().mockResolvedValue(true),
    resolveWorkspaceFn: vi.fn((repoPath: string) => repoPath),
    runAgent: vi
      .fn()
      .mockResolvedValue(
        agentOk([{ role: 'reviewer', severity: 'low', category: 'style', message: 'nit', file: 'src/a.ts', line: 2 }]),
      ),
    ...overrides,
  };
}

const emptyStore = {
  findLatestReviewedPrHeadSha: () => undefined,
  getChannelPolicyPack: () => undefined,
} as any;

beforeEach(() => {
  vi.mocked(resolveGithubTokenForCodex).mockResolvedValue(undefined);
});

describe('agenticPrReview', () => {
  it('asks for PR URL and pauses when no PR exists anywhere (pinned stage pr_review.context.missing)', async () => {
    const slack = makeSlack(['please review this']);
    const logStep = vi.fn();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> please review'),
      config,
      slack: slack as any,
      store: emptyStore,
      logStep,
    });

    expect(result.status).toBe('PAUSED');
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    // The stage string is the pause-resume key (jobStore.isPausedAwaitingPrUrl) — pinned.
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pr_review.context.missing' }));
  });

  it('asks which PR and pauses when the thread has several PRs and no selector — never guesses', async () => {
    const slack = makeSlack([`backend : ${API_PR}\nfrontend : ${WEB_PR}`]);
    const logStep = vi.fn();
    const deps = makeDeps();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review the PR please'),
      config,
      slack: slack as any,
      store: emptyStore,
      logStep,
      deps: deps as any,
    });

    expect(result.status).toBe('PAUSED');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.targets.ambiguous' }));
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('newton-api#5781') }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('newton-web#8652') }),
    );
  });

  it('incident regression: "review the frontend PR" reviews newton-web#8652, not the first thread URL', async () => {
    const slack = makeSlack([`backend : ${API_PR}\nfrontend : ${WEB_PR}`]);
    const deps = makeDeps();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review the frontend PR and comment the findings directly in the PR.'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].prUrl).toBe(WEB_PR);
    expect(deps.resolveWorkspaceFn).toHaveBeenCalledWith('/repos/newton-web', '123.45--pr-8652');
  });

  it('incident regression: "review both the PRs" reviews both with per-PR summaries', async () => {
    const slack = makeSlack([`backend : ${API_PR}\nfrontend : ${WEB_PR}`]);
    const deps = makeDeps();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review both the PRs and comment the findings in the PR directly.'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes.map((o: any) => o.prUrl).sort()).toEqual([API_PR, WEB_PR].sort());
    // One ack listing both + one '*PR Review Complete*' summary per PR.
    const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(texts.some(t => t.includes('Reviewing 2 PRs'))).toBe(true);
    expect(texts.filter(t => t.includes('*PR Review Complete*'))).toHaveLength(2);
  });

  it('tags requester and skips when PR org is outside allowed scope', async () => {
    const slack = makeSlack(['review https://github.com/evil-org/repo/pull/1']);
    const deps = makeDeps();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review https://github.com/evil-org/repo/pull/1'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('outside supported review scope') }),
    );
  });

  it('tags requester and skips when PR repo is not newton-web/newton-api', async () => {
    const slack = makeSlack(['review https://github.com/Newton-School/random-repo/pull/9']);
    const deps = makeDeps();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review https://github.com/Newton-School/random-repo/pull/9'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('outside supported review scope') }),
    );
  });

  it('skips with no-new-changes when the PR head SHA is unchanged', async () => {
    const slack = makeSlack([`please review ${WEB_PR}`]);
    const deps = makeDeps({ resolveHeadSha: vi.fn().mockResolvedValue('deadbeef') });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review again ${WEB_PR}`),
      config,
      slack: slack as any,
      store: {
        findLatestReviewedPrHeadSha: () => ({
          jobId: 'previous-job',
          prHeadSha: 'deadbeef',
          updatedAt: '2026-03-03T08:00:00.000Z',
        }),
        getChannelPolicyPack: () => undefined,
      } as any,
      deps: deps as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toContain('No new changes');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('No new commits since the last review') }),
    );
  });

  it('fails the review with a specific message when the diff fetch returns empty — agent never runs', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps({
      fetchDiff: vi.fn().mockResolvedValue({ diff: '', truncated: false, reason: 'fetch_failed', status: 404 }),
    });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/Couldn't fetch the diff/);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/Couldn't fetch the diff/) }),
    );
  });

  it('status contract (issue #334 bug D): blocking findings still mean SUCCESS, verdict in result', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue(
        agentOk([
          {
            role: 'security',
            severity: 'high',
            category: 'authz',
            message: 'Missing check',
            file: 'src/a.ts',
            line: 2,
          },
        ]),
      ),
    });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(true);
    expect(outcomes[0].prHeadSha).toBe('feedface');
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('blocking-severity finding') }),
    );
  });

  it('retries as a degraded one-shot when the agentic run fails, then succeeds', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce(agentDead())
      .mockResolvedValueOnce(
        agentOk([{ role: 'reviewer', severity: 'low', category: 'style', message: 'nit', file: 'src/a.ts', line: 2 }]),
      );
    const deps = makeDeps({ runAgent });
    const logStep = vi.fn();

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1][0].prompt).toContain('Do not explore the repository');
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.fallback.one_shot' }));
  });

  it('isolates per-PR failures: one PR fails after retry, the other completes and is recorded', async () => {
    const slack = makeSlack([`backend : ${API_PR}\nfrontend : ${WEB_PR}`]);
    // First PR (api) reviews fine; second PR (web) dies on both attempts.
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce(
        agentOk([{ role: 'reviewer', severity: 'low', category: 'style', message: 'ok', file: 'src/a.ts', line: 2 }]),
      )
      .mockResolvedValue(agentDead());
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review both PRs'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toContain('1/2 PR review(s) failed');
    const outcomes = (result.result as any).outcomes;
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe('SUCCESS');
    expect(outcomes[0].prHeadSha).toBe('feedface');
    expect(outcomes[1].status).toBe('FAILED');
    // The user saw both the completed summary and the specific failure.
    const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(texts.some(t => t.includes('*PR Review Complete*'))).toBe(true);
    expect(texts.some(t => t.includes('failed (agent error'))).toBe(true);
  });

  it('forbids the agent from posting and submits through the hunk-validating path only', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps();

    await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(deps.runAgent.mock.calls[0][0].prompt).toContain('You must NOT post anything to GitHub or Slack');
    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(deps.submitReview.mock.calls[0][0]).toMatchObject({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 8652,
      commitId: 'feedface',
    });
  });

  it('cancels cleanly when the source message was deleted', async () => {
    const slack = {
      conversations: { replies: vi.fn().mockRejectedValue({ data: { error: 'thread_not_found' } }) },
      chat: { postMessage: vi.fn() },
    };

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
    });

    expect(result.status).toBe('CANCELLED');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });
});
