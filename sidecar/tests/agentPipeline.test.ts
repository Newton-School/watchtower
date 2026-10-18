/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoderFollowUpQuestion,
  buildCoderNoDiffQuestion,
  formatPlanDetail,
  formatPlanMessage,
  planNeedsRequesterConfirmation,
  postPlanForApproval,
  runAgentPipeline,
  waitForApproval,
  type ApprovalResult,
} from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import { __infraRetry } from '../src/codex/infraRetry.js';
import { currentConnectors, withConnectors } from '../src/backends/connectors.js';
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

  // Issue #443: a role that only reviews has no use for a design file or an
  // upload tool, whatever the change's planner and coder were given.
  it('keeps the change connectors for the planner and takes them away from the reviewer', async () => {
    const change = {
      mcpServers: { figma: { type: 'http' as const, url: 'https://figma.example/mcp' } },
      disallowedTools: [],
      unavailable: [],
    };
    const seen: string[][] = [];
    const ok = (parsedJson: Record<string, unknown>) => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson,
    });
    vi.mocked(runCodex)
      .mockImplementationOnce(async () => {
        seen.push(Object.keys(currentConnectors().mcpServers));
        return ok({
          plan: ['step 1'],
          risks: [],
          affectedFiles: ['file.ts'],
          scope: 'small',
          requiresCodeChanges: false,
        });
      })
      .mockImplementationOnce(async () => {
        seen.push(Object.keys(currentConnectors().mcpServers));
        return ok({ approved: true, findings: [], blockers: [] });
      });

    const result = await withConnectors(change, () =>
      runAgentPipeline({ ctx: makeContext(), slack: slack as any, logStep }),
    );

    expect(result.steps.map(step => step.role)).toEqual(['planner', 'reviewer']);
    expect(seen).toEqual([['figma'], []]);
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

    // The progress message is the first post; only it needs a ts back.
    slack.chat.postMessage.mockResolvedValueOnce({ ok: true, ts: '555.001' });

    await runAgentPipeline({ ctx, slack: slack as any, logStep });

    // One progress message, edited in place (issue #600): the intro stays as its
    // first line, every stage is an edit of that message, and the only other
    // new message is the plan, which a person acts on.
    const posted = slack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    expect(posted[0]).toMatch(
      /^On it — planning the approach first.*\nthinking through the approach · step 1\/2 · \d+s$/s,
    );
    expect(posted.slice(1).filter(text => /step \d\/\d/.test(text))).toEqual([]);
    const edits = slack.chat.update.mock.calls.map((call: any[]) => call[0]);
    expect(edits.every(edit => edit.ts === '555.001')).toBe(true);
    const edited = edits.map(edit => edit.text as string);
    expect(edited.every(text => text.startsWith('On it — planning the approach first'))).toBe(true);
    expect(edited.some(text => text.includes('\nreviewing the changes · step 2/2 · '))).toBe(true);
    expect(edited[edited.length - 1]).toMatch(/\nDone in \d+s\. Summary below\.$/);
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

describe("the pipeline's agents see the thread's attachments (issue #595)", () => {
  it('gives the coder, reviewer and verifier the screenshots and PDFs, and the coder again on a retry', async () => {
    const ok = (parsedJson: Record<string, unknown>) =>
      ({ ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '', parsedJson }) as any;
    vi.mocked(runCodex)
      .mockReset()
      .mockResolvedValueOnce(ok({ status: 'done', summary: 'Added the banner.', prUrl: '' }))
      .mockResolvedValueOnce(
        ok({ approved: false, findings: [{ severity: 'high', category: 'c', message: 'Wrong PDF.' }] }),
      )
      .mockResolvedValueOnce(ok({ status: 'done', summary: 'Used the attached PDF.', prUrl: '' }))
      .mockResolvedValueOnce(ok({ approved: true, findings: [] }))
      .mockResolvedValueOnce(ok({ verified: true, testsPassed: true, requirementsMet: true, findings: [] }));
    const files = ['/tmp/slack-files/F1-report.pdf'];
    const ctx = makeContext({
      workflowIntent: 'IMPLEMENTATION',
      imagePaths: files,
      pipelineConfig: makePipelineConfig({ agents: ['coder', 'reviewer', 'verifier'], maxRetryLoops: 1 }),
    });

    await runAgentPipeline({
      ctx,
      slack: { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1' }), update: vi.fn() } } as any,
      logStep: vi.fn(),
    });

    expect(vi.mocked(runCodex).mock.calls.length).toBe(5);
    for (const call of vi.mocked(runCodex).mock.calls) expect(call[0].imagePaths).toEqual(files);
  });

  it('passes nothing when the thread has no attachments', async () => {
    vi.mocked(runCodex)
      .mockReset()
      .mockResolvedValue({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { approved: true, findings: [] },
      } as any);
    const ctx = makeContext({ pipelineConfig: makePipelineConfig({ agents: ['reviewer'] }) });

    await runAgentPipeline({
      ctx,
      slack: { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1' }), update: vi.fn() } } as any,
      logStep: vi.fn(),
    });

    expect(vi.mocked(runCodex).mock.calls[0][0].imagePaths).toBeUndefined();
  });
});

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
    expect(message).toContain('*Files to change:*\n• `src/tms/exam-form/defaults.ts`');
    // The full plan is posted below it, as a file (postPlanForApproval).
    expect(message).not.toContain('Change the four');
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
      '<@UREQUESTER> before I start, please confirm the behaviour change above is what you want: reply *yes*, or tell me what to change.',
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
    expect(assumed).toContain('<@UREQ> before I start, please confirm the assumptions above are what you want');

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
    expect(message).toContain('<@UREQ> before I start, please confirm the behaviour change above is what you want');
  });

  it('does not repeat the approver block or the file list inside the full plan', () => {
    const detail = formatPlanDetail(block('none'));

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

  it('keeps the approval message short: the 6,300-character plan from the incident becomes a summary', () => {
    const longSteps = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step ${i + 1} touches \`src/tms/x${i}.ts\`.`);
    const plan = `${block('An exam now ends on the very first flagged breach.')}\n\n## Steps\n${longSteps.join('\n')}`;

    const message = formatPlanMessage(plan, FILES, 'small', REPO, false, 'UREQ');

    expect(plan.length).toBeGreaterThan(2_000);
    expect(message.length).toBeLessThan(900);
    expect(formatPlanDetail(plan)).toContain('60. Step 60');
  });

  it('asks the requester to confirm only when behaviour changes or something was assumed', () => {
    expect(planNeedsRequesterConfirmation(block('none'))).toBe(false);
    expect(planNeedsRequesterConfirmation(block('Ends on first breach.'))).toBe(true);
    expect(planNeedsRequesterConfirmation(block('none', 'Picked the web form.'))).toBe(true);
    // No approver block: nothing to confirm against, and the plan is posted whole.
    expect(planNeedsRequesterConfirmation('# Plain\n\n1. Edit `a.ts`.')).toBe(false);
    expect(formatPlanDetail('# Plain\n\n1. Edit `a.ts`.')).toBe('');
  });

  describe('postPlanForApproval', () => {
    const slackWith = (upload: () => Promise<unknown>) =>
      ({
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '300.00' }) },
        filesUploadV2: vi.fn(upload),
      }) as any;
    const post = (slack: any, planMarkdown = block('none')) =>
      postPlanForApproval({
        slack,
        channelId: 'C1',
        threadTs: '100.00',
        planMarkdown,
        affectedFiles: FILES,
        scope: 'small',
        repoPath: REPO,
      });

    it('posts the summary, then the full plan below it as plan.md', async () => {
      const slack = slackWith(async () => ({ ok: true }));

      expect(await post(slack)).toBe('300.00');

      expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('*What changes:*');
      const upload = slack.filesUploadV2.mock.calls[0][0];
      expect(upload).toMatchObject({ channel_id: 'C1', thread_ts: '100.00' });
      expect(upload.file_uploads[0].filename).toBe('plan.md');
      expect(upload.file_uploads[0].file.toString('utf8')).toContain('1. Change the four `DEFAULT_*` constants');
    });

    it('posts the full plan as a message when the upload fails', async () => {
      const slack = slackWith(async () => {
        throw new Error('missing_scope');
      });

      expect(await post(slack)).toBe('300.00');

      expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(slack.chat.postMessage.mock.calls[1][0].text).toMatch(/^_Full plan, for the coder:_\n/);
    });

    it('posts a plan with no approver block whole, with nothing below it', async () => {
      const slack = slackWith(async () => ({ ok: true }));

      await post(slack, '# Plain\n\n1. Edit `a.ts`.');

      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('1. Edit `a.ts`.');
      expect(slack.filesUploadV2).not.toHaveBeenCalled();
    });

    it('fails when the summary itself cannot be posted, so the caller can fail closed', async () => {
      const slack = slackWith(async () => ({ ok: true }));
      slack.chat.postMessage.mockRejectedValue(new Error('channel_not_found'));

      await expect(post(slack)).rejects.toThrow('channel_not_found');
      expect(slack.filesUploadV2).not.toHaveBeenCalled();
    });
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

  describe('a stop, and a reply to someone else (issues #598, #599)', () => {
    const texts = () => mockSlack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);

    it('ends the wait at once on an admin "stop"', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'stop', user: 'UCOREDEV', ts: '200.00' }]);
      const promise = runApproval();
      await vi.advanceTimersByTimeAsync(6000);

      const result = await promise;
      expect(result.outcome).toBe('cancelled');
      expect(result.approverId).toBe('UCOREDEV');
      expect(vi.mocked(runCodex)).not.toHaveBeenCalled();
    });

    it('lets the requester stop their own request', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: '<@UBOT> cancel it', user: 'UTRIGGER', ts: '200.00' }]);
      const promise = runApproval();
      await vi.advanceTimersByTimeAsync(6000);

      const result = await promise;
      expect(result.outcome).toBe('cancelled');
      expect(result.approverId).toBe('UTRIGGER');
      expect(texts()).toEqual([]);
    });

    it('tells a bystander who can stop it, once, and keeps waiting', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'stop', user: 'UOTHER', ts: '200.00' }]);
      const controller = new AbortController();
      const promise = runApproval({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(12_000);

      expect(texts()).toEqual(['<@UOTHER> only an admin or the person who asked can stop this.']);
      controller.abort();
      expect((await promise).outcome).toBe('cancelled');
      expect((await promise).approverId).toBe('');
    });

    it('reads an admin "no" as turning the plan down, not as a stop', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'no', user: 'UCOREDEV', ts: '200.00' }]);
      const promise = runApproval();
      await vi.advanceTimersByTimeAsync(6000);

      expect((await promise).outcome).toBe('rejected');
    });

    it('does not read "stop using X" as a stop', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'stop using the v1 endpoint and add a test', user: 'UCOREDEV', ts: '200.00' },
      ]);
      vi.mocked(runCodex).mockResolvedValue({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { intent: 'feedback', reasoning: 'a change to the plan' },
      });
      const promise = runApproval();
      await vi.advanceTimersByTimeAsync(6000);

      expect((await promise).outcome).toBe('feedback');
    });

    it('ignores a reply that @-mentions someone else and not miniOG, without asking the classifier', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'thanks <@UHUMAN>, can you also update the other pages?', user: 'UCOREDEV', ts: '200.00' },
      ]);
      const controller = new AbortController();
      const log = vi.fn();
      const promise = runApproval({ signal: controller.signal, logStep: log });
      await vi.advanceTimersByTimeAsync(12_000);

      expect(vi.mocked(runCodex)).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pipeline.approval.ignored' }));
      controller.abort();
      await promise;
    });

    it('still reads a reply that mentions miniOG alongside a person', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: '<@UHUMAN> fyi. <@UBOT> yes', user: 'UCOREDEV', ts: '200.00' },
      ]);
      vi.mocked(runCodex).mockResolvedValue({
        ok: true,
        exitCode: 0,
        timedOut: false,
        stdout: '',
        stderr: '',
        lastMessage: '',
        parsedJson: { intent: 'approve', reasoning: 'says yes to miniOG' },
      });
      const promise = runApproval();
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

  // Issue #437: a default changed to 0 was approved in 54 seconds by an admin,
  // and meant the opposite of what the requester wanted.
  describe('when the requester has to confirm the plan', () => {
    const texts = () => mockSlack.chat.postMessage.mock.calls.map((call: any[]) => call[0].text as string);
    const confirmRun = (overrides?: Partial<Parameters<typeof waitForApproval>[0]>) =>
      runApproval({ requesterToConfirm: 'UREQUESTER', ...overrides });

    it("holds an admin's yes until the requester confirms, and says who it is waiting for", async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
      let settled = false;
      const promise = confirmRun().then(result => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(16_000);

      expect(settled).toBe(false);
      expect(texts()).toEqual([
        'Thanks <@UCOREDEV>. <@UREQUESTER>, before I start: is the plan above what you want? Reply *yes*, or tell me what to change. (An admin can reply `approve without confirmation` to go ahead without that.)',
      ]);

      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'yes', user: 'UCOREDEV', ts: '200.00' },
        { text: 'yes', user: 'UREQUESTER', ts: '210.00' },
      ]);
      await vi.advanceTimersByTimeAsync(6000);

      expect(await promise).toEqual({
        outcome: 'approved',
        userReply: 'yes',
        approverId: 'UCOREDEV',
        replyTs: '210.00',
      });
    });

    it('logs the approval once, when it takes effect, not on every poll while it is held', async () => {
      const stages: string[] = [];
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
      const promise = confirmRun({ logStep: (entry: any) => stages.push(entry.stage) });
      await vi.advanceTimersByTimeAsync(60_000); // 12 polls

      expect(stages.filter(stage => stage === 'pipeline.approval.approved')).toHaveLength(0);
      expect(stages.filter(stage => stage === 'pipeline.approval.awaiting_requester')).toHaveLength(1);

      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'yes', user: 'UCOREDEV', ts: '200.00' },
        { text: 'yes', user: 'UREQUESTER', ts: '210.00' },
      ]);
      await vi.advanceTimersByTimeAsync(6000);
      await promise;

      expect(stages.filter(stage => stage === 'pipeline.approval.approved')).toHaveLength(1);
    });

    it('starts on the admin yes when the requester confirmed first', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'correct', user: 'UREQUESTER', ts: '200.00' }]);
      const promise = confirmRun();
      await vi.advanceTimersByTimeAsync(6000);
      expect(texts()).toEqual(['Thanks <@UREQUESTER>. Waiting for an admin to approve.']);

      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'correct', user: 'UREQUESTER', ts: '200.00' },
        { text: 'go', user: 'UCOREDEV', ts: '210.00' },
      ]);
      await vi.advanceTimersByTimeAsync(6000);

      expect((await promise).outcome).toBe('approved');
    });

    it("revises the plan from the requester's correction", async () => {
      vi.mocked(runCodex).mockResolvedValue({ ok: true, parsedJson: { intent: 'feedback' } } as any);
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'no, any number of breaches should be allowed', user: 'UREQUESTER', ts: '200.00' },
      ]);
      const promise = confirmRun();
      await vi.advanceTimersByTimeAsync(6000);

      expect(await promise).toEqual({
        outcome: 'feedback',
        userReply: 'no, any number of breaches should be allowed',
        approverId: 'UREQUESTER',
        replyTs: '200.00',
      });
    });

    it('asks a requester who only says no what they want instead', async () => {
      vi.mocked(runCodex).mockResolvedValue({ ok: true, parsedJson: { intent: 'reject' } } as any);
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'no', user: 'UREQUESTER', ts: '200.00' }]);
      const controller = new AbortController();
      const promise = confirmRun({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(16_000);

      expect(texts()).toEqual(["<@UREQUESTER> tell me what you want instead, and I'll revise the plan."]);
      controller.abort();
      expect((await promise).outcome).toBe('cancelled');
    });

    it('lets an admin go ahead without the requester, by exact phrase only', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([
        { text: 'approve without confirmation', user: 'UCOREDEV', ts: '200.00' },
      ]);

      const promise = confirmRun();
      await vi.advanceTimersByTimeAsync(6000);

      expect(await promise).toMatchObject({ outcome: 'approved', approverId: 'UCOREDEV' });
    });

    // The override miniOG itself advertises, typed the way people type to it: after an
    // @-mention, or pasted from its message with the backticks. Both fell through to the
    // classifier, whose "approve" only held the plan again, and the job never started.
    describe('the override, addressed to miniOG', () => {
      const heldThenOverride = (override: string) => [
        { text: '<@UBOT> update the eligibility copy', user: 'UREQUESTER', ts: '100.00' },
        { text: 'yes', user: 'UCOREDEV', ts: '200.00' },
        { text: override, user: 'UCOREDEV', ts: '220.00' },
      ];

      it.each([
        '<@UBOT> approve without confirmation',
        '<@UBOT|miniOG> approve without confirmation',
        '<@UBOT> `approve without confirmation`',
        '*approve without confirmation*',
      ])('starts the plan on %j after an admin yes', async override => {
        // What the classifier said in the thread where this broke.
        vi.mocked(runCodex).mockResolvedValue({ ok: true, parsedJson: { intent: 'approve' } } as any);
        vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
        let result: ApprovalResult | undefined;
        const controller = new AbortController();
        const promise = confirmRun({ signal: controller.signal }).then(r => (result = r));
        await vi.advanceTimersByTimeAsync(6000);
        expect(result).toBeUndefined();
        expect(texts()).toHaveLength(1); // held: "before I start: is the plan above what you want?"

        vi.mocked(fetchThreadContext).mockResolvedValue(heldThenOverride(override));
        await vi.advanceTimersByTimeAsync(6000);

        expect(result).toEqual({
          outcome: 'approved',
          userReply: override,
          approverId: 'UCOREDEV',
          replyTs: '220.00',
        });
        expect(texts()).toHaveLength(1);
        controller.abort();
        await promise;
      });

      it('does not let someone who cannot approve use it, and tells them so', async () => {
        vi.mocked(runCodex).mockResolvedValue({ ok: true, parsedJson: { intent: 'approve' } } as any);
        vi.mocked(fetchThreadContext).mockResolvedValue([
          { text: 'yes', user: 'UCOREDEV', ts: '200.00' },
          { text: '<@UBOT> approve without confirmation', user: 'UOTHER', ts: '220.00' },
        ]);
        let settled = false;
        const controller = new AbortController();
        const promise = confirmRun({ signal: controller.signal }).then(result => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(30_000);

        expect(settled).toBe(false);
        expect(texts()).toContain('<@UOTHER> Only admins can approve plans. Waiting for an admin to respond.');
        controller.abort();
        expect((await promise).outcome).toBe('cancelled');
      });

      it("takes the requester's yes after a mention without asking the classifier", async () => {
        vi.mocked(runCodex).mockResolvedValue({ ok: false } as any);
        vi.mocked(fetchThreadContext).mockResolvedValue([
          { text: 'yes', user: 'UCOREDEV', ts: '200.00' },
          { text: '<@UBOT> yes', user: 'UREQUESTER', ts: '210.00' },
        ]);

        let result: ApprovalResult | undefined;
        const controller = new AbortController();
        const promise = confirmRun({ signal: controller.signal }).then(r => (result = r));
        await vi.advanceTimersByTimeAsync(6000);

        expect(result).toMatchObject({ outcome: 'approved', approverId: 'UCOREDEV', replyTs: '210.00' });
        expect(runCodex).not.toHaveBeenCalled();
        controller.abort();
        await promise;
      });

      it("ignores an admin's yes addressed to someone else, without asking the classifier (issue #599)", async () => {
        vi.mocked(fetchThreadContext).mockResolvedValue([{ text: '<@UOTHER> yes', user: 'UCOREDEV', ts: '200.00' }]);
        let settled = false;
        const controller = new AbortController();
        const promise = confirmRun({ signal: controller.signal }).then(result => {
          settled = true;
          return result;
        });
        await vi.advanceTimersByTimeAsync(6000);

        expect(settled).toBe(false);
        expect(runCodex).not.toHaveBeenCalled();
        controller.abort();
        await promise;
      });

      // The reject pattern anchors only the start, and a rejection ends the job. Read after
      // the mention, it would have thrown away a plan the admin only wanted changed.
      it("revises the plan on an admin's no followed by a change, after a mention", async () => {
        vi.mocked(runCodex).mockResolvedValue({ ok: true, parsedJson: { intent: 'feedback' } } as any);
        vi.mocked(fetchThreadContext).mockResolvedValue([
          { text: '<@UBOT> no, use the v2 endpoint instead', user: 'UCOREDEV', ts: '200.00' },
        ]);

        const promise = confirmRun();
        await vi.advanceTimersByTimeAsync(6000);

        expect(await promise).toMatchObject({ outcome: 'feedback', approverId: 'UCOREDEV', replyTs: '200.00' });
        expect(runCodex).toHaveBeenCalledTimes(1);
      });
    });

    it('needs nothing extra when the requester can approve: their yes is both', async () => {
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);

      const promise = runApproval({ requesterToConfirm: 'UCOREDEV' });
      await vi.advanceTimersByTimeAsync(6000);

      expect(await promise).toMatchObject({ outcome: 'approved' });
      expect(texts()).toEqual([]);
    });

    it('reminds the requester, not the admins, once the plan is approved', async () => {
      const MIN = 60_000;
      vi.mocked(fetchThreadContext).mockResolvedValue([{ text: 'yes', user: 'UCOREDEV', ts: '200.00' }]);
      const controller = new AbortController();
      const promise = confirmRun({
        reminders: { afterMs: [15 * MIN], text: '<!subteam^S1> the plan still needs a yes or no.' },
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(16 * MIN);

      expect(texts()).toContain(
        '<@UREQUESTER> the plan above is approved and waits only for you: reply *yes* if it is what you want, or tell me what to change.',
      );
      expect(texts()).not.toContain('<!subteam^S1> the plan still needs a yes or no.');
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

  it('stops at once on "stop" followed by a reason (issue #598)', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([
      { text: 'stop - as this is huge change', user: 'UCOREDEV', ts: '200.00' },
    ]);

    const promise = runApproval();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.outcome).toBe('cancelled');
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
