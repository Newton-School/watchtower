/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentPipeline, waitForApproval } from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
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
    expect(result.needsInputQuestion).toContain('error text');
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
