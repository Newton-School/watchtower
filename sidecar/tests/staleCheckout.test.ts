import { describe, expect, it } from 'vitest';
import {
  buildStaleCheckoutBlock,
  describeRepoRefresh,
  isStaleCheckout,
  staleReasonText,
} from '../src/workspaces/staleCheckout.js';
import type { SharedRepoState } from '../src/workspaces/workspaceManager.js';

// The clone from the incident: on master, 707 behind, two uncommitted files.
const STUCK: SharedRepoState = {
  branch: 'master',
  head: 'eae5d68bb',
  upstream: 'origin/master',
  behind: 707,
  staleReason: 'dirty_tree',
  dirtyFiles: ['package-lock.json', 'package.json'],
};
const CURRENT: SharedRepoState = { branch: 'master', head: 'ac56c6935', upstream: 'origin/master', behind: 0 };

describe('describeRepoRefresh (issue #446)', () => {
  it('says "Refreshed" only for a clone that is current', () => {
    expect(describeRepoRefresh('newton-api', CURRENT)).toEqual({
      message: 'Refreshed newton-api to master @ ac56c6935.',
      level: 'INFO',
    });
  });

  it('says how far behind a stuck clone is, why, and what the agent is told', () => {
    expect(describeRepoRefresh('newton-web', STUCK)).toEqual({
      message:
        'newton-web is 707 commits behind origin/master and was not updated: it has uncommitted changes to package-lock.json, package.json. The files on disk are from eae5d68bb; the agent is told to read origin/master instead.',
      level: 'WARN',
    });
  });

  it('warns when the fetch failed, even if the clone looks current as of the last one', () => {
    const result = describeRepoRefresh('newton-web', { ...CURRENT, staleReason: 'fetch_failed' });

    expect(result.level).toBe('WARN');
    expect(result.message).toBe('Could not fetch newton-web; answering from master @ ac56c6935 as of the last fetch.');
  });

  it('warns for a directory it could not inspect', () => {
    expect(describeRepoRefresh('newton-web', null).level).toBe('WARN');
  });

  it('gives each reason in words', () => {
    expect(staleReasonText({ ...STUCK, staleReason: 'other_branch', branch: 'fix/x' })).toBe(
      'it is checked out on fix/x, not the default branch',
    );
    expect(staleReasonText({ ...STUCK, staleReason: 'diverged' })).toBe(
      'it has local commits that are not on origin/master',
    );
    expect(staleReasonText({ ...STUCK, staleReason: 'not_fast_forwardable' })).toBe('git would not fast-forward it');
  });
});

describe('buildStaleCheckoutBlock (issue #446)', () => {
  it('is empty when every clone is current', () => {
    expect(buildStaleCheckoutBlock([{ name: 'newton-api', state: CURRENT }])).toBe('');
    expect(buildStaleCheckoutBlock([{ name: 'gone', state: null }])).toBe('');
  });

  it('names only the stale clones and tells the agent to read origin, with commands it can run', () => {
    const block = buildStaleCheckoutBlock([
      { name: 'newton-web', state: STUCK },
      { name: 'newton-api', state: CURRENT },
    ]);

    expect(block).toContain('STALE CHECKOUTS');
    expect(block).toContain(
      '- newton-web: the files on disk are 707 commits behind origin/master (it has uncommitted changes to package-lock.json, package.json). Read it from origin/master.',
    );
    expect(block).not.toContain('newton-api');
    expect(block).toContain('cd newton-web && git grep -n "<pattern>" origin/master -- <path>');
    expect(block).toContain('cd newton-web && git show origin/master:<path>');
    // The wrong answer in the incident was "that param doesn't exist anywhere: zero hits".
    expect(block).toContain('Never conclude that something "does not exist"');
    expect(block).toContain('Say in your answer that you read origin/master, not the local files.');
  });

  it('counts a clone as stale only when it is known to be behind a known upstream', () => {
    expect(isStaleCheckout(STUCK)).toBe(true);
    expect(isStaleCheckout(CURRENT)).toBe(false);
    expect(isStaleCheckout({ ...STUCK, behind: undefined })).toBe(false);
    expect(isStaleCheckout({ ...STUCK, upstream: undefined })).toBe(false);
    // Fetch failed but older refs still show it behind: origin's last-known tree is still the better read.
    expect(isStaleCheckout({ ...STUCK, staleReason: 'fetch_failed' })).toBe(true);
  });

  it('reads right for one commit behind', () => {
    expect(buildStaleCheckoutBlock([{ name: 'r', state: { ...STUCK, behind: 1 } }])).toContain('1 commit behind');
  });
});
