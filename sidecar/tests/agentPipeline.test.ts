/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoderFollowUpQuestion,
  buildCoderNoDiffQuestion,
  formatPlanMessage,
  runAgentPipeline,
  waitForApproval,
} from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import { __infraRetry } from '../src/codex/infraRetry.js';
import { fetchThreadContext } from '../src/slack/threadContext.js';
import { checkCoderProducedChanges } from '../src/workspaces/gitState.js';
import type { AgentContext, PipelineConfig } from '../src/agents/types.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/workspaces/gitState.js', () => ({
  currentHead: vi.fn().mockResolvedValue('deadbeef'),
  checkCoderProducedChanges: vi.fn().mockResolvedValue({
    producedChanges: true,
    filesChanged: ['a.ts'],
    newCommits: 1,
    hasUncommitted: false,
    headMoved: true,
  }),
  git: vi.fn(),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  hasCommitsAheadOfBase: vi.fn().mockResolvedValue(false),
  diffFilesVsBase: vi.fn().mockResolvedValue([]),
  getDiffVsBase: vi.fn().mockResolvedValue({ diff: '--- a/a.ts\n+++ b/a.ts\n+changed', truncated: false }),
  currentBranch: vi.fn().mockResolvedValue('main'),
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
  multiAgentEnabled: true,
};

const task: NormalizedTask = {
  event: {
    eventId: 'EvPipeline1',
    channelId: 'C1',
    threadTs: '111.22',
    eventTs: '111.22',
    userId: 'U123',
    text: '<@UBOT1> review this PR',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'PR_REVIEW',
};

function makePipelineConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    agents: ['planner', 'reviewer'],
    maxRetryLoops: 2,
    perAgentTimeoutMs: 300000,
    totalTimeoutMs: 600000,
    abortOnCriticalFinding: true,
    slackProgressUpdates: false,
    requireApproval: false,
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workflowIntent: 'PR_REVIEW',
    task,
    config,
    repoPath: '/Users/dipesh/code/newton-web',
    threadContext: 'Test thread context',
    previousSteps: [],
    pipelineConfig: makePipelineConfig(),
    ...overrides,
  };
}

const slack = {
  chat: {
    postMessage: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
};

const logStep = vi.fn();

describe('agentPipeline', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    slack.chat.postMessage.mockClear();
    slack.chat.update.mockClear();
    logStep.mockClear();
  });

  it('executes agents in sequence, passing context forward', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          plan: ['step 1'],
          risks: [],
          affectedFiles: ['file.ts'],
          scope: 'small',
          requiresCodeChanges: false,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: true,
          findings: [],
          blockers: [],
        },
      });

    const result = await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    expect(result.finalStatus).toBe('passed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].role).toBe('planner');
    expect(result.steps[1].role).toBe('reviewer');
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('triggers coder re-run when reviewer rejects (feedback loop)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 1,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['fix it'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      // coder
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Fixed', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer (rejects)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'high', category: 'logic', message: 'Missing edge case' }],
          blockers: ['Missing edge case handling'],
        },
      })
      // coder retry
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          filesChanged: ['a.ts'],
          summary: 'Fixed with edge case',
          testsAdded: ['a.test.ts'],
          branch: 'codex/fix',
        },
      })
      // reviewer retry (approves)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.retryLoops).toBe(1);
    expect(result.finalStatus).toBe('passed');
    expect(runCodex).toHaveBeenCalledTimes(5);
  });

  it('plan-mismatch (high, not critical) self-heals via coder re-run instead of aborting (#388)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 1,
        abortOnCriticalFinding: true,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          plan: ['remove the experiment'],
          risks: [],
          affectedFiles: [],
          scope: 'medium',
          requiresCodeChanges: true,
        },
      })
      // coder (implements the WRONG thing)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Changed the ratio', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer flags plan-mismatch (high, NOT critical) and rejects
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [
            {
              severity: 'high',
              category: 'plan-mismatch',
              message: 'Plan asked to remove the experiment; diff only changed the ratio',
            },
          ],
          blockers: ['Does not match the approved plan'],
        },
      })
      // coder retry (corrects)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          filesChanged: ['a.ts'],
          summary: 'Removed the experiment per plan',
          testsAdded: [],
          branch: 'codex/fix',
        },
      })
      // reviewer retry (approves)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    // 'high' plan-mismatch must NOT abort (critical would); it self-heals.
    expect(result.finalStatus).toBe('passed');
    expect(result.retryLoops).toBe(1);
    expect(runCodex).toHaveBeenCalledTimes(5);
  });

  it('respects maxRetryLoops (no infinite loops)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 1,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['fix it'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      // coder
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Fixed', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer rejects
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'high', category: 'logic', message: 'Bad' }],
          blockers: ['Bad'],
        },
      })
      // coder retry
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Retry', testsAdded: [], branch: 'codex/fix' },
      })
      // reviewer rejects again (max loops exhausted)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'high', category: 'logic', message: 'Still bad' }],
          blockers: ['Still bad'],
        },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.retryLoops).toBe(1);
    expect(result.finalStatus).toBe('failed');
  });

  it('aborts pipeline on critical security finding', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'security', 'reviewer'],
        abortOnCriticalFinding: true,
      }),
    });

    vi.mocked(runCodex)
      // planner
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['review'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      // security (critical finding)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'critical', category: 'xss', message: 'XSS vulnerability found' }],
          overallSeverity: 'critical',
        },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('aborted');
    expect(result.steps).toHaveLength(2);
    // reviewer should NOT have run
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it('posts Slack progress updates at each step when enabled', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'reviewer'],
        slackProgressUpdates: true,
      }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    await runAgentPipeline({ ctx, slack: slack as any, logStep });

    // Pipeline start + per-agent (start + completion) + plan message + finish
    expect(slack.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('[1/2] Thinking through the approach') }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('[2/2] Reviewing the changes') }),
    );
  });

  it('aggregates findings from all agents', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['test'], risks: ['risk1'], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: true,
          findings: [
            { severity: 'medium', category: 'style', message: 'Style issue' },
            { severity: 'low', category: 'naming', message: 'Naming convention' },
          ],
          blockers: [],
        },
      });

    const result = await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    expect(result.aggregatedFindings).toHaveLength(2);
    expect(result.aggregatedFindings[0].category).toBe('style');
    expect(result.aggregatedFindings[1].category).toBe('naming');
  });

  it('assigns appropriate model profiles per agent role', async () => {
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    await runAgentPipeline({
      ctx: makeContext(),
      slack: slack as any,
      logStep,
    });

    // Planner uses lightweight profile
    expect(runCodex).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'low' }));
    // Reviewer uses high-reasoning profile
    expect(runCodex).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'xhigh' }));
  });

  it('handles total timeout across multi-step pipeline', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'reviewer', 'security'],
        totalTimeoutMs: 50,
      }),
    });

    // First agent resolves but introduces a delay to trigger timeout before third agent
    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['test'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false },
      })
      .mockImplementationOnce(async () => {
        // Introduce a delay that exceeds the total timeout
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { approved: true, findings: [], blockers: [] },
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], overallSeverity: 'clean' },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    // Pipeline should detect timeout and abort before completing all steps
    expect(result.finalStatus).toBe('aborted');
    // Security agent should not have run
    expect(result.steps.length).toBeLessThan(3);
  });

  it('short-circuits to needs-input when coder produces no diff', async () => {
    vi.mocked(checkCoderProducedChanges).mockResolvedValueOnce({
      producedChanges: false,
      filesChanged: [],
      newCommits: 0,
      hasUncommitted: false,
      headMoved: false,
    });

    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 2,
        abortOnCriticalFinding: true,
      }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          plan: ['investigate then fix'],
          risks: [],
          affectedFiles: ['src/foo.ts'],
          scope: 'small',
          requiresCodeChanges: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          filesChanged: ['hallucinated.ts'],
          summary: 'I totally wrote code (hallucinated to pass old guard).',
          testsAdded: [],
          branch: 'codex/ghost',
        },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('needs-input');
    expect(result.needsInputQuestion).toBeDefined();
    // It says what was checked (the repository), quotes the coder's own account,
    // and does not claim that nothing was touched (issue #432).
    expect(result.needsInputQuestion).toContain('nothing changed in the repository');
    expect(result.needsInputQuestion).toContain('> I totally wrote code (hallucinated to pass old guard).');
    expect(result.needsInputQuestion).not.toContain("haven't touched");
    // Reviewer should NOT have run — feedback loop short-circuited
    expect(result.steps.map(s => s.role)).toEqual(['planner', 'coder']);
  });

  it('coder empty-output always takes the needs-input path (abortOnCriticalFinding irrelevant)', async () => {
    vi.mocked(checkCoderProducedChanges).mockResolvedValueOnce({
      producedChanges: false,
      filesChanged: [],
      newCommits: 0,
      hasUncommitted: false,
      headMoved: false,
    });

    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({
        agents: ['planner', 'coder', 'reviewer'],
        maxRetryLoops: 0,
        abortOnCriticalFinding: true,
      }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['fix'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['x.ts'], summary: 'hallucinated fix', testsAdded: [], branch: 'codex/x' },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('needs-input');
    const coderStep = result.steps.find(s => s.role === 'coder');
    expect(coderStep?.status).toBe('failed');
    expect(coderStep?.findings.some(f => f.category === 'coder-empty-output')).toBe(true);
  });

  it('overwrites filesChanged with git truth when coder does produce changes', async () => {
    vi.mocked(checkCoderProducedChanges).mockResolvedValueOnce({
      producedChanges: true,
      filesChanged: ['actually-touched.ts'],
      newCommits: 1,
      hasUncommitted: false,
      headMoved: true,
    });

    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['planner', 'coder', 'reviewer'], maxRetryLoops: 0 }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['fix'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['lied-about.ts'], summary: 'Fixed', testsAdded: [], branch: 'codex/fix' },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    const coderStep = result.steps.find(s => s.role === 'coder');
    expect(coderStep?.status).toBe('passed');
    expect(coderStep?.output.filesChanged).toEqual(['actually-touched.ts']);
  });

  it('flags coder as failed on retry when git state still shows no changes', async () => {
    vi.mocked(checkCoderProducedChanges)
      .mockResolvedValueOnce({
        producedChanges: true,
        filesChanged: ['a.ts'],
        newCommits: 1,
        hasUncommitted: false,
        headMoved: true,
      })
      .mockResolvedValueOnce({
        producedChanges: false,
        filesChanged: [],
        newCommits: 0,
        hasUncommitted: false,
        headMoved: false,
      });

    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['planner', 'coder', 'reviewer'], maxRetryLoops: 1 }),
    });

    vi.mocked(runCodex)
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { plan: ['fix'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { filesChanged: ['a.ts'], summary: 'Real fix', testsAdded: [], branch: 'codex/fix' },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          approved: false,
          findings: [{ severity: 'high', category: 'logic', message: 'Missing case' }],
          blockers: ['Missing case'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: {
          filesChanged: ['a.ts'],
          summary: 'Retry said it fixed but did not',
          testsAdded: [],
          branch: 'codex/fix',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [], blockers: [] },
      });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    const coderSteps = result.steps.filter(s => s.role === 'coder');
    expect(coderSteps).toHaveLength(2);
    expect(coderSteps[1].status).toBe('failed');
    expect(coderSteps[1].findings.some(f => f.category === 'coder-empty-output')).toBe(true);
    expect(result.finalStatus).toBe('needs-input');
    expect(result.needsInputQuestion).toBeDefined();
    // The retry's own account is what gets quoted, not the first run's (issue #432).
    expect(result.needsInputQuestion).toContain('> Retry said it fixed but did not');
    expect(result.needsInputQuestion).not.toContain("haven't touched");
  });

  describe('approved plan reaches the agents (#413)', () => {
    const APPROVED_PLAN = '# Scale control to 100%\n\nEdit `src/lib/experiments/registry.ts`: control 70 -> 100.';

    function seededPlannerStep() {
      return {
        role: 'planner' as const,
        status: 'passed' as const,
        output: {
          planMarkdown: APPROVED_PLAN,
          scope: 'small',
          affectedFiles: ['src/lib/experiments/registry.ts'],
          requiresCodeChanges: true,
          clarificationNeeded: null,
        },
        findings: [],
        durationMs: 1000,
      };
    }

    function promptFor(role: 'coder' | 'reviewer'): string {
      const marker = role === 'coder' ? 'You are the CODER agent' : 'You are the REVIEWER agent';
      const call = vi.mocked(runCodex).mock.calls.find(c => String(c[0].prompt).includes(marker));
      return String(call?.[0].prompt ?? '');
    }

    it('hands a pre-approved planner step to the coder and reviewer prompts', async () => {
      const ctx = makeContext({
        previousSteps: [seededPlannerStep()],
        pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer'], maxRetryLoops: 0 }),
      });

      vi.mocked(runCodex)
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { status: 'done', filesChanged: ['a.ts'], summary: 'Done', testsAdded: [], branch: 'x' },
        })
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { approved: true, findings: [], blockers: [] },
        });

      const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

      expect(result.finalStatus).toBe('passed');

      const coderPrompt = promptFor('coder');
      expect(coderPrompt).toContain(APPROVED_PLAN);
      expect(coderPrompt).not.toContain('No plan markdown available.');
      expect(coderPrompt).toContain('Plan scope: small');
      expect(coderPrompt).toContain('src/lib/experiments/registry.ts');

      // The reviewer's plan-conformance gate is only real if it has the plan.
      const reviewerPrompt = promptFor('reviewer');
      expect(reviewerPrompt).toContain(APPROVED_PLAN);
      expect(reviewerPrompt).not.toContain('No plan markdown available.');

      // The seeded step stays out of this run's results — it wasn't run here.
      expect(result.steps.map(s => s.role)).toEqual(['coder', 'reviewer']);
    });

    it('quotes the approved plan when asking for more info after an empty coder run', async () => {
      vi.mocked(checkCoderProducedChanges).mockResolvedValueOnce({
        producedChanges: false,
        filesChanged: [],
        newCommits: 0,
        hasUncommitted: false,
        headMoved: false,
      });

      const ctx = makeContext({
        previousSteps: [seededPlannerStep()],
        pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer'], maxRetryLoops: 0 }),
      });

      vi.mocked(runCodex).mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { status: 'done', filesChanged: ['ghost.ts'], summary: 'Did it', testsAdded: [], branch: 'x' },
      });

      const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

      expect(result.finalStatus).toBe('needs-input');
      // Without the seeded planner this question was generic — no plan, no files.
      expect(result.needsInputQuestion).toContain('Scale control to 100%');
      expect(result.needsInputQuestion).toContain('src/lib/experiments/registry.ts');
    });

    it('keeps the plan in context when the reviewer rejects and the coder re-runs', async () => {
      const ctx = makeContext({
        previousSteps: [seededPlannerStep()],
        pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer'], maxRetryLoops: 1 }),
      });

      vi.mocked(runCodex)
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { status: 'done', filesChanged: ['a.ts'], summary: 'First try', testsAdded: [], branch: 'x' },
        })
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: {
            approved: false,
            findings: [{ severity: 'high', category: 'plan-mismatch', message: 'Wrong file' }],
            blockers: ['Wrong file'],
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { status: 'done', filesChanged: ['a.ts'], summary: 'Corrected', testsAdded: [], branch: 'x' },
        })
        .mockResolvedValueOnce({
          ok: true,
          exitCode: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          lastMessage: '',
          parsedJson: { approved: true, findings: [], blockers: [] },
        });

      await runAgentPipeline({ ctx, slack: slack as any, logStep });

      const retryPrompt = String(vi.mocked(runCodex).mock.calls[2][0].prompt);
      expect(retryPrompt).toContain('You are the CODER agent');
      expect(retryPrompt).toContain(APPROVED_PLAN);
      expect(retryPrompt).toContain('Wrong file'); // reviewer feedback still there
    });
  });

  it('routes a self-declared coder block to needs-input instead of a PR (#413)', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer'], maxRetryLoops: 2 }),
    });

    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'blocked',
        blockedReason: 'Which element should scale to 100% — can you share a Figma link?',
        summary: 'Blocked: ambiguous request.',
        filesChanged: [],
        testsAdded: [],
        branch: '',
        prUrl: '',
      },
    });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('needs-input');
    expect(result.needsInputQuestion).toContain('can you share a Figma link?');
    const coderStep = result.steps.find(s => s.role === 'coder');
    expect(coderStep?.status).toBe('failed');
    expect(coderStep?.findings.some(f => f.category === 'coder-blocked')).toBe(true);
    // Reviewer must not run, and there is nothing for a PR to be built from.
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.agent.coder.blocked' }));
  });

  it('aborts immediately on a usage-limit hit — no feedback loops, no further spawns (issue #342)', async () => {
    // Incident shape (job 264ea287): every CLI spawn exits 1 in ~3s with the
    // limit message and zero API tokens. The old behavior treated each exit
    // as a reviewer verdict and burned coder->reviewer x2 retry loops in 23s.
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer', 'verifier'] }),
    });

    vi.mocked(runCodex).mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage:
        '{"type":"result","subtype":"error_during_execution","result":"You\'ve hit your session limit · resets 9:40pm (Asia/Calcutta)"}',
      parsedJson: { status: 'error', summary: "You've hit your session limit · resets 9:40pm (Asia/Calcutta)" },
      errorKind: 'USAGE_LIMIT',
      limitResetsAtText: '9:40pm (Asia/Calcutta)',
    } as any);

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('usage-limit');
    expect(result.usageLimitResetsAt).toBe('9:40pm (Asia/Calcutta)');
    // One spawn only: the coder. No reviewer, no verifier, no retry loops.
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result.retryLoops).toBe(0);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.usage_limit' }));
  });

  it('aborts on a usage-limit hit during the coder retry inside the feedback loop', async () => {
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer'] }),
    });

    vi.mocked(runCodex)
      // coder: ok
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { status: 'success', summary: 'done', filesChanged: ['a.ts'] },
      } as any)
      // reviewer: rejects -> triggers feedback loop
      .mockResolvedValueOnce({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: false, findings: [], blockers: ['needs work'] },
      } as any)
      // coder retry: limit hit
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: "You've hit your usage limit · resets 11:00am (Asia/Calcutta)",
        parsedJson: { status: 'error', summary: 'limit' },
        errorKind: 'USAGE_LIMIT',
        limitResetsAtText: '11:00am (Asia/Calcutta)',
      } as any);

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('usage-limit');
    expect(result.usageLimitResetsAt).toBe('11:00am (Asia/Calcutta)');
    expect(runCodex).toHaveBeenCalledTimes(3);
  });
});

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn(),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

describe('formatPlanMessage: the plan as the approver sees it (issue #437)', () => {
  const block = (behaviour: string, assumptions = 'none') =>
    [
      '# Default the four proctor breach thresholds to 0',
      '',
      '## For the approver',
      '- What changes: New exams start with all four breach thresholds set to 0.',
      '- Where: TMS exam form',
      `- Behaviour change: ${behaviour}`,
      `- Assumptions to confirm: ${assumptions}`,
      '- Risk: high',
      '',
      '## Files to change',
      '- `src/tms/exam-form/defaults.ts` — the four defaults',
      '',
      '## Steps',
      '1. Change the four `DEFAULT_*` constants from 3 to 0.',
      '',
      'Scope: small',
    ].join('\n');
  const FILES = ['/ws/newton-web/1-1/src/tms/exam-form/defaults.ts'];
  const REPO = '/ws/newton-web/1-1';

  it('opens with what the approver needs, before any of the plan', () => {
    const message = formatPlanMessage(block('none'), FILES, 'small', REPO);
    const lines = message.split('\n');

    expect(lines[0]).toBe('*Plan* (scope: small, 1 file to change, risk: high)');
    expect(lines[1]).toBe('*What changes:* New exams start with all four breach thresholds set to 0.');
    expect(lines[2]).toBe('*Where:* TMS exam form');
    expect(lines[3]).toBe('*Behaviour change:* none');
    expect(lines[4]).toBe('*Assumptions to confirm:* none');
    expect(message.indexOf('*Files to change:*')).toBeLessThan(message.indexOf('_Full plan, for the coder:_'));
    expect(message).toContain('• `src/tms/exam-form/defaults.ts`');
  });

  it('flags a behaviour change and asks the requester to confirm it, not only the approver', () => {
    // The incident: approved in 54 seconds, and the opposite of what the requester wanted.
    const message = formatPlanMessage(
      block('An exam now ends on the very first flagged breach. 0 is the strictest setting, not the most lenient.'),
      FILES,
      'small',
      REPO,
      false,
      'UREQUESTER',
    );

    expect(message).toContain('*Behaviour change:* :warning: An exam now ends on the very first flagged breach.');
    expect(message).toContain(
      '<@UREQUESTER> please confirm the behaviour change above is what you want, before this is approved.',
    );
  });

  it('asks the requester about assumptions too, and about nothing when there is nothing to confirm', () => {
    const assumed = formatPlanMessage(
      block('none', 'I could not open the screenshot.'),
      FILES,
      'small',
      REPO,
      false,
      'UREQ',
    );
    expect(assumed).toContain('<@UREQ> please confirm the assumptions above are what you want');

    const both = formatPlanMessage(
      block('Ends on first breach.', 'Picked the web form.'),
      FILES,
      'small',
      REPO,
      false,
      'UREQ',
    );
    expect(both).toContain('please confirm the behaviour change and the assumptions above are what you want');

    expect(formatPlanMessage(block('none'), FILES, 'small', REPO, false, 'UREQ')).not.toContain('<@UREQ>');
    // No requester known (older callers): the warning still shows, nobody is tagged.
    expect(formatPlanMessage(block('Ends on first breach.'), FILES, 'small', REPO)).not.toContain('<@');
  });

  it('does not flag or ask about a "none" that comes with an explanation', () => {
    const message = formatPlanMessage(
      block(
        'none. The line is an HTML comment, so nothing in the product changes.',
        'None — the README at the repo root.',
      ),
      FILES,
      'small',
      REPO,
      false,
      'UREQ',
    );

    expect(message).toContain(
      '*Behaviour change:* none. The line is an HTML comment, so nothing in the product changes.',
    );
    expect(message).toContain('*Assumptions to confirm:* None — the README at the repo root.');
    expect(message).not.toContain(':warning:');
    expect(message).not.toContain('<@UREQ>');
  });

  it('still flags a change that hides behind a leading "none"', () => {
    const message = formatPlanMessage(block('none, but the default becomes 0'), FILES, 'small', REPO, false, 'UREQ');

    expect(message).toContain('*Behaviour change:* :warning: none, but the default becomes 0');
    expect(message).toContain('<@UREQ> please confirm the behaviour change above is what you want');
  });

  it('does not repeat the approver block or the file list inside the full plan', () => {
    const message = formatPlanMessage(block('none'), FILES, 'small', REPO);
    const detail = message.slice(message.indexOf('_Full plan, for the coder:_'));

    expect(detail).toContain('1. Change the four `DEFAULT_*` constants from 3 to 0.');
    expect(detail).not.toContain('For the approver');
    expect(detail).not.toContain('What changes');
    expect(detail).not.toContain('Files to change');
  });

  it('keeps the old layout for a plan with no approver block, with an honest header', () => {
    const plain = '# Fix the redirect\n\n1. Edit `auth.ts`.';

    expect(formatPlanMessage(plain, ['auth.ts', 'login.tsx'], 'medium')).toBe(
      '*Plan* (scope: medium, 2 files to change)\n# Fix the redirect\n\n1. Edit `auth.ts`.\n\n*Files to change:*\n• `auth.ts`\n• `login.tsx`',
    );
    // No count is better than a wrong one.
    expect(formatPlanMessage(plain, [], 'medium')).toBe(
      '*Plan* (scope: medium)\n# Fix the redirect\n\n1. Edit `auth.ts`.',
    );
  });

  it('lists at most eight files and says how many more there are', () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
    const message = formatPlanMessage('# Big\n\n1. Many edits.', files, 'large');

    expect(message).toContain('11 files to change');
    expect(message).toContain('• `src/f7.ts`\n• … and 3 more');
    expect(message).not.toContain('src/f8.ts');
  });

  it('marks an executed plan at the end, whichever layout', () => {
    expect(formatPlanMessage(block('none'), FILES, 'small', REPO, true).endsWith('_✅ Plan executed._')).toBe(true);
    expect(formatPlanMessage('# Plain', [], 'small', undefined, true).endsWith('_✅ Plan executed._')).toBe(true);
  });
});

describe('what the thread is told when the coder leaves no diff (issue #432)', () => {
  const PLAN = '# Fix Metabase dashboard 674 — restrict Dyte recording coverage to real course topic classes';
  const REPORT =
    'Updated all 7 cards on dashboard 674 and its description.\nBefore: 1,204 sessions counted. After: 987 (topic classes only).';

  it('quotes the coder own account of what it did, line by line', () => {
    const question = buildCoderNoDiffQuestion(PLAN, ['video_sessions/models.py'], REPORT);

    expect(question).toContain('This is what it says it did:');
    expect(question).toContain('> Updated all 7 cards on dashboard 674 and its description.');
    expect(question).toContain('> Before: 1,204 sessions counted. After: 987 (topic classes only).');
  });

  it('says only what was checked, and never that nothing was touched', () => {
    const question = buildCoderNoDiffQuestion(PLAN, [], REPORT);

    expect(question.startsWith('The coder finished, but nothing changed in the repository')).toBe(true);
    expect(question).toContain('it may already be in place. Check it before you ask me to do it again.');
    expect(question).not.toContain("haven't touched");
    expect(question).not.toContain('hallucinat');
  });

  it('admits it cannot tell when the coder gave no account', () => {
    const question = buildCoderNoDiffQuestion(PLAN, [], '   ');

    expect(question).toContain('It gave no account of what it did');
    expect(question).toContain('cannot tell you whether anything outside the repository changed');
    expect(question).not.toContain('This is what it says it did');
  });

  it('keeps a long report to a readable length', () => {
    const question = buildCoderNoDiffQuestion('', [], 'x'.repeat(5000));

    expect(question).toContain(`> ${'x'.repeat(900)}…`);
    expect(question.length).toBeLessThan(1500);
  });

  it('still shows the plan and the planned files, and how to go on', () => {
    const question = buildCoderNoDiffQuestion(PLAN, ['a.py', 'b.py', 'c.py', 'd.py'], REPORT);

    expect(question).toContain(`The plan opened with: _${PLAN}_`);
    expect(question).toContain('Planned files: `a.py, b.py, c.py` …');
    expect(question).toContain('or say "cancel" to stop.');
  });

  it('no longer claims untouched files when the coder could not pin a change down either', () => {
    const question = buildCoderFollowUpQuestion(makeContext(), PLAN, []);

    expect(question.startsWith("I couldn't pin down a concrete change from the info I have.")).toBe(true);
    expect(question).not.toContain("haven't touched");
  });
});

describe('agentPipeline and a dropped connection (issue #439)', () => {
  const savedRetry = { ...__infraRetry };
  const okStep = (parsedJson: Record<string, unknown>) =>
    ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      durationMs: 10,
      parsedJson,
    }) as any;
  const dropped = {
    ok: false,
    exitCode: 1,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '{"type":"result","is_error":true,"result":"API Error: No response from API"}',
    durationMs: 0,
    errorKind: 'API_ERROR',
    apiErrorDetail: 'API Error: No response from API',
    sessionId: 'sess-coder',
  } as any;
  const coderDone = okStep({ status: 'success', summary: 'changed two strings', filesChanged: ['a.ts'] });
  const reviewerOk = okStep({ approved: true, findings: [], blockers: [] });
  const verifierOk = okStep({ verified: true, findings: [] });

  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    logStep.mockClear();
    __infraRetry.sleep = vi.fn().mockResolvedValue(true);
  });
  afterEach(() => Object.assign(__infraRetry, savedRetry));

  const coderPipeline = (overrides: Partial<PipelineConfig> = {}) =>
    makeContext({
      workflowIntent: 'IMPLEMENTATION',
      pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer', 'verifier'], ...overrides }),
    });

  it('runs the coder again when its connection drops, resuming its session, and then carries on', async () => {
    // The incident: the coder had committed and pushed, then died on "API Error" before finishing.
    vi.mocked(runCodex)
      .mockResolvedValueOnce(dropped)
      .mockResolvedValueOnce(coderDone)
      .mockResolvedValueOnce(reviewerOk)
      .mockResolvedValueOnce(verifierOk);

    const result = await runAgentPipeline({ ctx: coderPipeline(), slack: slack as any, logStep });

    expect(result.finalStatus).toBe('passed');
    expect(result.interrupted).toBeUndefined();
    expect(runCodex).toHaveBeenCalledTimes(4);
    expect(vi.mocked(runCodex).mock.calls[1][0]).toMatchObject({ resumeSessionId: 'sess-coder' });
    expect(result.steps.map(step => `${step.role}:${step.status}`)).toEqual([
      'coder:passed',
      'reviewer:passed',
      'verifier:passed',
    ]);
  });

  it('stops when the connection never comes back, and says that is why', async () => {
    vi.mocked(runCodex).mockResolvedValue(dropped);

    const result = await runAgentPipeline({ ctx: coderPipeline(), slack: slack as any, logStep });

    expect(result.finalStatus).toBe('failed');
    expect(result.interrupted).toEqual({ kind: 'connection_lost', role: 'coder', retries: 3 });
    // The coder and its three retries. No reviewer and no verifier on a step that never happened.
    expect(runCodex).toHaveBeenCalledTimes(4);
    expect(result.steps.map(step => step.role)).toEqual(['coder']);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.api_error', level: 'ERROR' }));
  });

  it('does not let the reviewer and verifier run on a coder that failed', async () => {
    vi.mocked(runCodex).mockResolvedValueOnce({ ...coderDone, ok: false, exitCode: 1, parsedJson: undefined });

    const result = await runAgentPipeline({ ctx: coderPipeline(), slack: slack as any, logStep });

    expect(result.finalStatus).toBe('failed');
    expect(result.interrupted).toBeUndefined();
    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.coder_failed' }));
  });

  describe('an agent killed from outside (issue #445)', () => {
    const killed = {
      ok: false,
      exitCode: 143,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      durationMs: 0,
      errorKind: 'EXTERNAL_KILL',
      killSignal: 'SIGTERM',
    } as any;

    it('runs a killed reviewer again instead of reading its death as "rejected"', async () => {
      // The incident: the reviewer had flagged nothing. Its process was killed
      // by another job's `pkill`, and the coder was sent round again.
      vi.mocked(runCodex)
        .mockResolvedValueOnce(coderDone)
        .mockResolvedValueOnce(killed)
        .mockResolvedValueOnce(reviewerOk)
        .mockResolvedValueOnce(verifierOk);

      const result = await runAgentPipeline({ ctx: coderPipeline(), slack: slack as any, logStep });

      expect(result.finalStatus).toBe('passed');
      expect(result.retryLoops).toBe(0);
      expect(runCodex).toHaveBeenCalledTimes(4);
      expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.feedback_loop' }));
    });

    it('stops when the retry is killed too: no feedback loop, no coder re-run, and it says why', async () => {
      vi.mocked(runCodex).mockResolvedValueOnce(coderDone).mockResolvedValue(killed);

      const result = await runAgentPipeline({ ctx: coderPipeline(), slack: slack as any, logStep });

      expect(result.finalStatus).toBe('failed');
      expect(result.interrupted).toEqual({ kind: 'killed', role: 'reviewer', retries: 1 });
      expect(result.retryLoops).toBe(0);
      // The coder once, the reviewer twice. Not the coder again, and not the verifier.
      expect(runCodex).toHaveBeenCalledTimes(3);
      expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.feedback_loop' }));
      expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.killed', level: 'ERROR' }));
    });
  });

  it('does not charge the time a dropped connection cost to the pipeline timeout', async () => {
    // 80 ms really pass while "offline"; the pipeline's budget is 60 ms.
    __infraRetry.delaysMs = [80];
    __infraRetry.sleep = (ms: number) => new Promise(resolve => setTimeout(() => resolve(true), ms));
    vi.mocked(runCodex)
      .mockResolvedValueOnce({ ...dropped, sessionId: undefined })
      .mockResolvedValueOnce(
        okStep({ plan: ['x'], risks: [], affectedFiles: [], scope: 'small', requiresCodeChanges: false }),
      )
      .mockResolvedValueOnce(reviewerOk);
    const ctx = makeContext({
      pipelineConfig: makePipelineConfig({ agents: ['planner', 'reviewer'], totalTimeoutMs: 60 }),
    });

    const result = await runAgentPipeline({ ctx, slack: slack as any, logStep });

    expect(result.finalStatus).toBe('passed');
    expect(result.steps.map(step => step.role)).toEqual(['planner', 'reviewer']);
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.timeout' }));
  });
});

describe('waitForApproval', () => {
  const mockSlack = {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
  } as any;
  const noopLog: any = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function runApproval(overrides?: Partial<Parameters<typeof waitForApproval>[0]>) {
    return waitForApproval({
      slack: mockSlack,
      channelId: 'C1',
      threadTs: '100.00',
      approverUserIds: ['UCOREDEV'],
      triggerUserId: 'UTRIGGER',
      approvalPromptTs: '150.00',
      logStep: noopLog,
      botUserId: 'UBOT',
      ...overrides,
    });
  }

  // Issue #436: the wait had no reminder, so a plan could sit unseen for a day.
  describe('reminders', () => {
    const MIN = 60_000;
    const reminders = {
      afterMs: [15 * MIN, 120 * MIN],
      text: "<!subteam^S1> <@UTRIGGER>'s plan above still needs a yes or no.",
    };
    const reminderPosts = () =>
      mockSlack.chat.postMessage.mock.calls.filter((call: any[]) => call[0].text === reminders.text).length;

    it('re-pings once after 15 minutes and once after 2 hours, and not before', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([]);
      const controller = new AbortController();
      const promise = runApproval({ reminders, signal: controller.signal });

      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(reminderPosts()).toBe(0);

      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(reminderPosts()).toBe(1);
      expect(mockSlack.chat.postMessage.mock.calls[0][0]).toMatchObject({ channel: 'C1', thread_ts: '100.00' });

      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(reminderPosts()).toBe(1);

      await vi.advanceTimersByTimeAsync(50 * MIN);
      expect(reminderPosts()).toBe(2);

      await vi.advanceTimersByTimeAsync(600 * MIN);
      expect(reminderPosts()).toBe(2);

      controller.abort();
      await promise;
    });

    it('sends one message, not two, when both thresholds have passed at once', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([]);
      const controller = new AbortController();
      const promise = runApproval({ reminders: { ...reminders, afterMs: [1000, 2000] }, signal: controller.signal });

      await vi.advanceTimersByTimeAsync(6000); // the first poll is already past both
      expect(reminderPosts()).toBe(1);

      controller.abort();
      await promise;
    });

    it('sends nothing when no reminders are configured', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([]);
      const controller = new AbortController();
      const promise = runApproval({ signal: controller.signal });

      await vi.advanceTimersByTimeAsync(200 * MIN);
      expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();

      controller.abort();
      await promise;
    });

    it('still approves on an admin yes after a reminder', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([]);
      const promise = runApproval({ reminders });
      await vi.advanceTimersByTimeAsync(16 * MIN);
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
      await vi.advanceTimersByTimeAsync(6000);

      expect((await promise).outcome).toBe('approved');
    });
  });

  describe('a yes from someone who cannot approve', () => {
    const texts = () => mockSlack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);

    it('names who can approve and tags them once', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'yes', user: 'UREQUESTER', ts: '200.00' },
        { text: 'yes', user: 'UOTHER', ts: '201.00' },
      ]);
      const controller = new AbortController();
      const promise = runApproval({ approverMention: '<!subteam^S1>', signal: controller.signal });
      await vi.advanceTimersByTimeAsync(6000);

      expect(texts()).toEqual([
        '<@UREQUESTER> only admins can approve plans. <!subteam^S1>, this one is waiting for you.',
        '<@UOTHER> Only admins can approve plans. Waiting for an admin to respond.',
      ]);

      // And it is not repeated on later polls.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(texts()).toHaveLength(2);

      controller.abort();
      await promise;
    });

    it('keeps the plain reply when it does not know who can approve', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UREQUESTER', ts: '200.00' }]);
      const controller = new AbortController();
      const promise = runApproval({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(6000);

      expect(texts()).toEqual(['<@UREQUESTER> Only admins can approve plans. Waiting for an admin to respond.']);

      controller.abort();
      await promise;
    });
  });

  // Issue #264: a cancelled job used to wait here until an admin replied.
  it('returns cancelled as soon as the job is aborted, without waiting out the poll', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([]);
    const controller = new AbortController();
    const stages: string[] = [];

    const promise = runApproval({ signal: controller.signal, logStep: (entry: any) => stages.push(entry.stage) });
    await vi.advanceTimersByTimeAsync(1000); // mid-poll: the 5s tick has not fired
    controller.abort();
    const result = await promise;

    expect(result).toEqual({ outcome: 'cancelled', userReply: '', approverId: '', replyTs: '' });
    expect(fetchThreadContext).not.toHaveBeenCalled();
    expect(stages).toContain('pipeline.approval.cancelled');
  });

  it('returns cancelled without polling when the job was aborted before the wait began', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runApproval({ signal: controller.signal });

    expect(result.outcome).toBe('cancelled');
    expect(fetchThreadContext).not.toHaveBeenCalled();
  });

  it('does not read an approval that arrives in the same tick as the cancel', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
    const controller = new AbortController();

    const promise = runApproval({ signal: controller.signal });
    controller.abort();
    await vi.advanceTimersByTimeAsync(6000);

    expect((await promise).outcome).toBe('cancelled');
  });

  it('rejects when message starts with "stop" followed by a reason', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([
      { text: 'stop - as this is huge change', user: 'UCOREDEV', ts: '200.00' },
    ]);

    const promise = runApproval();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.outcome).toBe('rejected');
    expect(result.approverId).toBe('UCOREDEV');
  });

  it('rejects on bare "no"', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'no', user: 'UCOREDEV', ts: '200.00' }]);

    const promise = runApproval();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.outcome).toBe('rejected');
  });

  it('approves on bare "yes" from admin', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);

    const promise = runApproval();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.outcome).toBe('approved');
    expect(result.approverId).toBe('UCOREDEV');
  });

  it('blocks non-admin from approving', async () => {
    // First poll: non-admin says "yes" — should be ignored
    vi.mocked(fetchThreadContext)
      .mockResolvedValueOnce([{ text: 'yes', user: 'URANDOM', ts: '200.00' }])
      // Second poll: admin says "go"
      .mockResolvedValueOnce([
        { text: 'yes', user: 'URANDOM', ts: '200.00' },
        { text: 'go', user: 'UCOREDEV', ts: '210.00' },
      ]);

    const promise = runApproval();
    await vi.advanceTimersByTimeAsync(12000);
    const result = await promise;

    expect(result.outcome).toBe('approved');
    expect(result.approverId).toBe('UCOREDEV');
    expect(mockSlack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Only admins can approve') }),
    );
  });
});
