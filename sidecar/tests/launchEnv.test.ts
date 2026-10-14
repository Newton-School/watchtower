import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentBaseEnv,
  isInheritedLaunchVar,
  isTerminalShimDir,
  withoutTerminalShims,
} from '../src/backends/launchEnv.js';
import { buildCodexPath } from '../src/backends/codexBackend.js';
import { claudeCodeBackend } from '../src/backends/claudeCodeBackend.js';
import { runAgent } from '../src/codex/runCodex.js';
import type { AgentBackend } from '../src/backends/types.js';

const SHIM = '/Users/x/.cmuxterm/cmux-cli-shims/F9888BE1';

// Issue #572: started from a cmux terminal, the app ran every agent through
// cmux's claude shim, which rejects arguments over 120 KB, so large PR reviews
// failed within milliseconds; agents also inherited the launching session.
describe('what agents inherit from whoever started the app', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("recognises a terminal's shim directories, and only those", () => {
    expect(isTerminalShimDir(SHIM)).toBe(true);
    expect(isTerminalShimDir('/Users/x/.cmuxterm/cmux-cli-shims')).toBe(true);
    expect(isTerminalShimDir('/Users/x/.local/bin')).toBe(false);
    expect(withoutTerminalShims(`${SHIM}:/usr/bin:/Users/x/.local/bin`)).toBe('/usr/bin:/Users/x/.local/bin');
    expect(buildCodexPath(`${SHIM}:/custom/bin`).split(':')).not.toContain(SHIM);
    expect(buildCodexPath(`${SHIM}:/custom/bin`).split(':')).toContain('/custom/bin');
  });

  it("drops the terminal's and the parent Claude session's variables, and keeps the machine's", () => {
    for (const key of [
      'CMUX_CLAUDE_HOOK_SPOOL_DIR',
      'CMUX_CUA_SOCKET_PATH',
      'GHOSTTY_SURFACE_ID',
      'CLAUDECODE',
      'CLAUDE_EFFORT',
      'CLAUDE_JOB_DIR',
      'CLAUDE_PID',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_BRIDGE_SESSION_ID',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_SESSION_ATTENDED',
    ]) {
      expect(isInheritedLaunchVar(key)).toBe(true);
    }
    for (const key of [
      'HOME',
      'USER',
      'GH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(isInheritedLaunchVar(key)).toBe(false);
    }
    const env = agentBaseEnv({ HOME: '/Users/x', CLAUDECODE: '1', CMUX_BUNDLE_ID: 'x', PATH: `${SHIM}:/usr/bin` });
    expect(env).toEqual({ HOME: '/Users/x', PATH: '/usr/bin' });
  });

  it('resolves the real claude when a shim comes first on PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-launchenv-'));
    const shimDir = path.join(root, 'cmux-cli-shims', 'S1');
    const realDir = path.join(root, 'bin');
    for (const dir of [shimDir, realDir]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    }
    process.env.PATH = `${shimDir}:${realDir}`;

    expect(claudeCodeBackend.resolveBinary()).toBe(path.join(realDir, 'claude'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts an agent without them', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'parent-session-token';
    process.env.CMUX_CLAUDE_HOOK_SPOOL_DIR = '/tmp/spool';
    process.env.PATH = `${SHIM}:${process.env.PATH}`;
    const printEnv: AgentBackend = {
      id: 'codex',
      displayName: 'env printer',
      resolveBinary: () => '/bin/sh',
      isAvailable: () => true,
      supportsImages: () => false,
      buildArgs: () => ['-c', 'env'],
      buildEnv: (_request, basePath) => ({ PATH: buildCodexPath(basePath) }),
      parseOutput: () => ({}),
      availableModels: () => [],
      defaultModel: () => 'none',
    };

    const result = await runAgent({ cwd: os.tmpdir(), prompt: 'x', noTools: true }, printEnv);

    expect(result.stdout).toContain('HOME=');
    expect(result.stdout).not.toMatch(/^CLAUDECODE=/m);
    expect(result.stdout).not.toContain('parent-session-token');
    expect(result.stdout).not.toMatch(/^CMUX_/m);
    expect(result.stdout).not.toContain('cmux-cli-shims');
  });
});
