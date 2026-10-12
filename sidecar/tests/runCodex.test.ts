import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  detectApiError,
  detectExternalKill,
  detectUsageLimit,
  parseCodexStructuredOutput,
  runAgent,
} from '../src/codex/runCodex.js';
import type { AgentBackend } from '../src/backends/types.js';

describe('runCodex structured output parsing', () => {
  it('parses direct JSON object output', () => {
    const parsed = parseCodexStructuredOutput(
      JSON.stringify({ status: 'success', summary: 'done', actions: [], prUrl: '' }),
    );

    expect(parsed.strategy).toBe('direct');
    expect(parsed.parsedJson?.status).toBe('success');
  });

  it('salvages JSON from fenced blocks', () => {
    const parsed = parseCodexStructuredOutput(
      'Here is the result:\n```json\n{"status":"success","summary":"fenced","actions":[],"prUrl":""}\n```',
    );

    expect(parsed.strategy).toBe('fenced_block');
    expect(parsed.parsedJson?.summary).toBe('fenced');
  });

  it('salvages first top-level object from mixed text', () => {
    const parsed = parseCodexStructuredOutput(
      'Completed execution. payload={"status":"success","summary":"mixed","actions":[],"prUrl":""} end.',
    );

    expect(parsed.strategy).toBe('first_object');
    expect(parsed.parsedJson?.summary).toBe('mixed');
  });

  it('reports attempts when parsing fails', () => {
    const parsed = parseCodexStructuredOutput('not json at all');

    expect(parsed.parsedJson).toBeUndefined();
    expect(parsed.attempts).toEqual(['direct', 'fenced_block', 'first_object']);
  });
});

describe('detectUsageLimit (issue #342)', () => {
  it('classifies the exact incident message and extracts the reset clause', () => {
    const hit = detectUsageLimit(
      '{"type":"result","subtype":"error_during_execution","result":"You\'ve hit your session limit · resets 9:40pm (Asia/Calcutta)"}',
    );
    expect(hit).toBeDefined();
    expect(hit?.resetsAtText).toContain('9:40pm (Asia/Calcutta)');
  });

  it('classifies weekly/usage limit variants', () => {
    expect(detectUsageLimit("You've hit your weekly limit · resets Tue 4:00am")).toBeDefined();
    expect(detectUsageLimit('usage limit reached')).toBeDefined();
    expect(detectUsageLimit('Rate limit exceeded, retry later')).toBeDefined();
  });

  it('does not classify ordinary failures or successful output', () => {
    expect(detectUsageLimit('TypeError: cannot read properties of undefined')).toBeUndefined();
    expect(detectUsageLimit('{"status":"success","summary":"the session limit constant was renamed"}')).toBeUndefined();
    expect(detectUsageLimit('')).toBeUndefined();
  });
});

describe('runAgent timeout (issue #440)', () => {
  it('logs how long the call really ran beside the timeout it was given', async () => {
    const sleeper: AgentBackend = {
      id: 'claude-code',
      displayName: 'Sleeper',
      resolveBinary: () => '/bin/sleep',
      isAvailable: () => true,
      supportsImages: () => false,
      buildArgs: () => ['5'],
      buildEnv: () => ({}),
      parseOutput: () => ({ finalMessage: '' }) as never,
      availableModels: () => ['test'],
      defaultModel: () => 'test',
    };
    const onLog = vi.fn();

    const result = await runAgent({ cwd: os.tmpdir(), prompt: 'unused', timeoutMs: 120, onLog }, sleeper);

    expect(result).toMatchObject({ ok: false, timedOut: true });
    const timeout = onLog.mock.calls.map(call => call[0]).find(entry => entry.stage === 'agent.timeout');
    expect(timeout.data.timeoutMs).toBe(120);
    expect(timeout.data.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(timeout.data.elapsedMs).toBeLessThan(4000);
  });
});

describe('detectApiError (issue #439)', () => {
  const INCIDENT = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
  const envelope = (result: string, isError: boolean) =>
    JSON.stringify({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      result,
    });

  it('recognises the line that was posted as a plan, bare or inside the result envelope', () => {
    expect(detectApiError(INCIDENT, { failedRun: true })?.detail).toBe(INCIDENT);
    expect(detectApiError(envelope(INCIDENT, true), { failedRun: true })?.detail).toBe(INCIDENT);
    expect(
      detectApiError(envelope('API Error: No response from API (waited 3m, then 10m on the retry).', true), {
        failedRun: true,
      })?.detail,
    ).toContain('No response from API');
  });

  it('recognises the envelope the CLI really prints when it cannot connect (captured from 2.1.296)', () => {
    // Exit code 1, subtype "success", and the reason stated outright.
    const real =
      '{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"56bb1724","total_cost_usd":0,"terminal_reason":"api_error",' +
      '"is_error":true,"subtype":"success","type":"result","num_turns":1,' +
      '"result":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"}';
    const detail = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)';

    expect(detectApiError(real, { failedRun: true })).toEqual({ detail });
    expect(detectApiError(real, { failedRun: false })).toEqual({ detail });
    // The stated reason is enough even if the wording of the result changes.
    expect(
      detectApiError('{"terminal_reason":"api_error","result":"Could not connect"}', { failedRun: false }),
    ).toEqual({
      detail: 'api_error',
    });
  });

  it('recognises it on a clean exit only when the CLI itself flags the result as an error', () => {
    expect(detectApiError(envelope(INCIDENT, true), { failedRun: false })).toBeDefined();
    expect(detectApiError(envelope(INCIDENT, false), { failedRun: false })).toBeUndefined();
  });

  it('recognises a network failure named in the final message of a failed run', () => {
    expect(
      detectApiError(envelope('request failed: getaddrinfo ENOTFOUND api.anthropic.com', true), { failedRun: true }),
    ).toEqual({ detail: 'ENOTFOUND' });
    expect(detectApiError('socket closed: ECONNRESET', { failedRun: true })).toEqual({ detail: 'ECONNRESET' });
  });

  it('does not mistake an answer about API errors for one', () => {
    const answers = [
      envelope('The handler now shows "API Error: 500" in a toast when the request fails.', false),
      envelope('API Error: handling added in src/api/client.ts — retries on ECONNRESET with backoff.', false),
      envelope('Added a retry for ENOTFOUND in the DNS helper.', false),
    ];
    for (const answer of answers) expect(detectApiError(answer, { failedRun: false })).toBeUndefined();
    expect(detectApiError('', { failedRun: true })).toBeUndefined();
    expect(
      detectApiError(envelope('TypeError: cannot read properties of undefined', true), { failedRun: true }),
    ).toBeUndefined();
  });
});

describe('a run killed from outside (issue #445)', () => {
  const shell = (script: string): AgentBackend => ({
    id: 'claude-code',
    displayName: 'Shell',
    resolveBinary: () => '/bin/sh',
    isAvailable: () => true,
    supportsImages: () => false,
    buildArgs: () => ['-c', script],
    buildEnv: () => ({}),
    parseOutput: () => ({}),
    availableModels: () => ['test'],
    defaultModel: () => 'test',
  });
  const run = (script: string, extra: Record<string, unknown> = {}) => {
    const onLog = vi.fn();
    return runAgent({ cwd: os.tmpdir(), prompt: 'unused', onLog, ...extra }, shell(script)).then(result => ({
      result,
      stages: onLog.mock.calls.map(call => call[0].stage as string),
    }));
  };

  it('reads the signal, or the 128+signal exit code a process reports when it handles one', () => {
    expect(detectExternalKill(null, 'SIGTERM')).toEqual({ signal: 'SIGTERM' });
    expect(detectExternalKill(143, undefined)).toEqual({ signal: 'SIGTERM' });
    expect(detectExternalKill(137, undefined)).toEqual({ signal: 'SIGKILL' });
    expect(detectExternalKill(0, undefined)).toBeUndefined();
    expect(detectExternalKill(1, undefined)).toBeUndefined();
  });

  it('classifies a process that is signalled as killed from outside, not as a failed run to read', async () => {
    const { result, stages } = await run('kill -TERM $$');

    expect(result).toMatchObject({ ok: false, errorKind: 'EXTERNAL_KILL', killSignal: 'SIGTERM' });
    expect(stages).toContain('agent.killed');
  });

  it('classifies exit 143, which is how the CLI leaves when it is sent SIGTERM', async () => {
    const { result } = await run('exit 143');

    expect(result).toMatchObject({ ok: false, exitCode: 143, errorKind: 'EXTERNAL_KILL', killSignal: 'SIGTERM' });
  });

  it('does not call its own timeout or an ordinary failure a kill', async () => {
    const timedOut = await run('sleep 5', { timeoutMs: 100 });
    expect(timedOut.result.timedOut).toBe(true);
    expect(timedOut.result.errorKind).toBeUndefined();

    const failed = await run('exit 1');
    expect(failed.result).toMatchObject({ ok: false, exitCode: 1 });
    expect(failed.result.errorKind).toBeUndefined();
  });

  it('does not call a cancel a kill', async () => {
    const controller = new AbortController();
    const pending = run('sleep 5', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    const { result } = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.errorKind).toBeUndefined();
  });
});
