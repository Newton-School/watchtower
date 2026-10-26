import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITHUB_OVER_HTTPS_GIT_CONFIG,
  NO_UPSTREAM_WRITES_GIT_CONFIG,
  agentGitDefaultsEnv,
  gitConfigEntries,
  gitConfigEnv,
  githubAccessGitEnv,
  makeGhConfigDir,
  mergeAgentEnv,
} from '../src/backends/agentGitHubEnv.js';
import { NO_PUSH_TO_GITHUB_ENV } from '../src/github/noPush.js';

const execFileAsync = promisify(execFile);

describe('git settings for agent runs (issue #746)', () => {
  it('reads complete GIT_CONFIG pairs and leaves out a pair missing a half', () => {
    expect(
      gitConfigEntries({
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'a.b',
        GIT_CONFIG_VALUE_0: '1',
        GIT_CONFIG_KEY_1: 'c.d',
        GIT_CONFIG_KEY_2: 'e.f',
        GIT_CONFIG_VALUE_2: '',
      }),
    ).toEqual([
      ['a.b', '1'],
      ['e.f', ''],
    ]);
    expect(gitConfigEntries({ GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' })).toEqual([]);
    expect(gitConfigEntries(undefined)).toEqual([]);
  });

  it('gives a run with a token the HTTPS rewrite and token helper, and nothing without one', () => {
    expect(githubAccessGitEnv(undefined)).toEqual({});
    const env = githubAccessGitEnv('t0ken');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(gitConfigEntries(env)).toEqual(GITHUB_OVER_HTTPS_GIT_CONFIG);
    expect(JSON.stringify(env)).not.toContain('t0ken');
  });

  it("keeps every layer's git entries in order instead of letting one layer's KEY_0 replace another's", () => {
    const merged = mergeAgentEnv([
      { PATH: '/base', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.base', GIT_CONFIG_VALUE_0: 'x' },
      { PATH: '/backend' },
      githubAccessGitEnv('t'),
      NO_PUSH_TO_GITHUB_ENV,
    ]);
    expect(merged.PATH).toBe('/backend');
    expect(gitConfigEntries(merged)).toEqual([
      ['core.base', 'x'],
      ...GITHUB_OVER_HTTPS_GIT_CONFIG,
      ...gitConfigEntries(NO_PUSH_TO_GITHUB_ENV),
    ]);
    expect(merged.GIT_CONFIG_COUNT).toBe(
      String(1 + GITHUB_OVER_HTTPS_GIT_CONFIG.length + gitConfigEntries(NO_PUSH_TO_GITHUB_ENV).length),
    );
  });

  it('gives every run the settings that keep git from recording upstreams, token or not', () => {
    expect(gitConfigEntries(agentGitDefaultsEnv())).toEqual(NO_UPSTREAM_WRITES_GIT_CONFIG);
    expect(NO_UPSTREAM_WRITES_GIT_CONFIG).toEqual([
      ['branch.autoSetupMerge', 'false'],
      ['push.autoSetupRemote', 'false'],
    ]);
  });

  it("can't have its entries dropped by a later layer's count or stray keys", () => {
    const merged = mergeAgentEnv([
      githubAccessGitEnv('t'),
      { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'url.x.insteadOf', GIT_CONFIG_VALUE_7: 'y' },
    ]);
    expect(gitConfigEntries(merged)).toEqual(GITHUB_OVER_HTTPS_GIT_CONFIG);
    expect(Object.keys(merged).filter(key => key.startsWith('GIT_CONFIG_'))).toHaveLength(
      1 + 2 * GITHUB_OVER_HTTPS_GIT_CONFIG.length,
    );
  });

  it('writes no git variables when no layer has entries', () => {
    expect(mergeAgentEnv([{ A: '1' }, undefined, {}])).toEqual({ A: '1' });
    expect(gitConfigEnv([])).toEqual({});
  });
});

describe('what git does with those settings (real git, no network)', () => {
  let root: string;
  let home: string;
  const repos: Record<string, string> = {};
  const urls = {
    scp: 'git@github.com:Newton-School/example.git',
    ssh: 'ssh://git@github.com/Newton-School/example.git',
    https: 'https://github.com/Newton-School/example.git',
    httpsPort: 'https://github.com:443/Newton-School/example.git',
    sshPort: 'ssh://git@github.com:22/Newton-School/example.git',
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ghenv-'));
    // A home whose git config has a generic helper (like osxkeychain) and its
    // own github.com one: the run's must replace both for github.com only.
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      [
        '[credential]',
        '\thelper = "!f() { test \\"$1\\" = get && echo username=generic && echo password=generic-login; }; f"',
        '[credential "https://github.com"]',
        '\thelper = "!f() { echo username=owner; echo password=owners-login; }; f"',
        '',
      ].join('\n'),
    );
    for (const [name, url] of Object.entries(urls)) {
      const dir = path.join(root, name);
      await execFileAsync('git', ['init', '-q', dir]);
      await execFileAsync('git', ['-C', dir, 'remote', 'add', 'origin', url]);
      repos[name] = dir;
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const gitEnv = (layer: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    ...layer,
  });
  const git = async (cwd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<string> => {
    if (input === undefined) {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv(env) });
      return stdout.trim();
    }
    return await new Promise((resolve, reject) => {
      const child = execFile('git', ['-C', cwd, ...args], { env: gitEnv(env) }, (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim()),
      );
      child.stdin?.end(input);
    });
  };

  it('fetches and pushes github.com SSH remotes over HTTPS in a normal run', async () => {
    const env = mergeAgentEnv([githubAccessGitEnv('t')]);
    for (const name of ['scp', 'ssh', 'https']) {
      expect(await git(repos[name], ['remote', 'get-url', 'origin'], env)).toBe(urls.https);
      expect(await git(repos[name], ['remote', 'get-url', '--push', 'origin'], env)).toBe(urls.https);
    }
  });

  it("still can't push in a follow-up run, over any form of URL, while fetches go over HTTPS", async () => {
    const env = mergeAgentEnv([githubAccessGitEnv('t'), NO_PUSH_TO_GITHUB_ENV]);
    for (const name of ['scp', 'ssh', 'https']) {
      expect(await git(repos[name], ['remote', 'get-url', 'origin'], env)).toBe(urls.https);
      expect(await git(repos[name], ['remote', 'get-url', '--push', 'origin'], env)).toMatch(/^no-push:\/\//);
    }
    for (const name of ['httpsPort', 'sshPort']) {
      expect(await git(repos[name], ['remote', 'get-url', '--push', 'origin'], env)).toMatch(/^no-push:\/\//);
    }
    await expect(git(repos.scp, ['push', '--dry-run', 'origin', 'HEAD:refs/heads/x'], env)).rejects.toThrow(/no-push/);
  });

  it("answers github.com credentials with the run's token, not the home config's helpers", async () => {
    const env = { ...mergeAgentEnv([githubAccessGitEnv('run-token')]), GH_TOKEN: 'run-token' };
    const filled = await git(repos.https, ['credential', 'fill'], env, 'protocol=https\nhost=github.com\n\n');
    expect(filled).toContain('username=x-access-token');
    expect(filled).toContain('password=run-token');
    expect(filled).not.toContain('owners-login');
    expect(filled).not.toContain('generic-login');
  });

  it('prints a token with backslashes or a leading dash as it is', async () => {
    const token = '-n a\\nb';
    const env = { ...mergeAgentEnv([githubAccessGitEnv(token)]), GH_TOKEN: token };
    const filled = await git(repos.https, ['credential', 'fill'], env, 'protocol=https\nhost=github.com\n\n');
    expect(filled.split('\n')).toContain(`password=${token}`);
  });

  it('leaves other hosts to the configured helpers', async () => {
    const env = { ...mergeAgentEnv([githubAccessGitEnv('run-token')]), GH_TOKEN: 'run-token' };
    const filled = await git(repos.https, ['credential', 'fill'], env, 'protocol=https\nhost=gitlab.com\n\n');
    expect(filled).toContain('password=generic-login');
    expect(filled).not.toContain('run-token');
  });
});

describe("the run's gh config folder", () => {
  it('is an empty 0700 folder inside the run temp folder, and only with a token', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ghcfg-'));
    try {
      expect(await makeGhConfigDir(tempDir, undefined)).toBeUndefined();
      const dir = await makeGhConfigDir(tempDir, 't');
      expect(dir).toBe(path.join(tempDir, 'gh'));
      expect(fs.readdirSync(dir!)).toEqual([]);
      expect(fs.statSync(dir!).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('is skipped, not fatal, when it cannot be made, and says why', async () => {
    const codes: string[] = [];
    expect(
      await makeGhConfigDir(path.join(os.tmpdir(), 'wt-no-such-dir', 'x'), 't', code => codes.push(code)),
    ).toBeUndefined();
    expect(codes).toEqual(['ENOENT']);
  });
});

// The sandbox lets a linked worktree's shell write its main clone's `.git`
// but not `.git/config`; an immutable config file stands in for that here.
describe.skipIf(process.platform !== 'darwin')('a linked worktree whose main git config is read-only', () => {
  let root: string;
  let home: string;
  let wt: string;
  let config: string;

  const gitEnv = (layer: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...layer,
  });
  const git = async (cwd: string, args: string[], layer?: NodeJS.ProcessEnv): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv(layer) });
    return stdout.trim();
  };
  const runEnv = (): NodeJS.ProcessEnv => mergeAgentEnv([agentGitDefaultsEnv(), githubAccessGitEnv('t')]);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-upstream-'));
    // The owner's own config turns push.autoSetupRemote on.
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[push]\n\tautoSetupRemote = true\n');
    const remote = path.join(root, 'remote.git');
    const main = path.join(root, 'main');
    wt = path.join(root, 'wt');
    await execFileAsync('git', ['init', '-q', '--bare', remote], { env: gitEnv() });
    await execFileAsync('git', ['init', '-q', '-b', 'main', main], { env: gitEnv() });
    await git(main, ['remote', 'add', 'origin', remote]);
    await git(main, ['commit', '-q', '--allow-empty', '-m', 'init']);
    await git(main, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    await git(main, ['fetch', '-q', 'origin']);
    await git(main, ['worktree', 'add', '-q', '--detach', wt, 'origin/main']);
    config = path.join(main, '.git', 'config');
    await execFileAsync('chflags', ['uchg', config]);
  });

  afterAll(async () => {
    await execFileAsync('chflags', ['nouchg', config]).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** stderr of a git command that may or may not exit 0. */
  const gitStderr = async (cwd: string, args: string[], layer?: NodeJS.ProcessEnv): Promise<string> =>
    execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv(layer) }).then(
      ({ stderr }) => stderr,
      (error: { stderr?: string }) => error.stderr ?? '',
    );

  // Depending on the git version, the refused write either stops the switch
  // (as in the live run) or is only reported; either way it is attempted.
  it('tries to write the main config for a new branch from origin without the run settings (the bug)', async () => {
    const stderr = await gitStderr(wt, ['checkout', '-b', 'without-settings', 'origin/main']);
    expect(stderr).toMatch(/could not write config file .*Operation not permitted/);
  });

  it('switches to a new branch from origin in one step with them, writing no config', async () => {
    const stderr = await gitStderr(wt, ['checkout', '-b', 'with-settings', 'origin/main'], runEnv());
    expect(stderr).not.toMatch(/config/);
    expect(await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('with-settings');
    await expect(git(wt, ['config', '--get', 'branch.with-settings.merge'])).rejects.toThrow();
  });

  it("turns off the owner's push.autoSetupRemote and still pushes HEAD:<branch>", async () => {
    expect(await git(wt, ['config', '--get', 'push.autoSetupRemote'])).toBe('true');
    expect(await git(wt, ['config', '--get', 'push.autoSetupRemote'], runEnv())).toBe('false');
    await git(wt, ['commit', '-q', '--allow-empty', '-m', 'change'], runEnv());
    await git(wt, ['push', '-q', 'origin', 'HEAD:refs/heads/with-settings'], runEnv());
    expect(await git(wt, ['ls-remote', 'origin', 'refs/heads/with-settings'], runEnv())).toContain('with-settings');
  });
});
