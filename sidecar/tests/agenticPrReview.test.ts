/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDeferredNote, runAgenticPrReview } from '../src/agentic/agenticPrReview.js';
import { VERIFIER_PROMPT_MARKER } from '../src/agentic/prReviewAgent.js';
import { ORCHESTRATOR_PROMPT_MARKER } from '../src/agentic/prReviewOrchestrator.js';
import { EMPTY_DISCOVERY } from '../src/agentic/reviewSkills.js';
import { resolveGithubTokenForCodex } from '../src/github/githubAuth.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';
import { WorkspaceSetupError } from '../src/workspaces/workspaceManager.js';

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

function agentVerify(verdict: 'confirmed' | 'refuted', severity?: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '{}',
    stderr: '',
    lastMessage: '',
    parsedJson: { verdict, ...(severity ? { severity } : {}), ...extra },
    durationMs: 5,
    backend: 'codex',
  };
}

/**
 * Orchestrated fan-out makes an orchestrator call + 2 safety-net lens calls
 * (security/performance), a reviewer-lens call only on tier-2 fallback, then N
 * verifier calls, all through the same injected `runAgent`. Route the mock by
 * prompt marker so tests are robust to the (non-deterministic) interleave of
 * the parallel agents. `oneShot` matches the collapse fallback (the combined
 * buildAgenticPrReviewPrompt, which has no "specialist" marker). Orchestrator
 * defaults to dead so legacy-shaped tests exercise the classic tier-2 lenses.
 */
function routedRunAgent(routes: {
  orchestrator?: unknown;
  reviewer?: unknown;
  security?: unknown;
  performance?: unknown;
  verifier?: (req: any) => unknown;
  oneShot?: unknown;
}) {
  return vi.fn().mockImplementation((req: any) => {
    const p = req.prompt as string;
    if (p.includes(VERIFIER_PROMPT_MARKER)) {
      return Promise.resolve(routes.verifier ? routes.verifier(req) : agentVerify('confirmed'));
    }
    if (p.includes(ORCHESTRATOR_PROMPT_MARKER)) return Promise.resolve(routes.orchestrator ?? agentDead());
    if (p.includes('reviewer specialist')) return Promise.resolve(routes.reviewer ?? agentOk([]));
    if (p.includes('security specialist')) return Promise.resolve(routes.security ?? agentOk([]));
    if (p.includes('performance specialist')) return Promise.resolve(routes.performance ?? agentOk([]));
    return Promise.resolve(routes.oneShot ?? agentDead());
  });
}

const verifierCalls = (runAgent: any) =>
  runAgent.mock.calls.filter((c: any[]) => (c[0].prompt as string).includes(VERIFIER_PROMPT_MARKER)).length;

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
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n line\n+added',
      truncated: false,
      reason: 'ok',
    }),
    fetchDiffSince: vi.fn().mockResolvedValue(undefined),
    resolveHeadSha: vi.fn().mockResolvedValue('feedface'),
    fetchState: vi.fn().mockResolvedValue({ state: 'open' }),
    submitReview: vi.fn().mockResolvedValue(SUBMIT_OK),
    checkoutPr: vi.fn().mockResolvedValue(true),
    resolveWorkspaceFn: vi.fn((repoPath: string) => repoPath),
    runAgent: vi
      .fn()
      .mockResolvedValue(
        agentOk([{ role: 'reviewer', severity: 'low', category: 'style', message: 'nit', file: 'src/a.ts', line: 2 }]),
      ),
    discoverSkills: vi.fn().mockResolvedValue(EMPTY_DISCOVERY),
    runBuildGate: vi
      .fn()
      .mockResolvedValue({ ok: true, nodeVersion: 'v20.0.0', usedNvmrc: false, buildScript: 'build', outputTail: '' }),
    prepareDeps: vi.fn().mockResolvedValue({ status: 'skipped' }),
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

afterEach(() => {
  vi.unstubAllEnvs();
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
    // Fan-out runs one agent per lens (reviewer/security/performance).
    expect(deps.runAgent).toHaveBeenCalledTimes(3);
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
    // 2 PRs × 3 lenses (default low-severity findings → no verifier calls).
    expect(deps.runAgent).toHaveBeenCalledTimes(6);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes.map((o: any) => o.prUrl).sort()).toEqual([API_PR, WEB_PR].sort());
    // One ack listing both + one '*PR Review Complete*' summary per PR.
    const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
    expect(texts.some(t => t.includes('Reviewing 2 PRs'))).toBe(true);
    expect(texts.filter(t => t.includes('*PR Review Complete*'))).toHaveLength(2);
  });

  describe('more PRs than one request reviews (issue #442)', () => {
    const pr = (n: number) => `https://github.com/Newton-School/newton-web/pull/${n}`;
    const SIX = [9155, 9156, 9157, 9158, 9159, 9160].map(pr);

    it('ends the batch by naming what was not reviewed, with a line to send back', async () => {
      // The incident: six PRs "in the given order"; three reviewed, the thread ended there.
      const slack = makeSlack([
        `Please review in the given order.\n${SIX.map((url, i) => `${i + 1}. ${url}`).join('\n')}`,
      ]);
      const deps = makeDeps();

      const result = await runAgenticPrReview({
        task: makeTask(`<@UBOT1> Please review in the given order.\n${SIX.join('\n')}`),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: deps as any,
      });

      const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
      expect(texts.filter(t => t.includes('*PR Review Complete*'))).toHaveLength(3);
      // It is the last thing said, after the third verdict.
      const closing = texts[texts.length - 1];
      expect(closing).toContain(
        'That was 3 of the 6 PRs you listed. Not reviewed yet: newton-web#9158, newton-web#9159, newton-web#9160.',
      );
      expect(closing).toContain('> <@UBOT1> review #9158 #9159 #9160');
      // The acknowledgement no longer buries the instructions.
      expect(texts[0]).toContain('3 more deferred');
      expect(texts[0]).not.toContain('reply with a PR link');
      expect((result.result as any).deferredUrls).toEqual([pr(9158), pr(9159), pr(9160)]);
    });

    it('reviews exactly the deferred PRs when that line is sent back', async () => {
      const slack = makeSlack([`Please review in the given order.\n${SIX.join('\n')}`]);

      const result = await runAgenticPrReview({
        task: makeTask('<@UBOT1> review #9158 #9159 #9160'),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: makeDeps() as any,
      });

      const outcomes = (result.result as any).outcomes;
      expect(outcomes.map((o: any) => o.prUrl)).toEqual([pr(9158), pr(9159), pr(9160)]);
      const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
      expect(texts.some(t => t.includes('Not reviewed yet'))).toBe(false);
    });

    it('says nothing more when every PR was reviewed', async () => {
      const slack = makeSlack([`backend : ${API_PR}\nfrontend : ${WEB_PR}`]);
      const result = await runAgenticPrReview({
        task: makeTask('<@UBOT1> review both the PRs'),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: makeDeps() as any,
      });

      const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
      expect(texts.some(t => t.includes('Not reviewed yet'))).toBe(false);
      expect(result.result as any).not.toHaveProperty('deferredUrls');
    });

    it('writes the line with #numbers when they are unambiguous, and with links when two repos share one', () => {
      const target = (repo: string, number: number) => ({
        repo,
        number,
        url: `https://github.com/Newton-School/${repo}/pull/${number}`,
      });

      expect(
        buildDeferredNote({
          deferred: [target('lumina-web', 55), target('newton-web', 9234)],
          reviewed: [target('Edison-Backend', 102), target('newton-api', 6412), target('lumina-api', 40)],
          botUserId: 'UBOT1',
        }),
      ).toContain('> <@UBOT1> review #55 #9234');

      const clash = buildDeferredNote({
        deferred: [target('lumina-web', 40)],
        reviewed: [target('lumina-api', 40), target('newton-api', 1), target('newton-web', 2)],
        botUserId: 'UBOT1',
      });
      expect(clash).toContain('> <@UBOT1> review https://github.com/Newton-School/lumina-web/pull/40');
      expect(clash).toContain('To have it reviewed');
      // No bot id known: the line is still there to send with a mention.
      expect(buildDeferredNote({ deferred: [target('a', 9)], reviewed: [target('a', 1)] })).toContain('> review #9');
    });
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

  it('reviews any Newton-School repo without a local clone from the diff alone (#10)', async () => {
    const slack = makeSlack(['review https://github.com/Newton-School/random-repo/pull/9']);
    const deps = makeDeps();
    const logStep = vi.fn();

    const result = await runAgenticPrReview({
      task: makeTask('<@UBOT1> review https://github.com/Newton-School/random-repo/pull/9'),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    // No local clone → diff-only fan-out, one agent per lens, no checkout.
    expect(deps.runAgent).toHaveBeenCalledTimes(3);
    expect(deps.runAgent.mock.calls[0][0].prompt).toContain('Do not explore the repository');
    expect(deps.checkoutPr).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.repo_diff_only' }));
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

  describe('when the review could not be put on the PR (issue #449)', () => {
    const findings = [
      { role: 'security', severity: 'high', category: 'authz', message: 'Missing check', file: 'src/a.ts', line: 2 },
      { role: 'reviewer', severity: 'low', category: 'style', message: 'Rename x', file: 'src/a.ts', line: 3 },
      { role: 'reviewer', severity: 'medium', category: 'logic', message: 'Off by one', file: 'src/a.ts', line: 2 },
    ];
    const review = async (submitResult: Record<string, unknown>) => {
      const slack = makeSlack([`review ${WEB_PR}`]);
      const deps = makeDeps({
        runAgent: vi.fn().mockResolvedValue(agentOk(findings)),
        submitReview: vi.fn().mockResolvedValue(submitResult),
      });
      await runAgenticPrReview({
        task: makeTask(`<@UBOT1> review ${WEB_PR}`),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: deps as any,
      });
      return slack.chat.postMessage.mock.calls.map(c => c[0].text as string).join('\n---\n');
    };
    const failed = {
      ...SUBMIT_OK,
      submitted: false,
      commentsPosted: 0,
      submissionMode: 'skipped' as const,
      failureReason: 'HTTP 502',
    };

    it('says why, and puts every finding in the thread, worst first', async () => {
      const posted = await review(failed);

      expect(posted).toContain("I couldn't post the review to GitHub (HTTP 502)");
      expect(posted).toContain('The review is not on the PR, so here is what it found:');
      expect(posted.indexOf('[HIGH] src/a.ts:2 — Missing check')).toBeGreaterThan(-1);
      expect(posted.indexOf('[HIGH]')).toBeLessThan(posted.indexOf('[MEDIUM] src/a.ts:2 — Off by one'));
      expect(posted.indexOf('[MEDIUM]')).toBeLessThan(posted.indexOf('[LOW] src/a.ts:3 — Rename x'));
      // Nothing is "on the PR" to point at.
      expect(posted).not.toContain('more on the PR');
    });

    it('says it could not confirm when GitHub could not be asked', async () => {
      const posted = await review({ ...failed, failureReason: 'timed out after 30s', unconfirmed: true });

      expect(posted).toContain('I could not confirm whether the review reached GitHub (timed out after 30s)');
      expect(posted).toContain('check the PR before asking again');
    });

    it('does not repeat the findings in the thread when the review is on the PR', async () => {
      const posted = await review(SUBMIT_OK);

      expect(posted).not.toContain('The review is not on the PR');
      expect(posted).not.toContain('Rename x');
    });
  });

  it('downgrades a security finding anchored outside the diff to a summary note (#7)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue(
        agentOk([
          {
            role: 'security',
            severity: 'high',
            category: 'authz',
            message: 'pre-existing issue',
            file: 'src/a.ts',
            line: 999, // outside the mock diff hunk (which covers lines 1-2)
          },
        ]),
      ),
    });
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
    const outcomes = (result.result as any).outcomes;
    // The off-diff security finding is demoted to a note — not a blocking finding.
    expect(outcomes[0].hasBlockingFindings).toBe(false);
    expect(outcomes[0].totalFindings).toBe(0);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.pr.changed_code_downgraded' }),
    );
  });

  it('a lens recovers at medium reasoning without collapsing the whole review', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    // Security lens fails its tier-1 (non-medium) run, recovers at medium.
    const runAgent = vi.fn().mockImplementation((req: any) => {
      const p = req.prompt as string;
      if (p.includes('security specialist')) {
        return Promise.resolve(req.reasoningEffort === 'medium' ? agentOk([]) : agentDead());
      }
      if (p.includes('skeptical PR-review verifier')) return Promise.resolve(agentVerify('confirmed'));
      return Promise.resolve(agentOk([]));
    });
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
    // Security lens ran twice (tier-1 + medium); reviewer & performance once each.
    const securityCalls = runAgent.mock.calls.filter((c: any[]) =>
      (c[0].prompt as string).includes('security specialist'),
    );
    expect(securityCalls).toHaveLength(2);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.lens.security.fallback_medium' }),
    );
    expect(logStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.fallback.fanout_collapsed' }),
    );
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.fallback.one_shot' }));
  });

  it('collapses to a diff-only one-shot when every lens fails, then succeeds', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    // Every lens (both tiers) dies; the combined one-shot fallback succeeds.
    const runAgent = routedRunAgent({
      reviewer: agentDead(),
      security: agentDead(),
      performance: agentDead(),
      oneShot: agentOk([
        { role: 'reviewer', severity: 'low', category: 'style', message: 'nit', file: 'src/a.ts', line: 2 },
      ]),
    });
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
    // The one-shot fallback is the only diff-only prompt (lenses had a clone).
    const oneShotCalls = runAgent.mock.calls.filter((c: any[]) =>
      (c[0].prompt as string).includes('Do not explore the repository'),
    );
    expect(oneShotCalls).toHaveLength(1);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.fallback.fanout_collapsed' }),
    );
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.fallback.one_shot' }));
  });

  it('fan-out: runs the orchestrator plus the security/performance safety net, each forbidden from posting', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({ orchestrator: agentOk([]) });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const callFor = (marker: string) =>
      runAgent.mock.calls.find((c: any[]) => (c[0].prompt as string).includes(marker))?.[0];
    expect(callFor(ORCHESTRATOR_PROMPT_MARKER)).toBeDefined();
    expect(callFor('security specialist')).toBeDefined();
    expect(callFor('performance specialist')).toBeDefined();
    // The orchestrator subsumes the reviewer lens slot in tier 1.
    expect(callFor('reviewer specialist')).toBeUndefined();
    // Per-role tiering: orchestrator/security high-reasoning; performance is
    // upgraded to the high tier in orchestrated mode (quality-first decision).
    expect(callFor(ORCHESTRATOR_PROMPT_MARKER)).toMatchObject({ model: 'gpt-5.4', reasoningEffort: 'xhigh' });
    expect(callFor('security specialist')).toMatchObject({ model: 'gpt-5.4', reasoningEffort: 'xhigh' });
    expect(callFor('performance specialist')).toMatchObject({ model: 'gpt-5.4', reasoningEffort: 'high' });
    // Pinned invariant: every prompt forbids posting.
    const prompts = runAgent.mock.calls.map((c: any[]) => c[0].prompt as string);
    for (const p of prompts) expect(p).toContain('You must NOT post anything to GitHub or Slack');
  });

  it('tier-2 fallback: orchestrator failure runs the classic reviewer lens without re-running the safety net', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      // orchestrator defaults to dead (both tiers)
      reviewer: agentOk([
        { role: 'reviewer', severity: 'low', category: 'style', message: 'nit', file: 'src/a.ts', line: 2 },
      ]),
    });
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
    const callsFor = (marker: string) =>
      runAgent.mock.calls.filter((c: any[]) => (c[0].prompt as string).includes(marker));
    // Orchestrator tried tier-1 + high retry, then the reviewer lens filled its slot.
    expect(callsFor(ORCHESTRATOR_PROMPT_MARKER)).toHaveLength(2);
    expect(callsFor('reviewer specialist')).toHaveLength(1);
    // Security/performance results from tier 1 are reused, never re-run.
    expect(callsFor('security specialist')).toHaveLength(1);
    expect(callsFor('performance specialist')).toHaveLength(1);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.fallback.fanout' }));
    // The degradation is visible to the user, never silent.
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts.some(t => t.includes('orchestrated review unavailable'))).toBe(true);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].totalFindings).toBe(1);
  });

  it('injects classified repo skills into the orchestrator prompt and reports the applied ones', async () => {
    const slack = makeSlack([`review ${API_PR}`]);
    const skill = {
      name: 'newton-api-pr-review',
      description: 'Checklist review for newton-api.',
      source: 'claude',
      dir: '/wt/.claude/skills/newton-api-pr-review',
      relDir: '.claude/skills/newton-api-pr-review',
      skillFilePath: '/wt/.claude/skills/newton-api-pr-review/SKILL.md',
      body: 'Read references/review-patterns.md and review in order.',
      bodyTruncated: false,
      frontmatter: {},
    };
    const orchestratorResult = {
      ...agentOk([
        {
          role: 'reviewer',
          severity: 'medium',
          category: 'repo-fit',
          message: 'misses convention',
          file: 'src/a.ts',
          line: 2,
        },
      ]),
      parsedJson: {
        findings: [
          {
            role: 'reviewer',
            severity: 'medium',
            category: 'repo-fit',
            message: 'misses convention',
            file: 'src/a.ts',
            line: 2,
          },
        ],
        summaryNotes: [],
        summary: 'done',
        skillsApplied: ['newton-api-pr-review', 'not-a-real-skill'],
      },
    };
    const runAgent = routedRunAgent({ orchestrator: orchestratorResult });
    const deps = makeDeps({
      runAgent,
      discoverSkills: vi.fn().mockResolvedValue({ all: [skill], applicable: [skill], classifierUsed: true }),
    });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${API_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(deps.discoverSkills).toHaveBeenCalledTimes(1);
    const orchPrompt = runAgent.mock.calls
      .map((c: any[]) => c[0].prompt as string)
      .find(p => p.includes(ORCHESTRATOR_PROMPT_MARKER)) as string;
    expect(orchPrompt).toContain('REPO REVIEW SKILLS');
    expect(orchPrompt).toContain('newton-api-pr-review');
    expect(orchPrompt).toContain('CRITICAL OVERRIDES');
    // Unknown names claimed by the orchestrator are filtered out.
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].appliedSkills).toEqual(['newton-api-pr-review']);
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts.some(t => t.includes('Reviewed with newton-api-pr-review'))).toBe(true);
  });

  it('runs the deterministic build gate for deps-changed PRs and surfaces a failure', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({ orchestrator: agentOk([]) });
    const deps = makeDeps({
      runAgent,
      fetchDiff: vi.fn().mockResolvedValue({
        diff: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n line\n+added',
        truncated: false,
        reason: 'ok',
      }),
      runBuildGate: vi.fn().mockResolvedValue({
        ok: false,
        nodeVersion: 'v24.0.0',
        usedNvmrc: true,
        failedStage: 'install',
        buildScript: 'build',
        outputTail: 'npm ERR! peer dep conflict',
      }),
    });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(deps.runBuildGate).toHaveBeenCalledTimes(1);
    const orchPrompt = runAgent.mock.calls
      .map((c: any[]) => c[0].prompt as string)
      .find(p => p.includes(ORCHESTRATOR_PROMPT_MARKER)) as string;
    expect(orchPrompt).toContain('BUILD STATUS');
    expect(orchPrompt).toContain('FAILED at the install stage');
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts.some(t => t.includes('npm ci/build FAILED'))).toBe(true);
  });

  it('gives the review installed deps for the PR head, after the checkout, and says so in the prompts (issue #611)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({ orchestrator: agentOk([]) });
    const order: string[] = [];
    const deps = makeDeps({
      runAgent,
      checkoutPr: vi.fn(async () => {
        order.push('checkout');
        return true;
      }),
      prepareDeps: vi.fn(async () => {
        order.push('deps');
        return {
          status: 'ready',
          manager: 'npm',
          lockfile: 'package-lock.json',
          key: 'k',
          command: 'npm ci',
          installed: false,
          ms: 10,
        };
      }),
    });

    await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(order).toEqual(['checkout', 'deps']);
    expect(deps.prepareDeps).toHaveBeenCalledWith(
      '/repos/newton-web',
      expect.objectContaining({ stage: 'agentic.pr_review.deps' }),
    );
    const orchPrompt = runAgent.mock.calls
      .map((c: any[]) => c[0].prompt as string)
      .find(p => p.includes(ORCHESTRATOR_PROMPT_MARKER)) as string;
    expect(orchPrompt).toContain("Dependencies: installed in node_modules for this checkout's package-lock.json");
  });

  it('fails plainly when it cannot make its own worktree, and never checks the PR out in the shared clone', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const message =
      "I couldn't set up my own copy of newton-web to work in, so I stopped here. Ask me again in a few minutes.";
    const deps = makeDeps({ resolveWorkspaceFn: vi.fn().mockRejectedValue(new WorkspaceSetupError(message)) });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('FAILED');
    expect(deps.checkoutPr).not.toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts).toContain(message);
  });

  it('does not install deps a second time when the build gate already ran', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps({
      fetchDiff: vi.fn().mockResolvedValue({
        diff: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,1 +1,2 @@\n line\n+added',
        truncated: false,
        reason: 'ok',
      }),
    });

    await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(deps.runBuildGate).toHaveBeenCalledTimes(1);
    expect(deps.prepareDeps).not.toHaveBeenCalled();
  });

  it('skips the build gate for app-code-only PRs', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps();

    await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(deps.runBuildGate).not.toHaveBeenCalled();
  });

  it('surfaces a failed PR-head checkout in the prompts and the Slack summary (no more silent degradation)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const deps = makeDeps({ checkoutPr: vi.fn().mockResolvedValue(false) });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const prompts = (deps.runAgent as any).mock.calls.map((c: any[]) => c[0].prompt as string);
    expect(prompts.some((p: string) => p.includes('the PR-head checkout FAILED'))).toBe(true);
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts.some(t => t.includes('Could not check out the PR head'))).toBe(true);
  });

  it('re-review: prior findings feed the orchestrator prompt and new findings are persisted', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      orchestrator: agentOk([
        { role: 'reviewer', severity: 'medium', category: 'bug', message: 'still broken', file: 'src/a.ts', line: 2 },
      ]),
    });
    const deps = makeDeps({ runAgent, resolveHeadSha: vi.fn().mockResolvedValue('newsha9999') });
    const recordPrReviewFindings = vi.fn();
    const getPrReviewFindings = vi.fn().mockReturnValue([
      {
        jobId: 'previous-job',
        prHeadSha: 'oldsha1234',
        role: 'security',
        severity: 'high',
        category: 'authz',
        message: 'missing permission check',
        file: 'src/a.ts',
        line: 2,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    const store = {
      findLatestReviewedPrHeadSha: () => ({
        jobId: 'previous-job',
        prHeadSha: 'oldsha1234',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
      getChannelPolicyPack: () => undefined,
      recordPrReviewFindings,
      getPrReviewFindings,
    };

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: store as any,
      jobId: 'job-new',
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(getPrReviewFindings).toHaveBeenCalledWith({ prUrl: WEB_PR, jobId: 'previous-job' });
    const orchPrompt = runAgent.mock.calls
      .map((c: any[]) => c[0].prompt as string)
      .find(p => p.includes(ORCHESTRATOR_PROMPT_MARKER)) as string;
    expect(orchPrompt).toContain('PRIOR REVIEW');
    expect(orchPrompt).toContain('missing permission check');
    expect(orchPrompt).toContain('git diff oldsha1234');
    expect(recordPrReviewFindings).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-new',
        prUrl: WEB_PR,
        repo: 'newton-web',
        prNumber: 8652,
        findings: [expect.objectContaining({ role: 'reviewer', message: 'still broken', line: 2 })],
      }),
    );
  });

  describe('a second review follows up on the first (issue #451)', () => {
    // The PR adds six lines to src/a.ts. Since the earlier review, only lines 5 and 6 changed.
    const PR_DIFF =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,6 @@\n+one\n+two\n+three\n+four\n+five\n+six';
    const SINCE_DIFF =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,1 +4,3 @@\n four\n+five\n+six';
    const prior = (message: string, line: number, severity = 'medium') => ({
      jobId: 'previous-job',
      prHeadSha: 'oldsha1234',
      role: 'reviewer',
      severity,
      category: 'bug',
      message,
      file: 'src/a.ts',
      line,
      createdAt: '2026-10-06T10:00:00.000Z',
    });
    const storeWithEarlierReview = () => ({
      findLatestReviewedPrHeadSha: () => ({
        jobId: 'previous-job',
        prHeadSha: 'oldsha1234',
        updatedAt: '2026-10-06T10:00:00.000Z',
      }),
      getChannelPolicyPack: () => undefined,
      recordPrReviewFindings: vi.fn(),
      getPrReviewFindings: vi
        .fn()
        .mockReturnValue([
          prior('The retry loop never backs off', 2),
          prior('Rename the helper', 3, 'low'),
          prior('Missing test for the empty list', 4, 'low'),
        ]),
    });
    const orchestrator = agentOk(
      [
        {
          role: 'reviewer',
          severity: 'medium',
          category: 'bug',
          message: 'Still open: the retry loop never backs off',
          file: 'src/a.ts',
          line: 2,
        },
        {
          role: 'reviewer',
          severity: 'low',
          category: 'style',
          message: 'This could be const',
          file: 'src/a.ts',
          line: 3,
        },
        { role: 'reviewer', severity: 'low', category: 'style', message: 'Magic number', file: 'src/a.ts', line: 5 },
      ],
      ['Addressed since last review: helper renamed', 'Addressed since last review: empty-list test added'],
    );
    const followUp = async (depsOverrides: Record<string, unknown> = {}) => {
      const slack = makeSlack([`review ${WEB_PR}`]);
      const runAgent = routedRunAgent({
        orchestrator,
        security: agentOk([
          {
            role: 'security',
            severity: 'high',
            category: 'secrets',
            message: 'Token logged in full',
            file: 'src/a.ts',
            line: 3,
          },
        ]),
      });
      const deps = makeDeps({
        runAgent,
        resolveHeadSha: vi.fn().mockResolvedValue('newsha9999'),
        fetchDiff: vi.fn().mockResolvedValue({ diff: PR_DIFF, truncated: false, reason: 'ok' }),
        fetchDiffSince: vi.fn().mockResolvedValue(SINCE_DIFF),
        ...depsOverrides,
      });
      const logStep = vi.fn();
      const result = await runAgenticPrReview({
        task: makeTask(`<@UBOT1> Please review again, resolved and replied on the comments ${WEB_PR}`),
        config,
        slack: slack as any,
        store: storeWithEarlierReview() as any,
        jobId: 'job-new',
        deps: deps as any,
        logStep,
      });
      return {
        deps,
        runAgent,
        logStep,
        outcome: (result.result as any).outcomes[0],
        texts: slack.chat.postMessage.mock.calls.map(c => c[0].text as string).join('\n---\n'),
        prompts: runAgent.mock.calls.map((c: any[]) => c[0].prompt as string),
      };
    };

    it('reports what became of the earlier findings, and only what is new in the code changed since', async () => {
      const { deps, outcome, texts } = await followUp();

      const line =
        'Follow-up on my review at oldsha1: of its 3 findings, 2 addressed, 1 still open; 2 new in the code changed since. 1 further low or medium point on code unchanged since then was left out.';
      expect(texts).toContain(line);
      expect(outcome.followUp).toEqual({ earlierTotal: 3, addressed: 2, stillOpen: 1, newFindings: 2, leftOut: 1 });
      expect(outcome.totalFindings).toBe(3);

      const submitted = deps.submitReview.mock.calls[0][0];
      expect(submitted.summary.startsWith(line)).toBe(true);
      const messages = [
        ...submitted.findingsByRole.flatMap((r: any) => r.findings.map((x: any) => x.message)),
        submitted.summary,
      ].join('\n');
      // Raised again, new on changed code, and a new blocker on unchanged code: all there.
      expect(messages).toContain('Still open: the retry loop never backs off');
      expect(messages).toContain('Magic number');
      expect(messages).toContain('Token logged in full');
      // A new nit on code the author already had one review of: not there.
      expect(messages).not.toContain('This could be const');
      expect(deps.fetchDiffSince).toHaveBeenCalledWith(
        expect.objectContaining({ baseSha: 'oldsha1234', headSha: 'newsha9999' }),
      );
    });

    it('tells every lens about the earlier findings: the lead accounts for them, the others do not repeat them', async () => {
      const { prompts } = await followUp();

      const lead = prompts.find(p => p.includes(ORCHESTRATOR_PROMPT_MARKER)) as string;
      expect(lead).toContain('This is a FOLLOW-UP on that review, not a first review.');
      expect(lead).toContain('"message" starting "Still open: " or "Regressed: "');
      expect(lead).toContain('Do NOT raise new low or medium points on code that has not changed since oldsha1234');
      for (const lens of ['security specialist', 'performance specialist']) {
        const prompt = prompts.find(p => p.includes(lens)) as string;
        expect(prompt).toContain('PRIOR REVIEW');
        expect(prompt).toContain('The retry loop never backs off');
        expect(prompt).toContain('do NOT report any of them again');
      }
    });

    it('leaves nothing out when the diff since the earlier review cannot be had, and says so in the log', async () => {
      const { outcome, logStep, texts } = await followUp({ fetchDiffSince: vi.fn().mockResolvedValue(undefined) });

      expect(outcome.followUp).toMatchObject({ leftOut: 0, newFindings: 3, stillOpen: 1 });
      expect(texts).toContain('3 new in the code changed since.');
      expect(logStep).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'agentic.pr_review.follow_up.scope_unavailable', level: 'WARN' }),
      );
    });

    it('is not a follow-up when there was no earlier review', async () => {
      const slack = makeSlack([`review ${WEB_PR}`]);
      const deps = makeDeps();
      const result = await runAgenticPrReview({
        task: makeTask(`<@UBOT1> review ${WEB_PR}`),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: deps as any,
      });

      expect((result.result as any).outcomes[0]).not.toHaveProperty('followUp');
      expect(deps.fetchDiffSince).not.toHaveBeenCalled();
      expect(slack.chat.postMessage.mock.calls.map(c => c[0].text).join('\n')).not.toContain('Follow-up on my review');
    });
  });

  it('kill switch WATCHTOWER_PR_REVIEW_ORCHESTRATED=0 restores the classic 3-lens fan-out', async () => {
    vi.stubEnv('WATCHTOWER_PR_REVIEW_ORCHESTRATED', '0');
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({});
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const callsFor = (marker: string) =>
      runAgent.mock.calls.filter((c: any[]) => (c[0].prompt as string).includes(marker));
    expect(callsFor(ORCHESTRATOR_PROMPT_MARKER)).toHaveLength(0);
    expect(callsFor('reviewer specialist')).toHaveLength(1);
    expect(callsFor('security specialist')).toHaveLength(1);
    expect(callsFor('performance specialist')).toHaveLength(1);
    // Classic mode: skill discovery never runs, performance stays lightweight.
    expect(deps.discoverSkills).not.toHaveBeenCalled();
    expect(callsFor('performance specialist')[0][0]).toMatchObject({ model: 'gpt-5.2-codex', reasoningEffort: 'low' });
  });

  it('graceful degradation: one dead lens still posts the others (partial fan-out)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentDead(), // both tiers dead via the default route fallback
      reviewer: agentOk([
        {
          role: 'reviewer',
          severity: 'high',
          category: 'bug',
          message: 'surviving lens bug',
          file: 'src/a.ts',
          line: 2,
        },
      ]),
      performance: agentOk([]),
      verifier: () => agentVerify('confirmed'),
    });
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
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.fanout.partial',
        data: expect.objectContaining({ failedLenses: ['security'] }),
      }),
    );
    expect(logStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agentic.pr_review.fallback.fanout_collapsed' }),
    );
    // A surviving lens's blocking finding is still verified and posted.
    expect(verifierCalls(runAgent)).toBe(1);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].totalFindings).toBe(1);
    expect(outcomes[0].hasBlockingFindings).toBe(true);
  });

  it('adversarial verify drops a high finding only when the adjudicator upholds the refute', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'missing check', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('refuted'),
    });
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
    // Primary refute + adjudicator upholding it — a solo light-tier vote no longer drops.
    expect(verifierCalls(runAgent)).toBe(2);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(false);
    expect(outcomes[0].totalFindings).toBe(0);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.verify.adjudicated' }));
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.verify.done',
        data: expect.objectContaining({ refuted: 1 }),
      }),
    );
  });

  it('adjudicator restores a primary-refuted high finding (no solo veto by the light tier)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'real issue', file: 'src/a.ts', line: 2 },
      ]),
      verifier: (req: any) =>
        (req.prompt as string).includes('senior adjudicator') ? agentVerify('confirmed') : agentVerify('refuted'),
    });
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
    expect(verifierCalls(runAgent)).toBe(2);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(true);
    expect(outcomes[0].totalFindings).toBe(1);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.verify.adjudicated' }));
  });

  it('adversarial verify keeps a confirmed high finding', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'missing check', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('confirmed'),
    });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(verifierCalls(runAgent)).toBe(1);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(true);
    expect(outcomes[0].totalFindings).toBe(1);
  });

  it('verifier downgrade lowers severity and clears the blocking signal', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'overstated', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('confirmed', 'medium'),
    });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const outcomes = (result.result as any).outcomes;
    // Kept, but downgraded high → medium, so it no longer blocks.
    expect(outcomes[0].totalFindings).toBe(1);
    expect(outcomes[0].hasBlockingFindings).toBe(false);
    expect(outcomes[0].severityCounts).toEqual({ medium: 1 });
    const texts = slack.chat.postMessage.mock.calls.map((c: any) => c[0].text as string);
    expect(texts.some(t => t.includes('blocking-severity finding'))).toBe(false);
  });

  describe('a verifier that lowers a finding below medium (the 5.5 models)', () => {
    const lowered = async (extra: Record<string, unknown>) => {
      const slack = makeSlack([`review ${WEB_PR}`]);
      const runAgent = routedRunAgent({
        reviewer: agentOk([
          {
            role: 'reviewer',
            severity: 'medium',
            category: 'edge-case',
            message: 'NaN on 0',
            file: 'src/a.ts',
            line: 2,
          },
        ]),
        verifier: () => agentVerify('confirmed', 'low', extra),
      });
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
      const done = logStep.mock.calls.map(c => c[0]).find(entry => entry.stage === 'agentic.pr_review.verify.done');
      const inline = deps.submitReview.mock.calls[0][0].findingsByRole.flatMap((r: any) => r.findings);
      return { outcome: (result.result as any).outcomes[0], done, inline };
    };

    it('keeps a real but narrow bug at medium, posts it inline, and logs the refused downgrade', async () => {
      const reason = 'Real, but only when total is 0, an uncommon setup.';
      const { outcome, done, inline } = await lowered({ severityBasis: 'smaller-impact', reason });

      expect(outcome.severityCounts).toEqual({ medium: 1 });
      expect(inline).toHaveLength(1);
      expect(done.message).toContain('0 lowered, 1 kept at medium');
      expect(done.data).toMatchObject({
        lowered: 0,
        keptAtMedium: 1,
        severityChanges: [
          {
            from: 'medium',
            proposed: 'low',
            applied: 'medium',
            basis: 'smaller-impact',
            reason,
            lens: 'reviewer',
            file: 'src/a.ts',
            line: 2,
          },
        ],
      });
    });

    it('also keeps it at medium when the verifier gives no basis', async () => {
      const { outcome, done } = await lowered({});

      expect(outcome.severityCounts).toEqual({ medium: 1 });
      expect(done.data.severityChanges[0]).toMatchObject({ proposed: 'low', applied: 'medium' });
      expect(done.data.severityChanges[0].basis).toBeUndefined();
    });

    it.each(['no-behaviour-change', 'not-shipped'])('lowers it to low with the basis "%s"', async basis => {
      const { outcome, done, inline } = await lowered({ severityBasis: basis });

      expect(outcome.severityCounts).toEqual({ low: 1 });
      expect(inline).toEqual([]);
      expect(done.data).toMatchObject({ lowered: 1, keptAtMedium: 0 });
      expect(done.data.severityChanges[0]).toMatchObject({ from: 'medium', applied: 'low', basis });
    });
  });

  it('a high lowered to low without an accepted basis stops at medium', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'ssrf', message: 'unchecked URL', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('confirmed', 'low', { severityBasis: 'smaller-impact' }),
    });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect((result.result as any).outcomes[0].severityCounts).toEqual({ medium: 1 });
  });

  it('verifier severity escalation is ignored (no high → critical promotion)', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'missing check', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('confirmed', 'critical'),
    });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    const outcomes = (result.result as any).outcomes;
    // Escalation refused — severity stays high (a single vote can't mint a critical).
    expect(outcomes[0].severityCounts).toEqual({ high: 1 });
  });

  it('verifier failure fails open — the finding is kept', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'missing check', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentDead(),
    });
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
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(true);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.verify.inconclusive' }));
  });

  describe('which findings are checked and where they are posted (issue #441)', () => {
    const finding = (severity: string, n: number, role = 'reviewer') => ({
      role,
      severity,
      category: 'bug',
      message: `${severity} finding ${n}`,
      file: 'src/a.ts',
      line: n,
    });
    const review = async (runAgent: any, extraDeps: Record<string, unknown> = {}) => {
      const slack = makeSlack([`review ${WEB_PR}`]);
      const deps = makeDeps({ runAgent, ...extraDeps });
      const result = await runAgenticPrReview({
        task: makeTask(`<@UBOT1> review ${WEB_PR}`),
        config,
        slack: slack as any,
        store: emptyStore,
        deps: deps as any,
      });
      const texts = slack.chat.postMessage.mock.calls.map(c => c[0].text as string);
      return { result, deps, texts, outcome: (result.result as any).outcomes[0] };
    };

    it('does not verify low and info findings: they are not posted inline, so they are not worth a run', async () => {
      const runAgent = routedRunAgent({ reviewer: agentOk([finding('low', 2), finding('info', 3)]) });

      const { outcome } = await review(runAgent);

      expect(verifierCalls(runAgent)).toBe(0);
      expect(outcome.totalFindings).toBe(2);
    });

    it('gives a medium finding one verifier vote and keeps it when confirmed', async () => {
      const runAgent = routedRunAgent({ reviewer: agentOk([finding('medium', 2)]) });

      const { outcome } = await review(runAgent);

      expect(verifierCalls(runAgent)).toBe(1);
      expect(outcome.totalFindings).toBe(1);
    });

    it('drops a medium finding on that one refute, with no adjudication', async () => {
      // The five false positives an author listed from one batch were all of this kind.
      const runAgent = routedRunAgent({
        reviewer: agentOk([finding('medium', 2), finding('low', 3)]),
        verifier: () => agentVerify('refuted'),
      });

      const { outcome } = await review(runAgent);

      expect(verifierCalls(runAgent)).toBe(1);
      expect(outcome.totalFindings).toBe(1); // the low one
    });

    it('posts at most ten inline, worst first, and lists the rest in the review body', async () => {
      const findings = [
        ...Array.from({ length: 5 }, (_, i) => finding('low', 40 + i)),
        ...Array.from({ length: 12 }, (_, i) => finding('medium', 20 + i)),
        finding('high', 2, 'security'),
      ];
      const runAgent = routedRunAgent({
        reviewer: agentOk(findings.filter(f => f.role === 'reviewer')),
        security: agentOk(findings.filter(f => f.role === 'security')),
      });

      const { deps, texts } = await review(runAgent);

      const submitted = deps.submitReview.mock.calls[0][0];
      const inline = submitted.findingsByRole.flatMap((r: any) => r.findings);
      expect(inline).toHaveLength(10);
      expect(inline.filter((f: any) => f.severity === 'high')).toHaveLength(1);
      expect(inline.filter((f: any) => f.severity === 'medium')).toHaveLength(9);
      expect(inline.some((f: any) => f.severity === 'low')).toBe(false);
      // The other three mediums and the five lows: in the body, once, and counted.
      expect(submitted.findingsInBody).toBe(8);
      expect(submitted.summary).toContain('Lower-priority findings (not posted inline):');
      expect(submitted.summary).toContain('`src/a.ts:44` — low finding 44');
      expect(submitted.summary.match(/- \[REVIEWER - MEDIUM\]/g)).toHaveLength(3);
      expect(texts.join('\n')).toContain('8 lower-priority listed in the review summary');
    });

    it('posts no inline comments when nothing reaches medium, and says that is why', async () => {
      const runAgent = routedRunAgent({ reviewer: agentOk([finding('low', 2), finding('low', 3)]) });
      const submitOk = { ...SUBMIT_OK, attemptedComments: 0, commentsPosted: 0, submissionMode: 'summary_only' };

      const { deps, texts } = await review(runAgent, { submitReview: vi.fn().mockResolvedValue(submitOk) });

      const submitted = deps.submitReview.mock.calls[0][0];
      expect(submitted.findingsByRole.flatMap((r: any) => r.findings)).toEqual([]);
      expect(submitted.findingsInBody).toBe(2);
      expect(texts.join('\n')).toContain('2 findings identified, none above low severity');
    });
  });

  it('critical findings get a best-of-3 majority vote and drop on ≥2 refutes', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    let verify = 0;
    const runAgent = routedRunAgent({
      security: agentOk([
        { role: 'security', severity: 'critical', category: 'injection', message: 'sqli', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => {
        verify += 1;
        // refute, refute, confirm → 2 refutes → dropped.
        return verify <= 2 ? agentVerify('refuted') : agentVerify('confirmed');
      },
    });
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('SUCCESS');
    expect(verifierCalls(runAgent)).toBe(3); // best-of-3
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].hasBlockingFindings).toBe(false);
  });

  it('caps verifier runs by worst-case budget; the overflow passes through unverified', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const many = Array.from({ length: 21 }, (_v, i) => ({
      role: 'security',
      severity: 'high',
      category: 'authz',
      message: `issue number ${i}`,
      file: 'src/a.ts',
      line: 2,
    }));
    const runAgent = routedRunAgent({ security: agentOk(many), verifier: () => agentVerify('confirmed') });
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
    // Budget 30 at worst-case cost 2/high → 15 findings verified; all confirm on
    // the primary vote so each spends 1 actual run.
    expect(verifierCalls(runAgent)).toBe(15);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.verify.capped' }));
    // The 6 overflow findings are KEPT unverified, not dropped.
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].totalFindings).toBe(21);
  });

  it('cross-lens dedup: the same file:line:message collapses, higher severity wins', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      reviewer: agentOk([
        { role: 'reviewer', severity: 'medium', category: 'bug', message: 'same issue', file: 'src/a.ts', line: 2 },
      ]),
      security: agentOk([
        { role: 'security', severity: 'high', category: 'authz', message: 'same issue', file: 'src/a.ts', line: 2 },
      ]),
      verifier: () => agentVerify('confirmed'),
    });
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
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].totalFindings).toBe(1); // collapsed to one
    // The HIGHER-severity (security/high) finding wins the tiebreak, not the medium one —
    // which also means the survivor is blocking and goes through verification.
    expect(outcomes[0].severityCounts).toEqual({ high: 1 });
    expect(verifierCalls(runAgent)).toBe(1);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agentic.pr_review.synth.done',
        data: expect.objectContaining({ beforeDedupe: 2, afterDedupe: 1 }),
      }),
    );
  });

  it('honors an aborted signal — no agent runs, batch cancelled', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({});
    const deps = makeDeps({ runAgent });
    const ac = new AbortController();
    ac.abort();

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
      signal: ac.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(runAgent).not.toHaveBeenCalled();
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

    // Mixed batch: one PR reviewed cleanly → SUCCESS (a partial failure is not
    // a batch failure), with the failure surfaced via failedCount/failedUrls (#1).
    expect(result.status).toBe('SUCCESS');
    expect(result.message).toContain('Reviewed 1 PR(s)');
    expect(result.message).toContain('1 failed');
    expect((result.result as any).failedCount).toBe(1);
    expect((result.result as any).failedUrls).toEqual([WEB_PR]);
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

  it('marks the batch FAILED only when every PR fails (reorder preserves the all-failed path)', async () => {
    const slack = makeSlack([]);
    const runAgent = vi.fn().mockResolvedValue(agentDead());
    const deps = makeDeps({ runAgent });

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${WEB_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
    });

    expect(result.status).toBe('FAILED');
    expect((result.result as any).failedCount).toBe(1);
    expect(result.message).toMatch(/PR review\(s\) failed/);
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

describe('agenticPrReview — merged or closed PRs are not reviewed (issue #447)', () => {
  const merged = { state: 'merged', at: '2026-10-06T09:12:00Z' };
  const posted = (slack: any) => slack.chat.postMessage.mock.calls.map((c: any[]) => c[0].text as string);

  async function review(text: string, deps: ReturnType<typeof makeDeps>, threadTexts: string[] = [text]) {
    const slack = makeSlack(threadTexts);
    const logStep = vi.fn();
    const result = await runAgenticPrReview({
      task: makeTask(text),
      config,
      slack: slack as any,
      store: emptyStore,
      logStep,
      deps: deps as any,
    });
    return { result, slack, logStep };
  }

  it('does not review a merged PR, says when it merged, and offers a post-merge review', async () => {
    const deps = makeDeps({ fetchState: vi.fn().mockResolvedValue(merged) });
    const { result, slack, logStep } = await review(`<@UBOT1> review ${API_PR}`, deps);

    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.submitReview).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    const reply = posted(slack)[0];
    expect(reply).toContain('`newton-api#5781` is already merged (2026-10-06)');
    expect(reply).toContain(`post-merge review ${API_PR}`);
    expect(reply).toContain('@ me with the question');
    expect(posted(slack).join(' ')).not.toContain('PR review in progress');
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.guard.not_open' }));
  });

  it('does not review a question about a merged PR either (the issue #447 run)', async () => {
    const deps = makeDeps({ fetchState: vi.fn().mockResolvedValue(merged) });
    const { result } = await review(`<@UBOT1> is ${API_PR} merged and deployed to production?`, deps);

    expect(deps.submitReview).not.toHaveBeenCalled();
    expect(result.status).toBe('SKIPPED');
  });

  it('says a closed PR was closed without merging', async () => {
    const deps = makeDeps({ fetchState: vi.fn().mockResolvedValue({ state: 'closed' }) });
    const { slack } = await review(`<@UBOT1> review ${WEB_PR}`, deps);

    expect(deps.submitReview).not.toHaveBeenCalled();
    expect(posted(slack)[0]).toContain('`newton-web#8652` is closed without merging');
  });

  it('reviews a merged PR when a post-merge review is asked for, and drops "before merge"', async () => {
    const runAgent = routedRunAgent({
      orchestrator: agentOk([
        { role: 'reviewer', severity: 'high', category: 'bug', message: 'null deref', file: 'src/a.ts', line: 2 },
      ]),
    });
    const deps = makeDeps({ fetchState: vi.fn().mockResolvedValue(merged), runAgent });
    const { result, slack } = await review(`<@UBOT1> post-merge review ${API_PR}`, deps);

    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
    const all = posted(slack).join('\n');
    expect(all).toContain('this PR is already merged, so they need a follow-up');
    expect(all).not.toContain('please address before merge');
  });

  it('reviews as before when GitHub cannot say what state the PR is in', async () => {
    const deps = makeDeps({ fetchState: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) });
    const { result } = await review(`<@UBOT1> review ${API_PR}`, deps);

    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('SUCCESS');
  });

  it('in a batch, reviews the open PR and names the merged one', async () => {
    const fetchState = vi.fn(async ({ prContext }: any) => (prContext.url === API_PR ? merged : { state: 'open' }));
    const deps = makeDeps({ fetchState });
    const { result, slack } = await review(`<@UBOT1> review ${API_PR} and ${WEB_PR}`, deps);

    expect(deps.submitReview).toHaveBeenCalledTimes(1);
    expect(deps.submitReview.mock.calls[0][0]).toMatchObject({ repo: 'newton-web', pullNumber: 8652 });
    expect(posted(slack)[0]).toContain('`newton-api#5781` is already merged');
    expect(result.status).toBe('SUCCESS');
  });
});

describe('agenticPrReview — a cancelled review is not a failed one (issue #438)', () => {
  it('returns CANCELLED for a single PR stopped mid-review, and posts nothing after the cancel', async () => {
    const controller = new AbortController();
    // Every agent dies with the abort.
    const runAgent = vi.fn().mockImplementation(async () => {
      controller.abort();
      return agentDead();
    });
    const deps = makeDeps({ runAgent });
    const slack = makeSlack([`please review ${API_PR}`]);

    const result = await runAgenticPrReview({
      task: makeTask(`<@UBOT1> review ${API_PR}`),
      config,
      slack: slack as any,
      store: emptyStore,
      deps: deps as any,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(deps.submitReview).not.toHaveBeenCalled();
    const postedAfterCancel = slack.chat.postMessage.mock.calls
      .map((c: any[]) => c[0].text as string)
      .filter((text: string) => !text.includes('PR review in progress'));
    expect(postedAfterCancel).toEqual([]);
  });
});
