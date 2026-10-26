import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITHUB_OVER_HTTPS_GIT_CONFIG,
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
    expect(merged.GIT_CONFIG_COUNT).toBe(String(1 + GITHUB_OVER_HTTPS_GIT_CONFIG.length + 3));
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
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ghenv-'));
    // A home whose git config has its own github.com helper: the run's must replace it.
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[credential "https://github.com"]\n\thelper = "!f() { echo username=owner; echo password=owners-login; }; f"\n',
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
    await expect(git(repos.scp, ['push', '--dry-run', 'origin', 'HEAD:refs/heads/x'], env)).rejects.toThrow(/no-push/);
  });

  it("answers github.com credentials with the run's token, not the home config's helper", async () => {
    const env = { ...mergeAgentEnv([githubAccessGitEnv('run-token')]), GH_TOKEN: 'run-token' };
    const filled = await git(repos.https, ['credential', 'fill'], env, 'protocol=https\nhost=github.com\n\n');
    expect(filled).toContain('username=x-access-token');
    expect(filled).toContain('password=run-token');
    expect(filled).not.toContain('owners-login');
  });

  it('leaves other hosts to the configured helpers', async () => {
    const env = mergeAgentEnv([githubAccessGitEnv('t')]);
    const helpers = await git(
      repos.https,
      ['config', '--get-urlmatch', 'credential.helper', 'https://gitlab.com'],
      env,
    ).catch(() => '');
    expect(helpers).not.toContain('GH_TOKEN');
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

  it('is skipped, not fatal, when it cannot be made', async () => {
    expect(await makeGhConfigDir(path.join(os.tmpdir(), 'wt-no-such-dir', 'x'), 't')).toBeUndefined();
  });
});
