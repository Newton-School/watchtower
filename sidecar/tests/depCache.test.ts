import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __depCache,
  __resetDepCacheState,
  depsPromptLine,
  installEnv,
  planDeps,
  prepareWorktreeDeps,
} from '../src/workspaces/depCache.js';
import { buildCoderPrompt, buildReviewerPrompt, buildVerifierPrompt } from '../src/agents/prompts.js';
import type { AgentContext } from '../src/agents/types.js';

// Issue #611: worktrees got a symlink to the shared clone's node_modules, which
// for the marketing site was an empty directory, so reviews skipped their
// typecheck, lint and build gates and change runs installed deps themselves.

const original = { ...__depCache };
const NPM_CI = 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error';
let tmp: string;
let installs: string[];

function write(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

/** A worktree miniOG made, as `resolveWorkspace` lays them out: <root>/<repo>/<thread>. */
function worktree(name: string, lock = '{"lockfileVersion":3,"v":1}', repo = 'newton-marketing-web'): string {
  const dir = path.join(__depCache.workspacesRoot, repo, name);
  write(dir, { 'package.json': '{"name":"site"}', 'package-lock.json': lock });
  return dir;
}

/** A stand-in for `npm ci`: writes a node_modules into the install dir. */
async function fakeInstall(dir: string): Promise<void> {
  installs.push(dir);
  write(path.join(dir, 'node_modules', 'next'), { 'index.js': 'module.exports = 1;' });
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}

const repoDir = () => path.join(__depCache.root, 'newton-marketing-web');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-depcache-'));
  installs = [];
  __resetDepCacheState();
  Object.assign(__depCache, {
    root: path.join(tmp, 'cache'),
    workspacesRoot: path.join(tmp, 'workspaces'),
    minFreeBytes: 0,
    install: vi.fn(fakeInstall),
    copy: vi.fn(async (source: string, target: string) => {
      fs.cpSync(source, target, { recursive: true });
    }),
  });
});

afterEach(() => {
  Object.assign(__depCache, original);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the cache key', () => {
  it('follows package.json, the lockfile, the npm config and the Node major version', () => {
    const dir = worktree('a');
    const plan = planDeps(dir, '20.9.0');
    expect(plan).toMatchObject({ kind: 'install', manager: 'npm', lockfile: 'package-lock.json' });
    const key = plan.kind === 'install' ? plan.key : '';

    expect(planDeps(dir, '20.11.0')).toMatchObject({ key });
    expect(planDeps(dir, '22.1.0')).not.toMatchObject({ key });

    write(dir, { 'package.json': '{"name":"site","dependencies":{"left-pad":"1.3.0"}}' });
    expect(planDeps(dir, '20.9.0')).not.toMatchObject({ key });
    write(dir, { 'package.json': '{"name":"site"}' });
    expect(planDeps(dir, '20.9.0')).toMatchObject({ key });

    write(dir, { '.npmrc': 'legacy-peer-deps=true\n' });
    expect(planDeps(dir, '20.9.0')).not.toMatchObject({ key });
    fs.rmSync(path.join(dir, '.npmrc'));
    write(dir, { 'package-lock.json': '{"lockfileVersion":3,"v":2}' });
    expect(planDeps(dir, '20.9.0')).not.toMatchObject({ key });
  });

  it('picks the package manager from the lockfile, and leaves out what it cannot install', () => {
    const pnpm = path.join(tmp, 'pnpm');
    write(pnpm, { 'package.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 9' });
    expect(planDeps(pnpm)).toMatchObject({
      manager: 'pnpm',
      command: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
    });

    const api = path.join(tmp, 'api');
    write(api, { 'requirements.txt': 'django' });
    expect(planDeps(api)).toEqual({ kind: 'none' });

    const monorepo = path.join(tmp, 'mono');
    write(monorepo, { 'package.json': '{"workspaces":["packages/*"]}', 'package-lock.json': '{}' });
    expect(planDeps(monorepo)).toMatchObject({ kind: 'unsupported' });

    const unlocked = path.join(tmp, 'unlocked');
    write(unlocked, { 'package.json': '{}' });
    expect(planDeps(unlocked)).toEqual({ kind: 'unsupported', reason: 'the repo has no lockfile' });
  });
});

describe('the install', () => {
  it('runs no package scripts: it is outside the sandbox and shared between runs', () => {
    const yarn = path.join(tmp, 'yarn');
    write(yarn, { 'package.json': '{}', 'yarn.lock': '' });
    for (const dir of [worktree('s'), yarn]) {
      const plan = planDeps(dir);
      expect(plan.kind === 'install' && plan.command).toContain('--ignore-scripts');
    }
  });

  it("gets none of the sidecar's secrets", () => {
    const env = installEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GITHUB_TOKEN: 'ghp_secret',
      GH_TOKEN: 'ghp_secret',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      WATCHTOWER_DB_PATH: '/Users/x/Library/Application Support/watchtower.db',
      NODE_OPTIONS: '--require /tmp/evil.js',
    });

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', SSH_AUTH_SOCK: '/tmp/agent.sock', CI: '1' });
  });
});

describe('prepareWorktreeDeps', () => {
  it('installs a lockfile once, and gives each worktree its own copy', async () => {
    const first = await prepareWorktreeDeps(worktree('111.1'));
    expect(first).toMatchObject({ status: 'ready', installed: true });
    expect(installs).toHaveLength(1);
    // The install ran in a temp dir beside the cache entry, with the manifest copied in.
    expect(installs[0]).toContain(`${path.sep}newton-marketing-web${path.sep}`);

    const secondDir = worktree('222.2');
    const second = await prepareWorktreeDeps(secondDir);
    expect(second).toMatchObject({ status: 'ready', installed: false });
    expect(installs).toHaveLength(1);
    expect(fs.existsSync(path.join(secondDir, 'node_modules', 'next', 'index.js'))).toBe(true);
    expect(fs.lstatSync(path.join(secondDir, 'node_modules')).isSymbolicLink()).toBe(false);

    // Asked again (a re-review in the same thread): already right, nothing copied.
    vi.mocked(__depCache.copy).mockClear();
    expect(await prepareWorktreeDeps(secondDir)).toMatchObject({ status: 'ready', installed: false, ms: 0 });
    expect(__depCache.copy).not.toHaveBeenCalled();
  });

  it('shares one install between runs that ask at the same time', async () => {
    const gate = deferred();
    __depCache.install = vi.fn(async (dir: string) => {
      await gate.promise;
      await fakeInstall(dir);
    });

    const runs = Promise.all([prepareWorktreeDeps(worktree('1.1')), prepareWorktreeDeps(worktree('2.2'))]);
    gate.release();
    const [a, b] = await runs;

    expect(__depCache.install).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ status: 'ready' });
    expect(b).toMatchObject({ status: 'ready' });
  });

  it('lets a stopped run stop waiting, while the install carries on for the others', async () => {
    const gate = deferred();
    __depCache.install = vi.fn(async (dir: string) => {
      await gate.promise;
      await fakeInstall(dir);
    });
    const stop = new AbortController();

    const stopped = prepareWorktreeDeps(worktree('11.1'), { signal: stop.signal });
    const waiting = prepareWorktreeDeps(worktree('11.2'));
    stop.abort();
    expect(await stopped).toMatchObject({ status: 'unavailable', reason: 'the run was stopped during the install' });
    gate.release();
    expect(await waiting).toMatchObject({ status: 'ready' });

    // The stop is not held against the next run.
    expect(await prepareWorktreeDeps(worktree('11.3'))).toMatchObject({ status: 'ready', installed: false });
    expect(__depCache.install).toHaveBeenCalledTimes(1);
  });

  it('replaces the link to the shared clone, without touching the clone', async () => {
    const clone = path.join(tmp, 'mini-og', 'newton-marketing-web');
    write(path.join(clone, 'node_modules', 'old'), { 'index.js': 'stale' });
    const dir = worktree('3.3');
    fs.symlinkSync(path.join(clone, 'node_modules'), path.join(dir, 'node_modules'));

    expect(await prepareWorktreeDeps(dir)).toMatchObject({ status: 'ready' });

    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules', 'next'))).toBe(true);
    expect(fs.readFileSync(path.join(clone, 'node_modules', 'old', 'index.js'), 'utf8')).toBe('stale');
  });

  it('leaves a shared clone alone: only worktrees miniOG made get deps', async () => {
    const clone = path.join(tmp, 'mini-og', 'newton-marketing-web');
    write(clone, { 'package.json': '{}', 'package-lock.json': '{}' });

    expect(await prepareWorktreeDeps(clone)).toEqual({ status: 'skipped' });
    expect(installs).toHaveLength(0);
    expect(fs.existsSync(path.join(clone, 'node_modules'))).toBe(false);
    expect(depsPromptLine(clone)).toBe('');
  });

  it('falls back when the install fails, says so to the agents, and does not retry it straight away', async () => {
    __depCache.install = vi.fn(async () => {
      throw Object.assign(new Error('Command failed: npm ci'), { stderr: 'npm ERR! code ERESOLVE\nnpm ERR! peer dep' });
    });
    const clone = path.join(tmp, 'mini-og', 'newton-marketing-web');
    write(path.join(clone, 'node_modules', 'old'), { 'index.js': 'stale' });
    const dir = worktree('4.4');
    fs.symlinkSync(path.join(clone, 'node_modules'), path.join(dir, 'node_modules'));
    const logStep = vi.fn();

    const result = await prepareWorktreeDeps(dir, { logStep });

    expect(result).toMatchObject({ status: 'unavailable', command: NPM_CI });
    expect(result.status === 'unavailable' && result.reason).toContain('ERESOLVE');
    // Today's behaviour stays: the link to the shared clone's install.
    expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN' }));
    expect(depsPromptLine(dir)).toContain('miniOG could not install them for this checkout');
    expect(depsPromptLine(dir)).toContain('rm node_modules && npm ci');
    // No temp install left behind in the cache.
    expect(fs.readdirSync(repoDir()).filter(name => name.includes('.tmp-'))).toEqual([]);

    const again = await prepareWorktreeDeps(worktree('5.5'));
    expect(again).toMatchObject({ status: 'unavailable' });
    expect(__depCache.install).toHaveBeenCalledTimes(1);
    expect(depsPromptLine(path.join(__depCache.workspacesRoot, 'newton-marketing-web', '5.5'))).toContain(
      'NOT installed',
    );
  });

  it('removes a partial copy and reports the deps missing when the copy fails', async () => {
    __depCache.copy = vi.fn(async (source: string, target: string) => {
      fs.mkdirSync(path.join(target, 'next'), { recursive: true });
      throw Object.assign(new Error('cp: write error: No space left on device'), { code: 'ENOSPC' });
    });
    const dir = worktree('12.1');

    const result = await prepareWorktreeDeps(dir);

    expect(result).toEqual({ status: 'unavailable', reason: 'the disk filled up during the copy', command: NPM_CI });
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(depsPromptLine(dir)).toContain('NOT installed');
  });

  it('does not take a copy that came out incomplete for an install', async () => {
    // The install was pruned from under the copy, which then "succeeded" with nothing.
    __depCache.copy = vi.fn(async (_source: string, target: string) => {
      fs.mkdirSync(target, { recursive: true });
    });
    const dir = worktree('12.2');

    expect(await prepareWorktreeDeps(dir)).toMatchObject({ status: 'unavailable', reason: 'the copy is incomplete' });
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
  });

  it('keeps only the most recently used installs of a repo', async () => {
    __depCache.keepPerRepo = 1;
    await prepareWorktreeDeps(worktree('6.1', '{"v":"old"}'));
    await prepareWorktreeDeps(worktree('6.2', '{"v":"new"}'));

    expect(fs.readdirSync(repoDir())).toHaveLength(1);
    // The worktree on the pruned install still has its own copy.
    expect(
      fs.existsSync(path.join(__depCache.workspacesRoot, 'newton-marketing-web', '6.1', 'node_modules', 'next')),
    ).toBe(true);
  });

  it('does not prune an install while a worktree is being copied from it', async () => {
    __depCache.keepPerRepo = 1;
    await prepareWorktreeDeps(worktree('13.1', '{"v":"old"}'));
    const oldEntry = fs.readdirSync(repoDir())[0];

    // A second worktree on the old lockfile is mid-copy...
    const copying = deferred();
    const copyStarted = deferred();
    __depCache.copy = vi.fn(async (source: string, target: string) => {
      if (source.includes(oldEntry)) {
        copyStarted.release();
        await copying.promise;
      }
      fs.cpSync(source, target, { recursive: true });
    });
    const slow = prepareWorktreeDeps(worktree('13.2', '{"v":"old"}'));
    await copyStarted.promise;

    // ...when another run installs a new lockfile, which prunes down to one.
    expect(await prepareWorktreeDeps(worktree('13.3', '{"v":"new"}'))).toMatchObject({ status: 'ready' });
    expect(fs.readdirSync(repoDir())).toContain(oldEntry);

    copying.release();
    expect(await slow).toMatchObject({ status: 'ready' });
    expect(
      fs.existsSync(path.join(__depCache.workspacesRoot, 'newton-marketing-web', '13.2', 'node_modules', 'next')),
    ).toBe(true);
  });

  it.runIf(process.platform === 'darwin')(
    'clones the install copy-on-write, so a write stays in the worktree',
    async () => {
      __depCache.copy = original.copy;
      const dir = worktree('8.8');

      expect(await prepareWorktreeDeps(dir)).toMatchObject({ status: 'ready' });
      expect(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink()).toBe(false);
      fs.writeFileSync(path.join(dir, 'node_modules', 'next', 'index.js'), 'changed by an agent');

      const other = worktree('9.9');
      await prepareWorktreeDeps(other);
      expect(fs.readFileSync(path.join(other, 'node_modules', 'next', 'index.js'), 'utf8')).toBe('module.exports = 1;');
    },
  );

  it('puts the line under "Repository:" for the coder, reviewer and verifier', async () => {
    const dir = worktree('10.10');
    await prepareWorktreeDeps(dir);
    const ctx = {
      workflowIntent: 'IMPLEMENTATION',
      task: { event: { channelId: 'C1', threadTs: '1.1' } },
      config: {},
      repoPath: dir,
      threadContext: '',
      previousSteps: [],
      pipelineConfig: { agents: ['coder'] },
    } as unknown as AgentContext;

    for (const prompt of [buildCoderPrompt(ctx), buildReviewerPrompt(ctx), buildVerifierPrompt(ctx)]) {
      expect(prompt).toContain(`Repository: ${dir}\nDependencies: installed in node_modules`);
    }
    // Nothing to say for a path that isn't a worktree: the prompt is as before.
    expect(buildCoderPrompt({ ...ctx, repoPath: '/elsewhere' })).toContain('Repository: /elsewhere\nPolicy:');
  });

  it('tells the agents the deps are installed, and that install scripts did not run', async () => {
    const dir = worktree('7.7');
    await prepareWorktreeDeps(dir);
    expect(depsPromptLine(dir)).toBe(
      `Dependencies: installed in node_modules for this checkout's package-lock.json (with \`${NPM_CI}\`, before you started: packages' install scripts did not run). Run the repo's own typecheck, lint, test and build scripts directly; reinstall only if you change package.json or the lockfile.`,
    );
  });
});
