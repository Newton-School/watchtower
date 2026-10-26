/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { stampApprovedPlan } from '../src/workflows/implementationWorkflow.js';
import { normalizePlannerOutput } from '../src/agents/normalizePlannerOutput.js';
import { buildCoderPrompt, buildVerifierPrompt } from '../src/agents/prompts.js';
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

  // Regression for the plannerBackend threading fix: on claude-code the revision
  // schema is unenforced, so the planner returns prose wrapped as
  // {status, summary, actions, prUrl}. Normalizing that with 'codex' (the old
  // hardcode at the revision site) yields an EMPTY planMarkdown — the workflow
  // then silently kept the stale pre-feedback plan. Normalizing with the real
  // backend recovers the revised plan.
  it('claude-code prose revision replaces the plan when normalized with the real backend', () => {
    const proseRevision = {
      status: 'success',
      summary: `## Revised plan\n- ${REVISED_STEPS[0]} in \`src/containers/WelcomeStep/index.js\`\n- ${REVISED_STEPS[1]}\n\nScope: small\nRequires code changes: yes`,
      actions: [],
      prUrl: '',
    };

    // The bug: codex normalization of a claude-code envelope loses everything.
    const wrongBackend = normalizePlannerOutput(proseRevision, 'codex');
    expect(wrongBackend.planMarkdown).toBe('');
    expect(wrongBackend.affectedFiles).toEqual([]);

    // The fix: claude-code normalization recovers the revised plan.
    const normalized = normalizePlannerOutput(proseRevision, 'claude-code');
    expect(normalized.planMarkdown).toContain(REVISED_STEPS[0]);
    expect(normalized.scope).toBe('small');
    expect(normalized.affectedFiles).toContain('src/containers/WelcomeStep/index.js');

    const raw: Record<string, unknown> = { ...proseRevision };
    stampApprovedPlan(raw, {
      planMarkdown: normalized.planMarkdown,
      scope: normalized.scope,
      affectedFiles: normalized.affectedFiles,
    });
    const prompt = buildCoderPrompt(makeCoderCtx(raw));
    expect(prompt).not.toContain('No plan markdown available.');
    expect(prompt).toContain(REVISED_STEPS[1]);
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

// Issue #730: a follow-up adds a commit to the thread's open PR.
describe('the coder on a follow-up', () => {
  const PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1484';
  const ctx = (followUp?: { prUrl: string; branch: string }): AgentContext => ({
    ...makeCoderCtx({ planMarkdown: '## Plan\n- change the footer' }),
    requestedBy: 'Raj',
    followUp,
  });

  it('works on the PR branch and only commits: no new branch, no PR, no push before the checks', () => {
    const prompt = buildCoderPrompt(ctx({ prUrl: PR, branch: 'raj/hero-copy-1-1' }));
    expect(prompt).toContain(`You are already on the branch of the open pull request ${PR} (\`raj/hero-copy-1-1\`)`);
    expect(prompt).toContain('do NOT create a new branch and do NOT open a new pull request');
    expect(prompt).toContain('Do NOT push');
    expect(prompt).toContain('miniOG pushes them to the pull request once they pass');
    // The summaries are read after the push, so they must not say it is still to come (live test, 26 Oct).
    expect(prompt).toContain("don't mention pushing or say the change still has to reach the pull request");
    expect(prompt).toContain('Never amend, rebase, reset or squash');
    expect(prompt).not.toContain('git push origin');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).not.toContain('Create a NEW branch');
  });

  it('tells the final check the commits are not on the PR yet', () => {
    const verifier = buildVerifierPrompt(ctx({ prUrl: PR, branch: 'raj/hero-copy-1-1' }));
    expect(verifier).toContain(`new commits for the open pull request ${PR}, not pushed yet`);
    expect(buildVerifierPrompt(ctx())).toContain('No PR yet is not a reason to reject');
  });

  it('opens a new PR as before when it is not a follow-up', () => {
    const prompt = buildCoderPrompt(ctx());
    expect(prompt).toContain('Create a NEW branch named raj/<short-task-name>-111-22');
    expect(prompt).toContain('gh pr create --head <branch>');
    expect(prompt).toContain('Prefix the PR title with [Raj via miniOG]');
  });
});
