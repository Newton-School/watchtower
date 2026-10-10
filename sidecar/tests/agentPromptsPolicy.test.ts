import { describe, expect, it } from 'vitest';
import {
  buildCoderPrompt,
  buildVerifierPrompt,
  buildPlannerPrompt,
  buildPlannerPlanModePrompt,
} from '../src/agents/prompts.js';
import type { AgentContext } from '../src/agents/types.js';
import type { NormalizedTask } from '../src/types/contracts.js';

function makeCtx(policyPack?: { packName: string; rules: string[] }): AgentContext {
  const task: NormalizedTask = {
    event: {
      eventId: 'E1',
      channelId: 'C1',
      threadTs: '1.1',
      eventTs: '1.1',
      userId: 'U1',
      text: 'do the thing',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'IMPLEMENTATION',
  };
  return {
    workflowIntent: 'IMPLEMENTATION',
    task,
    config: {} as AgentContext['config'],
    repoPath: '/ws/newton-marketing-web/1-1',
    threadContext: 'thread',
    previousSteps: [],
    pipelineConfig: {
      agents: ['coder'],
      maxRetryLoops: 1,
      abortOnCriticalFinding: true,
      slackProgressUpdates: false,
      requireApproval: false,
    },
    policyPack,
  } as AgentContext;
}

const MARKETING_PACK = {
  packName: 'repo:newton-marketing-web',
  rules: [
    'These repo rules OVERRIDE any prior habits or recalled conventions from other repos.',
    'Never edit `worker/**` or `.github/workflows/**`.',
    'This repo has NO test suite — verification is typecheck + lint + build.',
  ],
};

describe('repo policy pack rendering (#repo-guardrails)', () => {
  it('renders the policy pack in the CODER prompt — previously the coder saw no policy at all', () => {
    const prompt = buildCoderPrompt(makeCtx(MARKETING_PACK));
    expect(prompt).toContain('repo:newton-marketing-web');
    expect(prompt).toContain('worker/**');
    expect(prompt).toContain('OVERRIDE any prior habits');
  });

  it('renders the policy pack in the VERIFIER prompt so conformance is judged with the same rules', () => {
    const prompt = buildVerifierPrompt(makeCtx(MARKETING_PACK));
    expect(prompt).toContain('repo:newton-marketing-web');
    expect(prompt).toContain('NO test suite');
  });

  it('keeps the planner rendering unchanged and degrades cleanly without a pack', () => {
    expect(buildPlannerPrompt(makeCtx(MARKETING_PACK))).toContain('repo:newton-marketing-web');
    expect(buildCoderPrompt(makeCtx())).toContain('No explicit policy pack assigned.');
  });
});

describe('plan-mode planner delivery contract (#408)', () => {
  it('no longer depends on ExitPlanMode and demands the plan as the final message', () => {
    const prompt = buildPlannerPlanModePrompt(makeCtx());
    expect(prompt).not.toContain('ExitPlanMode');
    expect(prompt).toContain('FINAL message must be exactly the full plan markdown');
    expect(prompt).toContain('no notes about tools, plan files you wrote, or session mechanics');
    // The parse-critical tags survive the rewrite.
    expect(prompt).toContain('Scope: small');
    expect(prompt).toContain('Requires code changes: yes');
  });
});
