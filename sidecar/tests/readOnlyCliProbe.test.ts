import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeBackend } from '../src/backends/claudeCodeBackend.js';
import { agentBaseEnv } from '../src/backends/launchEnv.js';

/**
 * Runs the real Claude Code CLI with a read-only run's own arguments and asks
 * it to run each command as written (issue #622). Costs a model call, so it
 * runs only with WATCHTOWER_CLI_PROBE=1; rerun it after a CLI upgrade, since
 * what `dontAsk` refuses by itself is part of what keeps these out.
 */
const PROBE = process.env.WATCHTOWER_CLI_PROBE === '1';

type Verdict = 'denied' | 'ran';

function runProbe(cwd: string, commands: string[]): Map<string, Verdict> {
  const prompt = `You are testing a shell permission setup in a throwaway repo. Run each command below with the Bash tool, one call per command, exactly as written, in order. Do not change, combine or retry any of them. Then say "done".\n\n${commands.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
  const request = { prompt, cwd, readOnly: true, model: 'claude-sonnet-5-5', reasoningEffort: 'low' as const };
  const args = claudeCodeBackend.buildArgs(request, path.join(cwd, '.probe-out.json'));
  const env = { ...agentBaseEnv(process.env), ...claudeCodeBackend.buildEnv(request, process.env.PATH ?? '') };
  const result = spawnSync(claudeCodeBackend.resolveBinary(), args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const uses = new Map<string, string>();
  const verdicts = new Map<string, Verdict>();
  for (const line of (result.stdout ?? '').split('\n')) {
    let event: { message?: { content?: Array<Record<string, unknown>> } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use' && block.name === 'Bash') {
        uses.set(String(block.id), String((block.input as { command?: string })?.command ?? ''));
      }
      if (block.type === 'tool_result' && uses.has(String(block.tool_use_id))) {
        const content = block.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map(part => String((part as { text?: string }).text ?? '')).join(' ')
              : '';
        const denied = /Permission to use Bash (with command [\s\S]*? )?has been denied|requires approval/i.test(text);
        verdicts.set(uses.get(String(block.tool_use_id)) ?? '', denied ? 'denied' : 'ran');
      }
    }
  }
  return verdicts;
}

describe.skipIf(!PROBE)('a read-only run on the real CLI (WATCHTOWER_CLI_PROBE=1)', () => {
  it('refuses git flags that run a program or read outside the repos, and runs git log', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'miniog-ro-probe-'));
    const repo = path.join(workspace, 'repoA');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'const hello = 1;\n');
    const git = (...gitArgs: string[]) =>
      execFileSync('git', ['-c', 'user.email=p@example.com', '-c', 'user.name=p', ...gitArgs], { cwd: repo });
    git('init', '-q');
    git('add', 'a.ts');
    git('commit', '-q', '-m', 'init hello');
    const marker = path.join(workspace, 'ran-a-program');
    const outside = path.join(os.homedir(), '.claude', 'history.jsonl');
    const commands = [
      `cd ${repo}`,
      `git grep -O'touch ${marker}' -l hello`,
      `git grep --open-files-in-pager='touch ${marker}' -l hello`,
      `git blame --contents ${outside} a.ts`,
      `git blame --contents=${outside} a.ts`,
      'git log -S hello --oneline',
    ];
    try {
      const verdicts = runProbe(workspace, commands);
      for (const command of commands.slice(1, 5)) expect(verdicts.get(command)).toBe('denied');
      expect(verdicts.get('git log -S hello --oneline')).toBe('ran');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 360_000);
});
