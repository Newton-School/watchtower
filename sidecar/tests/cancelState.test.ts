import { describe, expect, it } from 'vitest';
import { cancelledResult, settleAbortedResult } from '../src/workflows/shared/cancelState.js';
import type { WorkflowResult } from '../src/types/contracts.js';

const failed: WorkflowResult = {
  workflow: 'INVESTIGATION',
  status: 'FAILED',
  message: 'Investigator produced no usable output.',
  notifyDesktop: true,
  slackPosted: true,
};

describe('settleAbortedResult', () => {
  it('records an aborted run that came back FAILED as CANCELLED, without a failure alert', () => {
    expect(settleAbortedResult(failed, true)).toEqual({
      ...failed,
      status: 'CANCELLED',
      message: 'Cancelled before it finished.',
      notifyDesktop: false,
    });
  });

  it("does not keep the workflow's failure text as the job's message", () => {
    expect(settleAbortedResult(failed, true).message).not.toContain('Investigator');
  });

  it('leaves a genuine failure alone', () => {
    expect(settleAbortedResult(failed, false)).toBe(failed);
  });

  it.each(['SUCCESS', 'PAUSED', 'SKIPPED', 'CANCELLED'] as const)(
    'does not relabel a run that ended %s before the cancel landed',
    status => {
      const result: WorkflowResult = { ...failed, status, result: { prUrl: 'https://github.com/o/r/pull/1' } };
      expect(settleAbortedResult(result, true)).toBe(result);
    },
  );
});

describe('cancelledResult', () => {
  it('is a quiet terminal result: nothing posted, no desktop alert', () => {
    expect(cancelledResult('DEPLOY')).toEqual({
      workflow: 'DEPLOY',
      status: 'CANCELLED',
      message: 'Cancelled.',
      notifyDesktop: false,
      slackPosted: false,
    });
  });
});
