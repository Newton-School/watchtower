import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentSandboxSettings,
  configureAgentSandbox,
  isAgentSandboxEnabled,
  sandboxReadDenyRules,
} from '../src/backends/agentSandbox.js';
import { claudeCodeBackend } from '../src/backends/claudeCodeBackend.js';
import { __depCache } from '../src/workspaces/depCache.js';

const home = os.homedir();
const root = path.join(home, 'code', 'mini-og');

// Issue #445: agents run as the owner's user. One agent's `pkill -f "next dev"`
// killed sibling agents and the owner's own processes.
describe('the shell sandbox for agent runs', () => {
  afterEach(() => {
    delete process.env.WATCHTOWER_AGENT_SANDBOX;
    configureAgentSandbox({ repoPaths: [] });
  });

  const settingsOf = (args: string[]) => {
    const at = args.indexOf('--settings');
    return at === -1 ? undefined : (JSON.parse(args[at + 1]) as ReturnType<typeof agentSandboxSettings>);
  };
  const base = { cwd: '/tmp/wt', prompt: 'hello' };

  it('is on for a run with tools, with no way out of it', () => {
    const settings = settingsOf(claudeCodeBackend.buildArgs(base, '/tmp/out.json'));

    expect(settings?.sandbox).toMatchObject({
      enabled: true,
      allowUnsandboxedCommands: false,
      enableWeakerNetworkIsolation: true,
      network: { allowLocalBinding: true },
    });
    // A run with bypassed permissions keeps the default: sandboxed commands run.
    expect(settings?.sandbox).not.toHaveProperty('autoAllowBashIfSandboxed');
  });

  it('keeps a read-only run to its allow-list', () => {
    const settings = settingsOf(claudeCodeBackend.buildArgs({ ...base, readOnly: true }, '/tmp/out.json'));

    expect(settings?.sandbox.autoAllowBashIfSandboxed).toBe(false);
  });

  it('is off for a text-only call, a run that opts out (QA, deploy), and with the kill switch', () => {
    expect(settingsOf(claudeCodeBackend.buildArgs({ ...base, noTools: true }, '/tmp/out.json'))).toBeUndefined();
    const optedOut = claudeCodeBackend.buildArgs({ ...base, sandbox: false }, '/tmp/out.json');
    expect(settingsOf(optedOut)).toBeUndefined();
    expect(optedOut.some(arg => arg.startsWith('Read('))).toBe(false);
    process.env.WATCHTOWER_AGENT_SANDBOX = '0';
    expect(isAgentSandboxEnabled()).toBe(false);
    expect(settingsOf(claudeCodeBackend.buildArgs(base, '/tmp/out.json'))).toBeUndefined();
  });

  it("writes only in the working directory, /tmp, package caches and the repos' build caches", () => {
    configureAgentSandbox({ miniOgRepoRoot: root, repoPaths: [path.join(root, 'newton-web')] });

    const { filesystem } = agentSandboxSettings({ readOnly: false }).sandbox as {
      filesystem: { allowWrite: string[] };
    };
    expect(filesystem.allowWrite).toEqual([
      '/tmp',
      '/private/tmp',
      '~/.npm',
      '~/.cache',
      '~/Library/Caches',
      path.join(root, 'newton-web', 'node_modules', '.cache'),
    ]);
  });

  it("hides secrets, miniOG's own data and the owner's other checkouts, but not the miniOG root", () => {
    const appDataDir = path.join(home, 'Library', 'Application Support', 'com.example.watchtower');
    configureAgentSandbox({ miniOgRepoRoot: root, repoPaths: [], appDataDir });

    const { filesystem } = agentSandboxSettings({ readOnly: false }).sandbox as {
      filesystem: { denyRead: string[]; allowRead: string[] };
    };
    expect(filesystem.denyRead).toEqual(
      expect.arrayContaining([
        '~/.ssh',
        '~/.aws',
        '~/.claude/projects',
        '~/Library/Application Support/com.example.watchtower',
        path.join(home, 'code'),
      ]),
    );
    expect(filesystem.allowRead).toEqual([root]);
    // The Read tool is not sandboxed: the same paths are denied to it by rule, ~/code excepted.
    expect(sandboxReadDenyRules()).toContain('Read(~/.ssh/**)');
    expect(sandboxReadDenyRules()).toContain('Read(~/Library/Application Support/com.example.watchtower/**)');
    expect(sandboxReadDenyRules().some(rule => rule.includes('/code'))).toBe(false);
  });

  it('lists no folder macOS guards with a permission prompt: a pending prompt hung every agent', () => {
    configureAgentSandbox({ miniOgRepoRoot: root, repoPaths: [] });

    const { filesystem } = agentSandboxSettings({ readOnly: false }).sandbox as { filesystem: { denyRead: string[] } };
    for (const prompted of ['~/Documents', '~/Desktop', '~/Downloads']) {
      expect(filesystem.denyRead).not.toContain(prompted);
      expect(sandboxReadDenyRules()).not.toContain(`Read(${prompted}/**)`);
    }
  });

  it('hides no neighbours when the miniOG root sits directly in home', () => {
    configureAgentSandbox({ miniOgRepoRoot: path.join(home, 'mini-og'), repoPaths: [] });

    const { filesystem } = agentSandboxSettings({ readOnly: false }).sandbox as {
      filesystem: { denyRead: string[]; allowRead?: string[] };
    };
    expect(filesystem.denyRead).not.toContain(home);
    expect(filesystem.allowRead).toBeUndefined();
  });

  it('leaves the dependency installs readable but not writable (issue #611)', () => {
    configureAgentSandbox({
      miniOgRepoRoot: root,
      repoPaths: [path.join(root, 'newton-web')],
      appDataDir: path.join(home, 'Library', 'Application Support', 'com.example.watchtower'),
    });
    const { filesystem } = agentSandboxSettings({ readOnly: false }).sandbox as {
      filesystem: { denyRead: string[]; allowWrite: string[] };
    };
    const cache = __depCache.root;
    const expand = (entry: string) => (entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry);
    const covers = (entry: string) => cache === expand(entry) || cache.startsWith(`${expand(entry)}${path.sep}`);

    // A worktree that could only link to an install still reads it.
    expect(filesystem.denyRead.filter(covers)).toEqual([]);
    // An agent's install must not change what other runs get.
    expect(filesystem.allowWrite.filter(covers)).toEqual([]);
  });

  it('puts the Read rules among the deny rules and ahead of a flag', () => {
    const args = claudeCodeBackend.buildArgs(base, '/tmp/out.json');
    const at = args.indexOf('--disallowedTools');
    const rules = args.slice(
      at + 1,
      args.findIndex((arg, i) => i > at && arg.startsWith('--')),
    );
    expect(rules).toContain('Read(~/.ssh/**)');
  });
});
