/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { __reviewHttp, submitPrReview } from '../src/github/submitPrReview.js';
import type { AgentFinding } from '../src/agents/types.js';

const originalFetch = globalThis.fetch;

describe('submitPrReview', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Stands in for GitHub. POSTs are answered in order from `posts` (a Response,
   * or an Error to throw). GETs of the reviews list return `reviews` (or fail
   * when it is 'down'), and a review's comments list has `reviewComments` items.
   */
  function github(options: {
    posts: Array<Response | Error>;
    reviews?: Array<Record<string, unknown>> | 'down';
    reviewComments?: number;
    reviewsLink?: string;
  }) {
    const seen: Array<{ method: string; url: string; body: any; signal?: AbortSignal }> = [];
    const queue = [...options.posts];
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      seen.push({
        method,
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        signal: init?.signal ?? undefined,
      });
      if (method === 'POST') {
        const next = queue.shift();
        if (!next) throw new Error('unexpected POST');
        if (next instanceof Error) throw next;
        return next;
      }
      if (/\/reviews\/\d+\/comments/.test(url)) {
        return new Response(JSON.stringify(Array.from({ length: options.reviewComments ?? 0 }, (_, id) => ({ id }))));
      }
      if (options.reviews === 'down') return new Response('Server Error', { status: 500 });
      return new Response(JSON.stringify(options.reviews ?? []), {
        headers: options.reviewsLink && !/[?&]page=/.test(url) ? { link: options.reviewsLink } : {},
      });
    });
    return {
      all: () => seen,
      posts: () => seen.filter(call => call.method === 'POST'),
      gets: () => seen.filter(call => call.method === 'GET'),
    };
  }

  const baseFinding = (severity: AgentFinding['severity'], file?: string, line?: number): AgentFinding => ({
    severity,
    category: 'test',
    message: `Test ${severity} finding`,
    file,
    line,
  });

  it('submits COMMENT when critical findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'security', findings: [baseFinding('critical', 'src/auth.ts', 10)] }],
      summary: 'Found critical issue',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.event).toBe('COMMENT');
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(1);
    expect(result.submissionMode).toBe('inline');
    expect(result.fallbackReason).toBeUndefined();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string);
    expect(body.event).toBe('COMMENT');
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe('src/auth.ts');
    expect(body.comments[0].line).toBe(10);
  });

  it('submits COMMENT when high findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/api.ts', 42)] }],
      summary: 'High severity issue',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('COMMENT');
  });

  it('submits COMMENT when only medium/low findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium', 'src/utils.ts', 5)] }],
      summary: 'Medium issue',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('COMMENT');
    expect(result.submissionMode).toBe('inline');
  });

  it('submits APPROVE when no findings exist', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [] }],
      summary: 'No issues',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('APPROVE');
    expect(result.submissionMode).toBe('summary_only');
  });

  it('submits COMMENT, not APPROVE, when the only findings are the ones written into the body (issue #441)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [] }],
      findingsInBody: 4,
      summary: 'Four low findings, listed here.',
      githubToken: 'ghp_test',
    });

    expect(result.event).toBe('COMMENT');
    expect(JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string).event).toBe('COMMENT');
  });

  it('excludes findings without file/line from inline comments and posts file-only as file-level', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // review
      .mockResolvedValueOnce(new Response('{}', { status: 201 })); // file-level for src/b.ts

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [
        {
          role: 'reviewer',
          findings: [
            baseFinding('medium', 'src/a.ts', 10), // inline
            baseFinding('medium'), // no file → skip entirely
            baseFinding('low', 'src/b.ts', 0), // file-only → file-level
          ],
        },
      ],
      summary: 'Mixed',
      githubToken: 'ghp_test',
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(1);
    expect(result.fileLevelAttempted).toBe(1);
    expect(result.fileLevelPosted).toBe(1);
    expect(result.submissionMode).toBe('inline');
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe('src/a.ts');
  });

  it('posts file-only findings as file-level comments after the review', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // review POST
      .mockResolvedValueOnce(new Response('{}', { status: 201 })); // file-level comment POST

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium'), baseFinding('low', 'src/a.ts', 0)] }],
      summary: 'Summary + file-level',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.attemptedComments).toBe(0);
    expect(result.commentsPosted).toBe(0);
    expect(result.fileLevelAttempted).toBe(1);
    expect(result.fileLevelPosted).toBe(1);
    expect(result.submissionMode).toBe('summary_only');
    expect(result.fallbackReason).toBeUndefined();

    // First call: review POST with empty inline comments.
    const reviewBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
    expect(reviewBody.comments).toHaveLength(0);

    // Second call: the file-level subject_type='file' comment.
    const fileLevelBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]?.body as string);
    expect(fileLevelBody.path).toBe('src/a.ts');
    expect(fileLevelBody.subject_type).toBe('file');
    expect(fileLevelBody.line).toBeUndefined();
  });

  it('returns summary_only with missing_location fallback when no finding has any file', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium'), baseFinding('low')] }],
      summary: 'No locations anywhere',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.attemptedComments).toBe(0);
    expect(result.commentsPosted).toBe(0);
    expect(result.fileLevelAttempted).toBe(0);
    expect(result.submissionMode).toBe('summary_only');
    expect(result.fallbackReason).toBe('missing_location');
  });

  it('returns submitted false when no GitHub token', async () => {
    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 4)] }],
      summary: 'Test',
      githubToken: undefined,
    });

    expect(result.submitted).toBe(false);
    expect(result.attemptedComments).toBe(1);
    expect(result.submissionMode).toBe('skipped');
    expect(result.fallbackReason).toBe('no_token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('retries without inline comments when API rejects', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Validation Failed', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('medium', 'src/a.ts', 999)] }],
      summary: 'Retry test',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(true);
    expect(result.attemptedComments).toBe(1);
    expect(result.commentsPosted).toBe(0);
    expect(result.submissionMode).toBe('summary_only');
    expect(result.fallbackReason).toBe('github_rejected_comments');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    // Second call should have empty comments
    const retryBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]?.body as string);
    expect(retryBody.comments).toHaveLength(0);
  });

  it('retries the body-only fallback once after a transient 5xx, once GitHub confirms it did not land', async () => {
    vi.useFakeTimers();
    try {
      const calls = github({
        posts: [
          new Response('Validation Failed', { status: 422 }), // with inline comments: refused
          new Response('Bad Gateway', { status: 502 }), // body-only #1: transient
          new Response('{}', { status: 200 }), // body-only #2
        ],
        reviews: [],
      });

      const promise = submitPrReview({
        owner: 'Newton-School',
        repo: 'newton-web',
        pullNumber: 123,
        commitId: 'abc123',
        findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 4)] }],
        summary: 'Transient retry test',
        githubToken: 'ghp_test',
      });

      // Drive the 1.5s backoff timer.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.submitted).toBe(true);
      expect(result.submissionMode).toBe('summary_only');
      expect(result.fallbackReason).toBe('github_rejected_comments');
      expect(calls.posts()).toHaveLength(3);
      // The 502 was checked against the PR before the second body-only POST.
      expect(calls.gets()).toHaveLength(1);
      // Both body-only calls should have empty comments.
      expect(calls.posts()[1].body.comments).toHaveLength(0);
      expect(calls.posts()[2].body.comments).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry the body-only fallback again on a deterministic 422', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Validation Failed', { status: 422 })) // initial with comments
      .mockResolvedValueOnce(new Response('Validation Failed', { status: 422 })); // body-only also 422 → no retry

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 4)] }],
      summary: 'Deterministic 422',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(false);
    expect(result.submissionMode).toBe('skipped');
    expect(result.fallbackReason).toBe('github_rejected_comments');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('persists GitHub rejection details to logStep', async () => {
    const logStep = vi.fn();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(new Response('Validation Failed: line out of range', { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 999)] }],
      summary: 'logStep test',
      githubToken: 'ghp_test',
      logStep,
    });

    const rejectionCall = logStep.mock.calls.find(c => c[0]?.stage === 'pr_review.github_review.rejected');
    expect(rejectionCall).toBeDefined();
    const step = rejectionCall![0];
    expect(step.level).toBe('WARN');
    expect(step.data?.status).toBe(422);
    expect(step.data?.errorBody).toContain('Validation Failed: line out of range');
    expect(step.data?.attempt).toContain('inline comments');
    expect(step.data?.owner).toBe('Newton-School');
    expect(step.data?.repo).toBe('newton-web');
    expect(step.data?.pullNumber).toBe(123);
  });

  it('persists thrown errors to logStep', async () => {
    const logStep = vi.fn();
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('socket hang up'));

    await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 1)] }],
      summary: 'throw test',
      githubToken: 'ghp_test',
      logStep,
    });

    const threwCall = logStep.mock.calls.find(c => c[0]?.stage === 'pr_review.github_review.threw');
    expect(threwCall).toBeDefined();
    expect(threwCall![0].data?.error).toContain('socket hang up');
  });

  it('handles fetch errors gracefully', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('network error'));

    const result = await submitPrReview({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 123,
      commitId: 'abc123',
      findingsByRole: [{ role: 'reviewer', findings: [] }],
      summary: 'Test',
      githubToken: 'ghp_test',
    });

    expect(result.submitted).toBe(false);
    expect(result.submissionMode).toBe('skipped');
  });

  describe('a review POST that fails on our side (issue #449)', () => {
    const SUMMARY = '## miniOG review\n\n20 findings.';
    const request = (extra: Record<string, unknown> = {}) => ({
      owner: 'Newton-School',
      repo: 'newton-web',
      pullNumber: 9295,
      commitId: 'head123',
      findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 4)] }],
      summary: SUMMARY,
      githubToken: 'ghp_test',
      ...extra,
    });
    const ourReview = (extra: Record<string, unknown> = {}) => ({
      id: 777,
      commit_id: 'head123',
      body: SUMMARY,
      state: 'COMMENTED',
      submitted_at: new Date().toISOString(),
      ...extra,
    });
    const saved = { ...__reviewHttp };
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
    afterEach(() => {
      vi.useRealTimers();
      Object.assign(__reviewHttp, saved);
    });
    const run = async (params: ReturnType<typeof request>) => {
      const promise = submitPrReview(params);
      await vi.advanceTimersByTimeAsync(5000);
      return promise;
    };

    it('finds the review on the PR after the response was lost, and does not post it again', async () => {
      // The incident: on GitHub one second after it was sent, with 16 inline
      // comments; the client gave up five minutes later and said "skipped".
      const calls = github({ posts: [new TypeError('fetch failed')], reviews: [ourReview()], reviewComments: 16 });
      const logStep = vi.fn();

      const result = await run(request({ logStep }));

      expect(result).toMatchObject({ submitted: true, commentsPosted: 16, submissionMode: 'inline' });
      expect(result.failureReason).toBeUndefined();
      expect(calls.posts()).toHaveLength(1);
      expect(logStep).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'pr_review.github_review.landed_after_error' }),
      );
    });

    it('finds it after a 5xx too', async () => {
      const calls = github({
        posts: [new Response('Bad Gateway', { status: 502 })],
        reviews: [ourReview()],
        reviewComments: 1,
      });

      const result = await run(request());

      expect(result).toMatchObject({ submitted: true, commentsPosted: 1 });
      expect(calls.posts()).toHaveLength(1);
    });

    it('posts again, once, when GitHub confirms the review is not there', async () => {
      const calls = github({
        posts: [new TypeError('fetch failed'), new Response('{}', { status: 200 })],
        reviews: [],
      });

      const result = await run(request());

      expect(result).toMatchObject({ submitted: true, commentsPosted: 1, submissionMode: 'inline' });
      expect(calls.posts()).toHaveLength(2);
      // The retry carries the inline comments: a failed connection is not a refused comment.
      expect(calls.posts()[1].body.comments).toHaveLength(1);
    });

    it('does not take another review for ours: a different commit, a different body, or an old one', async () => {
      const calls = github({
        posts: [new TypeError('fetch failed'), new Response('{}', { status: 200 })],
        reviews: [
          ourReview({ id: 1, commit_id: 'older-head' }),
          ourReview({ id: 2, body: 'someone else said this' }),
          ourReview({ id: 3, submitted_at: new Date(Date.now() - 3_600_000).toISOString() }),
        ],
      });

      const result = await run(request());

      expect(calls.posts()).toHaveLength(2);
      expect(result.submitted).toBe(true);
    });

    it('never retries blind: if GitHub cannot be asked, it says it could not confirm', async () => {
      const calls = github({ posts: [new TypeError('fetch failed')], reviews: 'down' });
      const logStep = vi.fn();

      const result = await run(request({ logStep }));

      expect(result).toMatchObject({
        submitted: false,
        submissionMode: 'skipped',
        unconfirmed: true,
        failureReason: 'network error (fetch failed)',
      });
      expect(calls.posts()).toHaveLength(1);
      expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pr_review.github_review.unconfirmed' }));
    });

    it('reports why when the retry fails as well, and that nothing is on the PR', async () => {
      const calls = github({
        posts: [new Response('Bad Gateway', { status: 502 }), new Response('Bad Gateway', { status: 502 })],
        reviews: [],
      });

      const result = await run(request());

      expect(result).toMatchObject({ submitted: false, failureReason: 'HTTP 502' });
      expect(result.unconfirmed).toBeUndefined();
      expect(calls.posts()).toHaveLength(2);
    });

    it('gives up on a POST after its timeout instead of waiting out the runtime default', async () => {
      vi.useRealTimers();
      __reviewHttp.postTimeoutMs = 40;
      const seen: AbortSignal[] = [];
      vi.mocked(globalThis.fetch).mockImplementation((_input, init) => {
        if (init?.method !== 'POST') return Promise.resolve(new Response('[]'));
        seen.push(init.signal as AbortSignal);
        // Never answers: only the caller's own timeout ends this.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      });
      const startedAt = Date.now();

      const result = await submitPrReview(request());

      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(result.submitted).toBe(false);
      expect(result.failureReason).toMatch(/^timed out after/);
      // Two attempts of 40 ms and one 1.5 s pause: seconds, not minutes.
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it('treats a rate limit as not applied: no check, one retry', async () => {
      const calls = github({
        posts: [new Response('slow down', { status: 429 }), new Response('{}', { status: 200 })],
      });

      const result = await run(request());

      expect(result.submitted).toBe(true);
      expect(calls.gets()).toHaveLength(0);
      expect(calls.posts()).toHaveLength(2);
    });

    it('looks on the last page of a long review list, where the newest reviews are', async () => {
      const last = 'https://api.github.com/repos/Newton-School/newton-web/pulls/9295/reviews?per_page=100&page=3';
      const calls = github({
        posts: [new TypeError('fetch failed')],
        reviews: [ourReview()],
        reviewsLink: `<${last}>; rel="last"`,
      });

      const result = await run(request());

      expect(result.submitted).toBe(true);
      expect(calls.gets().map(call => call.url)).toContain(last);
    });

    it('still falls back to the body alone when GitHub refuses the comments, without asking whether it landed', async () => {
      const calls = github({
        posts: [new Response('Validation Failed', { status: 422 }), new Response('{}', { status: 200 })],
      });

      const result = await run(request());

      expect(result).toMatchObject({ submitted: true, submissionMode: 'summary_only', commentsPosted: 0 });
      expect(calls.gets()).toHaveLength(0);
    });
  });

  describe('with prDiff pre-validation', () => {
    const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 context
+added line
 keep
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,2 +5,3 @@
 x
+y
 z
`;

    it('drops inline comments whose lines are outside the diff hunks and keeps the valid ones', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await submitPrReview({
        owner: 'Newton-School',
        repo: 'newton-web',
        pullNumber: 123,
        commitId: 'abc123',
        findingsByRole: [
          {
            role: 'reviewer',
            findings: [
              baseFinding('high', 'src/a.ts', 2), // in hunk 1 → keep
              baseFinding('high', 'src/a.ts', 50), // outside diff → drop
              baseFinding('medium', 'src/b.ts', 6), // in hunk → keep
              baseFinding('low', 'src/c.ts', 1), // file not in diff → drop
            ],
          },
        ],
        summary: 'Mixed validity',
        githubToken: 'ghp_test',
        prDiff: DIFF,
      });

      expect(result.submitted).toBe(true);
      expect(result.attemptedComments).toBe(2);
      expect(result.commentsPosted).toBe(2);
      expect(result.droppedOutsideDiff).toBe(2);
      expect(result.submissionMode).toBe('inline');

      const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string);
      expect(body.comments).toHaveLength(2);
      expect(body.comments.map((c: { path: string }) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('posts file-level comments only when the file is in the diff', async () => {
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // review
        .mockResolvedValueOnce(new Response('{}', { status: 201 })); // file-level for src/a.ts

      const result = await submitPrReview({
        owner: 'Newton-School',
        repo: 'newton-web',
        pullNumber: 123,
        commitId: 'abc123',
        findingsByRole: [
          {
            role: 'reviewer',
            findings: [
              baseFinding('medium', 'src/a.ts'), // file-only, file in diff → post file-level
              baseFinding('medium', 'src/missing.ts'), // file-only, file NOT in diff → drop entirely
            ],
          },
        ],
        summary: 'file-level fan-out',
        githubToken: 'ghp_test',
        prDiff: DIFF,
      });

      expect(result.attemptedComments).toBe(0);
      expect(result.fileLevelAttempted).toBe(1);
      expect(result.fileLevelPosted).toBe(1);
      expect(result.submissionMode).toBe('summary_only');

      // Second fetch is the file-level POST.
      expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(2);
      const fileLevelUrl = vi.mocked(globalThis.fetch).mock.calls[1][0];
      expect(String(fileLevelUrl)).toContain('/pulls/123/comments');
      const fileLevelBody = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]?.body as string);
      expect(fileLevelBody.path).toBe('src/a.ts');
      expect(fileLevelBody.subject_type).toBe('file');
    });

    it('still falls back to summary-only if GitHub 422s despite pre-validation (diff drift)', async () => {
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(new Response('Validation Failed', { status: 422 })) // first review POST with comments
        .mockResolvedValueOnce(new Response('{}', { status: 200 })); // retry without comments

      const result = await submitPrReview({
        owner: 'Newton-School',
        repo: 'newton-web',
        pullNumber: 123,
        commitId: 'abc123',
        findingsByRole: [{ role: 'reviewer', findings: [baseFinding('high', 'src/a.ts', 2)] }],
        summary: 'Diff drift',
        githubToken: 'ghp_test',
        prDiff: DIFF,
      });

      expect(result.submitted).toBe(true);
      expect(result.attemptedComments).toBe(1);
      expect(result.commentsPosted).toBe(0);
      expect(result.submissionMode).toBe('summary_only');
      expect(result.fallbackReason).toBe('github_rejected_comments');
    });
  });
});
