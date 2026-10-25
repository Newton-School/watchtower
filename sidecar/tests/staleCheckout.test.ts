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

  // Issue #709: with no newer tree to read, the agent is told its files may be old, and from when.
  it('warns about a clone that could not be checked against GitHub, with when it last fetched', () => {
    const block = buildStaleCheckoutBlock([
      {
        name: 'newton-web',
        state: { ...CURRENT, staleReason: 'fetch_failed', headDate: '2026-05-26', lastFetched: '2026-10-20' },
      },
      { name: 'newton-api', state: CURRENT },
    ]);

    expect(block).toContain('POSSIBLY OUT OF DATE');
    expect(block).toContain(
      '- newton-web: git fetch failed; it last fetched on 2026-10-20, and the files are from ac56c6935 (2026-05-26).',
    );
    expect(block).toContain('say the code you read may be out of date');
    expect(block).not.toContain('newton-api');
    expect(block).not.toContain('STALE CHECKOUTS');
  });

  it('adds the unconfirmed clones after the stale ones', () => {
    const block = buildStaleCheckoutBlock([
      { name: 'newton-web', state: STUCK },
      { name: 'newton-api', state: { ...CURRENT, behind: undefined, staleReason: 'unverified' } },
    ]);

    expect(block.indexOf('STALE CHECKOUTS')).toBeLessThan(block.indexOf('POSSIBLY OUT OF DATE'));
    expect(block).toContain("- newton-api: I couldn't tell how far it is behind GitHub; the files are from ac56c6935.");
  });

  it('warns when the refresh failed outright', () => {
    expect(buildStaleCheckoutBlock([{ name: 'gone', state: null }])).toContain(
      '- gone: the update check failed, so the files may be out of date.',
    );
  });
});

describe('describeRepoRefresh (issue #709)', () => {
  const setAside = {
    files: ['package.json'],
    ref: 'refs/miniog/autostash/2026-10-26T00-00-00-000Z',
    stash: 'abc123',
    label: 'miniog-autostash 2026-10-26T00-00-00-000Z (#709): 1 uncommitted file set aside so the clone could update',
    patch: '/home/x/.watchtower/autostash/newton-web/2026-10-26T00-00-00-000Z.patch',
  };

  it('says which files were set aside, where they are saved, and how to see them', () => {
    expect(describeRepoRefresh('newton-web', { ...CURRENT, setAside })).toEqual({
      message:
        'Refreshed newton-web to master @ ac56c6935 after setting aside 1 file with uncommitted changes in the way (package.json). They are saved at refs/miniog/autostash/2026-10-26T00-00-00-000Z (patch copy: /home/x/.watchtower/autostash/newton-web/2026-10-26T00-00-00-000Z.patch); `git stash show -p --include-untracked refs/miniog/autostash/2026-10-26T00-00-00-000Z` in the clone shows them.',
      level: 'WARN',
    });
  });

  it('names the uncommitted files the update did not touch', () => {
    expect(
      describeRepoRefresh('newton-web', { ...CURRENT, setAside, leftInPlace: ['a.ts', 'b.ts'], leftInPlaceCount: 7 })
        .message,
    ).toContain("7 files the update didn't touch stayed as they were (a.ts, b.ts, …).");
  });

  it('says why changes in the way were left in place, and how old the files are', () => {
    expect(
      describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'recent_edits', headDate: '2026-05-26' }).message,
    ).toBe(
      'newton-web is 707 commits behind origin/master and was not updated: it has uncommitted changes to package-lock.json, package.json. They changed in the last 15 minutes, so they were left in place. The files on disk are from eae5d68bb as of 2026-05-26; the agent is told to read origin/master instead.',
    );
    expect(describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'busy' }).message).toContain(
      'A git command was running in the clone, so they were left in place.',
    );
    expect(describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'failed' }).message).toContain(
      'Setting them aside did not work, so they were left in place.',
    );
    expect(describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'other_staged' }).message).toContain(
      'Other files have staged changes, so nothing was moved.',
    );
    expect(describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'update_failed' }).message).toContain(
      'They were set aside, but the update still failed for another reason, so they were put back.',
    );
  });

  it('gives the age of the index.lock, and calls an old one a leftover', () => {
    expect(
      describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'busy', indexLockAgeMs: 3 * 60_000 }).message,
    ).toContain(
      'A git command was running in the clone (its index.lock is 3 minutes old), so they were left in place.',
    );
    expect(
      describeRepoRefresh('newton-web', { ...STUCK, setAsideSkipped: 'busy', indexLockAgeMs: 2 * 60 * 60_000 }).message,
    ).toContain(
      'The clone has an index.lock from 2 hours ago, probably left by a git command that crashed, so they were left in place; delete it if nothing is running there.',
    );
  });

  it('says the changes are still in the stash list when no private ref could be made', () => {
    const message = describeRepoRefresh('newton-web', {
      ...STUCK,
      setAsideSkipped: 'failed',
      setAsideKept: { stashLabel: 'miniog-autostash x (#709): 1 uncommitted file set aside', restored: 'no' },
    }).message;
    expect(message).toContain(
      `they are saved at the clone's stash list as "miniog-autostash x (#709): 1 uncommitted file set aside"`,
    );
  });

  it('never says "left in place" when the changes could not be put back', () => {
    const notBack = describeRepoRefresh('newton-web', {
      ...STUCK,
      setAsideSkipped: 'failed',
      setAsideKept: { ref: setAside.ref, patch: setAside.patch, restored: 'no' },
    }).message;
    expect(notBack).toContain(
      'Setting them aside did not finish and putting them back failed: they are NOT in the working tree, they are saved at refs/miniog/autostash/',
    );
    expect(notBack).not.toContain('left in place');

    const unstaged = describeRepoRefresh('newton-web', {
      ...STUCK,
      setAsideSkipped: 'failed',
      setAsideKept: { ref: setAside.ref, restored: 'unstaged' },
    }).message;
    expect(unstaged).toContain(
      'Setting them aside did not finish; they are back in the working tree, unstaged, and a copy is saved at refs/miniog/',
    );
  });

  it('says when the clone last fetched when a fetch fails', () => {
    expect(
      describeRepoRefresh('newton-web', { ...CURRENT, staleReason: 'fetch_failed', lastFetched: '2026-10-20' }).message,
    ).toBe('Could not fetch newton-web; answering from master @ ac56c6935 as of the last fetch (2026-10-20).');
  });

  it('never says "Refreshed" for a clone it could not confirm is current', () => {
    const result = describeRepoRefresh('newton-web', { ...CURRENT, behind: undefined, staleReason: 'unverified' });

    expect(result).toEqual({
      message: 'Could not confirm newton-web is up to date with origin/master; answering from master @ ac56c6935.',
      level: 'WARN',
    });
  });
});
