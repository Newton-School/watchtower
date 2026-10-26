import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentShellPath,
  claudeCodeBackend,
  PROCESS_KILL_DENY_RULES,
  READ_ONLY_ALLOW_RULES,
  READ_ONLY_GIT_ALLOW_RULES,
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

  it('writes only under /tmp and runs only read-only GitHub and git commands', () => {
    const writes = READ_ONLY_ALLOW_RULES.filter(rule => /^(Edit|Write)\(/.test(rule));
    expect(writes).toEqual(['Edit(//tmp/**)', 'Edit(//private/tmp/**)']);
    const shell = READ_ONLY_ALLOW_RULES.filter(rule => rule.startsWith('Bash('));
    const readOnlyGh = /^Bash\(gh (pr|issue|run) (view|list|diff|checks):\*\)$/;
    const readOnlyGit =
      /^Bash\(git (log|show|blame|grep|diff|ls-files|ls-tree|rev-parse|status|cat-file|shortlog):\*\)$/;
    expect(shell.every(rule => readOnlyGh.test(rule) || readOnlyGit.test(rule))).toBe(true);
  });

  // Issue #622: `dontAsk` refused `git log -S/-G/-i/-L/--follow`.
  it('may run the read-only git commands whatever their flags, and nothing that moves a branch', () => {
    expect(READ_ONLY_GIT_ALLOW_RULES).toEqual(
      expect.arrayContaining(['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git diff:*)']),
    );
    const mutating =
      /\bgit (checkout|switch|reset|commit|push|pull|fetch|merge|rebase|stash|clean|restore|tag|branch|config|worktree|apply|am|rm|mv|add)\b/;
    expect(READ_ONLY_ALLOW_RULES.some(rule => mutating.test(rule))).toBe(false);
    // `git -C <path>` can't be kept inside the workspace by a prefix rule.
    expect(READ_ONLY_ALLOW_RULES.some(rule => rule.startsWith('Bash(git -C'))).toBe(false);
    expect(READ_ONLY_ALLOW_RULES).not.toContain('Bash(cd:*)');
  });

  // A flag like `git log --output=<file>` writes: the sandbox refuses writes in the run's directory.
  it('may not write in its working directory, while /tmp stays writable', () => {
    const args = claudeCodeBackend.buildArgs({ ...base, readOnly: true }, '/tmp/out/final.txt');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as {
      sandbox: { filesystem: { denyWrite?: string[]; allowWrite: string[] } };
    };
    expect(settings.sandbox.filesystem.denyWrite).toEqual(['/lookups/lookup-1']);
    expect(settings.sandbox.filesystem.allowWrite).toEqual(expect.arrayContaining(['/tmp', '/private/tmp']));
  });

  it('leaves a run that does work able to write in its directory', () => {
    const args = claudeCodeBackend.buildArgs(base, '/tmp/out/final.txt');
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]) as {
      sandbox: { filesystem: { denyWrite?: string[] } };
    };
    expect(settings.sandbox.filesystem.denyWrite).toBeUndefined();
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

// Issue #622: zsh failed a whole command on an unmatched glob (`grep --include=*.py`)
// and on `echo ===`; bash passes an unmatched glob through.
describe("the agent's shell", () => {
  const exists = (file: string) => file === '/bin/bash' || file === '/usr/local/bin/fish';

  it('is bash by default', () => {
    expect(agentShellPath({}, exists)).toBe('/bin/bash');
  });

  it('can be another shell, or the CLI default', () => {
    expect(agentShellPath({ WATCHTOWER_AGENT_SHELL: '/usr/local/bin/fish' }, exists)).toBe('/usr/local/bin/fish');
    expect(agentShellPath({ WATCHTOWER_AGENT_SHELL: 'default' }, exists)).toBeUndefined();
  });

  it('is left to the CLI when the named shell is missing', () => {
    expect(agentShellPath({ WATCHTOWER_AGENT_SHELL: '/nope/zsh' }, exists)).toBeUndefined();
    expect(agentShellPath({}, () => false)).toBeUndefined();
  });

  it('reaches the CLI as CLAUDE_CODE_SHELL', () => {
    const env = claudeCodeBackend.buildEnv({ ...base, readOnly: true }, '/usr/bin:/bin');
    expect(env.CLAUDE_CODE_SHELL).toBe(agentShellPath());
  });
});

describe('the read-only note', () => {
  it('steers git work to a lone cd then separate git calls, and asks for quoted globs', () => {
    expect(READ_ONLY_RUN_NOTE).toContain('`cd <absolute path of that repo>` as a command on its own');
    expect(READ_ONLY_RUN_NOTE).toContain('a `cd … && git …` line and `git -C …` are always refused');
    expect(READ_ONLY_RUN_NOTE).toContain("--include='*.py'");
    expect(READ_ONLY_RUN_NOTE).not.toContain('cd newton-web && git log');
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
