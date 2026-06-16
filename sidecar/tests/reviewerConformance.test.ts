/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { buildReviewerPrompt, buildVerifierPrompt } from '../src/agents/prompts.js';
import type { AgentContext, AgentStepResult } from '../src/agents/types.js';
import type { NormalizedTask } from '../src/types/contracts.js';

// #388 (part 2): reviewer/verifier must judge the ACTUAL diff against the approved
// plan and flag a mismatch as a blocking finding.

const task: NormalizedTask = {
  event: {
    eventId: 'Ev388b',
    channelId: 'C1',
    threadTs: '111.22',
    eventTs: '111.22',
    userId: 'U123',
    text: '<@UBOT1> end the experiment',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
};

const PLAN =
  '## Plan\n- Remove the WelcomeMobileExperienceV1 A/B experiment entirely\n- Delete the legacy control flow';

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  const plannerStep: AgentStepResult = {
    role: 'planner',
    status: 'passed',
    output: { planMarkdown: PLAN, scope: 'medium', affectedFiles: ['src/WelcomeStep/index.js'] },
    findings: [],
    durationMs: 1,
  };
  const coderStep: AgentStepResult = {
    role: 'coder',
    status: 'passed',
    output: { summary: 'Changed cohort ratio from 50/50 to 0/100', filesChanged: ['src/WelcomeStep/constants.js'] },
    findings: [],
    durationMs: 1,
  };
  return {
    workflowIntent: 'IMPLEMENTATION',
    task,
    config: {} as any,
    repoPath: '/tmp/worktree',
    threadContext: 'thread',
    previousSteps: [plannerStep, coderStep],
    pipelineConfig: {} as any,
    coderDiff: { diff: '--- a/constants.js\n+++ b/constants.js\n-control: 50\n+control: 0', truncated: false },
    ...overrides,
  };
}

describe('reviewer/verifier plan conformance (#388)', () => {
  it('reviewer prompt surfaces the approved plan, the real diff, and a blocking conformance gate', () => {
    const p = buildReviewerPrompt(ctx());
    expect(p).toContain('Remove the WelcomeMobileExperienceV1 A/B experiment entirely'); // readable plan
    expect(p).toContain('Approved plan');
    expect(p).toContain('control: 0'); // actual diff injected
    expect(p).toContain('PLAN CONFORMANCE');
    expect(p).toContain('plan-mismatch');
    expect(p).toContain('"approved": false');
    // It must tell the reviewer NOT to trust the coder's self-report over the diff.
    expect(p.toLowerCase()).toContain('not the coder');
  });

  it('verifier prompt surfaces the plan, the diff, and a blocking conformance check', () => {
    const p = buildVerifierPrompt(ctx());
    expect(p).toContain('Remove the WelcomeMobileExperienceV1 A/B experiment entirely');
    expect(p).toContain('control: 0');
    expect(p).toContain('PLAN CONFORMANCE');
    expect(p).toContain('"requirementsMet": false');
    expect(p).toContain('plan-mismatch');
  });

  it('falls back to a git-diff instruction when no diff was captured', () => {
    const p = buildReviewerPrompt(ctx({ coderDiff: undefined }));
    expect(p).toContain('not captured');
    expect(p).toContain('git diff');
  });

  it('truncated diffs are flagged so the agent inspects the full change', () => {
    const p = buildReviewerPrompt(ctx({ coderDiff: { diff: 'partial diff', truncated: true } }));
    expect(p).toContain('diff truncated');
  });
});
