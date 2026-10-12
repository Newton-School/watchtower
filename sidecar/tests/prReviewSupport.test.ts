/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import {
  buildGithubReviewSummary,
  formatSlackReviewSummary,
  normalizePrReviewAgentOutput,
  splitAgenticOutputByRole,
  formatUnpostedFindings,
  MAX_INLINE_COMMENTS,
  planReviewPosting,
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

  it('appends the applied repo skills to the Slack summary (and stays byte-identical without them)', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'medium', category: 'logic', message: 'Attachable issue', file: 'src/a.ts', line: 10 },
          ],
          summaryNotes: [],
        }),
      ),
    ];
    const prUrl = 'https://github.com/Newton-School/newton-api/pull/42';

    const plain = formatSlackReviewSummary(outputs, prUrl);
    const withSkills = formatSlackReviewSummary(outputs, prUrl, undefined, ['newton-api-pr-review']);

    expect(plain).not.toContain('Reviewed with');
    expect(withSkills).toContain('_Reviewed with newton-api-pr-review + standard security/perf lenses_');
    expect(withSkills.startsWith(plain)).toBe(true);
  });

  it('prepends the applied repo skills to the GitHub review summary', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'medium', category: 'logic', message: 'Attachable issue', file: 'src/a.ts', line: 10 },
          ],
          summaryNotes: [],
        }),
      ),
    ];

    const plain = buildGithubReviewSummary(outputs);
    const withSkills = buildGithubReviewSummary(outputs, ['newton-api-pr-review', 'pre-pr']);

    expect(plain).not.toContain('Reviewed with repo skill(s)');
    expect(withSkills).toContain('Reviewed with repo skill(s): newton-api-pr-review, pre-pr');
    expect(withSkills).toContain('Watchtower found 1 issue(s) in this PR.');
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

  it('surfaces a no-token skip so findings are not silently dropped (#4)', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [{ severity: 'high', category: 'logic', message: 'real issue', file: 'src/a.ts', line: 5 }],
          summaryNotes: [],
        }),
      ),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: false,
      event: 'COMMENT',
      attemptedComments: 0,
      commentsPosted: 0,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'skipped',
      fallbackReason: 'no_token',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/9001',
      reviewResult,
    );

    expect(summary).toContain('submission was skipped');
    expect(summary).toMatch(/no GitHub token/i);
  });

  it('warns when every finding fell outside the PR diff (#4)', () => {
    const outputs = [
      normalizePrReviewAgentOutput(
        'reviewer',
        codexResult({
          findings: [
            { severity: 'high', category: 'logic', message: 'A', file: 'src/a.ts', line: 5 },
            { severity: 'medium', category: 'logic', message: 'B', file: 'src/b.ts', line: 9 },
          ],
          summaryNotes: [],
        }),
      ),
    ];
    const reviewResult: SubmitPrReviewResult = {
      submitted: true,
      event: 'COMMENT',
      attemptedComments: 2,
      commentsPosted: 0,
      droppedOutsideDiff: 2,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'summary_only',
    };

    const summary = formatSlackReviewSummary(
      outputs,
      'https://github.com/Newton-School/newton-web/pull/9002',
      reviewResult,
    );

    expect(summary).toMatch(/all 2 finding\(s\) fell outside the PR diff/i);
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

describe('what the thread is told when a review is not on the PR (issue #449)', () => {
  const PR = 'https://github.com/Newton-School/newton-web/pull/9295';
  const finding = (severity: string, message: string, file?: string, line?: number) =>
    ({ severity, category: 'x', message, file, line }) as never;
  const skipped = {
    submitted: false,
    event: 'COMMENT' as const,
    attemptedComments: 16,
    commentsPosted: 0,
    droppedOutsideDiff: 0,
    fileLevelAttempted: 0,
    fileLevelPosted: 0,
    submissionMode: 'skipped' as const,
  };
  const outputs = [{ role: 'reviewer', findings: [finding('high', 'A', 'a.ts', 1)], summaryNotes: [] }] as never;

  it('names the failure instead of calling it skipped', () => {
    const summary = formatSlackReviewSummary(outputs, PR, { ...skipped, failureReason: 'timed out after 30s' });

    expect(summary).toContain("1 findings identified, but I couldn't post the review to GitHub (timed out after 30s)");
    expect(summary).not.toContain('was skipped');
  });

  it('says so when it cannot tell whether the review is there', () => {
    const summary = formatSlackReviewSummary(outputs, PR, { ...skipped, failureReason: 'HTTP 502', unconfirmed: true });

    expect(summary).toContain('I could not confirm whether the review reached GitHub (HTTP 502)');
    expect(summary).toContain('check the PR before asking again');
  });

  it('keeps the existing wording for a missing token and for a plain skip', () => {
    expect(formatSlackReviewSummary(outputs, PR, { ...skipped, fallbackReason: 'no_token' })).toContain(
      'GitHub review submission was skipped (no GitHub token — nothing was posted to the PR)',
    );
    expect(formatSlackReviewSummary(outputs, PR, skipped)).toContain('but GitHub review submission was skipped');
  });

  it('reads correctly when there was nothing to report either', () => {
    const none = [{ role: 'reviewer', findings: [], summaryNotes: [] }] as never;

    expect(formatSlackReviewSummary(none, PR, { ...skipped, failureReason: 'HTTP 502' })).toContain(
      "No actionable findings. I couldn't post the review to GitHub (HTTP 502).",
    );
  });

  it('lists unposted findings worst first, with where they are', () => {
    const text = formatUnpostedFindings([
      finding('low', 'Rename x', 'a.ts', 3),
      finding('critical', 'SQL injection', 'db.py', 40),
      finding('medium', 'No file here'),
    ]);

    expect(text.split('\n')).toEqual([
      'The review is not on the PR, so here is what it found:',
      '• [CRITICAL] db.py:40 — SQL injection',
      '• [MEDIUM] No file here',
      '• [LOW] a.ts:3 — Rename x',
    ]);
  });

  it('caps the list and shortens long findings, and says how many are left out', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      finding('medium', `Finding ${i} ${'x'.repeat(400)}`, 'a.ts', i + 1),
    );
    const lines = formatUnpostedFindings(many).split('\n');

    expect(lines).toHaveLength(17);
    expect(lines[16]).toBe('… and 5 more that are not shown here.');
    expect(lines[1].length).toBeLessThan(290);
    expect(formatUnpostedFindings([])).toBe('');
  });
});

describe('planReviewPosting: what goes on the diff and what goes in the body (issue #441)', () => {
  const f = (severity: string, line?: number, file: string | undefined = 'src/a.ts') =>
    ({ severity, category: 'x', message: `${severity} at ${line ?? 'file'}`, file, line }) as never;
  const output = (role: string, findings: any[]) =>
    ({
      role,
      findings,
      attachableFindings: findings.filter(x => x.file && typeof x.line === 'number'),
      unattachableFindings: findings.filter(x => !(x.file && typeof x.line === 'number')),
      summaryNotes: [],
      invalidFindings: 0,
    }) as never;

  it('posts medium and above inline, and collapses low and info', () => {
    const plan = planReviewPosting([output('reviewer', [f('low', 1), f('medium', 2), f('info', 3), f('high', 4)])]);

    expect(plan.inlineCount).toBe(2);
    expect(plan.toSubmit[0].findings.map((x: any) => x.severity)).toEqual(['medium', 'high']);
    expect(plan.collapsed.map(c => c.finding.severity)).toEqual(['low', 'info']);
  });

  it('caps inline comments, keeping the worst, across every role', () => {
    const plan = planReviewPosting([
      output(
        'reviewer',
        Array.from({ length: 14 }, (_, i) => f('medium', i + 1)),
      ),
      output('security', [f('critical', 50), f('high', 51)]),
    ]);

    expect(plan.inlineCount).toBe(MAX_INLINE_COMMENTS);
    const submitted = plan.toSubmit.flatMap(r => r.findings as any[]);
    expect(submitted.filter(x => x.severity === 'critical' || x.severity === 'high')).toHaveLength(2);
    expect(submitted.filter(x => x.severity === 'medium')).toHaveLength(8);
    // The six mediums past the cap are not lost: they are in the body.
    expect(plan.collapsed).toHaveLength(6);
    expect(plan.collapsed.every(c => c.finding.severity === 'medium')).toBe(true);
  });

  it('holds file-level findings to the same floor, and leaves line-less ones out of the collapsed list', () => {
    const plan = planReviewPosting([
      output('reviewer', [f('high', undefined), f('low', undefined), f('medium', undefined, undefined)]),
    ]);

    // The body already lists findings with no line; they are not listed twice.
    expect(plan.collapsed).toEqual([]);
    expect(plan.toSubmit[0].findings.map((x: any) => x.severity)).toEqual(['high', 'medium']);
    expect(plan.inlineCount).toBe(0);
  });

  it('writes the collapsed findings into the review body, once, with where they are', () => {
    const outputs = [output('reviewer', [f('high', 4), f('low', 9), f('info', 12)])];
    const body = buildGithubReviewSummary(outputs, undefined, planReviewPosting(outputs));

    expect(body).toContain('Watchtower found 3 issue(s) in this PR.');
    expect(body).toContain('1 of them, of medium severity or above, are inline comments on the diff.');
    expect(body).toContain('2 lower-priority finding(s) are listed below instead of inline.');
    expect(body).toContain('Lower-priority findings (not posted inline):');
    expect(body).toContain('- [REVIEWER - LOW] `src/a.ts:9` — low at 9');
    expect(body).toContain('- [REVIEWER - INFO] `src/a.ts:12` — info at 12');
    expect(body).not.toContain('high at 4');
  });

  it('leaves the body as it was when no plan is given', () => {
    const outputs = [output('reviewer', [f('low', 9)])];

    expect(buildGithubReviewSummary(outputs)).toContain('1 inline comment(s) were prepared from line-mapped findings.');
    expect(buildGithubReviewSummary(outputs)).not.toContain('Lower-priority');
  });

  it('counts collapsed findings in the Slack line instead of calling them dropped', () => {
    const outputs = [output('reviewer', [f('high', 4), f('low', 9), f('info', 12)])];
    const posted = {
      submitted: true,
      event: 'COMMENT' as const,
      attemptedComments: 1,
      commentsPosted: 1,
      droppedOutsideDiff: 0,
      fileLevelAttempted: 0,
      fileLevelPosted: 0,
      submissionMode: 'inline' as const,
    };

    const summary = formatSlackReviewSummary(outputs, 'https://github.com/o/r/pull/1', posted, undefined, 2);

    expect(summary).toContain('3 findings identified; 1 inline posted; 2 lower-priority listed in the review summary');
    expect(summary).not.toContain('without an anchor');
  });
});
