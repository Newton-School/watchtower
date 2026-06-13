import { describe, expect, it } from 'vitest';
import { detectUsageLimit, parseCodexStructuredOutput } from '../src/codex/runCodex.js';

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
