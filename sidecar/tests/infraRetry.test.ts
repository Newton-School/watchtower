import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INFRA_RETRY_DELAYS_MS,
  KILL_RETRY_DELAYS_MS,
  RESUME_AFTER_DROP_PROMPT,
  __infraRetry,
  connectionLostReply,
  killedFromOutsideReply,
  runWithInfraRetry,
} from '../src/codex/infraRetry.js';
import { activeClock } from '../src/runtime/activeClock.js';
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

  it('leaves out of the lost time a sleep that dropped the connection: the pipeline already does not count it (issue #586)', async () => {
    vi.useFakeTimers();
    activeClock.stop();
    try {
      run
        .mockImplementationOnce(async () => {
          // Asleep for 30 min of the attempt's 31; the drop shows on waking.
          vi.setSystemTime(Date.now() + 30 * 60_000);
          await vi.advanceTimersByTimeAsync(60_000);
          return dropped({ durationMs: 31 * 60_000 });
        })
        .mockResolvedValueOnce(ok());

      const result = await runWithInfraRetry(request, { label: 'coder' });

      // The minute awake and the wait; not the 30 min asleep.
      expect(result.infraWaitMs).toBe(60_000 + INFRA_RETRY_DELAYS_MS[0]);
    } finally {
      activeClock.stop();
      vi.useRealTimers();
    }
  });

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
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agent.retry.resume_failed' }));
  });

  it('starts over when the dropped run left no session to resume', async () => {
    run.mockResolvedValueOnce(dropped({ sessionId: undefined })).mockResolvedValueOnce(ok());

    await runWithInfraRetry(request, { label: 'coder', resume: true });

    expect(run.mock.calls[1][0]).toBe(request);
  });

  describe('a run killed from outside (issue #445)', () => {
    const killed = (extra: Partial<CodexRunResult> = {}): CodexRunResult =>
      ({
        ...base,
        ok: false,
        exitCode: 143,
        durationMs: 20_000,
        errorKind: 'EXTERNAL_KILL',
        killSignal: 'SIGTERM',
        sessionId: 'sess-reviewer',
        ...extra,
      }) as CodexRunResult;

    it('is run again once, after a short pause', async () => {
      run.mockResolvedValueOnce(killed()).mockResolvedValueOnce(ok());
      const logStep = vi.fn();

      const result = await runWithInfraRetry(request, { label: 'reviewer', logStep });

      expect(result).toMatchObject({ ok: true, infraRetries: 1, infraWaitMs: 20_000 + KILL_RETRY_DELAYS_MS[0] });
      expect(sleep).toHaveBeenCalledExactlyOnceWith(KILL_RETRY_DELAYS_MS[0], undefined);
      expect(logStep).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'agent.killed.retry',
          message: 'The reviewer run was killed from outside — retrying in 5s (attempt 1 of 1).',
        }),
      );
    });

    it('is handed back as a kill, not a result, when the retry is killed too', async () => {
      run.mockResolvedValue(killed());

      const result = await runWithInfraRetry(request, { label: 'reviewer' });

      expect(result).toMatchObject({ ok: false, errorKind: 'EXTERNAL_KILL', infraRetries: 1 });
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("resumes the coder's session, like a dropped connection does", async () => {
      run.mockResolvedValueOnce(killed({ sessionId: 'sess-coder' })).mockResolvedValueOnce(ok());

      await runWithInfraRetry(request, { label: 'coder', resume: true });

      expect(run.mock.calls[1][0]).toMatchObject({ resumeSessionId: 'sess-coder', prompt: RESUME_AFTER_DROP_PROMPT });
    });

    it('keeps its own budget: a kill does not use up the waits for a dropped connection', async () => {
      run
        .mockResolvedValueOnce(killed())
        .mockResolvedValueOnce(dropped())
        .mockResolvedValueOnce(dropped())
        .mockResolvedValueOnce(ok());

      const result = await runWithInfraRetry(request, { label: 'coder' });

      expect(result.ok).toBe(true);
      expect(result.infraRetries).toBe(3);
      expect(sleep.mock.calls.map(call => call[0])).toEqual([
        KILL_RETRY_DELAYS_MS[0],
        INFRA_RETRY_DELAYS_MS[0],
        INFRA_RETRY_DELAYS_MS[1],
      ]);
    });

    it('words the reply for the thread', () => {
      expect(killedFromOutsideReply('The reviewer')).toBe(
        "The reviewer was killed from outside while it was working, and so was my retry. That was not a verdict on the change. Nothing has been merged. Mention me again and I'll run it again.",
      );
    });
  });

  it('words the reply for the thread around what was happening', () => {
    expect(connectionLostReply('planning')).toBe(
      "I lost my connection to the model while planning, and retrying didn't bring it back. Nothing has been merged. Mention me again in a few minutes and I'll pick it up.",
    );
  });
});

describe('usageLimitReply (issue #592)', () => {
  it('says when to come back, without the CLI sentence’s own punctuation', async () => {
    const { usageLimitReply } = await import('../src/codex/infraRetry.js');
    expect(usageLimitReply('do this', '4pm (Asia/Calcutta).')).toBe(
      "I've hit my usage limit, so I can't do this right now. It resets 4pm (Asia/Calcutta); ask me again after that.",
    );
    expect(usageLimitReply('do this', '  ')).toBe(
      "I've hit my usage limit, so I can't do this right now. Ask me again once it resets.",
    );
  });
});
