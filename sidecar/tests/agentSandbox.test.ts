import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOST_CONFIG_WRITE_DENY_RULES,
  SETTINGS_WRITE_DENY_RULES,
  agentSandboxSettings,
  configureAgentSandbox,
  fileWriteDenyRules,
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

  // Issue #743: a run with the sandbox off (browser QA, deploys) has the same file tools.
  it('keeps the file-tool write rules on a run without the sandbox, but not the Read rules', () => {
    const optedOut = denyRulesOf(claudeCodeBackend.buildArgs({ ...base, sandbox: false }, '/tmp/out.json'));
    expect(optedOut).toEqual(expect.arrayContaining(fileWriteDenyRules()));
    expect(optedOut.some(rule => rule.startsWith('Read('))).toBe(false);

    process.env.WATCHTOWER_AGENT_SANDBOX = '0';
    expect(denyRulesOf(claudeCodeBackend.buildArgs(base, '/tmp/out.json'))).toEqual(
      expect.arrayContaining(fileWriteDenyRules()),
    );
    expect(denyRulesOf(claudeCodeBackend.buildArgs({ ...base, noTools: true }, '/tmp/out.json'))).toEqual([]);
  });

  // Gitignore-style, as the CLI matches: a rule that matches a folder refuses
  // every file under it (measured on CLI 2.1.310: `Edit(~/x/*)` refused a write
  // to `~/x/workspaces/repo/1-1/src/index.ts`).
  const refuses = (rule: string, file: string): boolean => {
    const pattern = rule.slice('Edit('.length, -1).replace(/^~\//, `${home}/`).replace(/^\/\//, '/');
    const toRegex = (part: string) =>
      part
        .split('*')
        .map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*');
    const re = new RegExp(`^${pattern.split('**').map(toRegex).join('.*')}$`);
    const segments = file.split('/');
    return segments.some((_, i) => i > 0 && re.test(segments.slice(0, i + 1).join('/')));
  };
  const refusedByAny = (file: string) => fileWriteDenyRules().some(rule => refuses(rule, file));

  it('a single-star rule on the data folder would refuse the worktrees too', () => {
    expect(refuses('Edit(~/.watchtower/*)', `${home}/.watchtower/workspaces/newton-web/1-1/src/index.ts`)).toBe(true);
  });

  // Issue #743: with permissions bypassed the file tools skip the CLI's own
  // checks on `.git` and `.claude`, and write anywhere the user can.
  it('refuses the file tools config outside the worktree that runs commands outside the sandbox', () => {
    configureAgentSandbox({
      repoPaths: [],
      appDataDir: path.join(home, 'Library', 'Application Support', 'com.example.watchtower'),
    });
    const refused = [
      path.join(root, 'newton-web', '.git', 'config'),
      path.join(root, 'newton-web', '.git', 'hooks', 'pre-push'),
      path.join(root, 'newton-web', '.git', 'modules', 'lib', 'config'),
      path.join(root, 'newton-web', '.git', 'worktrees', '1-1', 'config.worktree'),
      `${home}/.gitconfig`,
      `${home}/.config/git/config`,
      `${home}/.bashrc`,
      `${home}/.profile`,
      `${home}/.zshrc`,
      `${home}/.npmrc`,
      `${home}/Library/LaunchAgents/com.example.plist`,
      `${home}/.ssh/config`,
      `${home}/.claude.json`,
      `${home}/.claude/CLAUDE.md`,
      `${home}/.claude/commands/x.md`,
      `${home}/.claude/skills/x/SKILL.md`,
      `${home}/.claude/settings.json`,
      `${home}/.watchtower/watchtower.db`,
      `${home}/.watchtower/dep-cache/abc/node_modules/left-pad/index.js`,
      `${home}/.watchtower/vault/notes.md`,
      `${home}/.watchtower/lookup-workspaces/1/newton-web/a.ts`,
      `${home}/Library/Application Support/com.example.watchtower/watchtower.db`,
    ];
    for (const file of refused) expect(refusedByAny(file), file).toBe(true);
  });

  it("leaves the worktree writable, its `.claude/skills` included, and /tmp and the planner's plan files", () => {
    configureAgentSandbox({ repoPaths: [], appDataDir: path.join(home, '.watchtower') });
    const worktree = `${home}/.watchtower/workspaces/newton-marketing-web/1793-1`;
    const writable = [
      `${worktree}/src/index.ts`,
      `${worktree}/package.json`,
      `${worktree}/.claude/skills/parity-audit/ledgers/nst-home.json`,
      `${worktree}/.claude/skills/parity-audit/SKILL.md`,
      `${worktree}/.claude/commands/x.md`,
      `${worktree}/.github/workflows/ci.yml`,
      '/tmp/miniog-attachments/table.csv',
      `${home}/.claude/plans/plan.md`,
    ];
    for (const file of writable) expect(refusedByAny(file), file).toBe(false);
    expect(HOST_CONFIG_WRITE_DENY_RULES.every(rule => /^Edit\((~\/|\/\/\*\*\/\.git\/)/.test(rule))).toBe(true);
  });

  it("refuses the app's data folder by a rule from the root when it is outside home", () => {
    configureAgentSandbox({ repoPaths: [], appDataDir: '/var/lib/watchtower' });
    expect(fileWriteDenyRules()).toContain('Edit(//var/lib/watchtower/**)');
    configureAgentSandbox({ repoPaths: [], appDataDir: path.join(home, '.watchtower') });
    expect(fileWriteDenyRules().filter(rule => rule.endsWith('/.watchtower/**)'))).toEqual([]);
  });

  it("doesn't list the worktree's `.claude` in allowWrite: the sandbox protects it whatever the list says", () => {
    const { filesystem } = agentSandboxSettings({ readOnly: false, cwd: '/ws/repo/1-1' }).sandbox as {
      filesystem: { allowWrite: string[] };
    };
    expect(filesystem.allowWrite.some(entry => entry.includes('.claude'))).toBe(false);
  });
});
