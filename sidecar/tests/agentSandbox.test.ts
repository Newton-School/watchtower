import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SETTINGS_WRITE_DENY_RULES,
  agentSandboxSettings,
  configureAgentSandbox,
  gitCommonDir,
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

  // Issue #622: `git blame --contents ~/.claude/history.jsonl` printed the file in a read-only run.
  it("hides the owner's Claude sessions, shell history and miniOG's records, files as well as folders", () => {
    configureAgentSandbox({ miniOgRepoRoot: root, repoPaths: [] });

    const { filesystem } = agentSandboxSettings({ readOnly: true, cwd: root }).sandbox as {
      filesystem: { denyRead: string[] };
    };
    for (const secret of [
      '~/.claude/history.jsonl',
      '~/.claude/session-env',
      '~/.claude/settings.json',
      '~/.zsh_history',
      '~/.profile',
      '~/.config/gh/hosts.yml',
      '~/.watchtower/vault',
      '~/.watchtower/egress',
      '~/.watchtower/logs',
      '~/.watchtower/autostash',
    ]) {
      expect(filesystem.denyRead).toContain(secret);
    }
    // A file needs its own rule: `~/.netrc/**` never matched `~/.netrc`.
    expect(sandboxReadDenyRules()).toEqual(
      expect.arrayContaining(['Read(~/.netrc)', 'Read(~/.claude/history.jsonl)', 'Read(~/.ssh)', 'Read(~/.ssh/**)']),
    );
    // Commands source the CLI's shell snapshot; runs that do work use skills' files.
    for (const needed of ['~/.claude/shell-snapshots', '~/.claude/skills', '~/.claude/plugins', '~/.claude']) {
      expect(filesystem.denyRead).not.toContain(needed);
    }
  });

  it('lets a read-only run write only under /tmp, never in its working directory or the caches', () => {
    configureAgentSandbox({ miniOgRepoRoot: root, repoPaths: [path.join(root, 'newton-web')] });

    const { filesystem } = agentSandboxSettings({ readOnly: true, cwd: '/lookups/lookup-1' }).sandbox as {
      filesystem: { allowWrite: string[]; denyWrite: string[] };
    };
    expect(filesystem.allowWrite).toEqual(['/tmp', '/private/tmp']);
    expect(filesystem.denyWrite).toEqual(['/lookups/lookup-1']);
  });

  // Issue #610: the CLI makes every --add-dir folder writable, and `git log --output=<file>` wrote into one.
  it('never lets a run write into the other repos it is given to read', () => {
    const readDirs = ['/code/mini-og/newton-web', '/code/mini-og/newton-marketing-web'];

    const settings = settingsOf(claudeCodeBackend.buildArgs({ ...base, readOnly: true, readDirs }, '/tmp/out.json'));
    const { filesystem } = settings!.sandbox as { filesystem: { denyWrite: string[] } };
    expect(filesystem.denyWrite).toEqual(expect.arrayContaining(['/tmp/wt', ...readDirs]));

    const working = agentSandboxSettings({ readOnly: false, cwd: '/tmp/wt', readDirs }).sandbox as {
      filesystem: { denyWrite: string[] };
    };
    expect(working.filesystem.denyWrite).toEqual(readDirs);
  });

  describe("a read-only run is refused the checkouts' git directories", () => {
    let tmp: string;
    let clone: string;
    let worktree: string;
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sandbox-git-')));
      clone = path.join(tmp, 'newton-api');
      fs.mkdirSync(clone);
      git(clone, 'init', '-q', '-b', 'main');
      git(clone, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'A');
      worktree = path.join(tmp, 'workspaces', 'newton-api', '1.1');
      git(clone, 'worktree', 'add', '-q', '--detach', worktree);
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("finds a linked worktree's history in its main clone", () => {
      expect(gitCommonDir(worktree)).toBe(path.join(clone, '.git'));
      expect(gitCommonDir(clone)).toBe(path.join(clone, '.git'));
      expect(gitCommonDir(tmp)).toBeUndefined();
    });

    it("denies writes to the main clone's .git for a run in a worktree, and for a folder of worktrees", () => {
      const inWorktree = agentSandboxSettings({ readOnly: true, cwd: worktree }).sandbox as {
        filesystem: { denyWrite: string[] };
      };
      expect(inWorktree.filesystem.denyWrite).toEqual([worktree, path.join(clone, '.git')]);

      // A lookup's copy: one worktree per repo inside the slot folder.
      const slot = path.dirname(worktree);
      const inSlot = agentSandboxSettings({ readOnly: true, cwd: slot }).sandbox as {
        filesystem: { denyWrite: string[] };
      };
      expect(inSlot.filesystem.denyWrite).toContain(path.join(clone, '.git'));
    });

    it("leaves a working run's git directory alone: it commits there", () => {
      const working = agentSandboxSettings({ readOnly: false, cwd: worktree }).sandbox as {
        filesystem: { denyWrite?: string[] };
      };
      expect(working.filesystem.denyWrite).toBeUndefined();
    });
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

  const denyRulesOf = (args: string[]) => {
    const at = args.indexOf('--disallowedTools');
    return at === -1
      ? []
      : args.slice(
          at + 1,
          args.findIndex((arg, i) => i > at && arg.startsWith('--')),
        );
  };

  it('puts the Read rules among the deny rules and ahead of a flag', () => {
    expect(denyRulesOf(claudeCodeBackend.buildArgs(base, '/tmp/out.json'))).toContain('Read(~/.ssh/**)');
  });

  // Issue #609: the sandbox refuses shell writes under `.claude/`, so a skill's
  // ledger is saved with the Write tool, which is not sandboxed. A hook written
  // the same way ran outside the sandbox, so settings and hooks are refused to it.
  it("refuses the file tools Claude Code's settings and hooks at any depth, but not a skill's files", () => {
    expect(SETTINGS_WRITE_DENY_RULES).toEqual([
      'Edit(//**/.claude/settings.json)',
      'Edit(//**/.claude/settings.local.json)',
      'Edit(//**/.claude/hooks/**)',
    ]);
    for (const editable of ['skills', 'commands', 'agents']) {
      expect(SETTINGS_WRITE_DENY_RULES.some(rule => rule.includes(`/.claude/${editable}`))).toBe(false);
    }

    const rules = denyRulesOf(claudeCodeBackend.buildArgs(base, '/tmp/out.json'));
    expect(rules).toEqual(expect.arrayContaining(SETTINGS_WRITE_DENY_RULES));
    expect(denyRulesOf(claudeCodeBackend.buildArgs({ ...base, readOnly: true }, '/tmp/out.json'))).toEqual(
      expect.arrayContaining(SETTINGS_WRITE_DENY_RULES),
    );
  });

  it('adds no settings rule when the run is not sandboxed, as the Read rules', () => {
    const optedOut = denyRulesOf(claudeCodeBackend.buildArgs({ ...base, sandbox: false }, '/tmp/out.json'));
    expect(optedOut.some(rule => rule.startsWith('Edit('))).toBe(false);
    expect(denyRulesOf(claudeCodeBackend.buildArgs({ ...base, noTools: true }, '/tmp/out.json'))).toEqual([]);
  });

  it("doesn't list the worktree's `.claude` in allowWrite: the sandbox protects it whatever the list says", () => {
    const { filesystem } = agentSandboxSettings({ readOnly: false, cwd: '/ws/repo/1-1' }).sandbox as {
      filesystem: { allowWrite: string[] };
    };
    expect(filesystem.allowWrite.some(entry => entry.includes('.claude'))).toBe(false);
  });
});
