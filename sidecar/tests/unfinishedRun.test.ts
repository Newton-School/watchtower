/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUnfinishedRunMessage,
  coderReportedPrUrl,
  openFindings,
  unfinishedReason,
} from '../src/agents/unfinishedRun.js';
import { runAgentPipeline } from '../src/agents/pipeline.js';
import { buildReviewerPrompt, buildVerifierPrompt } from '../src/agents/prompts.js';
import { diagnoseFailure } from '../src/learning/failureDoctor.js';
import { runCodex } from '../src/codex/runCodex.js';
import type {
  AgentContext,
  AgentFinding,
  AgentStepResult,
  PipelineConfig,
  PipelineResult,
} from '../src/agents/types.js';

vi.mock('../src/codex/runCodex.js', () => ({ runCodex: vi.fn(), getActiveBackendId: vi.fn(() => 'claude-code') }));
vi.mock('../src/workspaces/gitState.js', () => ({
  currentHead: vi.fn().mockResolvedValue('deadbeef'),
  checkCoderProducedChanges: vi.fn().mockResolvedValue({
    producedChanges: true,
    filesChanged: ['a.ts'],
    newCommits: 1,
    hasUncommitted: false,
    headMoved: true,
  }),
  getDiffVsBase: vi.fn().mockResolvedValue({ diff: '+x', truncated: false }),
}));

// Issue #333: five times in Sep–Oct 2026 the thread was told "Not opening a
// PR" while the coder had already opened one.
const PR = 'https://github.com/Newton-School/newton-web/pull/9354';
const finding = (
  severity: AgentFinding['severity'],
  message: string,
  file = 'src/Submit.tsx',
  line = 12,
): AgentFinding => ({ severity, category: 'correctness', message, file, line }) as AgentFinding;
const step = (
  role: string,
  status: 'passed' | 'failed',
  output: Record<string, unknown> = {},
  findings: AgentFinding[] = [],
) => ({ role, status, output, findings, durationMs: 1 }) as AgentStepResult;
const result = (overrides: Partial<PipelineResult>): PipelineResult => ({
  steps: [],
  finalStatus: 'aborted',
  totalDurationMs: 1,
  retryLoops: 0,
  aggregatedFindings: [],
  ...overrides,
});

describe('what the thread is told when a change run did not pass', () => {
  // Job 980d3d7f, 2026-10-14.
  const timedOutRun = result({
    finalStatus: 'aborted',
    retryLoops: 1,
    budgetExhausted: { elapsedMs: 2_846_247, limitMs: 2_700_000, lastCoderPassUnreviewed: true },
    steps: [
      step('coder', 'passed', { prUrl: PR }),
      step('reviewer', 'failed', { approved: false }, [
        finding('high', 'The confirm dialog does not close on Escape.'),
        finding('medium', 'No test covers the cancel path.', 'src/Submit.test.tsx', 4),
        finding('low', 'Rename `ok` to `confirmed`.'),
      ]),
      step('coder', 'passed', { prUrl: '' }),
    ],
  });

  it('names the open PR, why it stopped, that the last pass was not reviewed, and what is still open', () => {
    const message = buildUnfinishedRunMessage({ result: timedOutRun, pr: { url: PR, state: 'OPEN' } });

    expect(message).toBe(
      [
        `I stopped: this run's 45-minute time limit ran out right after the coder's latest pass, so those changes were not reviewed again. The coder already opened ${PR}, but it has not passed the checks: review it before merging, or close it and mention me again.`,
        'Still open:\n• *high* `src/Submit.tsx:12` — The confirm dialog does not close on Escape.\n• *medium* `src/Submit.test.tsx:4` — No test covers the cancel path.',
      ].join('\n\n'),
    );
    expect(message).not.toContain('Not opening a PR');
  });

  it("finds the PR from the coder's earlier pass when the latest one reported none", () => {
    expect(coderReportedPrUrl(timedOutRun.steps)).toBe(PR);
    expect(coderReportedPrUrl([step('coder', 'passed', { prUrl: 'n/a' })])).toBeUndefined();
  });

  it('says what became of a PR that was merged or closed, and when there is none', () => {
    expect(buildUnfinishedRunMessage({ result: timedOutRun, pr: { url: PR, state: 'MERGED' } })).toContain(
      `The coder had already opened ${PR}, and it has since been merged.`,
    );
    expect(buildUnfinishedRunMessage({ result: timedOutRun, pr: { url: PR, state: 'CLOSED' } })).toContain(
      'it is closed now.',
    );
    expect(buildUnfinishedRunMessage({ result: timedOutRun })).toContain('I did not open a PR.');
  });

  it('gives the real reason for each way a run ends', () => {
    expect(
      unfinishedReason(result({ finalStatus: 'failed', steps: [step('coder', 'passed'), step('verifier', 'failed')] })),
    ).toBe('The final check did not pass.');
    expect(
      unfinishedReason(result({ finalStatus: 'failed', retryLoops: 2, steps: [step('reviewer', 'failed')] })),
    ).toBe('The review still had open findings after 2 revisions.');
    expect(
      unfinishedReason(
        result({
          finalStatus: 'aborted',
          steps: [step('security', 'failed', {}, [finding('critical', 'SQL injection')])],
        }),
      ),
    ).toBe('I stopped: the security check found a critical issue.');
    expect(
      unfinishedReason(
        result({ budgetExhausted: { elapsedMs: 1, limitMs: 2_700_000, lastCoderPassUnreviewed: false } }),
      ),
    ).toBe("I stopped: this run's 45-minute time limit ran out.");
  });

  it('lists only medium and worse from the latest review, once each, worst first, and at most five', () => {
    const many = Array.from({ length: 7 }, (_, i) => finding('medium', `issue ${i}`, 'a.ts', i + 1));
    const steps = [
      step('reviewer', 'failed', {}, [finding('high', 'old, superseded')]),
      step('reviewer', 'failed', {}, [...many, finding('low', 'nit')]),
      step('verifier', 'failed', {}, [finding('critical', 'tests fail'), many[0]]),
    ];

    expect(openFindings(steps).map(f => f.message)).toEqual(['tests fail', ...many.map(f => f.message)]);
    const message = buildUnfinishedRunMessage({ result: result({ finalStatus: 'failed', steps }) });
    expect(message).toContain('• …and 3 more');
    expect(message).not.toContain('old, superseded');
  });
});

describe('the time limit, when it runs out right after a coder pass', () => {
  const pipelineConfig = {
    agents: ['coder', 'reviewer', 'verifier'],
    maxRetryLoops: 2,
    totalTimeoutMs: 45 * 60_000,
    perAgentTimeoutMs: 600_000,
    abortOnCriticalFinding: false,
    slackProgressUpdates: true,
  } as PipelineConfig;
  const ctx = {
    workflowIntent: 'IMPLEMENTATION',
    task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'UREQ', text: 'add a confirm dialog', eventTs: '1.1' } },
    config: { botUserId: 'UBOT' },
    repoPath: '/ws/newton-web/1-1',
    threadContext: '',
    previousSteps: [],
    pipelineConfig,
  } as unknown as AgentContext;
  const ok = (parsedJson: Record<string, unknown>) =>
    ({ ok: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '', parsedJson }) as any;
  let now = 0;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(runCodex).mockReset();
  });

  it('says the latest changes were not reviewed again', async () => {
    const posted: string[] = [];
    const slack = {
      chat: {
        postMessage: vi.fn(async (args: any) => {
          posted.push(args.text);
          return { ts: '9.9' };
        }),
        // The progress line is edited in place (issue #600): the final text lands here.
        update: vi.fn(async (args: any) => {
          posted.push(args.text);
          return { ok: true };
        }),
      },
    } as any;
    vi.mocked(runCodex)
      .mockImplementationOnce(async () => {
        now += 30 * 60_000;
        return ok({ status: 'done', summary: 'Added the dialog.', prUrl: PR });
      })
      .mockImplementationOnce(async () => {
        now += 5 * 60_000;
        return ok({ approved: false, findings: [{ severity: 'high', category: 'c', message: 'No Escape handling.' }] });
      })
      .mockImplementationOnce(async () => {
        now += 11 * 60_000;
        return ok({ status: 'done', summary: 'Handled Escape.', prUrl: '' });
      });

    const run = await runAgentPipeline({ ctx, slack, logStep: vi.fn() });

    expect(run.finalStatus).toBe('aborted');
    expect(run.budgetExhausted).toMatchObject({ limitMs: 45 * 60_000, lastCoderPassUnreviewed: true });
    expect(runCodex).toHaveBeenCalledTimes(3);
    expect(posted).toContain(
      "Stopped after 46 min: this run's time limit ran out before the latest changes were reviewed again.",
    );
    expect(posted.some(text => text.includes('see the summary below'))).toBe(false);
  });
});

describe('the reviewer and the verifier hold a change to the same line', () => {
  const ctx = {
    workflowIntent: 'IMPLEMENTATION',
    task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'U', text: 'x', eventTs: '1.1' } },
    config: { botUserId: 'UBOT' },
    repoPath: '/ws/r',
    threadContext: '',
    previousSteps: [],
    pipelineConfig: { agents: ['coder', 'reviewer', 'verifier'] },
  } as unknown as AgentContext;

  it('approves only with nothing medium or worse open, and rejects only for that', () => {
    expect(buildReviewerPrompt(ctx)).toContain('Set "approved": false when any finding is "medium" or higher');
    const verifier = buildVerifierPrompt(ctx);
    expect(verifier).toContain('findings of severity "medium" or higher were addressed');
    expect(verifier).toContain('never a reason to set "verified": false');
    // A PR is opened after the checks pass; its absence is not a failure (job feaff117).
    expect(verifier).toContain('No PR yet is not a reason to reject');
  });
});

describe('the failure doctor on a change run that did not pass', () => {
  it('names a verifier rejection, not a timeout read off the logged config', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'The final check did not pass.',
      logs: [
        {
          stage: 'pipeline.start',
          message: 'Starting',
          level: 'INFO',
          data: { totalTimeoutMs: 2_700_000, perAgentTimeoutMs: 600_000 },
        },
        {
          stage: 'pipeline.agent.verifier.finish',
          message: 'verifier agent finished: failed (1000ms, 2 findings).',
          level: 'WARN',
        },
      ],
    } as any);

    expect(diagnosis?.errorKind).toBe('VERIFIER_REJECTED');
  });

  it('does not call a run a timeout because its config mentions one', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'something else went wrong',
      logs: [{ stage: 'pipeline.start', message: 'Starting', level: 'INFO', data: { totalTimeoutMs: 2_700_000 } }],
    } as any);

    expect(diagnosis?.errorKind).not.toBe('WORKFLOW_TIMEOUT');
    expect(diagnoseFailure({ workflow: 'X', message: 'Request timed out after 30s', logs: [] } as any)?.errorKind).toBe(
      'WORKFLOW_TIMEOUT',
    );
  });
});
