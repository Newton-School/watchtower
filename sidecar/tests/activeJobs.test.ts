import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerActiveJob,
  unregisterActiveJob,
  cancelJob,
  getActiveJobIds,
  takeCancelReason,
  activeJobIdForThread,
} from '../src/state/activeJobs.js';

describe('activeJobs', () => {
  beforeEach(() => {
    // Clean up any stale entries
    for (const id of getActiveJobIds()) {
      unregisterActiveJob(id);
    }
  });

  it('registers and lists active jobs', () => {
    const controller = new AbortController();
    registerActiveJob('job-1', controller);
    expect(getActiveJobIds()).toEqual(['job-1']);
  });

  it('unregisters a job', () => {
    const controller = new AbortController();
    registerActiveJob('job-2', controller);
    unregisterActiveJob('job-2');
    expect(getActiveJobIds()).toEqual([]);
  });

  it('cancels a job by exact id', () => {
    const controller = new AbortController();
    registerActiveJob('abcdef-1234', controller);

    const result = cancelJob('abcdef-1234');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(getActiveJobIds()).toEqual([]);
  });

  it('cancels a job by prefix match', () => {
    const controller = new AbortController();
    registerActiveJob('abcdef-1234-5678', controller);

    const result = cancelJob('abcdef');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(getActiveJobIds()).toEqual([]);
  });

  it('returns false when no job matches', () => {
    const result = cancelJob('nonexistent');
    expect(result).toBe(false);
  });

  it('remembers why a job was cancelled, once, for its finalizer (issue #438)', () => {
    registerActiveJob('job-ui', new AbortController());
    cancelJob('job-ui', { source: 'ui', message: 'Cancelled from Watchtower UI.' });

    expect(takeCancelReason('job-ui')).toEqual({ source: 'ui', message: 'Cancelled from Watchtower UI.' });
    expect(takeCancelReason('job-ui')).toBeUndefined();
  });

  it('stores the reason under the full id when cancelled by prefix', () => {
    registerActiveJob('abcdef-9999-full', new AbortController());
    cancelJob('abcdef', { source: 'source_deleted', message: 'Source message deleted by author.' });

    expect(takeCancelReason('abcdef-9999-full')?.source).toBe('source_deleted');
  });

  it('has the reason in place by the time abort listeners run', () => {
    const controller = new AbortController();
    registerActiveJob('job-listener', controller);
    let seen: string | undefined;
    controller.signal.addEventListener('abort', () => {
      seen = takeCancelReason('job-listener')?.source;
    });

    cancelJob('job-listener', { source: 'ui', message: 'x' });
    expect(seen).toBe('ui');
  });

  it('keeps no reason for a job that was not running', () => {
    expect(cancelJob('never-registered', { source: 'ui', message: 'x' })).toBe(false);
    expect(takeCancelReason('never-registered')).toBeUndefined();
  });
});

// Issue #261: the same-thread lock used to be "a RUNNING row updated in the
// last 45 minutes", and lapsed under any job that ran longer.
describe('activeJobIdForThread — the same-thread lock', () => {
  const thread = { channelId: 'C1', threadTs: '1791000000.000100' };

  it('holds the thread from register to unregister, however long the job runs', () => {
    registerActiveJob('job-long', new AbortController(), thread);
    expect(activeJobIdForThread('C1', '1791000000.000100')).toBe('job-long');

    unregisterActiveJob('job-long');
    expect(activeJobIdForThread('C1', '1791000000.000100')).toBeUndefined();
  });

  it('keeps the thread locked after a cancel, until the job has finished cleaning up', () => {
    registerActiveJob('job-cancelling', new AbortController(), thread);
    cancelJob('job-cancelling', { source: 'ui', message: 'Cancelled from Watchtower UI.' });

    // No longer cancellable, but still the owner of the thread and its worktree.
    expect(getActiveJobIds()).not.toContain('job-cancelling');
    expect(activeJobIdForThread('C1', '1791000000.000100')).toBe('job-cancelling');

    unregisterActiveJob('job-cancelling');
    expect(activeJobIdForThread('C1', '1791000000.000100')).toBeUndefined();
  });

  it('does not lock another thread, or the same thread ts in another channel', () => {
    registerActiveJob('job-a', new AbortController(), thread);

    expect(activeJobIdForThread('C1', '1791000999.000100')).toBeUndefined();
    expect(activeJobIdForThread('C2', '1791000000.000100')).toBeUndefined();
    unregisterActiveJob('job-a');
  });

  it('is empty in a fresh process: a RUNNING row left by a previous one locks nothing', () => {
    expect(activeJobIdForThread('C9', '1791000000.000100')).toBeUndefined();
  });

  it('does not lock a thread for a job registered without one', () => {
    registerActiveJob('job-no-thread', new AbortController());
    expect(activeJobIdForThread('C1', '1791000000.000100')).toBeUndefined();
    unregisterActiveJob('job-no-thread');
  });
});
