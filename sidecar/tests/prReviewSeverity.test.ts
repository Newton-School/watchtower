import { describe, expect, it } from 'vitest';
import {
  SEVERITY_RUBRIC,
  VERIFIER_PROMPT_MARKER,
  buildAgenticPrReviewPrompt,
  buildLensPrompt,
  buildPrReviewVerifierPrompt,
  readSeverityChange,
} from '../src/agentic/prReviewAgent.js';
import { buildOrchestratorPrompt } from '../src/agentic/prReviewOrchestrator.js';

const base = {
  recallBlock: '',
  prContext: { url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
  prMeta: { title: 'Fix bug' },
  policyBlock: 'policy',
  threadContext: 'thread',
  diff: '+const a = 1;',
} satisfies Parameters<typeof buildAgenticPrReviewPrompt>[0];

const finding = {
  lens: 'reviewer' as const,
  role: 'reviewer' as const,
  severity: 'medium' as const,
  category: 'edge-case',
  message: 'ratio returns NaN when total is 0',
  file: 'src/a.ts',
  line: 2,
};

describe('the severity rubric (5.5 calibration)', () => {
  it('draws the medium/low line at behaviour a user or caller can notice', () => {
    expect(SEVERITY_RUBRIC).toContain('narrowness keeps it below high, it does not make it low');
    expect(SEVERITY_RUBRIC).toContain('A missing test for new branching logic is medium');
    expect(SEVERITY_RUBRIC).toContain('is never low');
    // The old low example contradicted that line: an off-by-one is a real bug.
    expect(SEVERITY_RUBRIC).not.toContain('off-by-one');
  });

  it.each([
    ['one-shot', buildAgenticPrReviewPrompt(base)],
    ['lens', buildLensPrompt({ ...base, lens: 'security' })],
    ['orchestrator', buildOrchestratorPrompt({ ...base, skills: [], backendId: 'claude-code', forceDiffOnly: true })],
    ['verifier', buildPrReviewVerifierPrompt({ finding, diff: base.diff, oneShot: true })],
    ['adjudicator', buildPrReviewVerifierPrompt({ finding, diff: base.diff, oneShot: false, tier: 'adjudicator' })],
  ])('reaches the %s prompt', (_name, prompt) => {
    expect(prompt).toContain(SEVERITY_RUBRIC);
  });
});

describe('the verifier prompt', () => {
  const prompt = buildPrReviewVerifierPrompt({ finding, diff: base.diff, oneShot: true });

  it('is still routed by its marker', () => {
    expect(prompt).toContain(VERIFIER_PROMPT_MARKER);
  });

  it('names the only bases that take a finding below medium', () => {
    expect(prompt).toContain('"no-behaviour-change"');
    expect(prompt).toContain('"not-shipped"');
    expect(prompt).toContain('Any other lowering of a medium-or-above finding stops at medium.');
    expect(prompt).toContain('"severityBasis"?: "no-behaviour-change"|"not-shipped"|"smaller-impact"');
  });

  it('says that narrow, uncommon or untested is a medium, not a reason to go lower', () => {
    expect(prompt).toContain(
      '"Real but narrow", "an uncommon setup", "nice to have" and "the module has no other tests"',
    );
  });
});

describe('readSeverityChange', () => {
  it.each([
    // [from, verdict, applied]
    ['medium', { severity: 'low' }, 'medium'],
    ['medium', { severity: 'low', severityBasis: 'smaller-impact' }, 'medium'],
    ['medium', { severity: 'info', severityBasis: 'made-up' }, 'medium'],
    ['medium', { severity: 'low', severityBasis: 'no-behaviour-change' }, 'low'],
    ['medium', { severity: 'info', severityBasis: 'not-shipped' }, 'info'],
    ['high', { severity: 'low', severityBasis: 'smaller-impact' }, 'medium'],
    ['high', { severity: 'medium', severityBasis: 'smaller-impact' }, 'medium'],
    ['high', { severity: 'medium' }, 'medium'],
    ['critical', { severity: 'high' }, 'high'],
    ['critical', { severity: 'low', severityBasis: 'not-shipped' }, 'low'],
  ] as const)('%s lowered with %j becomes %s', (from, verdict, applied) => {
    expect(readSeverityChange(from, verdict)?.applied).toBe(applied);
  });

  it('keeps what the verifier proposed and why, for the log', () => {
    expect(
      readSeverityChange('medium', { severity: 'low', severityBasis: 'smaller-impact', reason: 'uncommon setup' }),
    ).toEqual({
      from: 'medium',
      proposed: 'low',
      applied: 'medium',
      basis: 'smaller-impact',
      reason: 'uncommon setup',
    });
  });

  it('leaves a finding already below medium to the verifier', () => {
    expect(readSeverityChange('low', { severity: 'info' })?.applied).toBe('info');
  });

  it('ignores an escalation, the same severity, and an unknown one', () => {
    expect(readSeverityChange('high', { severity: 'critical' })).toBeUndefined();
    expect(readSeverityChange('medium', { severity: 'medium' })).toBeUndefined();
    expect(readSeverityChange('medium', { severity: 'blocker' })).toBeUndefined();
    expect(readSeverityChange('medium', {})).toBeUndefined();
  });
});
