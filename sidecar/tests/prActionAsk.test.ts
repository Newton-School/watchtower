import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPrActionAsk } from '../src/router/prActionAsk.js';
import { mergeProtectionNote } from '../src/workflows/implementationWorkflow.js';
import { fetchChecksState, fetchMergeState, fetchUnresolvedReviewThreadCount } from '../src/github/prReviewComments.js';
import type { NormalizedTask, PrTarget } from '../src/types/contracts.js';

// Issue #605: "merge the pr" ran a 3.5-minute planner before the merge. A
// message that is only an operation on one known pull request skips it.

const pr = (number: number, source: PrTarget['source'], repo = 'newton-marketing-web'): PrTarget => ({
  url: `https://github.com/Newton-School/${repo}/pull/${number}`,
  owner: 'Newton-School',
  repo,
  number,
  source,
});

const addressees = { botUserId: 'UBOT1', ownerUserIds: ['UOWNER1'] };

const ask = (
  text: string,
  prContexts: PrTarget[] = [pr(1404, 'thread')],
  mentionType: NormalizedTask['mentionType'] = 'bot',
) =>
  readPrActionAsk(
    {
      event: { eventId: 'Ev1', channelId: 'C1', threadTs: '1.1', eventTs: '1.2', userId: 'U1', text, rawEvent: {} },
      prContexts,
      prContext: prContexts[0],
      mentionType,
    },
    addressees,
  );

describe('readPrActionAsk', () => {
  it.each([
    ['<@UBOT1> merge the pr', 'merge'],
    ['<@UBOT1> can you merge this PR please?', 'merge'],
    ['<@UBOT1> could u merge it', 'merge'],
    ['<@UBOT1> lgtm, squash and merge it 🙏', 'merge'],
    ['<@UBOT1> merge it :pray:', 'merge'],
    ['<@UBOT1> go ahead and merge it into main, thanks!', 'merge'],
    ['<@UBOT1> merge it for me', 'merge'],
    ['<@UBOT1> sync it', 'sync'],
    ['<@UBOT1> sync the branch with master', 'sync'],
    ['<@UBOT1> sync it with the base branch', 'sync'],
    ['<@UBOT1> close this PR', 'close'],
  ])('reads %s as only a %s', (text, action) => {
    expect(ask(text)).toEqual({
      action,
      pr: {
        url: 'https://github.com/Newton-School/newton-marketing-web/pull/1404',
        owner: 'Newton-School',
        repo: 'newton-marketing-web',
        number: 1404,
      },
    });
  });

  it.each([
    '<@UBOT1> merge it and also fix the typo in the title',
    '<@UBOT1> merge once CI is green',
    '<@UBOT1> should we merge this?',
    '<@UBOT1> is it merged?',
    "<@UBOT1> don't merge it yet",
    '<@UBOT1> merge and close',
    '<@UBOT1> merge and deploy it',
    '<@UBOT1> approve and merge',
    '<@UBOT1> revert this PR',
    '<@UBOT1> close the issue',
    '<@UBOT1> merge main into it',
    '<@UBOT1> merge constructor',
    '<@UBOT1> merge toString',
    '<@UBOT1> thanks!',
  ])('leaves %s to the planner', text => {
    expect(ask(text)).toBeUndefined();
  });

  it.each([
    ['a question about the PR', '<@UBOT1> can it merge?'],
    ['a question about the PR, without the question mark', '<@UBOT1> will this merge'],
    ['a bare question', '<@UBOT1> merge?'],
    ['a meeting, not a branch', '<@UBOT1> can you sync up with me'],
    ['a preposition before something other than a branch', '<@UBOT1> merge it with care'],
  ])('reads %s as no order', (_case, text) => {
    expect(ask(text)).toBeUndefined();
  });

  it('reads nothing into words in another script', () => {
    // "don't merge" in Hindi: only "merge" would survive the ASCII clean-up.
    expect(ask('<@UBOT1> merge मत करो')).toBeUndefined();
    expect(ask('<@UBOT1> merge it, gracias señor')).toBeUndefined();
  });

  it.each([
    ['an issue', 'close <https://github.com/Newton-School/newton-web/issues/77>'],
    ['a ticket', 'close <https://jira.example.com/browse/NW-123|NW-123>'],
    ['a branch', 'merge <https://github.com/Newton-School/newton-web/tree/feature-x>'],
    ['a pasted link', 'merge https://github.com/Newton-School/newton-web/tree/feature-x'],
    ['a PR the message does not link', 'merge <https://github.com/Newton-School/newton-web/pull/9999>'],
    ['a channel', 'merge it in <#C123|general>'],
    ['a user group', 'merge it <!subteam^S1|@core-dev>'],
  ])('does not pick the thread PR when the message links %s', (_case, text) => {
    expect(ask(`<@UBOT1> ${text}`)).toBeUndefined();
  });

  it('leaves a message that mentions someone else to the planner', () => {
    expect(ask('<@UBOT1> <@UALICE> merge it')).toBeUndefined();
    expect(ask('<@UALICE> merge it')).toBeUndefined();
  });

  it("takes the owner's tag when that is how the ask reached miniOG", () => {
    expect(ask('<@UOWNER1> merge it', undefined, 'owner')).toMatchObject({ action: 'merge' });
    expect(ask('<@UOWNER1> merge it', undefined, 'bot')).toBeUndefined();
  });

  it('needs a pull request to act on', () => {
    expect(ask('<@UBOT1> merge it', [])).toBeUndefined();
  });

  it('takes the PR linked in the message over the ones earlier in the thread', () => {
    const linked = pr(1406, 'trigger');
    expect(ask(`<@UBOT1> merge <${linked.url}|#1406>`, [linked, pr(1404, 'thread')])?.pr.number).toBe(1406);
    expect(ask(`<@UBOT1> merge ${linked.url}/files.`, [linked, pr(1404, 'thread')])?.pr.number).toBe(1406);
  });

  it('does not take a link to an earlier PR as the one the message links', () => {
    const earlier = pr(1404, 'thread');
    expect(ask(`<@UBOT1> merge <${earlier.url}>`, [earlier])).toBeUndefined();
  });

  it('does not guess between two PRs in the thread', () => {
    expect(ask('<@UBOT1> merge it', [pr(1404, 'thread'), pr(1406, 'thread')])).toBeUndefined();
    expect(ask('<@UBOT1> merge both', [pr(1404, 'trigger'), pr(1406, 'trigger')])).toBeUndefined();
  });

  it('takes the PR named by number, and only one the thread knows', () => {
    const thread = [pr(1404, 'thread'), pr(1406, 'thread')];
    expect(ask('<@UBOT1> merge #1406', thread)?.pr.number).toBe(1406);
    expect(ask('<@UBOT1> merge PR 1406 please', thread)?.pr.number).toBe(1406);
    expect(ask('<@UBOT1> merge #1500', thread)).toBeUndefined();
    expect(ask('<@UBOT1> merge 1404 and 1406', thread)).toBeUndefined();
    // The same number in two repos is two PRs.
    expect(ask('<@UBOT1> merge #1404', [pr(1404, 'thread'), pr(1404, 'thread', 'newton-web')])).toBeUndefined();
  });

  it('reads the ask, not the words inside a link or a forwarding footer', () => {
    const syncTool = pr(3, 'trigger', 'sync-tool');
    expect(ask(`<@UBOT1> merge <${syncTool.url}|sync-tool#3>`, [syncTool])).toMatchObject({ action: 'merge' });
    expect(ask(`<@UBOT1> merge ${syncTool.url}`, [syncTool])).toMatchObject({ action: 'merge' });
    expect(ask('merge it\n*Sent using* <@UOTHER>')).toMatchObject({ action: 'merge' });
  });
});

describe('mergeProtectionNote', () => {
  it('says a merge past a required review uses admin rights', () => {
    expect(mergeProtectionNote({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })).toBe(
      'It still needs an approving review, so merging now uses admin rights.',
    );
    expect(mergeProtectionNote({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' })).toBe(
      'A reviewer asked for changes, so merging now uses admin rights.',
    );
    expect(mergeProtectionNote({ reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' })).toBe(
      'Branch protection still blocks it, so merging now uses admin rights.',
    );
  });

  it('says a PR with conflicts cannot be merged, instead of claiming admin rights will do it', () => {
    expect(mergeProtectionNote({ mergeStateStatus: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED' })).toBe(
      "It has conflicts, so it can't be merged yet.",
    );
  });

  it('says when the branch is behind, or a draft', () => {
    expect(mergeProtectionNote({ mergeStateStatus: 'BEHIND' })).toBe(
      "It's behind the base branch, so merging now skips the up-to-date rule.",
    );
    expect(mergeProtectionNote({ mergeStateStatus: 'DRAFT', isDraft: true, reviewDecision: 'REVIEW_REQUIRED' })).toBe(
      "It's still a draft.",
    );
  });

  it("says it couldn't check, rather than nothing, when GitHub could not say", () => {
    expect(mergeProtectionNote(undefined)).toBe("I couldn't check branch protection.");
    expect(mergeProtectionNote({ mergeStateStatus: 'UNKNOWN' })).toBe("I couldn't check branch protection.");
    expect(mergeProtectionNote({})).toBe("I couldn't check branch protection.");
    // A required review is known while the rest is still being worked out.
    expect(mergeProtectionNote({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED' })).toBe(
      'It still needs an approving review, so merging now uses admin rights.',
    );
  });

  it('says nothing when nothing stands in the way', () => {
    expect(mergeProtectionNote({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })).toBe('');
    expect(mergeProtectionNote({ mergeStateStatus: 'CLEAN', isDraft: false })).toBe('');
    expect(mergeProtectionNote({ mergeStateStatus: 'UNSTABLE' })).toBe('');
  });
});

describe('fetchMergeState', () => {
  const target = { owner: 'Newton-School', repo: 'newton-web', pullNumber: 9300, githubToken: 'ghs_test' };
  const answer = (pullRequest: unknown, status = 200) =>
    new Response(JSON.stringify({ data: { repository: { pullRequest } } }), { status });

  afterEach(() => vi.unstubAllGlobals());

  it('reads an UNKNOWN state once more, since GitHub computes it lazily', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(answer({ reviewDecision: null, mergeStateStatus: 'UNKNOWN', isDraft: false }))
      .mockResolvedValueOnce(answer({ reviewDecision: null, mergeStateStatus: 'BEHIND', isDraft: false }));

    const state = await fetchMergeState({ ...target, fetcher: fetcher as never, retryDelayMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state).toEqual({ mergeStateStatus: 'BEHIND', isDraft: false });
  });

  it('keeps UNKNOWN when the second read says it too, and reads no more', async () => {
    const fetcher = vi.fn(async () => answer({ mergeStateStatus: 'UNKNOWN', isDraft: false }));

    const state = await fetchMergeState({ ...target, fetcher: fetcher as never, retryDelayMs: 0 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state?.mergeStateStatus).toBe('UNKNOWN');
  });

  it('keeps the first read when the second one fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(answer({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED' }))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    const state = await fetchMergeState({ ...target, fetcher: fetcher as never, retryDelayMs: 0 });

    expect(state).toEqual({ mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED' });
  });

  it('is undefined when GitHub refuses or errors', async () => {
    expect(
      await fetchMergeState({ ...target, fetcher: vi.fn().mockResolvedValue(answer(null, 502)) as never }),
    ).toBeUndefined();
    expect(
      await fetchMergeState({ ...target, fetcher: vi.fn().mockRejectedValue(new Error('ECONNRESET')) as never }),
    ).toBeUndefined();
  });

  it('cannot empty the unresolved-comments count: the two are separate queries', async () => {
    // A merge-state field GitHub refuses nulls its whole pullRequest; the
    // review threads, read on their own, still come back.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) =>
        init.body.includes('mergeStateStatus')
          ? new Response(
              JSON.stringify({
                errors: [{ message: 'Resource not accessible' }],
                data: { repository: { pullRequest: null } },
              }),
            )
          : answer({ reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }], totalCount: 2 } }),
      ),
    );

    expect(await fetchUnresolvedReviewThreadCount(target)).toEqual({ unresolvedCount: 1, totalThreads: 2 });
    expect(await fetchMergeState({ ...target, retryDelayMs: 0 })).toBeUndefined();
  });
});

// Issue #701: a content-only merge without the owner needs to know the checks
// passed and the review threads were read, not just a count of 0.
describe('fetchChecksState', () => {
  const target = { owner: 'Newton-School', repo: 'newton-marketing-web', sha: 'abc123', githubToken: 'ghs_test' };
  const answer = (object: unknown, extra: Record<string, unknown> = {}, status = 200) =>
    new Response(JSON.stringify({ ...extra, data: { repository: { object } } }), { status });
  const read = (fetcher: unknown) => fetchChecksState({ ...target, fetcher: fetcher as never });

  it('reads the combined state of the commit it is given, and null when it has no checks', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer({ statusCheckRollup: { state: 'SUCCESS' } }));
    expect(await read(fetcher)).toBe('SUCCESS');
    expect(JSON.parse(fetcher.mock.calls[0][1].body).variables).toEqual({
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      oid: 'abc123',
    });
    expect(await read(vi.fn().mockResolvedValue(answer({ statusCheckRollup: null })))).toBeNull();
  });

  it('is undefined, not "no checks", when the commit or the field cannot be read', async () => {
    expect(await read(vi.fn().mockResolvedValue(answer(null)))).toBeUndefined();
    // Not a commit: the field is absent rather than null.
    expect(await read(vi.fn().mockResolvedValue(answer({})))).toBeUndefined();
    expect(
      await read(
        vi.fn().mockResolvedValue(answer({ statusCheckRollup: null }, { errors: [{ message: 'Not accessible' }] })),
      ),
    ).toBeUndefined();
    expect(await read(vi.fn().mockResolvedValue(answer(null, {}, 502)))).toBeUndefined();
    expect(await read(vi.fn().mockRejectedValue(new Error('ECONNRESET')))).toBeUndefined();
  });
});

describe('fetchMergeState: the head commit', () => {
  it('says which commit the state describes, so a merge can be pinned to the one that was read', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewDecision: 'REVIEW_REQUIRED',
                mergeStateStatus: 'BLOCKED',
                isDraft: false,
                headRefOid: 'abc123',
              },
            },
          },
        }),
      ),
    );

    const state = await fetchMergeState({
      owner: 'Newton-School',
      repo: 'newton-marketing-web',
      pullNumber: 1490,
      githubToken: 'ghs_test',
      fetcher: fetcher as never,
      retryDelayMs: 0,
    });

    expect(state).toEqual({
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED',
      isDraft: false,
      headSha: 'abc123',
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).query).toContain('headRefOid');
  });
});

describe('fetchUnresolvedReviewThreadCount', () => {
  const target = { owner: 'Newton-School', repo: 'newton-marketing-web', pullNumber: 1490, githubToken: 'ghs_test' };
  afterEach(() => vi.unstubAllGlobals());

  it('marks a count it could not read, so a merge that needs it knows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    expect(await fetchUnresolvedReviewThreadCount(target)).toEqual({
      unresolvedCount: 0,
      totalThreads: 0,
      failed: true,
    });
  });

  it('marks a count from more threads than it read (the first 100)', async () => {
    const nodes = Array.from({ length: 100 }, () => ({ isResolved: true }));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, totalCount: 140 } } } } }),
          ),
      ),
    );

    expect(await fetchUnresolvedReviewThreadCount(target)).toEqual({
      unresolvedCount: 0,
      totalThreads: 140,
      incomplete: true,
    });
  });
});
