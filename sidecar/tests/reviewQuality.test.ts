import { describe, expect, it, vi } from 'vitest';
import { extractUserFocus, withoutSlackAppFooter } from '../src/agentic/reviewFocus.js';
import { isSameFinding, messageOverlap, NEVER_POST_RULE } from '../src/agentic/prReviewAgent.js';
import {
  buildGithubReviewSummary,
  MAX_SUMMARY_NOTES,
  REVIEW_BODY_BUDGET_CHARS,
  type NormalizedPrReviewAgentOutput,
} from '../src/github/prReviewSupport.js';
import type { AgentFinding } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({ runCodex: vi.fn(), getActiveBackendId: () => 'claude-code' }));

// Issue #555, all seen in one review of a 28-line test PR (#524).
describe('the Slack app footer is not an instruction', () => {
  it('is removed from the text the review focus is read from', () => {
    expect(withoutSlackAppFooter('review <https://github.com/o/r/pull/1> *Sent using* <@UCLAUDE>')).toBe(
      'review <https://github.com/o/r/pull/1>',
    );
    expect(withoutSlackAppFooter('please check the migration')).toBe('please check the migration');
  });

  it('leaves no focus when the request was only "review <link>" sent through the app', async () => {
    const { focusBlock } = await extractUserFocus({
      triggerText: '<@UBOT> review <https://github.com/o/r/pull/524|github.com/o/r/pull/524>\n*Sent using* <@UCLAUDE>',
      threadTexts: [],
    });
    expect(focusBlock).toBe('');
  });

  it('keeps a real instruction, without the footer', async () => {
    const { focusBlock } = await extractUserFocus({
      triggerText:
        '<@UBOT> review <https://github.com/o/r/pull/1> and focus on the migration rollback *Sent using* <@UCLAUDE>',
      threadTexts: [],
    });
    expect(focusBlock).toContain('focus on the migration rollback');
    expect(focusBlock).not.toContain('Sent using');
  });
});

describe('one issue reported twice is posted once', () => {
  const at = (line: number, message: string, file = 'sidecar/scripts/scratch-review-target.mjs'): AgentFinding =>
    ({ severity: 'high', category: 'security', message, file, line }) as AgentFinding;
  // The two findings the review posted (shortened).
  const first =
    '`listBranch` concatenates the caller-supplied `name` straight into a shell command string passed to `execSync`. `execSync` runs its argument through `/bin/sh`, so any shell metacharacter in `name` executes';
  const second =
    '`listBranch()` concatenates the caller-supplied `name` directly into a shell command string passed to `execSync`. `execSync` runs its argument through `/bin/sh`, so any shell metacharacter in `name` is interpreted';

  it('merges two lenses describing the same problem at the same line in their own words', () => {
    expect(messageOverlap(first, second)).toBeGreaterThan(0.5);
    expect(isSameFinding(at(16, first), at(16, second))).toBe(true);
    expect(isSameFinding(at(16, first), at(17, second))).toBe(true);
  });

  it('keeps different problems apart: other lines, other files, other words, short messages', () => {
    expect(isSameFinding(at(16, first), at(19, second))).toBe(false);
    expect(isSameFinding(at(16, first), at(16, second, 'other.mjs'))).toBe(false);
    expect(
      isSameFinding(
        at(16, first),
        at(16, '`average` divides by `values.length` without checking for an empty array, so it returns NaN for []'),
      ),
    ).toBe(false);
    expect(isSameFinding(at(20, 'medium finding 20'), at(21, 'medium finding 21'))).toBe(false);
  });

  it('matches a finding with no line only on the same text', () => {
    const note = (message: string) => ({ severity: 'low', category: 'style', message }) as AgentFinding;
    expect(isSameFinding(note('Use const here'), note('use  const here'))).toBe(true);
    expect(isSameFinding(note(first), note(second))).toBe(false);
  });
});

describe('the review body stays readable', () => {
  const output = (overrides: Partial<NormalizedPrReviewAgentOutput>): NormalizedPrReviewAgentOutput => ({
    role: 'reviewer',
    findings: [],
    attachableFindings: [],
    unattachableFindings: [],
    summaryNotes: [],
    invalidFindings: 0,
    ...overrides,
  });

  it('tells the lenses to leave out notes that say nothing', () => {
    expect(NEVER_POST_RULE).toContain('at most two of your own');
    expect(NEVER_POST_RULE).toContain('Never a note that a check found nothing');
    expect(NEVER_POST_RULE).toContain('Addressed since last review');
  });

  it(`lists at most ${MAX_SUMMARY_NOTES} notes and says how many were left out`, () => {
    const notes = Array.from({ length: 12 }, (_, i) => `note ${i + 1}`);
    const body = buildGithubReviewSummary([output({ summaryNotes: notes })]);

    expect(body).toContain('note 5');
    expect(body).not.toContain('note 6');
    expect(body).toContain('…and 7 more note(s) left out.');
  });

  it('stops the lower-priority list at the budget, worst first, and says how many were left out', () => {
    const long = (i: number) =>
      ({
        severity: 'low',
        category: 'style',
        message: `low finding ${i}: ${'x'.repeat(400)}`,
        file: 'src/a.ts',
        line: i,
      }) as AgentFinding;
    const collapsed = Array.from({ length: 40 }, (_, i) => ({ role: 'reviewer', finding: long(i + 1) }));
    const plan = { toSubmit: [], collapsed, inlineCount: 0 };
    const findings = collapsed.map(item => item.finding);

    const body = buildGithubReviewSummary([output({ findings })], undefined, plan);

    expect(body.length).toBeLessThan(REVIEW_BODY_BUDGET_CHARS + 600);
    expect(body).toContain('low finding 1:');
    expect(body).not.toContain('low finding 40:');
    expect(body).toMatch(/…and \d+ more lower-priority finding\(s\) left out to keep this readable\./);
  });

  it('lists everything when it fits', () => {
    const plan = {
      toSubmit: [],
      collapsed: [
        {
          role: 'reviewer',
          finding: { severity: 'low', category: 'c', message: 'small', file: 'a.ts', line: 1 } as AgentFinding,
        },
      ],
      inlineCount: 0,
    };
    const body = buildGithubReviewSummary(
      [output({ findings: [plan.collapsed[0].finding], summaryNotes: ['one note'] })],
      undefined,
      plan,
    );
    expect(body).not.toContain('left out');
  });
});
