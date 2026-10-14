import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeCodeBackend,
  PROCESS_KILL_DENY_RULES,
  READ_ONLY_ALLOW_RULES,
} from '../src/backends/claudeCodeBackend.js';
import { codexBackend } from '../src/backends/codexBackend.js';
import { READ_ONLY_RUN_NOTE, runClaudeAgentic } from '../src/agentic/runClaude.js';

const runCodex = vi.fn();
vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
  getActiveBackendId: () => 'claude-code',
}));

const base = { cwd: '/lookups/lookup-1', prompt: 'where is X?' } as Parameters<typeof claudeCodeBackend.buildArgs>[0];
const after = (args: string[], flag: string): string[] => {
  const start = args.indexOf(flag) + 1;
  const end = args.findIndex((arg, i) => i >= start && arg.startsWith('--'));
  return args.slice(start, end === -1 ? undefined : end);
};

// Issue #443: lookups, chat replies and investigations ran with every
// permission bypassed. They only read.
describe('a read-only run', () => {
  it('runs in dontAsk mode with the allow-list instead of bypassed permissions', () => {
    const args = claudeCodeBackend.buildArgs({ ...base, readOnly: true }, '/tmp/out/final.txt');

    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(after(args, '--allowedTools')).toEqual(READ_ONLY_ALLOW_RULES);
    // The deny rules still apply on top.
    expect(after(args, '--disallowedTools')).toEqual(expect.arrayContaining(PROCESS_KILL_DENY_RULES));
  });

  it('may use its own connectors, by server name, and no others', () => {
    const args = claudeCodeBackend.buildArgs(
      {
        ...base,
        readOnly: true,
        mcpServers: {
          metabase: { type: 'http', url: 'https://mb.example/mcp' },
          openpanel: { type: 'http', url: 'x' },
        },
      },
      '/tmp/out/final.txt',
    );

    expect(after(args, '--allowedTools')).toEqual([...READ_ONLY_ALLOW_RULES, 'mcp__metabase', 'mcp__openpanel']);
  });

  it('writes only under /tmp and runs only read-only GitHub commands', () => {
    const writes = READ_ONLY_ALLOW_RULES.filter(rule => /^(Edit|Write)\(/.test(rule));
    expect(writes).toEqual(['Edit(//tmp/**)', 'Edit(//private/tmp/**)']);
    const shell = READ_ONLY_ALLOW_RULES.filter(rule => rule.startsWith('Bash('));
    expect(shell.every(rule => /^Bash\(gh (pr|issue|run) (view|list|diff|checks):\*\)$/.test(rule))).toBe(true);
  });

  it('leaves every other run as it was', () => {
    expect(claudeCodeBackend.buildArgs(base, '/tmp/out/final.txt')).toContain('--dangerously-skip-permissions');
    const plan = claudeCodeBackend.buildArgs({ ...base, planMode: true, readOnly: true }, '/tmp/out/final.txt');
    expect(plan[plan.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(plan).not.toContain('--allowedTools');
  });

  it('is left to its sandbox on Codex, where attachments still need /tmp', () => {
    expect(codexBackend.buildArgs({ ...base, readOnly: true }, '/tmp/out/final.txt')).toContain('--full-auto');
  });
});

describe('runClaudeAgentic for a read-only run', () => {
  beforeEach(() => {
    runCodex.mockReset();
    runCodex.mockResolvedValue({ ok: true, exitCode: 0, stdout: 'hi', stderr: '', lastMessage: 'hi' });
  });

  it('asks for a read-only run and tells the agent what it will be refused', async () => {
    await runClaudeAgentic({ systemPrompt: 'SYSTEM', userMessage: 'where is X?', cwd: '/c', readOnly: true });

    const request = runCodex.mock.calls[0][0];
    expect(request.readOnly).toBe(true);
    expect(request.prompt).toContain(`SYSTEM\n\n${READ_ONLY_RUN_NOTE}`);
    expect(request.prompt.indexOf(READ_ONLY_RUN_NOTE)).toBeLessThan(request.prompt.indexOf('User message:'));
  });

  it('says nothing about it otherwise', async () => {
    await runClaudeAgentic({ systemPrompt: 'SYSTEM', userMessage: 'test the page', cwd: '/c' });

    expect(runCodex.mock.calls[0][0].readOnly).toBeUndefined();
    expect(runCodex.mock.calls[0][0].prompt).not.toContain('read-only');
  });
});
