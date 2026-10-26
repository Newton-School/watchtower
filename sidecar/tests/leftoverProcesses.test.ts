import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

// Fixed ids only for the tests on made-up process lists: real processes get
// random ids, so concurrent runs of this suite never stop each other's.
const RUN = '0b9f6a52-5d7e-4c1e-9a43-2f1d6c8e7a10';
const OTHER_RUN = '7d3c1e0a-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const SIDECAR = 500;

const row = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command });
const marked = (pid: number, ppid: number, command: string, runId = RUN): ProcessRow =>
  row(pid, ppid, `${command} HOME=/Users/x ${AGENT_RUN_ENV}=${runId} PATH=/usr/bin`);

function pick(rows: ProcessRow[], envRows: ProcessRow[], selfEnv?: NodeJS.ProcessEnv): number[] {
  return leftoverProcesses({ runId: RUN, rows, envRows, selfPid: SIDECAR, selfEnv })
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

  it('never picks the sidecar or anything above it, nor walks through them to their other children', () => {
    const rows = [
      row(1, 0, '/sbin/launchd'),
      row(400, 1, 'watchtower'),
      row(SIDECAR, 400, 'node index.js'),
      // Another run's agent, a child of the sidecar.
      row(510, SIDECAR, '/Users/x/.local/bin/claude -p review'),
      // Another child of the app.
      row(410, 400, 'node other-helper.js'),
    ];
    const envRows = [marked(400, 1, 'watchtower'), marked(SIDECAR, 400, 'node index.js'), marked(1, 0, 'launchd')];
    expect(pick(rows, envRows)).toEqual([]);
  });

  it('picks what a live agent of this run started, under the app the sidecar runs in', () => {
    const rows = [
      row(400, 1, '/Applications/watchtower.app/Contents/MacOS/watchtower'),
      row(SIDECAR, 400, 'node /Applications/watchtower.app/Contents/Resources/_up_/sidecar/dist/index.js'),
      row(520, SIDECAR, '/Users/x/.local/bin/claude -p change'),
      row(521, 520, 'node node_modules/.bin/next dev'),
    ];
    const envRows = [marked(520, SIDECAR, 'claude -p change'), marked(521, 520, 'node next dev')];
    expect(pick(rows, envRows)).toEqual([520, 521]);
  });

  it("spares Claude Code's shared daemon and everything under it, whatever the program is called", () => {
    const rows = [
      row(900, 1, '/Users/x/.local/bin/claude daemon run --json-path /Users/x/.claude/daemon.json --spawn'),
      row(901, 900, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/a/spare/b.sock 200 50'),
      row(902, 901, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/a/spare/b.claim.sock'),
      row(903, 1, '/Users/x/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/x.sock'),
      row(904, 903, '/bin/zsh -l'),
      row(910, 1, 'node /Users/x/claude-code/cli.js daemon run --spawn'),
      row(911, 910, 'node /Users/x/project/server.js'),
      row(920, 1, '/Users/x/.local/share/claude/versions/2.1.320 daemon run --origin transient'),
      row(905, 1, '/Users/x/.local/bin/claude -p hello'),
    ];
    const envRows = rows.map(r => marked(r.pid, r.ppid, r.command));
    expect(pick(rows, envRows)).toEqual([905]);
  });

  it('spares a session the daemon hosts, and what it started, by its CLAUDE_BG_ variables', () => {
    const rows = [row(930, 1, '/Users/x/.local/bin/claude'), row(931, 930, 'node server.js')];
    const envRows = [
      row(930, 1, `/Users/x/.local/bin/claude CLAUDE_BG_SESSION=abc ${AGENT_RUN_ENV}=${RUN}`),
      marked(931, 930, 'node server.js'),
    ];
    expect(pick(rows, envRows)).toEqual([]);
  });

  it("does not take a running agent's prompt for the daemon: its words count only where the arguments start", () => {
    const prompt = 'claude -p review: spare daemon run, --bg-pty-host and bg-spare processes';
    const rows = [
      row(980, 1, `/Users/x/.local/bin/${prompt}`),
      row(981, 980, 'node node_modules/.bin/next dev'),
      row(982, 1, `node /Users/x/claude-code/cli.js -p ${prompt}`),
    ];
    const envRows = rows.map(r => marked(r.pid, r.ppid, r.command));
    expect(pick(rows, envRows)).toEqual([980, 981, 982]);
  });

  it('reads CLAUDE_BG_ only in the environment, not on the command line', () => {
    const command = '/Users/x/.local/bin/claude -p check that CLAUDE_BG_SESSION=abc is ignored';
    const rows = [row(990, 1, command), row(991, 990, 'node server.js')];
    const envRows = [marked(990, 1, command), marked(991, 990, 'node server.js')];
    expect(pick(rows, envRows)).toEqual([990, 991]);
  });

  it('reads the whole line when the two listings disagree, which can only spare more', () => {
    const rows = [row(995, 1, 'next-server (v15)')];
    const envRows = [row(995, 1, `node next start CLAUDE_BG_SESSION=abc ${AGENT_RUN_ENV}=${RUN}`)];
    expect(pick(rows, envRows)).toEqual([]);
  });

  it('ignores CLAUDE_BG_ values the sidecar itself has, which every agent inherits', () => {
    const rows = [row(940, 1, 'node server.js')];
    const envRows = [row(940, 1, `node server.js CLAUDE_BG_SESSION=abc ${AGENT_RUN_ENV}=${RUN}`)];
    expect(pick(rows, envRows, { CLAUDE_BG_SESSION: 'abc' })).toEqual([940]);
    expect(pick(rows, envRows, { CLAUDE_BG_SESSION: 'other' })).toEqual([]);
  });

  it('spares tmux and screen servers and apps, with everything under them', () => {
    const rows = [
      row(950, 1, 'tmux new-session -d -s dev'),
      row(951, 950, 'node node_modules/.bin/next dev'),
      row(952, 1, '/opt/homebrew/bin/screen -dmS dev'),
      row(960, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'),
      row(961, 960, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code'),
      row(970, 1, '/Users/x/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    ];
    const envRows = rows.map(r => marked(r.pid, r.ppid, r.command));
    expect(pick(rows, envRows)).toEqual([970]);
  });

  it('labels a process by its executable and first arguments, without secrets or home paths', () => {
    expect(processLabel('/opt/homebrew/bin/node node_modules/.bin/next dev --port 3000')).toBe(
      'node node_modules/.bin/next dev',
    );
    expect(processLabel('/usr/local/bin/psql postgres://admin:hunter2@db.internal/app -c')).toBe(
      'psql postgres://[redacted]@db.internal/app -c',
    );
    expect(processLabel('node -e token=abc123;run()')).toBe('node -e [redacted]');
    expect(processLabel('node /Users/someone/work/server.js')).not.toContain('someone');
  });
});

describe('stopping what a run left', () => {
  const listing = (rows: ProcessRow[]) => async (withEnv: boolean) =>
    rows.map(r => `${r.pid} ${r.ppid} ${withEnv ? `${r.command} ${AGENT_RUN_ENV}=${RUN}` : r.command}`).join('\n');

  it('does nothing, and lists once, when nothing carries the id', async () => {
    const signal = vi.fn(() => true);
    const list = vi.fn(async () => '1 0 /sbin/launchd\n');
    const result = await stopLeftoverProcesses(RUN, { listProcesses: list, signal });
    expect(result).toEqual({ stopped: [], forced: [] });
    expect(signal).not.toHaveBeenCalled();
    expect(list.mock.calls).toEqual([[true]]);
  });

  it('sends SIGTERM, then SIGKILL to what is still there and still the run’s', async () => {
    const alive = new Set([700, 710]);
    let rows = [row(700, 1, 'node a.js'), row(710, 1, 'node b.js')];
    const signal = vi.fn((pid: number, sig: NodeJS.Signals) => {
      if (sig === 'SIGTERM' && pid === 700) alive.delete(pid);
      return true;
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

  it('also stops a process of the run started during the grace period (a watcher restarting its worker)', async () => {
    let rows = [row(700, 1, 'nodemon server.js'), row(701, 700, 'node server.js')];
    const alive = new Set([700, 701]);
    const signal = vi.fn((pid: number, sig: NodeJS.Signals) => {
      if (sig === 'SIGTERM' && pid === 701) alive.delete(pid);
      return true;
    });
    const result = await stopLeftoverProcesses(RUN, {
      listProcesses: async withEnv => listing(rows)(withEnv),
      signal,
      isAlive: pid => alive.has(pid),
      sleep: async () => {
        // nodemon ignores SIGTERM and restarts its worker.
        rows = [row(700, 1, 'nodemon server.js'), row(702, 700, 'node server.js')];
        alive.add(702);
      },
      graceMs: 100,
      selfPid: SIDECAR,
    });
    expect(signal.mock.calls).toEqual([
      [700, 'SIGTERM'],
      [701, 'SIGTERM'],
      [700, 'SIGKILL'],
      [702, 'SIGKILL'],
    ]);
    expect(result.stopped.map(r => r.pid)).toEqual([700, 701, 702]);
    expect(result.forced.map(r => r.pid)).toEqual([700, 702]);
  });

  it('does not SIGKILL a pid that is no longer the run’s', async () => {
    let call = 0;
    const signal = vi.fn(() => true);
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

  it('lists once more after every first-batch process exited, and stops a worker restarted meanwhile', async () => {
    // A supervisor whose environment is hidden (`/bin/sh` looping) restarts its worker.
    let rows = [row(700, 650, 'node server.js')];
    const alive = new Set([700]);
    const signal = vi.fn((pid: number, sig: NodeJS.Signals) => {
      alive.delete(pid);
      if (sig === 'SIGTERM') {
        rows = [row(702, 650, 'node server.js')];
        alive.add(702);
      }
      return true;
    });
    const sleep = vi.fn(async () => {});
    const result = await stopLeftoverProcesses(RUN, {
      listProcesses: async withEnv => listing(rows)(withEnv),
      signal,
      isAlive: pid => alive.has(pid),
      sleep,
      selfPid: SIDECAR,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(signal.mock.calls).toEqual([
      [700, 'SIGTERM'],
      [702, 'SIGKILL'],
    ]);
    expect(result.stopped.map(r => r.pid)).toEqual([700, 702]);
    expect(result.forced.map(r => r.pid)).toEqual([702]);
  });

  it('reports and waits for only the processes it could signal', async () => {
    const sleep = vi.fn(async () => {});
    let listed = 0;
    const first = listing([row(700, 1, 'node a.js'), row(710, 1, 'node b.js')]);
    const result = await stopLeftoverProcesses(RUN, {
      // The first pass lists both; by the second, nothing of the run's is left.
      listProcesses: async withEnv => (++listed <= 2 ? first(withEnv) : '1 0 /sbin/launchd'),
      // 710 exited (or is no longer this user's) before the signal reached it.
      signal: pid => pid === 700,
      isAlive: pid => pid === 710,
      sleep,
      selfPid: SIDECAR,
    });
    expect(result).toEqual({ stopped: [row(700, 1, 'node a.js')], forced: [] });
    expect(sleep).not.toHaveBeenCalled();
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
    const run = randomUUID();
    const otherRun = randomUUID();
    const mine = await startDetached({ [AGENT_RUN_ENV]: run });
    const theirs = await startDetached({ [AGENT_RUN_ENV]: otherRun });
    try {
      expect(isAlive(mine)).toBe(true);
      const result = await stopLeftoverProcesses(run);
      expect(result.stopped.map(r => r.pid)).toEqual([mine]);
      expect(await waitUntil(() => !isAlive(mine))).toBe(true);
      expect(isAlive(theirs)).toBe(true);
    } finally {
      for (const pid of [mine, theirs]) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  const leaver = (id: AgentBackend['id'] = 'codex'): AgentBackend => ({
    id,
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

  it('skips the check for a Claude Code run with no tools', async () => {
    const logs: WorkflowStepLog[] = [];
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'unused', noTools: true, onLog: entry => logs.push(entry as WorkflowStepLog) },
      leaver('claude-code'),
    );
    const pid = Number(result.stdout.trim());
    try {
      expect(logs.some(l => l.stage.startsWith('agent.leftover_processes'))).toBe(false);
    } finally {
      if (pid > 1 && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('still checks a Codex run marked no-tools: Codex always has a shell', async () => {
    const logs: WorkflowStepLog[] = [];
    const result = await runAgent(
      { cwd: os.tmpdir(), prompt: 'unused', noTools: true, onLog: entry => logs.push(entry as WorkflowStepLog) },
      leaver('codex'),
    );
    const pid = Number(result.stdout.trim());
    try {
      expect(await waitUntil(() => !isAlive(pid))).toBe(true);
      expect(logs.some(l => l.stage === 'agent.leftover_processes')).toBe(true);
    } finally {
      if (pid > 1 && isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
