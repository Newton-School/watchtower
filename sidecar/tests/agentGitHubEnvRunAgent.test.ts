import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/backends/types.js';

vi.mock('../src/backends/leftoverProcesses.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backends/leftoverProcesses.js')>()),
  isLeftoverSweepEnabled: () => false,
}));

const { runAgent } = await import('../src/codex/runCodex.js');
const { gitConfigEntries, GITHUB_OVER_HTTPS_GIT_CONFIG, NO_UPSTREAM_WRITES_GIT_CONFIG } =
  await import('../src/backends/agentGitHubEnv.js');
const { NO_PUSH_TO_GITHUB_ENV } = await import('../src/github/noPush.js');

/** Prints the run's environment, then whether its gh config folder exists and what is in it. */
const printEnv: AgentBackend = {
  id: 'codex',
  displayName: 'env printer',
  resolveBinary: () => '/bin/sh',
  isAvailable: () => true,
  supportsImages: () => false,
  buildArgs: () => [
    '-c',
    'env; if [ -n "$GH_CONFIG_DIR" ]; then echo "GH_DIR_ENTRIES=$(ls -A "$GH_CONFIG_DIR" | wc -l)"; fi',
  ],
  buildEnv: request => ({ PATH: '/usr/bin:/bin', ...(request.githubToken ? { GH_TOKEN: request.githubToken } : {}) }),
  parseOutput: () => ({}),
  availableModels: () => [],
  defaultModel: () => 'none',
};

function envOf(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

describe('gh and git settings in runAgent (issue #746)', () => {
  it('gives a run with a token its own empty gh config folder, removed when the run ends', async () => {
    const result = await runAgent({ cwd: os.tmpdir(), prompt: 'x', mcpServers: {}, githubToken: 't' }, printEnv);
    const env = envOf(result.stdout);
    expect(env.GH_CONFIG_DIR).toMatch(/watchtower-codex-[^/]+\/gh$/);
    expect(env.GH_DIR_ENTRIES?.trim()).toBe('0');
    await vi.waitFor(() => expect(fs.existsSync(env.GH_CONFIG_DIR)).toBe(false));
  });

  it('merges the HTTPS rewrite with a follow-up push block instead of replacing it', async () => {
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'x', mcpServers: {}, githubToken: 't', extraEnv: NO_PUSH_TO_GITHUB_ENV },
      printEnv,
    );
    expect(gitConfigEntries(envOf(result.stdout))).toEqual([
      ...NO_UPSTREAM_WRITES_GIT_CONFIG,
      ...GITHUB_OVER_HTTPS_GIT_CONFIG,
      ...gitConfigEntries(NO_PUSH_TO_GITHUB_ENV),
    ]);
  });

  it("keeps the run's gh folder over a caller's GH_CONFIG_DIR", async () => {
    const result = await runAgent(
      {
        cwd: os.tmpdir(),
        prompt: 'x',
        mcpServers: {},
        githubToken: 't',
        extraEnv: { GH_CONFIG_DIR: `${os.homedir()}/.config/gh` },
      },
      printEnv,
    );
    expect(envOf(result.stdout).GH_CONFIG_DIR).toMatch(/watchtower-codex-[^/]+\/gh$/);
  });

  it('gives a run without a token only the no-upstream settings', async () => {
    const result = await runAgent({ cwd: os.tmpdir(), prompt: 'x', mcpServers: {} }, printEnv);
    const env = envOf(result.stdout);
    expect(env.GH_CONFIG_DIR ?? '').not.toMatch(/watchtower-codex-/);
    expect(gitConfigEntries(env)).toEqual(NO_UPSTREAM_WRITES_GIT_CONFIG);
  });
});
