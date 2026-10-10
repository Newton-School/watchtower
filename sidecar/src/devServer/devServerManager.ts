import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrContext, WorkflowStepLogger } from '../types/contracts.js';
import { resolveWorkspace, removeWorktreeByPath } from '../workspaces/workspaceManager.js';
import { checkoutPrBranch, fetchPrDiff } from '../github/prReviewSupport.js';
import { buildCodexPath } from '../backends/codexBackend.js';

const execFileAsync = promisify(execFile);

/** A booted dev server serving a PR's code locally, with a teardown handle. */
export interface PrDevServer {
  /** Reachable base URL, e.g. http://127.0.0.1:38080. */
  url: string;
  /** Kill the dev server (process group). Idempotent, best-effort. Worktree
   *  removal is owned by the caller via `PreparedPrWorktree.cleanup`. */
  stop: () => Promise<void>;
}

/** How a PR's changed files map onto a QA strategy (browser QA vs build gate). */
export interface ChangedPathClassification {
  /** package.json / a lockfile changed. */
  depsChanged: boolean;
  /** Node/Docker runtime metadata changed (.nvmrc, .node-version, Dockerfile). */
  runtimeChanged: boolean;
  /** At least one changed path is application/source code (not deps/infra/config). */
  appCodeChanged: boolean;
  /** The PR changes ONLY deps/runtime/infra (no app code) AND touches deps or runtime. */
  depsOrInfraOnly: boolean;
}

export interface PreparedPrWorktree {
  /** Absolute path to the isolated worktree with the PR head checked out. */
  worktreePath: string;
  /** Changed file paths from the PR diff. */
  changedPaths: string[];
  /** Strategy classification derived from `changedPaths`. */
  classification: ChangedPathClassification;
  /** Remove the worktree. Idempotent, best-effort. */
  cleanup: () => Promise<void>;
}

export interface PreparePrWorktreeParams {
  /** Local clone root, e.g. config.repoPaths.newtonWeb. */
  baseRepoPath: string;
  prContext: PrContext;
  threadTs: string;
  githubToken?: string;
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
}

export interface BootPrDevServerParams {
  /** A worktree already prepared by `preparePrWorktree`. */
  worktreePath: string;
  prNumber: number;
  /** Abort → kills the dev server (wired to the job's AbortController). */
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
  /** Max wait for the server to start listening. Default 6 min (cold next dev). */
  readinessTimeoutMs?: number;
}

/** Outcome of an install + build gate run against a PR's own deps/Node. */
export interface PrBuildGateResult {
  /** True only if `npm ci` (and the build script, when present) both succeeded. */
  ok: boolean;
  /** Node version the build actually ran under, e.g. "v24.17.0", or "unknown". */
  nodeVersion: string;
  /** Whether the PR's .nvmrc was honored via nvm (vs falling back to the host Node). */
  usedNvmrc: boolean;
  /** Which stage failed when ok === false. */
  failedStage?: 'install' | 'build';
  /** The build script that ran (e.g. "build", "build:staging"), or null if none exists. */
  buildScript: string | null;
  /** Trailing combined output for the report, bounded. */
  outputTail: string;
}

export interface RunPrBuildGateParams {
  /** A worktree already prepared by `preparePrWorktree`. */
  worktreePath: string;
  prNumber: number;
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
  /** Max wall-clock for npm ci + build. Default 20 min. */
  timeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 6 * 60 * 1000;
const DEFAULT_BUILD_GATE_TIMEOUT_MS = 20 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.staging', '.env.prod'];

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Ask the OS for a free ephemeral port by binding :0, then releasing it. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not pick a free port'))));
    });
  });
}

/** Resolves true once a TCP connection to the port succeeds. */
function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
}

/** Kill a detached child's whole process group (SIGTERM → SIGKILL). */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS).unref();
}

/** Parse changed file paths out of a unified diff. */
export function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  const re = /^diff --git a\/(.+?) b\//gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(diff)) !== null) {
    if (match[1]) paths.add(match[1]);
  }
  return [...paths];
}

const DEPS_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json']);
const RUNTIME_FILES = new Set(['.nvmrc', '.node-version', 'Dockerfile', '.dockerignore']);

function basenameOf(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

function isDepsFile(p: string): boolean {
  return DEPS_FILES.has(basenameOf(p));
}

function isRuntimeFile(p: string): boolean {
  const b = basenameOf(p);
  return RUNTIME_FILES.has(b) || b.endsWith('.dockerfile') || /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(b);
}

/** Infra/deps/config files that don't change what the running app renders. */
function isInfraOrDepsPath(p: string): boolean {
  if (isDepsFile(p) || isRuntimeFile(p)) return true;
  if (basenameOf(p) === '.npmrc') return true;
  if (p.startsWith('.github/')) return true;
  return false;
}

/**
 * Classify a PR's changed files to pick a QA strategy. A PR that touches only
 * deps/runtime/infra (e.g. a Node-version bump: .nvmrc + Dockerfile +
 * package.json) has no app surface to exercise in a browser, and a local dev
 * server would run against the base clone's symlinked node_modules anyway — so
 * it should be validated with an install + build gate, not browser QA.
 */
export function classifyChangedPaths(changedPaths: string[]): ChangedPathClassification {
  const depsChanged = changedPaths.some(isDepsFile);
  const runtimeChanged = changedPaths.some(isRuntimeFile);
  const appCodeChanged = changedPaths.some(p => !isInfraOrDepsPath(p));
  const depsOrInfraOnly = changedPaths.length > 0 && !appCodeChanged && (depsChanged || runtimeChanged);
  return { depsChanged, runtimeChanged, appCodeChanged, depsOrInfraOnly };
}

/** Copy gitignored env files from the base clone into the worktree. */
function copyEnvFiles(baseRepoPath: string, worktreePath: string): number {
  let copied = 0;
  for (const name of ENV_FILES) {
    const src = path.join(baseRepoPath, name);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, path.join(worktreePath, name));
        copied++;
      } catch {
        /* non-fatal */
      }
    }
  }
  return copied;
}

/**
 * Resolve a GitHub PR to an isolated worktree with the PR head checked out:
 * create the worktree, check out the PR head, copy gitignored `.env*`, init
 * submodules, and compute the changed paths + a strategy classification. Does
 * NOT boot or install anything — the caller decides whether to boot a dev
 * server (browser QA) or run a build gate. Returns a `cleanup()` that removes
 * the worktree.
 *
 * Reuses the PR-review checkout machinery (`resolveWorkspace` +
 * `checkoutPrBranch`) so the worktree gets the same node_modules symlink and
 * the same `<thread>--pr-N` key the rest of the system cleans up.
 *
 * Throws (with a human-readable message) when a stage fails, cleaning up the
 * worktree first.
 */
export async function preparePrWorktree(params: PreparePrWorktreeParams): Promise<PreparedPrWorktree> {
  const { baseRepoPath, prContext, threadTs, githubToken, signal, logStep } = params;

  // 1. Worktree. resolveWorkspace returns the SHARED repo path on failure —
  //    never run a checkout/build against the user's real clone.
  const worktreePath = await resolveWorkspace(baseRepoPath, `${threadTs}--pr-${prContext.number}`);
  if (worktreePath === baseRepoPath) {
    throw new Error("Couldn't create an isolated worktree to test the PR safely.");
  }

  const cleanup = async (): Promise<void> => {
    await removeWorktreeByPath(worktreePath).catch(() => undefined);
  };

  try {
    if (signal?.aborted) throw new Error('aborted');

    // 2. Check out the PR head into the worktree.
    const checkedOut = await checkoutPrBranch(worktreePath, prContext.number, logStep);
    if (!checkedOut) {
      throw new Error(`Couldn't check out PR #${prContext.number} — is it open and accessible?`);
    }

    // 3. Copy gitignored env files (worktrees only carry tracked files).
    const copiedEnv = copyEnvFiles(baseRepoPath, worktreePath);

    // 3b. Initialise git submodules. newton-web vendors `content_platform` as a
    //     submodule that form pages (study-buddy, register, …) import at COMPILE
    //     time; it's absent from a fresh worktree, so those pages 500 without it.
    //     Gated on .gitmodules so submodule-less repos (newton-api,
    //     newton-marketing-web) skip the network call and its 3-min timeout.
    //     Best-effort: relies on the same ambient git credentials as the PR
    //     checkout; on failure we proceed and the QA agent reports the error.
    if (fs.existsSync(path.join(worktreePath, '.gitmodules'))) {
      try {
        await execFileAsync('git', ['-C', worktreePath, 'submodule', 'update', '--init', '--recursive'], {
          timeout: 180_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        logStep?.({ stage: 'qa.pr.submodules_ready', message: 'Initialised git submodules in the worktree.' });
      } catch (err) {
        logStep?.({
          stage: 'qa.pr.submodules_failed',
          level: 'WARN',
          message: `Couldn't init git submodules (pages that import them may 500): ${String(err)}`,
        });
      }
    }

    // 4. Diff → changed paths + strategy classification.
    const diffResult = await fetchPrDiff({ prContext, githubToken });
    const changedPaths = changedPathsFromDiff(diffResult.diff ?? '');
    const classification = classifyChangedPaths(changedPaths);

    logStep?.({
      stage: 'qa.pr.worktree_ready',
      message: `PR #${prContext.number} checked out; ${copiedEnv} env file(s) copied; ${changedPaths.length} changed path(s).`,
      data: { worktreePath, copiedEnv, changedPaths: changedPaths.length, ...classification },
    });

    return { worktreePath, changedPaths, classification, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Boot `next dev` (the repo's `dev` script) on a free port inside an
 * already-prepared worktree, and wait until it listens. node_modules is
 * symlinked from the base clone, so this does NOT `npm install` — for a PR that
 * changed deps, prefer `runPrBuildGate` (the classifier flags such PRs as
 * `depsOrInfraOnly`). Returns a `stop()` that kills the server; the worktree is
 * removed by the caller via `PreparedPrWorktree.cleanup`.
 *
 * Throws (human-readable) if the server never comes up, killing the child first.
 */
export async function bootPrDevServer(params: BootPrDevServerParams): Promise<PrDevServer> {
  const { worktreePath, prNumber, signal, logStep } = params;
  const readinessTimeoutMs = params.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  const port = await findFreePort();
  const env = { ...process.env, PATH: buildCodexPath(process.env.PATH) };
  const child = spawn('npm', ['run', 'dev', '--', '-p', String(port)], {
    cwd: worktreePath,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    killProcessTree(child);
  };

  // Wire abort → kill. (Worktree removal is the caller's responsibility.)
  if (signal) {
    if (signal.aborted) {
      await stop();
      throw new Error('aborted');
    }
    signal.addEventListener('abort', () => void stop(), { once: true });
  }

  // Keep a bounded tail of dev-server output for error reporting.
  let logTail = '';
  const appendTail = (chunk: Buffer): void => {
    logTail = (logTail + chunk.toString()).slice(-8192);
  };
  child.stdout?.on('data', appendTail);
  child.stderr?.on('data', appendTail);

  let exitedEarly = false;
  child.once('exit', () => {
    exitedEarly = true;
  });

  // Wait until the server listens (poll TCP), or the child dies / timeout.
  const deadline = Date.now() + readinessTimeoutMs;
  let listening = false;
  while (Date.now() < deadline) {
    if (exitedEarly) break;
    if (await canConnect(port)) {
      listening = true;
      break;
    }
    await delay(1500, signal);
  }

  if (!listening) {
    await stop();
    const reason = exitedEarly
      ? 'the dev server exited early'
      : `it didn't start within ${Math.round(readinessTimeoutMs / 1000)}s`;
    const tail = logTail.trim().split('\n').slice(-6).join('\n');
    throw new Error(
      `Couldn't boot the dev server for PR #${prNumber} — ${reason}.${tail ? `\nLast output:\n${tail}` : ''}`,
    );
  }

  const url = `http://127.0.0.1:${port}`;
  logStep?.({
    stage: 'qa.pr.dev_server_ready',
    message: `Dev server for PR #${prNumber} is listening at ${url}.`,
    data: { url, port },
  });

  return { url, stop };
}

/** Pick a build script from the worktree's package.json, preferring `build`. */
function pickBuildScript(worktreePath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const name of ['build', 'build:staging', 'build:prod', 'build:production']) {
      if (typeof scripts[name] === 'string' && scripts[name].length > 0) return name;
    }
  } catch {
    /* no/invalid package.json — fall through */
  }
  return null;
}

/**
 * Validate a deps/runtime-only PR the way a dev server cannot: drop the
 * symlinked node_modules, honor the PR's `.nvmrc` via nvm (best-effort), then
 * run `npm ci` (+ the build script, if any) against the PR's OWN lockfile and
 * Node version inside the worktree. This never writes through to the base clone
 * (the symlink is removed first), and attributes a failure to install vs build.
 */
export async function runPrBuildGate(params: RunPrBuildGateParams): Promise<PrBuildGateResult> {
  const { worktreePath, prNumber, signal, logStep } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_BUILD_GATE_TIMEOUT_MS;
  const buildScript = pickBuildScript(worktreePath);

  logStep?.({
    stage: 'qa.pr.build_gate.start',
    message: `Running install + build gate for PR #${prNumber}${buildScript ? ` (build script: \`${buildScript}\`)` : ' (no build script — npm ci only)'}.`,
    data: { worktreePath, buildScript, timeoutMs },
  });

  // `::STAGE::` markers let us attribute a failure to install vs build from the
  // captured output. `rm -rf node_modules` removes the SYMLINK (not the base
  // clone's tree), so `npm ci` installs the PR's own deps in the worktree. nvm
  // is sourced before `set -e` (its internals are not always set -e clean).
  const buildStep = buildScript ? `echo "::STAGE::build"\nnpm run ${buildScript} 2>&1\n` : '';
  const script = [
    'set -o pipefail',
    `cd "${worktreePath}"`,
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" || true; nvm install >/dev/null 2>&1 || true; (nvm use >/dev/null 2>&1 && echo "USED_NVM=1") || nvm use default >/dev/null 2>&1 || true; fi',
    'echo "NODE_VERSION=$(node -v 2>/dev/null || echo unknown)"',
    'set -e',
    'echo "::STAGE::install"',
    'rm -rf node_modules',
    'npm ci 2>&1',
    buildStep,
    'echo "::STAGE::done"',
  ].join('\n');

  let combined = '';
  let threw = false;
  try {
    const res = await execFileAsync('bash', ['-lc', script], {
      cwd: worktreePath,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
    combined = `${res.stdout}\n${res.stderr}`;
  } catch (err) {
    threw = true;
    const e = err as { stdout?: string; stderr?: string; message?: string };
    combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? String(err)}`;
  }

  const nodeVersion = /NODE_VERSION=(\S+)/.exec(combined)?.[1] ?? 'unknown';
  const usedNvmrc = /USED_NVM=1/.test(combined);
  const stages = [...combined.matchAll(/::STAGE::(\w+)/g)].map(m => m[1]);
  const ok = !threw && stages.includes('done');
  let failedStage: 'install' | 'build' | undefined;
  if (!ok) {
    failedStage = stages[stages.length - 1] === 'build' ? 'build' : 'install';
  }
  const outputTail = combined.trim().split('\n').slice(-30).join('\n').slice(-3500);

  logStep?.({
    stage: ok ? 'qa.pr.build_gate.passed' : 'qa.pr.build_gate.failed',
    level: ok ? 'INFO' : 'WARN',
    message: ok
      ? `Build gate PASSED for PR #${prNumber} under Node ${nodeVersion}.`
      : `Build gate FAILED for PR #${prNumber} at the ${failedStage} stage under Node ${nodeVersion}.`,
    data: { ok, nodeVersion, usedNvmrc, buildScript, failedStage },
  });

  return { ok, nodeVersion, usedNvmrc, failedStage, buildScript, outputTail };
}
