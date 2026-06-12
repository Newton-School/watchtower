import { describe, expect, it } from 'vitest';
import { decidePausedResume } from '../src/router/pausedResume.js';

describe('decidePausedResume', () => {
  describe('no paused job', () => {
    it('does not resume when no paused job exists in the thread', () => {
      const decision = decidePausedResume({
        pausedJob: undefined,
        pauseSignal: undefined,
        eventText: 'https://github.com/Newton-School/newton-web/pull/123',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('no_paused_job');
      expect(decision.paused).toBeUndefined();
    });

    it('does not resume even with a URL reply when no paused job exists', () => {
      const decision = decidePausedResume({
        pausedJob: undefined,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'https://github.com/Newton-School/newton-web/pull/9',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('no_paused_job');
    });
  });

  describe('paused for PR_REVIEW awaiting URL', () => {
    const paused = { id: 'job-1', workflow: 'PR_REVIEW' as const };

    it('resumes when reply carries a Newton-School PR URL', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'sorry, here it is: https://github.com/Newton-School/newton-web/pull/123',
      });
      expect(decision.resume).toBe(true);
      expect(decision.reason).toBe('pr_review_url_reply');
      expect(decision.paused).toEqual(paused);
    });

    it('resumes regardless of jobs.workflow when pauseSignal indicates awaiting-URL', () => {
      // Owner-mention work lands in jobs.workflow=OWNER_AUTOPILOT even when the
      // classifier later routed it to PR_REVIEW. Resume must still fire.
      const ownerPaused = { id: 'job-1b', workflow: 'OWNER_AUTOPILOT' as const };
      const decision = decidePausedResume({
        pausedJob: ownerPaused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'https://github.com/Newton-School/newton-api/pull/42',
      });
      expect(decision.resume).toBe(true);
      expect(decision.reason).toBe('pr_review_url_reply');
      expect(decision.paused).toEqual(ownerPaused);
    });

    it('resumes on a URL embedded in surrounding prose', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText:
          'oh whoops, the link: https://github.com/Newton-School/newton-web/pull/77 — let me know what you find',
      });
      expect(decision.resume).toBe(true);
      expect(decision.reason).toBe('pr_review_url_reply');
    });

    it('resumes on the first URL when multiple PR URLs are pasted', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText:
          'pick whichever you want: https://github.com/Newton-School/newton-web/pull/1 and https://github.com/Newton-School/newton-api/pull/2',
      });
      expect(decision.resume).toBe(true);
      expect(decision.reason).toBe('pr_review_url_reply');
    });

    it('does not resume on a no-URL reply (small talk)', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'thanks!',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('pr_review_no_url_in_reply');
    });

    it('does not resume on an empty reply', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: '',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('pr_review_no_url_in_reply');
    });

    it('does not resume on a non-PR github URL (e.g. issue, repo root, commit)', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'check this issue: https://github.com/Newton-School/newton-web/issues/42',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('pr_review_no_url_in_reply');
    });

    it('does not resume on a bare PR-shaped URL with no scheme/host (so extractor cannot match)', () => {
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: 'pr_review_awaiting_url',
        eventText: 'newton-web#123',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('pr_review_no_url_in_reply');
    });
  });

  describe('paused but not for a PR URL (signal undefined)', () => {
    it('does not resume when pauseSignal is undefined even if reply has a URL', () => {
      const paused = { id: 'job-2', workflow: 'IMPLEMENTATION' as const };
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: undefined,
        eventText: 'https://github.com/Newton-School/newton-web/pull/1',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('unhandled_pause_signal:unknown');
    });

    it('does not resume when pauseSignal is undefined and reply is small talk', () => {
      const paused = { id: 'job-3', workflow: 'IMPLEMENTATION' as const };
      const decision = decidePausedResume({
        pausedJob: paused,
        pauseSignal: undefined,
        eventText: 'looks good, please continue',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('unhandled_pause_signal:unknown');
    });
  });

  describe('usage_limit_retry signal (issue #342)', () => {
    const pausedJob = { id: 'job-limit', workflow: 'IMPLEMENTATION' as const };

    it('resumes on resume/retry keywords', () => {
      for (const text of ['resume', 'retry please', 'ok continue', 'try again now']) {
        const decision = decidePausedResume({
          pausedJob,
          pauseSignal: 'usage_limit_retry',
          eventText: text,
        });
        expect(decision.resume).toBe(true);
        expect(decision.reason).toBe('usage_limit_retry_reply');
      }
    });

    it('ignores unrelated chatter in the paused thread', () => {
      const decision = decidePausedResume({
        pausedJob,
        pauseSignal: 'usage_limit_retry',
        eventText: 'ugh, limits again',
      });
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe('usage_limit_no_resume_keyword');
    });
  });
});
