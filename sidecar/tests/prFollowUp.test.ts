import { describe, expect, it, vi } from 'vitest';
import type { PrFollowUpState } from '../src/github/prFollowUp.js';
import { fetchPrFollowUpState } from '../src/github/prFollowUp.js';
import {
  buildFollowUpLine,
  followUpStateKey,
  parsePrUrl,
  runPrFollowUp,
  type TrackedPr,
} from '../src/workflows/prFollowUp.js';

const now = Date.parse('2026-10-19T04:30:00Z');
const url = 'https://github.com/Newton-School/newton-marketing-web/pull/1406';
const BOT = '<@UBOT>';

function open(overrides: Partial<PrFollowUpState> = {}): PrFollowUpState {
  return {
    state: 'open',
    title: 'Students placed in AI firms 30% → 31%',
    createdAt: '2026-10-17T04:30:00Z',
    mergeableState: 'clean',
    reviews: [],
    requestedReviewers: [],
    baseRef: 'main',
    headRef: 'munazza/ai-firms-31',
    ...overrides,
  };
}

describe('parsePrUrl', () => {
  it('reads owner, repo and number, and refuses anything else', () => {
    expect(parsePrUrl(url)).toMatchObject({ owner: 'Newton-School', repo: 'newton-marketing-web', number: 1406 });
    expect(parsePrUrl('https://github.com/Newton-School/newton-web/pull/9354/files')).toMatchObject({ number: 9354 });
    expect(parsePrUrl('N/A')).toBeUndefined();
    expect(parsePrUrl('https://github.com/Newton-School/newton-web/issues/1')).toBeUndefined();
  });
});

describe('buildFollowUpLine', () => {
  it('says how long it has waited, that nobody has reviewed, and offers a sync when it conflicts', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ mergeableState: 'dirty' }),
        now,
        mergeMention: '<!subteam^S1>',
        botMention: BOT,
      }),
    ).toBe(
      `PR #1406 is still open for 2 days: ${url} No review yet. It conflicts with main; reply \`<@UBOT> sync it\` and I'll merge main into it.`,
    );
  });

  it('names the reviewer it waits on', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ requestedReviewers: ['kapatia'] }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      }),
    ).toBe(`PR #1406 is still open for 2 days: ${url} Waiting on a review from kapatia.`);
  });

  it('says changes were requested, and by whom', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ reviews: [{ login: 'mihir', state: 'CHANGES_REQUESTED' }] }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      }),
    ).toBe(`PR #1406 is still open for 2 days: ${url} Changes were requested by mihir.`);
  });

  it('tells the admins an approved, clean PR is ready to merge', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ reviews: [{ login: 'kapatia', state: 'APPROVED' }], createdAt: '2026-10-18T09:00:00Z' }),
        now,
        mergeMention: '<!subteam^S1>',
        botMention: BOT,
      }),
    ).toBe(
      `PR #1406 is still open since yesterday: ${url} Approved by kapatia. <!subteam^S1> it is ready to merge: reply \`<@UBOT> merge it\` when you want it in.`,
    );
  });

  it('offers a sync when the branch is behind', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ mergeableState: 'behind' }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      }),
    ).toContain("It is behind main; reply `<@UBOT> sync it` and I'll bring it up to date.");
  });

  it('does not call a draft, a red, or a blocked PR ready to merge', () => {
    const approved = [{ login: 'kapatia', state: 'APPROVED' as const }];
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ reviews: approved, draft: true }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      }),
    ).toBe(`PR #1406 is still open for 2 days: ${url} It is still a draft.`);
    for (const mergeableState of ['unstable', 'blocked', 'unknown']) {
      const text = buildFollowUpLine({
        prUrl: url,
        state: open({ reviews: approved, mergeableState }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      });
      expect(text).toBe(`PR #1406 is still open for 2 days: ${url} Approved by kapatia.`);
    }
  });

  it('names a team the review was requested from', () => {
    expect(
      buildFollowUpLine({
        prUrl: url,
        state: open({ requestedReviewers: ['team core-dev'] }),
        now,
        mergeMention: 'x',
        botMention: BOT,
      }),
    ).toContain('Waiting on a review from team core-dev.');
  });

  it('says nothing for a merged or closed PR', () => {
    expect(
      buildFollowUpLine({ prUrl: url, state: open({ state: 'merged' }), now, mergeMention: 'x', botMention: BOT }),
    ).toBeUndefined();
    expect(
      buildFollowUpLine({ prUrl: url, state: open({ state: 'closed' }), now, mergeMention: 'x', botMention: BOT }),
    ).toBeUndefined();
  });
});

describe('runPrFollowUp', () => {
  function makeStore(prs: TrackedPr[]) {
    const state = new Map<string, string>();
    return {
      state,
      store: {
        listChangeRunPrs: vi.fn(() => prs),
        getState: (key: string) => state.get(key),
        setState: (key: string, value: string) => void state.set(key, value),
      },
    };
  }
  const tracked = (prUrl: string, threadTs: string): TrackedPr => ({
    jobId: `job-${threadTs}`,
    channelId: 'C1',
    threadTs,
    prUrl,
    createdAt: '2026-10-16T08:00:00Z',
  });
  const github = (byNumber: Record<number, Record<string, unknown>>) =>
    vi.fn(async (input: string) => {
      const match = /pulls\/(\d+)(\/reviews)?/.exec(input);
      const pr = byNumber[Number(match?.[1])];
      if (!pr) return new Response('not found', { status: 404 });
      if (match?.[2]) return Response.json([]);
      return Response.json(pr);
    });

  it('posts one line per open PR in its own thread, once a day, and forgets a merged one', async () => {
    const other = 'https://github.com/Newton-School/newton-web/pull/9354';
    const { store, state } = makeStore([tracked(url, '100.1'), tracked(other, '200.2')]);
    const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
    const fetcher = github({
      1406: {
        state: 'open',
        created_at: '2026-10-17T04:30:00Z',
        mergeable_state: 'dirty',
        requested_reviewers: [],
        base: { ref: 'main' },
      },
      9354: { state: 'closed', merged: true, merged_at: '2026-10-18T00:00:00Z' },
    });

    const first = await runPrFollowUp({
      store,
      slack: slack as never,
      mergeMention: 'x',
      now,
      dateKey: '2026-10-19',
      fetcher,
    });

    expect(first).toEqual({ posted: 1, closed: 1, skipped: 0 });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0]).toMatchObject({ channel: 'C1', thread_ts: '100.1' });
    expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('PR #1406 is still open for 2 days');
    expect(state.get(followUpStateKey(url))).toBe('2026-10-19');
    expect(state.get(followUpStateKey(other))).toBe('done');

    const again = await runPrFollowUp({
      store,
      slack: slack as never,
      mergeMention: 'x',
      now,
      dateKey: '2026-10-19',
      fetcher,
    });
    expect(again).toEqual({ posted: 0, closed: 0, skipped: 2 });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);

    const tomorrow = await runPrFollowUp({
      store,
      slack: slack as never,
      mergeMention: 'x',
      now: now + 86_400_000,
      dateKey: '2026-10-20',
      fetcher,
    });
    expect(tomorrow.posted).toBe(1);
  });

  it('leaves a PR GitHub could not describe for the next day, and never reads one twice in a pass', async () => {
    const { store, state } = makeStore([tracked(url, '100.1'), tracked(url, '100.1')]);
    const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
    const fetcher = github({});

    const result = await runPrFollowUp({
      store,
      slack: slack as never,
      mergeMention: 'x',
      now,
      dateKey: '2026-10-19',
      fetcher,
    });

    expect(result).toEqual({ posted: 0, closed: 0, skipped: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.has(followUpStateKey(url))).toBe(false);
  });
});

describe('fetchPrFollowUpState', () => {
  it('reads again when GitHub has not computed mergeability yet, and names requested teams', async () => {
    let reads = 0;
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith('/reviews?per_page=100')) return Response.json([]);
      reads += 1;
      return Response.json({
        state: 'open',
        mergeable: reads === 1 ? null : false,
        mergeable_state: reads === 1 ? 'unknown' : 'dirty',
        requested_reviewers: [],
        requested_teams: [{ slug: 'core-dev' }],
        base: { ref: 'main' },
      });
    });

    const state = await fetchPrFollowUpState({ owner: 'o', repo: 'r', number: 1, fetcher, retryDelayMs: 0 });

    expect(reads).toBe(2);
    expect(state).toMatchObject({ mergeableState: 'dirty', requestedReviewers: ['team core-dev'], draft: false });
  });

  it('keeps the latest review per person, worst first, and the reviewers still asked', async () => {
    const fetcher = vi.fn(async (input: string) => {
      if (input.endsWith('/reviews?per_page=100')) {
        return Response.json([
          { user: { login: 'a' }, state: 'COMMENTED' },
          { user: { login: 'b' }, state: 'APPROVED' },
          { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
          { user: { login: 'b' }, state: 'COMMENTED' },
        ]);
      }
      return Response.json({
        state: 'open',
        title: 't',
        created_at: '2026-10-16T08:05:00Z',
        mergeable_state: 'clean',
        requested_reviewers: [{ login: 'c' }],
        base: { ref: 'main' },
        head: { ref: 'x' },
      });
    });

    const state = await fetchPrFollowUpState({ owner: 'o', repo: 'r', number: 1, fetcher });

    expect(state).toMatchObject({
      state: 'open',
      mergeableState: 'clean',
      requestedReviewers: ['c'],
      reviews: [
        { login: 'a', state: 'CHANGES_REQUESTED' },
        { login: 'b', state: 'APPROVED' },
      ],
    });
  });
});
