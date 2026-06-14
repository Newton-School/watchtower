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
  /** Changed file paths from the PR diff — used to focus the QA pass. */
  changedPaths: string[];
  /** True when the PR changed package-lock.json (deps may be stale vs symlinked node_modules). */
  depsChanged: boolean;
  /** Kill the dev server (process group) and remove the worktree. Idempotent, best-effort. */
  stop: () => Promise<void>;
}

export interface StartPrDevServerParams {
  /** Local clone root, e.g. config.repoPaths.newtonWeb. */
  baseRepoPath: string;
  prContext: PrContext;
  threadTs: string;
  githubToken?: string;
  /** Abort → kills the dev server (wired to the job's AbortController). */
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
  /** Max wait for the server to start listening. Default 6 min (cold next dev). */
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 6 * 60 * 1000;
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

/**
 * Resolve a GitHub PR to a locally-running dev server for browser QA: create a
 * worktree, check out the PR head, copy gitignored `.env*` from the base clone,
 * boot `next dev` on a free port, and wait until it listens. Returns a `stop()`
 * that kills the server and removes the worktree.
 *
 * Reuses the PR-review checkout machinery (`resolveWorkspace` +
 * `checkoutPrBranch`) so the worktree gets the same node_modules symlink, and
 * the same `<thread>--pr-N` key the rest of the system cleans up.
 *
 * Throws (with a human-readable message) when a stage fails — the caller posts
 * the message to Slack and stops. Always leaves nothing running on failure.
 */
export async function startPrDevServer(params: StartPrDevServerParams): Promise<PrDevServer> {
  const { baseRepoPath, prContext, threadTs, githubToken, signal, logStep } = params;
  const readinessTimeoutMs = params.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  // 1. Worktree. resolveWorkspace returns the SHARED repo path on failure —
  //    never run a dev server / checkout against the user's real clone.
  const worktreePath = await resolveWorkspace(baseRepoPath, `${threadTs}--pr-${prContext.number}`);
  if (worktreePath === baseRepoPath) {
    throw new Error("Couldn't create an isolated worktree to test the PR safely.");
  }

  const cleanupWorktree = async (): Promise<void> => {
    await removeWorktreeByPath(worktreePath).catch(() => undefined);
  };

  try {
    // 2. Check out the PR head into the worktree.
    const checkedOut = await checkoutPrBranch(worktreePath, prContext.number, logStep);
    if (!checkedOut) {
      throw new Error(`Couldn't check out PR #${prContext.number} — is it open and accessible?`);
    }

    // 3. Copy gitignored env files (worktrees only carry tracked files).
    let copiedEnv = 0;
    for (const name of ENV_FILES) {
      const src = path.join(baseRepoPath, name);
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, path.join(worktreePath, name));
          copiedEnv++;
        } catch {
          /* non-fatal */
        }
      }
    }

    // 3b. Initialise git submodules. newton-web vendors `content_platform` as a
    //     submodule that form pages (study-buddy, register, …) import at COMPILE
    //     time; it's absent from a fresh worktree, so those pages 500 without it.
    //     Must run before `next dev` boots — the server compiles the page on the
    //     first request, before the QA agent navigates. Best-effort: relies on the
    //     same ambient git credentials as the PR checkout; on failure we proceed
    //     and the QA agent reports the compile error.
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

    // 4. Diff → changed paths (focuses the QA pass) + deps-changed signal.
    const diffResult = await fetchPrDiff({ prContext, githubToken });
    const changedPaths = changedPathsFromDiff(diffResult.diff ?? '');
    const depsChanged = changedPaths.some(p => p.endsWith('package-lock.json') || p.endsWith('package.json'));

    logStep?.({
      stage: 'qa.pr.worktree_ready',
      message: `PR #${prContext.number} checked out; ${copiedEnv} env file(s) copied; ${changedPaths.length} changed path(s).`,
      data: { worktreePath, copiedEnv, changedPaths: changedPaths.length, depsChanged },
    });

    // 5. Boot `next dev` on a free port. node_modules is symlinked from the base
    //    clone, so do NOT `npm install` here (it would write through the symlink
    //    into the user's real clone). If deps changed, we proceed against base
    //    deps and surface depsChanged so the report can caveat it.
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
      if (!stopped) {
        stopped = true;
        killProcessTree(child);
      }
      await cleanupWorktree();
    };

    // Wire abort → teardown.
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

    // 6. Wait until the server listens (poll TCP), or the child dies / timeout.
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
        `Couldn't boot the dev server for PR #${prContext.number} — ${reason}.${tail ? `\nLast output:\n${tail}` : ''}`,
      );
    }

    const url = `http://127.0.0.1:${port}`;
    logStep?.({
      stage: 'qa.pr.dev_server_ready',
      message: `Dev server for PR #${prContext.number} is listening at ${url}.`,
      data: { url, port },
    });

    return { url, changedPaths, depsChanged, stop };
  } catch (error) {
    // Anything after the worktree exists must clean it up on failure.
    await cleanupWorktree();
    throw error;
  }
}
