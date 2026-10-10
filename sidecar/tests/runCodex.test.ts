import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { detectUsageLimit, parseCodexStructuredOutput, runAgent } from '../src/codex/runCodex.js';
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
