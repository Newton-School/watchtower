/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatExternalChanges,
  formatPlanMessage,
  parseExternalChanges,
  planListsOutsideChanges,
  planNeedsRequesterConfirmation,
  runAgentPipeline,
} from '../src/agents/pipeline.js';
import { parseApproverSummary } from '../src/agents/normalizePlannerOutput.js';
import { runCodex } from '../src/codex/runCodex.js';
import { checkCoderProducedChanges } from '../src/workspaces/gitState.js';
import type { AgentContext, PipelineConfig } from '../src/agents/types.js';

vi.mock('../src/codex/runCodex.js', () => ({ runCodex: vi.fn(), getActiveBackendId: vi.fn(() => 'claude-code') }));
vi.mock('../src/workspaces/gitState.js', () => ({
  currentHead: vi.fn().mockResolvedValue('deadbeef'),
  checkCoderProducedChanges: vi.fn(),
  getDiffVsBase: vi.fn().mockResolvedValue(''),
}));

// Issue #432: a fix made in seven Metabase cards was failed as "a hallucinated
// response" because the repository showed no diff, and the thread was told
// nothing had been touched.
const block = (outside: string) =>
  [
    '# Add the three diagrams to question 1042',
    '',
    '## For the approver',
    '- What changes: Question 1042 shows the three diagrams from the thread.',
    '- Where: question 1042',
    '- Behaviour change: none',
    '- Assumptions to confirm: none',
    `- Outside the repo: ${outside}`,
    '- Risk: low',
    '',
    '## Steps',
    '1. Upload the three images through Newton admin.',
  ].join('\n');
const UPLOAD = 'uploads 3 images to question 1042 through Newton admin';

describe('the plan names changes outside the repo', () => {
  it('reads the line, and shows it to the approver with a warning', () => {
    expect(parseApproverSummary(block(UPLOAD))?.outsideRepo).toBe(UPLOAD);
    expect(parseApproverSummary(block('none'))?.outsideRepo).toBe('none');

    const message = formatPlanMessage(block(UPLOAD), [], 'small', undefined, false, 'UREQ');
    expect(message).toContain(`*Outside the repo:* :warning: ${UPLOAD}`);
    expect(message).toContain(
      '<@UREQ> before I start, please confirm the changes outside the repo above are what you want',
    );
    expect(formatPlanMessage(block('none'), [], 'small')).not.toContain('Outside the repo');
  });

  it('counts as something the requester confirms, and as listed for the coder', () => {
    expect(planNeedsRequesterConfirmation(block(UPLOAD))).toBe(true);
    expect(planListsOutsideChanges(block(UPLOAD))).toBe(true);
    expect(planListsOutsideChanges(block('none'))).toBe(false);
    expect(planListsOutsideChanges('# no block')).toBe(false);
  });
});

describe("the coder's account of changes outside the repo", () => {
  it('keeps the entries that say what changed', () => {
    expect(
      parseExternalChanges({
        externalChanges: [
          {
            system: 'Newton admin',
            target: 'question 1042',
            description: 'uploaded 3 images',
            verification: 'page shows them',
          },
          { system: 'Figma' },
          'nonsense',
        ],
      }),
    ).toEqual([
      {
        system: 'Newton admin',
        target: 'question 1042',
        description: 'uploaded 3 images',
        verification: 'page shows them',
      },
    ]);
    expect(parseExternalChanges({})).toEqual([]);
  });

  it('lists them for the thread, saying when one was not checked or not in the plan', () => {
    const text = formatExternalChanges(
      [
        {
          system: 'Newton admin',
          target: 'question 1042',
          description: 'uploaded 3 images',
          verification: 'the page shows them',
        },
        { system: 'Figma', target: 'Home v2', description: 'renamed a frame', verification: '' },
      ],
      true,
    );

    expect(text).toBe(
      [
        '*Changed outside the repo:*',
        '• *Newton admin, question 1042:* uploaded 3 images Checked: the page shows them',
        '• *Figma, Home v2:* renamed a frame Not checked.',
        ':warning: The approved plan did not list changes outside the repo.',
      ].join('\n'),
    );
  });
});

describe('a run whose whole change is outside the repo', () => {
  const pipelineConfig: PipelineConfig = {
    agents: ['coder', 'reviewer', 'verifier'],
    maxRetryLoops: 1,
    totalTimeoutMs: 600_000,
    perAgentTimeoutMs: 300_000,
    abortOnCriticalFinding: false,
    slackProgressUpdates: false,
  } as PipelineConfig;
  const ctxWith = (planMarkdown: string): AgentContext =>
    ({
      workflowIntent: 'IMPLEMENTATION',
      task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'UREQ', text: 'add the diagrams', eventTs: '1.1' } },
      config: { botUserId: 'UBOT' },
      repoPath: '/ws/newton-api/1-1',
      threadContext: '',
      previousSteps: [{ role: 'planner', status: 'passed', output: { planMarkdown }, findings: [], durationMs: 1 }],
      pipelineConfig,
    }) as unknown as AgentContext;
  const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '9.9' }), update: vi.fn() } } as any;
  const coderSaid = (externalChanges: unknown[]) =>
    vi.mocked(runCodex).mockResolvedValueOnce({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        status: 'done',
        summary: 'Uploaded the three diagrams to question 1042.',
        prUrl: '',
        externalChanges,
      },
    } as any);
  const UPLOADED = [
    {
      system: 'Newton admin',
      target: 'question 1042',
      description: 'uploaded 3 images',
      verification: 'the page shows them',
    },
  ];

  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(checkCoderProducedChanges)
      .mockReset()
      .mockResolvedValue({
        producedChanges: false,
        filesChanged: [],
        newCommits: 0,
        hasUncommitted: false,
        headMoved: false,
      } as any);
  });

  it('passes, with nothing to review and no question back, when the coder says what it changed', async () => {
    coderSaid(UPLOADED);

    const result = await runAgentPipeline({ ctx: ctxWith(block(UPLOAD)), slack, logStep: vi.fn() });

    expect(result.finalStatus).toBe('passed');
    expect(result.externalOnly).toBe(true);
    expect(result.externalChanges).toEqual(UPLOADED);
    expect(result.externalNotInPlan).toBe(false);
    expect(result.needsInputQuestion).toBeUndefined();
    // The reviewer and verifier read diffs: there is none.
    expect(result.steps.map(step => step.role)).toEqual(['coder']);
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('says so when the approved plan did not list the change', async () => {
    coderSaid(UPLOADED);

    const result = await runAgentPipeline({ ctx: ctxWith(block('none')), slack, logStep: vi.fn() });

    expect(result.finalStatus).toBe('passed');
    expect(result.externalNotInPlan).toBe(true);
  });

  it('still asks back when the repository is clean and the coder names nothing outside it', async () => {
    coderSaid([]);

    const result = await runAgentPipeline({ ctx: ctxWith(block('none')), slack, logStep: vi.fn() });

    expect(result.finalStatus).toBe('needs-input');
    expect(result.externalOnly).toBeUndefined();
    expect(result.needsInputQuestion).toContain('nothing changed in the repository');
  });
});
