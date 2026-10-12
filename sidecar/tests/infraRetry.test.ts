import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INFRA_RETRY_DELAYS_MS,
  RESUME_AFTER_DROP_PROMPT,
  __infraRetry,
  connectionLostReply,
  runWithInfraRetry,
} from '../src/codex/infraRetry.js';
import type { CodexRunRequest, CodexRunResult } from '../src/types/contracts.js';

const base = { exitCode: 0, timedOut: false, stdout: '', stderr: '', lastMessage: '' };
const ok = (extra: Partial<CodexRunResult> = {}): CodexRunResult =>
  ({ ...base, ok: true, durationMs: 1000, parsedJson: { summary: 'done' }, ...extra }) as CodexRunResult;
const dropped = (extra: Partial<CodexRunResult> = {}): CodexRunResult =>
  ({
    ...base,
    ok: false,
    exitCode: 1,
    durationMs: 60_000,
    errorKind: 'API_ERROR',
    apiErrorDetail: "API Error: Can't reach the API server",
    sessionId: 'sess-1',
    ...extra,
  }) as CodexRunResult;

const request: CodexRunRequest = { cwd: '/repo', prompt: 'do the task' };

describe('runWithInfraRetry (issue #439)', () => {
  const original = { ...__infraRetry };
  const run = vi.fn();
  const sleep = vi.fn();

  beforeEach(() => {
    run.mockReset();
    sleep.mockReset().mockResolvedValue(true);
    __infraRetry.run = run;
    __infraRetry.sleep = sleep;
  });
  afterEach(() => Object.assign(__infraRetry, original));

  it('returns a run that worked as it is, without waiting', async () => {
    run.mockResolvedValueOnce(ok());

    const result = await runWithInfraRetry(request, { label: 'planner' });

    expect(result).toMatchObject({ ok: true, infraRetries: 0, infraWaitMs: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('runs again after a dropped connection, and reports the time the drop cost', async () => {
    run.mockResolvedValueOnce(dropped()).mockResolvedValueOnce(ok());
    const logStep = vi.fn();

    const result = await runWithInfraRetry(request, { label: 'planner', logStep });

    expect(result.ok).toBe(true);
    expect(result.infraRetries).toBe(1);
    // The dead attempt (60s) plus the first wait: none of it was the agent working.
    expect(result.infraWaitMs).toBe(60_000 + INFRA_RETRY_DELAYS_MS[0]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(INFRA_RETRY_DELAYS_MS[0], undefined);
    expect(run.mock.calls[1][0]).toBe(request);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'agent.api_error.retry',
        message: 'Lost the connection to the model API during planner — retrying in 30s (attempt 1 of 3).',
      }),
    );
  });

  it('gives up after the last delay and hands back the failure, never a result to read', async () => {
    run.mockResolvedValue(dropped());

    const result = await runWithInfraRetry(request, { label: 'coder' });

    expect(result.errorKind).toBe('API_ERROR');
    expect(result.ok).toBe(false);
    expect(result.infraRetries).toBe(INFRA_RETRY_DELAYS_MS.length);
    expect(run).toHaveBeenCalledTimes(INFRA_RETRY_DELAYS_MS.length + 1);
    expect(sleep.mock.calls.map(call => call[0])).toEqual(INFRA_RETRY_DELAYS_MS);
    // Four dead attempts and three waits.
    expect(result.infraWaitMs).toBe(4 * 60_000 + INFRA_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
  });

  it.each([
    ['an ordinary failure', { ...base, ok: false, exitCode: 1, durationMs: 5 }],
    ['a usage limit', { ...base, ok: false, exitCode: 1, durationMs: 5, errorKind: 'USAGE_LIMIT' }],
    ['a timeout', { ...base, ok: false, exitCode: null, timedOut: true, durationMs: 5 }],
  ])('does not retry %s', async (_name, failure) => {
    run.mockResolvedValueOnce(failure);

    const result = await runWithInfraRetry(request, { label: 'coder' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.infraRetries).toBe(0);
  });

  it('does not retry a cancelled job, and stops waiting when it is cancelled mid-wait', async () => {
    const aborted = new AbortController();
    aborted.abort();
    run.mockResolvedValueOnce(dropped());
    await runWithInfraRetry({ ...request, signal: aborted.signal }, { label: 'coder' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    run.mockReset().mockResolvedValueOnce(dropped());
    sleep.mockResolvedValueOnce(false);
    const midWait = await runWithInfraRetry({ ...request, signal: new AbortController().signal }, { label: 'coder' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(midWait.errorKind).toBe('API_ERROR');
  });

  it("picks the coder's session back up instead of starting over", async () => {
    run.mockResolvedValueOnce(dropped({ sessionId: 'sess-coder' })).mockResolvedValueOnce(ok());

    const result = await runWithInfraRetry(request, { label: 'coder', resume: true });

    expect(result.ok).toBe(true);
    expect(run.mock.calls[1][0]).toEqual({
      ...request,
      resumeSessionId: 'sess-coder',
      prompt: RESUME_AFTER_DROP_PROMPT,
    });
  });

  it('starts over when the session cannot be resumed', async () => {
    run
      .mockResolvedValueOnce(dropped({ sessionId: 'sess-gone' }))
      .mockResolvedValueOnce({ ...base, ok: false, exitCode: 1, durationMs: 800 })
      .mockResolvedValueOnce(ok());
    const logStep = vi.fn();

    const result = await runWithInfraRetry(request, { label: 'coder', resume: true, logStep });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2][0]).toBe(request);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agent.api_error.resume_failed' }));
  });

  it('starts over when the dropped run left no session to resume', async () => {
    run.mockResolvedValueOnce(dropped({ sessionId: undefined })).mockResolvedValueOnce(ok());

    await runWithInfraRetry(request, { label: 'coder', resume: true });

    expect(run.mock.calls[1][0]).toBe(request);
  });

  it('words the reply for the thread around what was happening', () => {
    expect(connectionLostReply('planning')).toBe(
      "I lost my connection to the model while planning, and retrying didn't bring it back. Nothing has been merged. Mention me again in a few minutes and I'll pick it up.",
    );
  });
});
