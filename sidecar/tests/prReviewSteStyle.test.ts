import { describe, expect, it } from 'vitest';
import { buildAgenticPrReviewPrompt, buildLensPrompt } from '../src/agentic/prReviewAgent.js';
import { buildOrchestratorPrompt } from '../src/agentic/prReviewOrchestrator.js';
import { STE_REVIEW_TEXT_RULE } from '../src/codex/replyStyle.js';

const base = {
  recallBlock: '',
  prContext: { url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
  prMeta: { title: 'Fix bug' },
  policyBlock: 'policy',
  threadContext: 'thread',
  diff: '+const a = 1;',
};

describe('PR review prompts use ASD-STE100 for comment text', () => {
  it('single-agent prompt includes the STE review rule', () => {
    expect(buildAgenticPrReviewPrompt(base)).toContain(STE_REVIEW_TEXT_RULE);
  });

  it('lens prompt includes the STE review rule', () => {
    expect(buildLensPrompt({ ...base, lens: 'security' })).toContain(STE_REVIEW_TEXT_RULE);
  });

  it('orchestrator prompt includes the STE review rule', () => {
    const prompt = buildOrchestratorPrompt({ ...base, skills: [], backendId: 'claude-code', forceDiffOnly: true });
    expect(prompt).toContain(STE_REVIEW_TEXT_RULE);
  });
});
