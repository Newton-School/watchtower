import { describe, expect, it } from 'vitest';
import { claudeCodeBackend } from '../src/backends/claudeCodeBackend.js';
import { createStreamDecoder, describeToolInput } from '../src/codex/streamEvents.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

/** One Claude `assistant` event carrying a single tool_use block. */
function claudeToolUse(name: string, input: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
  })}\n`;
}

function toolEvents(steps: WorkflowStepLog[]): Array<{ tool?: unknown; detail?: unknown }> {
  return steps.filter(step => step.stage === 'agent.tool.use').map(step => step.data ?? {});
}

describe('describeToolInput', () => {
  it('extracts the meaningful field per tool', () => {
    expect(describeToolInput('Read', { file_path: '/Users/d/code/newton-web/src/a.ts' })).toBe('src/a.ts');
    expect(describeToolInput('Grep', { pattern: 'NSAT' })).toBe('"NSAT"');
    expect(describeToolInput('Bash', { command: 'npm test' })).toBe('npm test');
    expect(describeToolInput('Skill', { skill: 'dataviz' })).toBe('dataviz');
    expect(describeToolInput('WebFetch', { url: 'https://docs.slack.dev/reference/x?token=abc' })).toBe(
      'docs.slack.dev',
    );
  });

  it('prefers subagent_type but falls back to description', () => {
    expect(describeToolInput('Agent', { subagent_type: 'Explore', description: 'Find files' })).toBe('Explore');
    expect(describeToolInput('Agent', { description: 'Find files' })).toBe('Find files');
  });

  it('returns undefined for tools with no useful detail', () => {
    expect(describeToolInput('Read', {})).toBeUndefined();
    expect(describeToolInput('mcp__metabase__execute_query', { sql: 'select 1' })).toBeUndefined();
    expect(describeToolInput('Read', 'not-an-object')).toBeUndefined();
  });
});

describe('createStreamDecoder — claude-code', () => {
  it('decodes tool_use blocks into tool steps', () => {
    const decoder = createStreamDecoder('claude-code');
    const steps = decoder.push(claudeToolUse('Read', { file_path: '/Users/dipesh/code/newton-web/src/nsat/a.ts' }));
    expect(toolEvents(steps)).toEqual([{ tool: 'Read', detail: 'src/nsat/a.ts' }]);
  });

  it('reassembles an event split across chunk boundaries', () => {
    const decoder = createStreamDecoder('claude-code');
    const line = claudeToolUse('Skill', { skill: 'rca-job' });
    const cut = Math.floor(line.length / 2);

    // First half alone must yield nothing — it is not yet a complete line.
    expect(decoder.push(line.slice(0, cut))).toEqual([]);
    const steps = decoder.push(line.slice(cut));

    expect(toolEvents(steps)).toEqual([{ tool: 'Skill', detail: 'rca-job' }]);
  });

  it('handles several events arriving in one chunk', () => {
    const decoder = createStreamDecoder('claude-code');
    const chunk = claudeToolUse('Read', { file_path: 'a.ts' }) + claudeToolUse('Bash', { command: 'npm test' });
    expect(toolEvents(decoder.push(chunk))).toEqual([
      { tool: 'Read', detail: 'a.ts' },
      { tool: 'Bash', detail: 'npm test' },
    ]);
  });

  it('emits one step per tool_use when a message carries several blocks', () => {
    const decoder = createStreamDecoder('claude-code');
    const line = `${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'NSAT' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.ts' } },
        ],
      },
    })}\n`;

    const steps = decoder.push(line);
    expect(toolEvents(steps)).toEqual([
      { tool: 'Grep', detail: '"NSAT"' },
      { tool: 'Read', detail: 'b.ts' },
    ]);
    expect(steps.some(step => step.stage === 'agent.message')).toBe(true);
  });

  it('ignores malformed lines instead of throwing', () => {
    const decoder = createStreamDecoder('claude-code');
    expect(() => decoder.push('not json at all\n{"type":"nonsense"}\n')).not.toThrow();
    expect(decoder.push('{"broken":\n')).toEqual([]);
  });

  it('tolerates the undocumented event types the CLI also emits', () => {
    const decoder = createStreamDecoder('claude-code');
    const chunk = [
      JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'x' }),
      JSON.stringify({ type: 'system', subtype: 'hook_response', exit_code: 0 }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }),
    ].join('\n');

    expect(decoder.push(`${chunk}\n`)).toEqual([]);
  });

  it('reports the session init details', () => {
    const decoder = createStreamDecoder('claude-code');
    const steps = decoder.push(
      `${JSON.stringify({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5',
        tools: ['Read', 'Bash'],
        skills: ['dataviz'],
        mcp_servers: [{ name: 'metabase' }],
        permissionMode: 'plan',
      })}\n`,
    );

    expect(steps[0].stage).toBe('agent.session.init');
    expect(steps[0].data).toMatchObject({ model: 'claude-opus-5', tools: 2, skills: 1, mcpServers: 1 });
  });

  // The critical regression guard: parseOutput must still receive the exact
  // result envelope, not the whole JSONL buffer.
  it('retains the raw result line as the final message', () => {
    const decoder = createStreamDecoder('claude-code');
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '{"status":"success"}',
      total_cost_usd: 0.14,
      permission_denials: [{ tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan' } }],
    });

    decoder.push(claudeToolUse('Read', { file_path: 'a.ts' }));
    decoder.push(`${resultLine}\n`);

    expect(decoder.finalMessage()).toBe(resultLine);
    // The plan-mode harvest reads permission_denials off this envelope.
    expect(JSON.parse(decoder.finalMessage() ?? '{}').permission_denials).toHaveLength(1);
  });

  it('falls back to assistant prose when no result event arrived', () => {
    const decoder = createStreamDecoder('claude-code');
    decoder.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer' }] } })}\n`,
    );

    expect(decoder.finalMessage()).toBeUndefined();
    expect(decoder.assistantText()).toBe('partial answer');
  });

  it('decodes a trailing line with no newline on flush', () => {
    const decoder = createStreamDecoder('claude-code');
    const line = claudeToolUse('Bash', { command: 'git status' }).trimEnd();

    expect(decoder.push(line)).toEqual([]);
    expect(toolEvents(decoder.flush())).toEqual([{ tool: 'Bash', detail: 'git status' }]);
  });
});

describe('createStreamDecoder — codex', () => {
  it('decodes command execution from the real item envelope', () => {
    const decoder = createStreamDecoder('codex');
    const steps = decoder.push(
      `${JSON.stringify({
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: `/bin/zsh -lc "sed -n '1,200p' a.txt"` },
      })}\n`,
    );

    expect(toolEvents(steps)).toEqual([{ tool: 'Bash', detail: 'sed -n' }]);
  });

  it('does not double-report a command on item.completed', () => {
    const decoder = createStreamDecoder('codex');
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'i1', type: 'command_execution', command: 'npm test' },
    });
    const completed = JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'command_execution', command: 'npm test', exit_code: 0 },
    });

    const steps = decoder.push(`${started}\n${completed}\n`);
    expect(toolEvents(steps)).toHaveLength(1);
  });

  it('treats the last agent message as the final message', () => {
    const decoder = createStreamDecoder('codex');
    decoder.push(
      `${JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'first' } })}\n`,
    );
    decoder.push(
      `${JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'banana' } })}\n`,
    );

    expect(decoder.finalMessage()).toBe('banana');
  });

  it('ignores thread/turn framing but reports usage on turn.completed', () => {
    const decoder = createStreamDecoder('codex');
    expect(decoder.push(`${JSON.stringify({ type: 'thread.started', thread_id: 'x' })}\n`)).toEqual([]);
    expect(decoder.push(`${JSON.stringify({ type: 'turn.started' })}\n`)).toEqual([]);

    const steps = decoder.push(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } })}\n`);
    expect(steps[0].stage).toBe('agent.result');
  });

  it('skips unrecognized item types rather than narrating garbage', () => {
    const decoder = createStreamDecoder('codex');
    const steps = decoder.push(
      `${JSON.stringify({ type: 'item.started', item: { id: 'i9', type: 'reasoning', text: 'hmm' } })}\n`,
    );
    expect(steps).toEqual([]);
  });
});

// The stream change rewrote what runCodex hands to parseOutput. These chain the
// two exactly as runCodex does, so a decoder regression cannot silently break
// output parsing or the plan-mode harvest (#408/#410).
describe('decoder output feeds claudeCodeBackend.parseOutput unchanged', () => {
  it('parses a normal structured reply out of a full JSONL stream', () => {
    const decoder = createStreamDecoder('claude-code');
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5', tools: [] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      claudeToolUse('Read', { file_path: 'a.ts' }).trimEnd(),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '{"status":"success","summary":"did the thing"}',
        session_id: 'sess-9',
        total_cost_usd: 0.21,
      }),
    ].join('\n');

    decoder.push(stream);
    decoder.flush();

    const parsed = claudeCodeBackend.parseOutput(decoder.finalMessage() ?? '');
    expect(parsed.parsedJson).toMatchObject({ status: 'success', summary: 'did the thing' });
    expect(parsed.costUsd).toBe(0.21);
    expect(parsed.sessionId).toBe('sess-9');
  });

  it('still harvests the plan from permission_denials in plan mode', () => {
    const decoder = createStreamDecoder('claude-code');
    const stream = [
      claudeToolUse('Read', { file_path: 'a.ts' }).trimEnd(),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'I have written a plan.',
        permission_denials: [{ tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan\n\nStep one.' } }],
      }),
    ].join('\n');

    decoder.push(stream);
    decoder.flush();

    const parsed = claudeCodeBackend.parseOutput(decoder.finalMessage() ?? '', { planMode: true });
    expect(parsed.strategy).toBe('claude_unwrap+exit_plan_mode');
    expect(parsed.parsedJson?.planMarkdown).toContain('Step one.');
  });
});

describe('createStreamDecoder — safety', () => {
  it('emits nothing for an unknown backend but still accepts input', () => {
    const decoder = createStreamDecoder('some-future-backend');
    expect(decoder.push('{"type":"assistant"}\n')).toEqual([]);
    expect(decoder.finalMessage()).toBeUndefined();
  });

  it('drops an unbounded single line instead of growing forever', () => {
    const decoder = createStreamDecoder('claude-code');
    // 5 MB with no newline — past the 4 MB partial-line guard.
    expect(() => decoder.push('x'.repeat(5 * 1024 * 1024))).not.toThrow();
    // Resynchronizes on the next complete line.
    expect(toolEvents(decoder.push(`\n${claudeToolUse('Read', { file_path: 'a.ts' })}`))).toEqual([
      { tool: 'Read', detail: 'a.ts' },
    ]);
  });
});
