/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { applyFollowUpScope, formatFollowUpLine, isCarriedOver } from '../src/agentic/reReview.js';
import { parseDiffHunks } from '../src/github/diffHunks.js';

const f = (severity: string, message: string, file?: string, line?: number) =>
  ({ severity, category: 'x', message, file, line }) as any;
const output = (role: string, findings: any[], summaryNotes: string[] = []) =>
  ({
    role,
    findings,
    attachableFindings: findings.filter(x => x.file && typeof x.line === 'number'),
    unattachableFindings: findings.filter(x => !(x.file && typeof x.line === 'number')),
    summaryNotes,
    invalidFindings: 0,
  }) as any;

// Since the earlier review, only lines 5 and 6 of src/a.ts changed.
const CHANGED_SINCE = parseDiffHunks(
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +4,3 @@\n context\n+five\n+six',
);
const EARLIER = [
  { severity: 'medium', message: 'The retry loop never backs off between attempts', file: 'src/a.ts', line: 2 },
  { severity: 'low', message: 'Rename the helper to describe what it returns', file: 'src/a.ts', line: 3 },
  { severity: 'low', message: 'Missing test for the empty list case', file: 'src/b.ts', line: 9 },
];

describe('isCarriedOver (issue #451)', () => {
  it('recognises a finding the reviewer marked as coming back', () => {
    expect(isCarriedOver(f('medium', 'Still open: the retry loop has no backoff', 'src/a.ts', 2), [])).toBe(true);
    expect(isCarriedOver(f('high', 'Regressed: the guard was removed again', 'src/a.ts', 2), [])).toBe(true);
    expect(isCarriedOver(f('medium', '**Still open** — no backoff', 'src/a.ts', 2), [])).toBe(true);
  });

  it('recognises one that says much the same thing in the same file, unmarked', () => {
    expect(
      isCarriedOver(f('medium', 'The retry loop still never backs off between attempts', 'src/a.ts', 14), EARLIER),
    ).toBe(true);
  });

  it('does not take a different point, or the same words in another file, for an earlier finding', () => {
    expect(isCarriedOver(f('low', 'This import is unused', 'src/a.ts', 2), EARLIER)).toBe(false);
    expect(isCarriedOver(f('medium', 'The retry loop never backs off between attempts', 'src/z.ts', 2), EARLIER)).toBe(
      false,
    );
  });
});

describe('applyFollowUpScope (issue #451)', () => {
  it('keeps what is still open, what is new in changed code, and any new blocker; leaves out the rest', () => {
    const stillOpen = f('medium', 'Still open: the retry loop never backs off', 'src/a.ts', 2);
    const newOnOldCode = f('low', 'This variable could be const', 'src/a.ts', 3);
    const newOnNewCode = f('low', 'Magic number here', 'src/a.ts', 5);
    const newBlocker = f('high', 'Token is logged in full', 'src/a.ts', 3);
    const noLocation = f('medium', 'No test covers the new branch');

    const { outputs, stats } = applyFollowUpScope({
      outputs: [
        output(
          'reviewer',
          [stillOpen, newOnOldCode, newOnNewCode, noLocation],
          [
            'Addressed since last review: helper renamed',
            'Addressed since last review: empty-list test added',
            'Unrelated note',
          ],
        ),
        output('security', [newBlocker], ['Addressed since last review: not mine to say']),
      ],
      earlier: EARLIER,
      changedSince: CHANGED_SINCE,
    });

    expect(outputs[0].findings).toEqual([stillOpen, newOnNewCode, noLocation]);
    expect(outputs[0].attachableFindings).toEqual([stillOpen, newOnNewCode]);
    expect(outputs[0].unattachableFindings).toEqual([noLocation]);
    expect(outputs[1].findings).toEqual([newBlocker]);
    // Only the lead reviewer's notes count as the accounting.
    expect(stats).toEqual({ earlierTotal: 3, addressed: 2, stillOpen: 1, newFindings: 3, leftOut: 1 });
  });

  it('judges a file-level finding by whether its file changed since', () => {
    const { outputs, stats } = applyFollowUpScope({
      outputs: [output('reviewer', [f('low', 'File is getting long', 'src/a.ts'), f('low', 'Same here', 'src/b.ts')])],
      earlier: [],
      changedSince: CHANGED_SINCE,
    });

    expect(outputs[0].findings.map((x: any) => x.file)).toEqual(['src/a.ts']);
    expect(stats.leftOut).toBe(1);
  });

  it('leaves nothing out when the diff since the earlier review cannot be had', () => {
    const findings = [f('low', 'On old code', 'src/a.ts', 3), f('info', 'Also old', 'src/a.ts', 2)];

    const { outputs, stats } = applyFollowUpScope({
      outputs: [output('reviewer', findings)],
      earlier: EARLIER,
      changedSince: undefined,
    });

    expect(outputs[0].findings).toEqual(findings);
    expect(stats).toMatchObject({ newFindings: 2, leftOut: 0 });
  });

  it('never counts more addressed than the earlier review had left after what is still open', () => {
    const { stats } = applyFollowUpScope({
      outputs: [
        output(
          'reviewer',
          [f('medium', 'Still open: no backoff', 'src/a.ts', 2)],
          Array.from({ length: 6 }, (_, i) => `Addressed since last review: thing ${i}`),
        ),
      ],
      earlier: EARLIER,
      changedSince: CHANGED_SINCE,
    });

    expect(stats).toMatchObject({ earlierTotal: 3, stillOpen: 1, addressed: 2 });
  });
});

describe('formatFollowUpLine (issue #451)', () => {
  const stats = { earlierTotal: 13, addressed: 11, stillOpen: 2, newFindings: 3, leftOut: 0 };

  it('says what became of the earlier findings and what is new', () => {
    expect(formatFollowUpLine(stats, 'oldsha1234567')).toBe(
      'Follow-up on my review at oldsha1: of its 13 findings, 11 addressed, 2 still open; 3 new in the code changed since.',
    );
  });

  it('says how many points on unchanged code were left out', () => {
    expect(formatFollowUpLine({ ...stats, leftOut: 4 }, 'oldsha1234567')).toContain(
      '4 further low or medium points on code unchanged since then were left out.',
    );
    expect(formatFollowUpLine({ ...stats, leftOut: 1 }, 'oldsha1234567')).toContain(
      '1 further low or medium point on code unchanged since then was left out.',
    );
  });

  it('does not claim an earlier finding was addressed when the reviewer did not say so', () => {
    expect(formatFollowUpLine({ ...stats, addressed: 8 }, 'oldsha1234567')).toContain(
      'of its 13 findings, 8 addressed, 2 still open, 3 not re-assessed;',
    );
  });

  it('reads correctly for one finding and for none', () => {
    expect(
      formatFollowUpLine({ earlierTotal: 1, addressed: 1, stillOpen: 0, newFindings: 0, leftOut: 0 }, 'abc1234'),
    ).toBe(
      'Follow-up on my review at abc1234: of its 1 finding, 1 addressed, 0 still open; 0 new in the code changed since.',
    );
    expect(
      formatFollowUpLine({ earlierTotal: 0, addressed: 0, stillOpen: 0, newFindings: 2, leftOut: 0 }, 'abc1234'),
    ).toContain('it had no findings; 2 new');
  });
});
