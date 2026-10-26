import { spawn } from 'node:child_process';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_RUN_ENV,
  leftoverProcesses,
  parsePsRows,
  processLabel,
  stopLeftoverProcesses,
  type ProcessRow,
} from '../src/backends/leftoverProcesses.js';
import { runAgent } from '../src/codex/runCodex.js';
import type { AgentBackend } from '../src/backends/types.js';
import type { WorkflowStepLog } from '../src/types/contracts.js';

const RUN = '0b9f6a52-5d7e-4c1e-9a43-2f1d6c8e7a10';
const OTHER_RUN = '7d3c1e0a-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const SIDECAR = 500;

const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
const marked = (pid: number, ppid: number, command: string, runId = RUN): ProcessRow =>
  row(pid, ppid, `${command} HOME=/Users/x ${AGENT_RUN_ENV}=${runId} PATH=/usr/bin`);

function pick(rows: ProcessRow[], envRows: ProcessRow[]): number[] {
  return leftoverProcesses({ runId: RUN, rows, envRows, selfPid: SIDECAR })
    .map(p => p.pid)
    .sort((a, b) => a - b);
}

describe('finding what a run left running (issue #608)', () => {
  it('reads ps rows', () => {
    expect(parsePsRows('    1     0 /sbin/launchd\n  812     1 node -e x  \n\nnot a row\n')).toEqual([
      row(1, 0, '/sbin/launchd'),
      row(812, 1, 'node -e x'),
    ]);
  });

  it('picks a server re-parented to launchd that carries the run id, and its children', () => {
    const rows = [
      row(1, 0, '/sbin/launchd'),
      row(SIDECAR, 1, 'node sidecar/dist/index.js'),
      row(700, 1, 'node node_modules/.bin/next dev'),
      row(701, 700, '/bin/sh -c next-server'),
      row(702, 701, 'next-server (v15)'),
      row(800, 1, 'node /Users/x/other/server.js'),
    ];
    // Apple's /bin/sh hides its environment; 702 shows it.
    const envRows = [marked(700, 1, 'node node_modules/.bin/next dev'), row(701, 700, '/bin/sh -c next-server')];
    expect(pick(rows, envRows)).toEqual([700, 701, 702]);
  });

  it("leaves another run's processes and the owner's own alone", () => {
    const rows = [row(700, 1, 'node a.js'), row(710, 1, 'node b.js'), row(720, 1, 'node c.js')];
    const envRows = [
      marked(700, 1, 'node a.js', OTHER_RUN),
      row(710, 1, 'node b.js HOME=/Users/x'),
      // An id that only starts with this run's id is another run's.
      row(720, 1, `node c.js ${AGENT_RUN_ENV}=${RUN}-2`),
    ];
    expect(pick(rows, envRows)).toEqual([]);
  });

  it('never picks the sidecar or anything above it, even when they carry the id', () => {
    const rows = [row(1, 0, '/sbin/launchd'), row(400, 1, 'watchtower'), row(SIDECAR, 400, 'node index.js')];
    const envRows = [marked(400, 1, 'watchtower'), marked(SIDECAR, 400, 'node index.js'), marked(1, 0, 'launchd')];
    expect(pick(rows, envRows)).toEqual([]);
  });

  it("spares Claude Code's shared daemon and everything under it", () => {
    const rows = [
      row(900, 1, '/Users/x/.local/bin/claude daemon run --json-path /Users/x/.claude/daemon.json --spawn'),
      row(901, 900, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/a/spare/b.sock 200 50'),
      row(902, 901, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/a/spare/b.claim.sock'),
      row(903, 1, '/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/x.sock'),
      row(904, 903, '/bin/zsh -l'),
      row(905, 1, '/Users/x/.local/bin/claude -p hello'),
    ];
    const envRows = rows.map(r => marked(r.pid, r.ppid, r.command));
    expect(pick(rows, envRows)).toEqual([905]);
  });

  it('labels a process by its executable and first arguments only', () => {
    expect(processLabel('/opt/homebrew/bin/node node_modules/.bin/next dev --port 3000 --token abc')).toBe(
      'node node_modules/.bin/next dev',
    );
  });
});

describe('stopping what a run left', () => {
  const listing = (rows: ProcessRow[]) => async (withEnv: boolean) =>
    rows.map(r => `${r.pid} ${r.ppid} ${withEnv ? `${r.command} ${AGENT_RUN_ENV}=${RUN}` : r.command}`).join('\n');

  it('does nothing when the run left nothing', async () => {
    const signal = vi.fn();
    const result = await stopLeftoverProcesses(RUN, { listProcesses: async () => '1 0 /sbin/launchd\n', signal });
    expect(result).toEqual({ stopped: [], forced: [] });
    expect(signal).not.toHaveBeenCalled();
  });

  it('sends SIGTERM, then SIGKILL to what is still there and still this run’s', async () => {
    const alive = new Set([700, 710]);
    let rows = [row(700, 1, 'node a.js'), row(710, 1, 'node b.js')];
    const signal = vi.fn((pid: number, sig: NodeJS.Signals) => {
      if (sig === 'SIGTERM' && pid === 700) alive.delete(pid);
    });
    const result = await stopLeftoverProcesses(RUN, {
      listProcesses: async withEnv => listing(rows)(withEnv),
      signal,
      isAlive: pid => alive.has(pid),
      sleep: async () => {
        rows = rows.filter(r => alive.has(r.pid));
      },
      graceMs: 300,
      selfPid: SIDECAR,
    });
    expect(result.stopped.map(r => r.pid)).toEqual([700, 710]);
    expect(result.forced.map(r => r.pid)).toEqual([710]);
    expect(signal.mock.calls).toEqual([
      [700, 'SIGTERM'],
      [710, 'SIGTERM'],
      [710, 'SIGKILL'],
    ]);
  });

  it('does not SIGKILL a pid that is no longer this run’s', async () => {
    let call = 0;
    const signal = vi.fn();
    await stopLeftoverProcesses(RUN, {
      // First listing: 710 is the run's. After the grace period, 710 is someone else's.
      listProcesses: async withEnv => {
        call += 1;
        if (call <= 2) return `710 1 node b.js${withEnv ? ` ${AGENT_RUN_ENV}=${RUN}` : ''}`;
        return '710 1 node unrelated.js';
      },
      signal,
      isAlive: () => true,
      sleep: async () => {},
      graceMs: 100,
      selfPid: SIDECAR,
    });
    expect(signal.mock.calls).toEqual([[710, 'SIGTERM']]);
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Start a node process detached from the shell that started it, the way `nohup … &` leaves a dev server. */
function startDetached(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const shell = spawn(
      '/bin/sh',
      ['-c', `nohup "${process.execPath}" -e 'setTimeout(()=>{},60000)' >/dev/null 2>&1 & echo $!`],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    shell.stdout.on('data', chunk => (out += String(chunk)));
    shell.on('error', reject);
    shell.on('close', () => resolve(Number(out.trim())));
  });
}

const waitUntil = async (check: () => boolean, ms = 3_000): Promise<boolean> => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return check();
};

describe.skipIf(process.platform !== 'darwin')('on this machine', () => {
  it("stops a detached process carrying the run id and leaves another run's", async () => {
    const mine = await startDetached({ [AGENT_RUN_ENV]: RUN });
    const theirs = await startDetached({ [AGENT_RUN_ENV]: OTHER_RUN });
    try {
      expect(isAlive(mine)).toBe(true);
      const result = await stopLeftoverProcesses(RUN);
      expect(result.stopped.map(r => r.pid)).toEqual([mine]);
      expect(await waitUntil(() => !isAlive(mine))).toBe(true);
      expect(isAlive(theirs)).toBe(true);
    } finally {
      for (const pid of [mine, theirs]) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  const leaver = (): AgentBackend => ({
    id: 'codex',
    displayName: 'leaver',
    resolveBinary: () => '/bin/sh',
    isAvailable: () => true,
    supportsImages: () => false,
    buildArgs: () => ['-c', `nohup "${process.execPath}" -e 'setTimeout(()=>{},60000)' >/dev/null 2>&1 & echo $!`],
    buildEnv: () => ({ PATH: '/usr/bin:/bin' }),
    parseOutput: () => ({}),
    availableModels: () => [],
    defaultModel: () => 'none',
  });

  it('stops what an agent run left when the run ends, and says so in the log', async () => {
    const logs: WorkflowStepLog[] = [];
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'unused', mcpServers: {}, onLog: entry => logs.push(entry as WorkflowStepLog) },
      leaver(),
    );
    const pid = Number(result.stdout.trim());
    try {
      expect(pid).toBeGreaterThan(1);
      expect(await waitUntil(() => !isAlive(pid))).toBe(true);
      const entry = logs.find(l => l.stage === 'agent.leftover_processes');
      expect(entry?.data).toMatchObject({ processes: [{ pid, command: expect.stringContaining('node -e') }] });
      expect(JSON.stringify(entry)).not.toContain(AGENT_RUN_ENV);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('skips the check for a run with no tools', async () => {
    const logs: WorkflowStepLog[] = [];
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'unused', noTools: true, onLog: entry => logs.push(entry as WorkflowStepLog) },
      leaver(),
    );
    const pid = Number(result.stdout.trim());
    try {
      expect(logs.some(l => l.stage.startsWith('agent.leftover_processes'))).toBe(false);
    } finally {
      if (pid > 1 && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
