import { describe, expect, it } from 'vitest';
import { buildCoderPrompt, buildPlannerPlanModePrompt, buildReviewerPrompt } from '../src/agents/prompts.js';
import type { AgentContext } from '../src/agents/types.js';

// Issue #596: the coder was told to delete tests on small/medium scope while
// the plan listed them and the reviewer enforced the plan. Reviewers rejected
// the change for the missing test three times, and one run timed out.
const ctx = {
  workflowIntent: 'IMPLEMENTATION',
  task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'U1', text: 'fix the subject filter', eventTs: '1.1' } },
  config: { botUserId: 'UBOT' },
  repoPath: '/ws/newton-web/1-1',
  threadContext: '',
  previousSteps: [],
  pipelineConfig: { agents: ['planner', 'coder', 'reviewer', 'verifier'] },
} as unknown as AgentContext;

describe('the plan decides which tests a change carries', () => {
  it('tells the coder to commit the tests the plan lists, and no others', () => {
    const coder = buildCoderPrompt(ctx);
    expect(coder).toContain('Write the tests the approved plan lists, run them, and commit them with the change');
    expect(coder).toContain('Do not add test files the plan does not list');
    expect(coder).not.toMatch(/do NOT include test files/i);
    expect(coder).not.toMatch(/Delete or git-restore any test files/);
  });

  it('tells the planner to plan tests only where there is logic to guard, and not to tie them to scope', () => {
    const planner = buildPlannerPlanModePrompt(ctx);
    expect(planner).toContain('plan a test only when the change has logic worth guarding');
    expect(planner).not.toContain('decide whether to include tests');
  });

  it('holds the reviewer to the tests the plan lists', () => {
    expect(buildReviewerPrompt(ctx)).toContain('Are the tests the approved plan lists present and meaningful?');
  });
});
