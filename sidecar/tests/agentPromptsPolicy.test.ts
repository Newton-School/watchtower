import { describe, expect, it } from 'vitest';
import {
  CLAUDE_DIR_WRITE_RULE,
  PROCESS_HYGIENE_RULE,
  buildCoderPrompt,
  buildPromptForRole,
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

describe('process rule on every agent prompt (issue #445)', () => {
  it.each(['planner', 'coder', 'reviewer', 'security', 'performance', 'verifier'] as const)(
    'tells the %s to stop only what it started, by PID, and never by name',
    role => {
      expect(buildPromptForRole(role, makeCtx())).toContain(PROCESS_HYGIENE_RULE);
    },
  );

  it('names the commands that killed other jobs, and says they are blocked', () => {
    expect(PROCESS_HYGIENE_RULE).toContain('`pkill`');
    expect(PROCESS_HYGIENE_RULE).toContain('`killall`');
    expect(PROCESS_HYGIENE_RULE).toContain('only by PID');
    expect(PROCESS_HYGIENE_RULE).toContain('are blocked');
  });

  it('keeps the repo policy pack beside it', () => {
    const prompt = buildCoderPrompt(makeCtx(MARKETING_PACK));
    expect(prompt).toContain('Active policy pack: repo:newton-marketing-web');
    expect(prompt).toContain(PROCESS_HYGIENE_RULE);
  });
});

describe('plan-mode planner prompt asks for a plan an approver can read (issue #437)', () => {
  const prompt = buildPlannerPlanModePrompt(makeCtx());

  it('asks for the approver block first, with its five lines', () => {
    for (const line of [
      '## For the approver',
      '- What changes:',
      '- Where:',
      '- Behaviour change:',
      '- Assumptions to confirm:',
      '- Risk:',
    ]) {
      expect(prompt).toContain(line);
    }
    expect(prompt.indexOf('## For the approver')).toBeLessThan(prompt.indexOf("A short summary of the user's intent."));
  });

  it('says what counts as a behaviour change, in the terms of the change that went wrong', () => {
    expect(prompt).toContain('A changed default, limit, condition or rule is a behaviour change');
    expect(prompt).toContain('say what the new value means for a real user');
  });

  it('asks for the files it will edit under their own heading, and nothing else there', () => {
    expect(prompt).toContain('A section headed exactly `## Files to change`');
    expect(prompt).toContain('ONLY files this change edits');
  });
});

describe('the coder writes for two readers (issue #601)', () => {
  it('asks for a plain requester summary beside the engineering one', () => {
    const prompt = buildPromptForRole('coder', {
      workflowIntent: 'IMPLEMENTATION',
      task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'U1', text: 'change the copy', eventTs: '1.1' } },
      config: {},
      repoPath: '/ws/repo',
      threadContext: '',
      previousSteps: [],
      pipelineConfig: { agents: ['coder'] },
    } as unknown as AgentContext);
    expect(prompt).toContain('"requesterSummary": string');
    expect(prompt).toContain('process ids, tooling, lint, git, dependency or sandbox details in it.');
  });
});

// Issue #609: shell commands can't write a repo's skill ledger under `.claude/skills/`.
describe('writing under .claude in a change run', () => {
  it('tells the coder to save files under .claude with the Write or Edit tool, and what stays off limits', () => {
    const prompt = buildCoderPrompt(makeCtx());
    expect(prompt).toContain(`Files: ${CLAUDE_DIR_WRITE_RULE}`);
    expect(CLAUDE_DIR_WRITE_RULE).toContain('use the Write or Edit tool');
    expect(CLAUDE_DIR_WRITE_RULE).toContain('/tmp');
    expect(CLAUDE_DIR_WRITE_RULE).toContain("settings files and `.claude/hooks/` can't be changed at all");
  });

  it('leaves it out of the agents that do not write', () => {
    expect(buildVerifierPrompt(makeCtx())).not.toContain(CLAUDE_DIR_WRITE_RULE);
    expect(buildPlannerPrompt(makeCtx())).not.toContain(CLAUDE_DIR_WRITE_RULE);
  });
});
