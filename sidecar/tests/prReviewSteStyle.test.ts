import { describe, expect, it } from 'vitest';
import { buildAgenticPrReviewPrompt, buildLensPrompt } from '../src/agentic/prReviewAgent.js';
import { buildOrchestratorPrompt } from '../src/agentic/prReviewOrchestrator.js';
import { conversationalSystemPrompt, informationalSystemPrompt, qaSystemPrompt } from '../src/agentic/agenticEntry.js';
import { STE_REPLY_STYLE_BLOCK, STE_REVIEW_TEXT_RULE } from '../src/codex/replyStyle.js';
import type { AppConfig } from '../src/types/contracts.js';

const base = {
  recallBlock: '',
  prContext: { url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
  prMeta: { title: 'Fix bug' },
  policyBlock: 'policy',
  threadContext: 'thread',
  diff: '+const a = 1;',
} satisfies Parameters<typeof buildAgenticPrReviewPrompt>[0];

const JSON_RULE = '- Your final message must be ONLY this JSON object';

const PRIOR_BLOCK = 'PRIOR REVIEW — "message" starting "Still open: " or "Regressed: ".';

function reviewPrompts(): Array<[string, string]> {
  return [
    ['single-agent', buildAgenticPrReviewPrompt(base)],
    ['follow-up single-agent', buildAgenticPrReviewPrompt({ ...base, priorReviewBlock: PRIOR_BLOCK })],
    ['lens', buildLensPrompt({ ...base, lens: 'security' })],
    ['orchestrator', buildOrchestratorPrompt({ ...base, skills: [], backendId: 'claude-code', forceDiffOnly: true })],
  ];
}

describe('PR review prompts use ASD-STE100 for comment text', () => {
  it.each(reviewPrompts())('%s prompt includes the STE review rule after the JSON output rule', (_name, prompt) => {
    const jsonIndex = prompt.indexOf(JSON_RULE);
    expect(jsonIndex).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf(STE_REVIEW_TEXT_RULE)).toBeGreaterThan(jsonIndex);
  });

  it.each(reviewPrompts())('%s prompt has no reply-only layout rules and redacts secrets', (_name, prompt) => {
    expect(prompt).not.toContain('Lead with the answer');
    expect(prompt).not.toContain('Use bullet lists');
    expect(prompt).toContain('[redacted]');
  });

  it.each(reviewPrompts())('%s prompt keeps suggestions on one line without code fences', (_name, prompt) => {
    expect(prompt).toContain('Write each "suggestion" on one line.');
    expect(prompt).toContain('Do not use code fences or line breaks.');
  });

  it('follow-up review keeps the prefixes that reReview matches', () => {
    const prompt = buildAgenticPrReviewPrompt({ ...base, priorReviewBlock: PRIOR_BLOCK });
    expect(prompt).toContain(PRIOR_BLOCK);
    for (const prefix of ['"Still open: "', '"Regressed: "', '"Addressed since last review: "']) {
      expect(prompt).toContain(prefix);
    }
    expect(prompt).toContain('keep that prefix exactly');
  });
});

describe('agentic Slack prompts use ASD-STE100', () => {
  const config = { repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' } } as AppConfig;

  it.each([
    ['informational', informationalSystemPrompt(config)],
    ['conversational', conversationalSystemPrompt()],
    ['web-QA', qaSystemPrompt('http://localhost:3123')],
  ])('%s prompt includes the STE reply block', (_name, prompt) => {
    expect(prompt).toContain(STE_REPLY_STYLE_BLOCK);
  });

  it('informational prompt redacts secrets but keeps file paths', () => {
    const prompt = informationalSystemPrompt(config);
    expect(prompt).toContain('[redacted]');
    expect(prompt).toContain('Never change a file path.');
  });

  it('informational prompt never lets a lookup start a deploy or a workflow', () => {
    expect(informationalSystemPrompt(config)).toContain(
      'Never trigger a deploy or a GitHub Actions workflow, staging or production, and never push, merge or edit anything in a repo or an outside system.',
    );
  });
});
