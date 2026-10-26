import { describe, expect, it, vi } from 'vitest';
import { landFollowUp } from '../src/workflows/implementationWorkflow.js';
import { composeChangeReply } from '../src/workflows/shared/changeReply.js';
import { STAGING_STATE_KEY } from '../src/workflows/stagingDeployWorkflow.js';

// Issue #730: landing a follow-up whose checks passed. The PR is read again
// first (M2), the commits go onto its branch, and the engineering account goes
// on the PR as a comment (S5).

const PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1484';
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
    const { result, logStep } = land({
      readPr: vi.fn(async () => ({ state: 'OPEN', branch: pr.branch, head: 'start1', crossRepo: false })),
      push,
      reland,
      comment,
    });
    expect(await result).toEqual({ kind: 'added', ontoNewerCommits: false, commented: true, stagingStillOld: false });
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
        readPr: vi.fn(async () => ({ state: 'OPEN', branch: pr.branch, crossRepo: false })),
        push: vi.fn(async () => ({ kind: 'pushed' as const, ontoNewerCommits: true })),
        comment: vi.fn(async () => true),
      },
      store,
    );
    expect(await result).toMatchObject({ kind: 'added', ontoNewerCommits: true, stagingStillOld: true });
  });

  it('a PR merged while the run worked gets a fresh PR from the default branch, never a push to its branch', async () => {
    const push = vi.fn();
    const reland = vi.fn(async () => ({ kind: 'opened' as const, prUrl: `${PR.replace('1484', '1500')}` }));
    const { result, logStep } = land({
      readPr: vi.fn(async () => ({ state: 'MERGED', branch: pr.branch, crossRepo: false })),
      push,
      reland,
      comment: vi.fn(),
    });
    expect(await result).toEqual({
      kind: 'relanded',
      prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1500',
      state: 'MERGED',
    });
    expect(push).not.toHaveBeenCalled();
    expect(reland).toHaveBeenCalledWith(
      expect.objectContaining({ originalPrUrl: PR, originalState: 'MERGED', startHead: 'start1', uniqueTs: '111.30' }),
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'implementation.followup.fallback',
        data: expect.objectContaining({ reason: 'merged' }),
      }),
    );
  });

  it('a rewritten history or a failed push is reported with the side branch, never as added', async () => {
    const rewritten = land({
      readPr: vi.fn(async () => ({ state: 'OPEN', branch: pr.branch, crossRepo: false })),
      push: vi.fn(async () => ({ kind: 'rewritten' as const, wipBranch: 'miniog/followup-wip-111-30' })),
      comment: vi.fn(),
    });
    expect(await rewritten.result).toEqual({ kind: 'rewritten', wipBranch: 'miniog/followup-wip-111-30' });
    expect(rewritten.logStep).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'history_rewritten' }) }),
    );

    const failed = land({
      readPr: vi.fn(async () => undefined),
      push: vi.fn(async () => ({ kind: 'failed' as const, reason: 'push rejected', wipBranch: 'w' })),
      comment: vi.fn(),
    });
    expect(await failed.result).toEqual({ kind: 'failed', reason: 'push rejected', wipBranch: 'w' });
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
