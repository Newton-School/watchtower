/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { stampApprovedPlan } from '../src/workflows/implementationWorkflow.js';
import { normalizePlannerOutput } from '../src/agents/normalizePlannerOutput.js';
import { buildCoderPrompt } from '../src/agents/prompts.js';
import type { AgentContext, AgentStepResult } from '../src/agents/types.js';
import type { NormalizedTask } from '../src/types/contracts.js';

// Regression for #388: a feedback-revised plan must reach the coder. The revision
// path produces raw codex JSON (`{ plan: string[] }`) with NO `planMarkdown` — the
// exact field buildCoderPrompt reads. Without stampApprovedPlan the coder gets
// "No plan markdown available." and falls back to the original request.

const REVISED_STEPS = [
  'Remove the WelcomeMobileExperienceV1 A/B experiment entirely',
  'Delete the legacy control-flow code and make the variant the default',
];

const task: NormalizedTask = {
  event: {
    eventId: 'Ev388',
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

function makeCoderCtx(plannerOutput: Record<string, unknown>): AgentContext {
  const plannerStep: AgentStepResult = {
    role: 'planner',
    status: 'passed',
    output: plannerOutput,
    findings: [],
    durationMs: 1,
  };
  return {
    workflowIntent: 'IMPLEMENTATION',
    task,
    config: {} as any,
    repoPath: '/tmp/worktree',
    threadContext: 'change the cohort ratio to 0/100',
    previousSteps: [plannerStep],
    pipelineConfig: {} as any,
  };
}

// The raw codex JSON shape the revision path puts on plannerOutput.
function rawRevisionOutput(): Record<string, unknown> {
  return {
    plan: [...REVISED_STEPS],
    affectedFiles: ['src/containers/WelcomeStep/index.js', 'src/containers/WelcomeStep/constants.js'],
    scope: 'medium',
    requiresCodeChanges: true,
  };
}

describe('revised plan handoff (#388)', () => {
  it('reproduces the bug: raw revision output gives the coder no plan', () => {
    const prompt = buildCoderPrompt(makeCoderCtx(rawRevisionOutput()));
    expect(prompt).toContain('No plan markdown available.');
    expect(prompt).not.toContain(REVISED_STEPS[0]);
  });

  it('stampApprovedPlan surfaces the revised plan so the coder receives it', () => {
    const raw = rawRevisionOutput();
    // Mirror the workflow: normalize the raw codex revision, then stamp the
    // approved values onto plannerOutput (what runImplementationWorkflow does).
    const normalized = normalizePlannerOutput(raw, 'codex');
    stampApprovedPlan(raw, {
      planMarkdown: normalized.planMarkdown,
      scope: normalized.scope,
      affectedFiles: normalized.affectedFiles,
    });

    const prompt = buildCoderPrompt(makeCoderCtx(raw));
    expect(prompt).not.toContain('No plan markdown available.');
    expect(prompt).toContain(REVISED_STEPS[0]);
    expect(prompt).toContain(REVISED_STEPS[1]);
    expect(prompt).toContain('Plan scope: medium');
  });

  it('stampApprovedPlan returns the same object with fields set', () => {
    const target: Record<string, unknown> = { plan: ['x'] };
    const result = stampApprovedPlan(target, {
      planMarkdown: '## Plan\n- do the thing',
      scope: 'small',
      affectedFiles: ['a.ts'],
    });
    expect(result).toBe(target);
    expect(target.planMarkdown).toBe('## Plan\n- do the thing');
    expect(target.scope).toBe('small');
    expect(target.affectedFiles).toEqual(['a.ts']);
  });
});
