import { describe, expect, it } from 'vitest';
import {
  buildGithubReviewSummary,
  formatSlackReviewSummary,
  normalizePrReviewAgentOutput,
  splitAgenticOutputByRole,
} from '../src/github/prReviewSupport.js';
import type { SubmitPrReviewResult } from '../src/github/submitPrReview.js';
import type { CodexRunResult } from '../src/types/contracts.js';

function codexResult(parsedJson: Record<string, unknown>): CodexRunResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    parsedJson,
    durationMs: 1,
    backend: 'codex',
  } as CodexRunResult;
}

describe('prReviewSupport', () => {
  it('normalizes non-attachable findings into summary-only review notes', () => {
    const output = normalizePrReviewAgentOutput(
      'reviewer',
      codexResult({
        findings: [
          { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          { severity: 'low', category: 'style', message: 'Broken payload', file: 'src/a.ts', line: '12' },
        ],
        summaryNotes: ['Keep the copy aligned with the incident context.'],
      }),
    );

    expect(output.findings).toHaveLength(2);
    expect(output.attachableFindings).toHaveLength(0);
    expect(output.unattachableFindings).toHaveLength(2);
    expect(output.invalidFindings).toBe(0);
    expect(output.summaryNotes).toEqual(['Keep the copy aligned with the incident context.']);
  });

  it('splits role-tagged agentic findings into per-role outputs (unknown roles land on reviewer)', () => {
    const outputs = splitAgenticOutputByRole(
      codexResult({
        findings: [
          { role: 'security', severity: 'high', category: 'authz', message: 'Missing check', file: 'a.py', line: 4 },
          { role: 'performance', severity: 'low', category: 'n+1', message: 'Loop query', file: 'b.py', line: 9 },
          { role: 'made-up', severity: 'medium', category: 'logic', message: 'Edge case', file: 'c.ts', line: 2 },
          { severity: 'info', category: 'style', message: 'Untagged finding', file: 'd.ts', line: 7 },
        ],
        summaryNotes: ['One note.'],
      }),
    );

    expect(outputs.map(o => o.role)).toEqual(['reviewer', 'security', 'performance']);
    expect(outputs[0].findings.map(f => f.message)).toEqual(['Edge case', 'Untagged finding']);
    expect(outputs[1].findings).toHaveLength(1);
    expect(outputs[2].findings).toHaveLength(1);
    // Notes are not role-tagged in the agentic schema — attributed to reviewer.
    expect(outputs[0].summaryNotes).toEqual(['One note.']);
    expect(outputs[1].summaryNotes).toEqual([]);
  });

  it('formats summary-only Slack completion when no inline comments were attached', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          ],
          summaryNotes: [],
        }),
      ),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'COMMENT',
      attemptedComments: 0,
      commentsPosted: 0,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'summary_only',
      fallbackReason: 'missing_location',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/7859',
      reviewResult,
    );

    expect(summary).toContain('1 findings identified; review summary posted, no inline comments attached');
    expect(summary).toContain('1 without an anchor');
    expect(summary).not.toContain('comments posted on PR');
  });

  it('formats partial Slack completion when only some findings are attachable', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'medium', category: 'logic', message: 'Attachable issue', file: 'src/a.ts', line: 10 },
            { severity: 'low', category: 'test', message: 'Needs broader follow-up' },
          ],
          summaryNotes: [],
        }),
      ),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'COMMENT',
      attemptedComments: 1,
      commentsPosted: 1,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'inline',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/7859',
      reviewResult,
    );

    expect(summary).toContain('2 findings identified; 1 inline posted');
    expect(summary).toContain('1 without an anchor dropped');
  });

  it('formats Slack completion with inline + file-level + outside-diff counters', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'high', category: 'logic', message: 'Inline A', file: 'src/a.ts', line: 5 },
            { severity: 'medium', category: 'logic', message: 'Inline B', file: 'src/b.ts', line: 12 },
            { severity: 'medium', category: 'convention', message: 'File-level', file: 'src/c.ts' },
            { severity: 'low', category: 'perf', message: 'Off-diff', file: 'src/a.ts', line: 999 },
          ],
          summaryNotes: [],
        }),
      ),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'REQUEST_CHANGES',
      attemptedComments: 2,
      commentsPosted: 2,
      droppedOutsideDiff: 1,
      fileLevelAttempted: 1,
      fileLevelPosted: 1,
      submissionMode: 'inline',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/8088',
      reviewResult,
    );

    expect(summary).toContain('4 findings identified');
    expect(summary).toContain('2 inline + 1 file-level posted');
    expect(summary).toContain('1 outside the PR diff dropped');
  });

  it('builds GitHub summary text for summary-only findings and notes', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'medium', category: 'logic', message: 'Needs a line reference before it can be attached.' },
          ],
          summaryNotes: ['Mention the legacy avatar flow in the summary.'],
        }),
      ),
    ];

    const summary = buildGithubReviewSummary(outputs);

    expect(summary).toContain('1 finding(s) could not be attached inline and are listed below.');
    expect(summary).toContain('[REVIEWER - MEDIUM] Needs a line reference before it can be attached.');
    expect(summary).toContain('[REVIEWER NOTE] Mention the legacy avatar flow in the summary.');
  });
});
