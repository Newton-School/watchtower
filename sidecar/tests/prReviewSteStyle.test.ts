import { describe, expect, it } from 'vitest';
import { buildAgenticPrReviewPrompt, buildLensPrompt } from '../src/agentic/prReviewAgent.js';
import { buildOrchestratorPrompt } from '../src/agentic/prReviewOrchestrator.js';
import {
  CONVERSATIONAL_SYSTEM_PROMPT,
  informationalSystemPrompt,
  qaSystemPrompt,
} from '../src/agentic/agenticEntry.js';
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

function reviewPrompts(): Array<[string, string]> {
  return [
    ['single-agent', buildAgenticPrReviewPrompt(base)],
    ['lens', buildLensPrompt({ ...base, lens: 'security' })],
    ['orchestrator', buildOrchestratorPrompt({ ...base, skills: [], backendId: 'claude-code', forceDiffOnly: true })],
  ];
}

describe('PR review prompts use ASD-STE100 for comment text', () => {
  it.each(reviewPrompts())('%s prompt includes the STE review rule after the JSON output rule', (_name, prompt) => {
    expect(prompt).toContain(STE_REVIEW_TEXT_RULE);
    expect(prompt.indexOf(STE_REVIEW_TEXT_RULE)).toBeGreaterThan(prompt.indexOf(JSON_RULE));
  });

  it('review rule leaves out the reply-only layout rules', () => {
    expect(STE_REVIEW_TEXT_RULE).not.toContain('Lead with the answer');
    expect(STE_REVIEW_TEXT_RULE).not.toContain('Use bullet lists');
    expect(STE_REVIEW_TEXT_RULE).toContain('Never copy secrets');
  });
});

describe('agentic Slack prompts use ASD-STE100', () => {
  const config = { repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' } } as AppConfig;

  it.each([
    ['informational', informationalSystemPrompt(config)],
    ['conversational', CONVERSATIONAL_SYSTEM_PROMPT],
    ['web-QA', qaSystemPrompt('http://localhost:3123')],
  ])('%s prompt includes the STE reply block', (_name, prompt) => {
    expect(prompt).toContain(STE_REPLY_STYLE_BLOCK);
  });

  it('reply block redacts secrets in error text', () => {
    expect(STE_REPLY_STYLE_BLOCK).toContain('[redacted]');
  });
});
