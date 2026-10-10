import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPrState } from '../src/github/prReviewSupport.js';
import { buildNotOpenReply, wantsPostMergeReview } from '../src/agentic/agenticPrReview.js';

const prContext = {
  url: 'https://github.com/Newton-School/newton-api/pull/6436',
  owner: 'Newton-School',
  repo: 'newton-api',
  number: 6436,
};

function githubReturns(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPrState', () => {
  it('reports a merged PR with its merge time', async () => {
    const fetchMock = githubReturns({ state: 'closed', merged: true, merged_at: '2026-10-06T09:12:00Z' });

    expect(await fetchPrState({ prContext, githubToken: 'ghs_test' })).toEqual({
      state: 'merged',
      at: '2026-10-06T09:12:00Z',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/Newton-School/newton-api/pulls/6436');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('tells closed-without-merging apart from merged', async () => {
    githubReturns({ state: 'closed', merged: false, merged_at: null, closed_at: '2026-10-05T10:00:00Z' });
    expect(await fetchPrState({ prContext })).toEqual({ state: 'closed', at: '2026-10-05T10:00:00Z' });
  });

  it('reports an open PR', async () => {
    githubReturns({ state: 'open', merged: false });
    expect(await fetchPrState({ prContext })).toEqual({ state: 'open' });
  });

  it('returns undefined, and logs, when GitHub refuses or cannot be reached', async () => {
    const logs: string[] = [];
    githubReturns({ message: 'Not Found' }, 404);
    expect(await fetchPrState({ prContext, logStep: entry => logs.push(entry.stage) })).toBeUndefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    expect(await fetchPrState({ prContext, logStep: entry => logs.push(entry.stage) })).toBeUndefined();
    expect(logs).toEqual(['pr_review.state.fetch_failed', 'pr_review.state.fetch_failed']);
  });

  it('returns undefined for a payload it does not recognise', async () => {
    githubReturns({ state: 'draft-ish' });
    expect(await fetchPrState({ prContext })).toBeUndefined();
  });
});

describe('wantsPostMergeReview', () => {
  it('needs the requester to say so', () => {
    expect(wantsPostMergeReview('post-merge review https://github.com/o/r/pull/1')).toBe(true);
    expect(wantsPostMergeReview('postmerge review please')).toBe(true);
    expect(wantsPostMergeReview('review it anyway')).toBe(true);
  });

  it('is false for an ordinary review ask or a question', () => {
    expect(wantsPostMergeReview('review https://github.com/o/r/pull/1')).toBe(false);
    expect(wantsPostMergeReview('is this merged and deployed?')).toBe(false);
  });
});

describe('buildNotOpenReply', () => {
  const target = { ...prContext, source: 'trigger' as const };

  it('names the PR, what happened to it and when, and how to get a review or an answer', () => {
    const reply = buildNotOpenReply([{ target, state: { state: 'merged', at: '2026-10-06T09:12:00Z' } }]);
    expect(reply).toBe(
      "`newton-api#6436` is already merged (2026-10-06), so I haven't reviewed it. For a post-merge review, say `post-merge review https://github.com/Newton-School/newton-api/pull/6436`. If you had a question about it instead, @ me with the question and I'll answer.",
    );
  });

  it('covers several PRs in one message', () => {
    const other = {
      ...target,
      url: 'https://github.com/Newton-School/newton-web/pull/9',
      repo: 'newton-web',
      number: 9,
    };
    const reply = buildNotOpenReply([
      { target, state: { state: 'merged' } },
      { target: other, state: { state: 'closed' } },
    ]);
    expect(reply).toContain('`newton-api#6436` is already merged; `newton-web#9` is closed without merging');
    expect(reply).toContain("so I haven't reviewed either.");
    expect(reply).toContain('question about them instead');
  });
});
