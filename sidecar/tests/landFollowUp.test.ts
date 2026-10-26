import { describe, expect, it, vi } from 'vitest';
import { landedFollowUpText, landFollowUp } from '../src/workflows/implementationWorkflow.js';
import { composeChangeReply } from '../src/workflows/shared/changeReply.js';
import { STAGING_STATE_KEY } from '../src/workflows/stagingDeployWorkflow.js';

// Issue #730: landing a follow-up whose checks passed. The PR is read again
// first (M2), the commits go onto its branch, and the engineering account goes
// on the PR as a comment (S5).

const PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1484';
const PR_NEW = 'https://github.com/Newton-School/newton-marketing-web/pull/1500';
const pr = {
  url: PR,
  owner: 'Newton-School',
  repo: 'newton-marketing-web',
  number: 1484,
  branch: 'raj/hero-copy',
  repoKey: 'newton-marketing-web' as const,
  files: ['src/hero.tsx'],
};
const task = {
  event: {
    eventId: 'Ev',
    channelId: 'C1',
    threadTs: '111.22',
    eventTs: '111.30',
    userId: 'URAJ',
    text: 'x',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
} as never;

const open = { state: 'OPEN', branch: pr.branch, crossRepo: false };

function land(deps: Parameters<typeof landFollowUp>[0]['deps'], store?: object) {
  const logStep = vi.fn();
  return {
    logStep,
    result: landFollowUp({
      followUp: { pr, startHead: 'start1' },
      repoPath: '/ws/newton-marketing-web/111.22',
      task,
      summary: 'Changed the footer copy.',
      requestedBy: 'Raj',
      store: store as never,
      logStep,
      deps,
    }),
  };
}

describe('landFollowUp', () => {
  it('a PR still open gets the commits and the engineering account as a comment', async () => {
    const push = vi.fn(async () => ({ kind: 'pushed' as const, ontoNewerCommits: false }));
    const comment = vi.fn(async () => true);
    const reland = vi.fn();
    const readPr = vi.fn(async () => open);
    const { result, logStep } = land({ readPr, push, reland, comment });
    expect(await result).toEqual({
      kind: 'added',
      ontoNewerCommits: false,
      commented: true,
      stagingStillOld: false,
      mergedMeanwhile: false,
    });
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'raj/hero-copy', startHead: 'start1', uniqueTs: '111.30', prUrl: PR }),
    );
    expect(comment).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: PR,
        summary: 'Changed the footer copy.',
        requestedBy: 'Raj',
        threadTs: '111.22',
      }),
    );
    expect(reland).not.toHaveBeenCalled();
    // Read before the push and again after it.
    expect(readPr).toHaveBeenCalledTimes(2);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'implementation.followup.pushed' }));
  });

  it('says staging still shows the previous version only when staging has this PR', async () => {
    const store = {
      getState: (key: string) =>
        key === STAGING_STATE_KEY
          ? JSON.stringify({ branch: pr.branch, prUrl: PR, atMs: Date.now() - 60_000 })
          : undefined,
    };
    const { result } = land(
      {
        readPr: vi.fn(async () => open),
        push: vi.fn(async () => ({ kind: 'pushed' as const, ontoNewerCommits: true })),
        comment: vi.fn(async () => true),
      },
      store,
    );
    expect(await result).toMatchObject({ kind: 'added', ontoNewerCommits: true, stagingStillOld: true });
  });

  it('a PR that merged just as the commits were pushed is said so, with no comment on it', async () => {
    const readPr = vi
      .fn()
      .mockResolvedValueOnce(open)
      .mockResolvedValueOnce({ ...open, state: 'MERGED' });
    const comment = vi.fn(async () => true);
    const { result, logStep } = land({
      readPr,
      push: vi.fn(async () => ({ kind: 'pushed' as const, ontoNewerCommits: false })),
      comment,
    });
    expect(await result).toMatchObject({ kind: 'added', mergedMeanwhile: true, commented: false });
    expect(comment).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation.followup.merged_meanwhile', level: 'WARN' }),
    );
  });

  it('a PR merged while the run worked gets a fresh PR from the default branch, never a push to its branch', async () => {
    const push = vi.fn();
    const reland = vi.fn(async () => ({ kind: 'opened' as const, prUrl: PR_NEW }));
    const { result, logStep } = land({
      readPr: vi.fn(async () => ({ ...open, state: 'MERGED' })),
      push,
      reland,
      comment: vi.fn(),
    });
    expect(await result).toEqual({ kind: 'relanded', prUrl: PR_NEW });
    expect(push).not.toHaveBeenCalled();
    expect(reland).toHaveBeenCalledWith(
      expect.objectContaining({ originalPrUrl: PR, startHead: 'start1', uniqueTs: '111.30' }),
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation.followup.fallback',
        data: expect.objectContaining({ reason: 'merged' }),
      }),
    );
  });

  it('a merged PR whose main already has the change, or a fresh PR that fails, says so', async () => {
    const already = land({
      readPr: vi.fn(async () => ({ ...open, state: 'MERGED' })),
      reland: vi.fn(async () => ({ kind: 'already' as const })),
    });
    expect(await already.result).toEqual({ kind: 'already' });

    const failed = land({
      readPr: vi.fn(async () => ({ ...open, state: 'MERGED' })),
      reland: vi.fn(async () => ({ kind: 'failed' as const, reason: 'gh failed', wipBranch: 'w' })),
    });
    expect(await failed.result).toEqual({ kind: 'failed', reason: 'gh failed', wipBranch: 'w', mergedMeanwhile: true });
    expect(failed.logStep).toHaveBeenCalledWith(expect.objectContaining({ level: 'ERROR' }));
  });

  it('a closed PR is not revived: the change is kept on a side branch and the person is asked', async () => {
    const push = vi.fn();
    const reland = vi.fn();
    const keep = vi.fn(async () => ({ wipBranch: 'miniog/followup-wip-111-30-abc1234', nothing: false }));
    const { result } = land({ readPr: vi.fn(async () => ({ ...open, state: 'CLOSED' })), push, reland, keep });
    expect(await result).toEqual({ kind: 'closed', wipBranch: 'miniog/followup-wip-111-30-abc1234' });
    expect(push).not.toHaveBeenCalled();
    expect(reland).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledWith(expect.objectContaining({ startHead: 'start1', uniqueTs: '111.30' }));
  });

  it('a clash is kept on a side branch and logged; our own commits on the PR are an ERROR', async () => {
    const conflict = land({
      readPr: vi.fn(async () => open),
      push: vi.fn(async () => ({
        kind: 'conflict' as const,
        wipBranch: 'w',
        prState: { untouched: false, landed: ['abc someone'], ours: false },
      })),
    });
    expect(await conflict.result).toMatchObject({ kind: 'conflict', wipBranch: 'w' });
    expect(conflict.logStep).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'WARN', data: expect.objectContaining({ reason: 'branch_moved_conflict' }) }),
    );

    const ours = land({
      readPr: vi.fn(async () => open),
      push: vi.fn(async () => ({
        kind: 'rewritten' as const,
        wipBranch: 'w',
        prState: { untouched: false, landed: ['abc coder: footer'], ours: true },
      })),
    });
    await ours.result;
    expect(ours.logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'ERROR',
        data: expect.objectContaining({ reason: 'history_rewritten', uncheckedCommitsOnPr: true }),
      }),
    );
  });

  it('a failed push is reported with the side branch, never as added', async () => {
    const failed = land({
      readPr: vi.fn(async () => undefined),
      push: vi.fn(async () => ({ kind: 'failed' as const, reason: 'push rejected', wipBranch: 'w' })),
      comment: vi.fn(),
    });
    expect(await failed.result).toEqual({ kind: 'failed', reason: 'push rejected', wipBranch: 'w' });
  });
});

describe('what the thread is told after a follow-up passed its checks', () => {
  const reply = (link: string, opts?: { addedTo?: boolean; notesInPr?: boolean }) =>
    composeChangeReply({
      summary: 'Changed `footer.txt`.',
      requesterSummary: 'The footer now says "Talk to us".',
      engineerReads: false,
      prUrl: link,
      externalBlock: '',
      addedTo: opts?.addedTo,
      notesInPr: opts?.notesInPr,
    });
  const text = (outcome: Parameters<typeof landedFollowUpText>[0]['outcome'], strayPrUrl?: string) =>
    landedFollowUpText({ outcome, prUrl: PR, reply, strayPrUrl });
  const plain = (t: string) => {
    expect(t).not.toContain(':warning:');
    expect(t).not.toContain('could not open a pull request');
    expect(t).not.toMatch(/existing commits|rebase|force|wip/i);
  };

  it('added: on the PR, with what changed meanwhile and stale staging', () => {
    const t = text({
      kind: 'added',
      ontoNewerCommits: true,
      commented: true,
      stagingStillOld: true,
      mergedMeanwhile: false,
    });
    expect(t).toContain(`Added to ${PR}: The footer now says "Talk to us".`);
    expect(t).toContain('_The engineering notes are in the PR._');
    expect(t).toContain('It had changed since I started');
    expect(t).toContain('Staging still shows the previous version');
    plain(t);
  });

  it("merged just as it was added: says the change isn't in it", () => {
    const t = text({
      kind: 'added',
      ontoNewerCommits: false,
      commented: false,
      stagingStillOld: false,
      mergedMeanwhile: true,
    });
    expect(t).toContain(`${PR} was merged just as I added this, so this change isn't in it.`);
    expect(t).not.toContain('Added to');
    plain(t);
  });

  it('a clash: kept on a side branch, mention me to redo it on top; no stacked PR', () => {
    const t = text({
      kind: 'conflict',
      wipBranch: 'miniog/followup-wip-111-30-abc1234',
      prState: { untouched: false, landed: ['x'], ours: false },
    });
    expect(t).toContain(`This clashes with what's on ${PR} now, so I didn't add it.`);
    expect(t).toContain('I saved it on a side branch (`miniog/followup-wip-111-30-abc1234`)');
    expect(t).toContain("Mention me and I'll redo it on top of the latest version.");
    expect(t).not.toContain('pull/15');
  });

  it('closed: asks whether they want a new PR', () => {
    const t = text({ kind: 'closed', wipBranch: 'miniog/followup-wip-111-30-abc1234' });
    expect(t).toContain(`${PR} was closed while I worked, so I didn't add this to it.`);
    expect(t).toContain('Want it as a new pull request?');
    expect(t).toContain('on a side branch (`miniog/followup-wip-111-30-abc1234`)');
  });

  it('merged before it was ready: the new PR, or "already in main"', () => {
    expect(text({ kind: 'relanded', prUrl: PR_NEW })).toContain(
      `${PR} was merged while I worked, so this change is in a new pull request.`,
    );
    expect(text({ kind: 'relanded', prUrl: PR_NEW })).toContain(PR_NEW);
    const already = text({ kind: 'already' });
    expect(already).toContain('everything this change does is already in the main branch');
    plain(already);
  });

  it("our own unchecked commits on the PR: don't merge it yet", () => {
    const t = text({
      kind: 'rewritten',
      wipBranch: 'w',
      prState: { untouched: false, landed: ['abc coder: footer'], ours: true },
    });
    expect(t).toContain(`My unfinished change reached ${PR} before its checks passed — don't merge it yet.`);
    expect(t).not.toContain("it's as it was");
  });

  it('a failed push: plain words, the PR checked, the change saved', () => {
    const t = text({
      kind: 'failed',
      reason: 'push rejected',
      wipBranch: 'miniog/followup-wip-111-30-abc1234',
      prState: { untouched: true, landed: [], ours: false },
    });
    expect(t).toContain(`I couldn't add this to ${PR}. Nothing was added to ${PR}; it's as it was.`);
    expect(t).toContain('I saved the change on a side branch');
    expect(t).not.toContain('push rejected');
  });

  it('mentions a PR the coder opened although it was told not to', () => {
    const t = text(
      { kind: 'added', ontoNewerCommits: false, commented: true, stagingStillOld: false, mergedMeanwhile: false },
      PR_NEW,
    );
    expect(t).toContain(`I also opened ${PR_NEW} by mistake; you can close it.`);
    expect(text({ kind: 'nothing' }, PR)).not.toContain('by mistake');
  });
});

describe('the reply for an added follow-up (S5)', () => {
  const summary = 'Changed `footer.txt`: the footer heading now reads "Talk to us".';
  const requesterSummary = 'The footer heading now says "Talk to us".';

  it('points to the engineering notes only when they were posted on the PR', () => {
    expect(
      composeChangeReply({
        summary,
        requesterSummary,
        engineerReads: false,
        prUrl: PR,
        externalBlock: '',
        addedTo: true,
      }),
    ).toBe(`Added to ${PR}: ${requesterSummary}\n_The engineering notes are in the PR._`);
    expect(
      composeChangeReply({
        summary,
        requesterSummary,
        engineerReads: false,
        prUrl: PR,
        externalBlock: '',
        addedTo: true,
        notesInPr: false,
      }),
    ).toBe(`Added to ${PR}: ${requesterSummary}`);
  });
});
