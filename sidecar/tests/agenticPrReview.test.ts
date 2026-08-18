/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgenticPrReview } from '../src/agentic/agenticPrReview.js';
import { VERIFIER_PROMPT_MARKER } from '../src/agentic/prReviewAgent.js';
import { ORCHESTRATOR_PROMPT_MARKER } from '../src/agentic/prReviewOrchestrator.js';
import { EMPTY_DISCOVERY } from '../src/agentic/reviewSkills.js';
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

function agentVerify(verdict: 'confirmed' | 'refuted', severity?: string) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '{}',
    stderr: '',
    lastMessage: '',
    parsedJson: { verdict, ...(severity ? { severity } : {}) },
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
    resolveHeadSha: vi.fn().mockResolvedValue('feedface'),
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

  it('severity gate: non-blocking findings are not verified', async () => {
    const slack = makeSlack([`review ${WEB_PR}`]);
    const runAgent = routedRunAgent({
      reviewer: agentOk([
        { role: 'reviewer', severity: 'medium', category: 'bug', message: 'edge case', file: 'src/a.ts', line: 2 },
      ]),
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
    expect(verifierCalls(runAgent)).toBe(0);
    const outcomes = (result.result as any).outcomes;
    expect(outcomes[0].totalFindings).toBe(1);
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
