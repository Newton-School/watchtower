import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../src/backends/types.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

vi.mock('../src/backends/leftoverProcesses.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/backends/leftoverProcesses.js')>()),
  isLeftoverSweepEnabled: () => true,
  stopLeftoverProcesses: vi.fn(async () => ({ stopped: [], forced: [] })),
}));

const { AGENT_RUN_ENV, stopLeftoverProcesses } = await import('../src/backends/leftoverProcesses.js');
const { runAgent } = await import('../src/codex/runCodex.js');

const printEnv: AgentBackend = {
  id: 'codex',
  displayName: 'env printer',
  resolveBinary: () => '/bin/sh',
  isAvailable: () => true,
  supportsImages: () => false,
  buildArgs: () => ['-c', 'env'],
  buildEnv: () => ({ PATH: '/usr/bin:/bin', [AGENT_RUN_ENV]: 'from-backend' }),
  parseOutput: () => ({}),
  availableModels: () => [],
  defaultModel: () => 'none',
};

describe('the run id and the leftover check in runAgent (issue #608)', () => {
  it('gives every run its own id, which neither the backend nor extraEnv can replace', async () => {
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'x', mcpServers: {}, extraEnv: { [AGENT_RUN_ENV]: 'from-caller' } },
      printEnv,
    );
    const runId = new RegExp(`^${AGENT_RUN_ENV}=(.+)$`, 'm').exec(result.stdout)?.[1];
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(vi.mocked(stopLeftoverProcesses)).toHaveBeenLastCalledWith(runId);

    const second = await runAgent({ cwd: os.tmpdir(), prompt: 'x', mcpServers: {} }, printEnv);
    expect(second.stdout).not.toContain(`${AGENT_RUN_ENV}=${runId}`);
  });

  it('logs a warning and keeps the run result when the check fails', async () => {
    vi.mocked(stopLeftoverProcesses).mockRejectedValueOnce(new Error('ps: timed out'));
    const logs: WorkflowStepLog[] = [];
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'x', mcpServers: {}, onLog: entry => logs.push(entry as WorkflowStepLog) },
      printEnv,
    );
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(logs.find(l => l.stage === 'agent.leftover_processes.error')).toMatchObject({
      level: 'WARN',
      data: { error: 'Error: ps: timed out' },
    });
    expect(logs.some(l => l.stage === 'agent.cleanup')).toBe(true);
  });
});
