import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkflowStepLogger } from '../../types/contracts.js';
import { toolchainEnv } from '../../backends/codexBackend.js';

const execFileAsync = promisify(execFile);

/** Internal seam — overridden by tests to avoid spawning the real `gh` CLI. */
export const __ghCli = {
  async exec(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    const { stdout } = await execFileAsync('gh', args, { cwd, timeout: timeoutMs, env: toolchainEnv() });
    return stdout;
  },
};

/** Poll/timeout knobs — a test seam so the suite never sleeps for real. */
export const __deployTiming = {
  resolvePollMs: 5_000,
  resolveTimeoutMs: 120_000,
  watchPollMs: 15_000,
  watchTimeoutMs: 15 * 60 * 1000,
};

/**
 * sidecar_state key. When '1', a confirmed deploy is reported but not run, so
 * the deploy paths can be exercised live without shipping anything.
 */
export const DEPLOY_DRY_RUN_STATE_KEY = 'deploy_dry_run';

export type DeployStateReader = { getState(key: string): string | undefined };

export function isDeployDryRun(store: DeployStateReader | undefined): boolean {
  try {
    return store?.getState(DEPLOY_DRY_RUN_STATE_KEY) === '1';
  } catch {
    return false;
  }
}

/** What happened to a dispatched GitHub Actions run, as far as it was followed. */
export type ActionsRunOutcome =
  /** The job was stopped before `gh workflow run`: nothing was started. */
  | { kind: 'stopped' }
  /** `gh workflow run` itself failed: nothing was started. */
  | { kind: 'dispatch_failed'; error: string }
  /** Dispatched, but the newest run before it could not be read, so its run can't be told apart: not followed. */
  | { kind: 'unanchored' }
  /** Dispatched, but no new run showed up in time. */
  | { kind: 'unidentified' }
  | { kind: 'completed'; id: number; headSha?: string; conclusion?: string; url?: string }
  /** A GitHub Environment is holding the run for a person's approval. */
  | { kind: 'waiting'; id: number; headSha?: string; url?: string }
  /** Still running when the watch gave up or the job was stopped. */
  | { kind: 'running'; id: number; headSha?: string; url?: string };

interface RunFilter {
  repoPath: string;
  workflowFile: string;
  /** Only runs on this branch count. Omitted: every run of the workflow. */
  branch?: string;
}

async function readLatestRun(
  filter: RunFilter,
): Promise<{ id?: number; url?: string; status?: string; conclusion?: string; headSha?: string }> {
  const args = ['run', 'list', `--workflow=${filter.workflowFile}`];
  if (filter.branch) args.push('--branch', filter.branch);
  args.push('--limit', '1', '--json', 'databaseId,url,status,conclusion,headSha');
  const stdout = await __ghCli.exec(args, filter.repoPath, 30_000);
  const rows = JSON.parse(stdout || '[]') as Array<{
    databaseId?: number;
    url?: string;
    status?: string;
    conclusion?: string;
    headSha?: string;
  }>;
  const row = rows[0] ?? {};
  return { id: row.databaseId, url: row.url, status: row.status, conclusion: row.conclusion, headSha: row.headSha };
}

/**
 * Starts a `workflow_dispatch` run and follows it to the end. `gh` resolves
 * the target repo from the clone's origin remote.
 *
 * The newest existing run is read BEFORE dispatching: `gh workflow run`
 * returns before GitHub materializes the new run, so without that anchor the
 * first poll would read the PREVIOUS run's outcome and report it as this
 * one's. A FAILED anchor read is not "no prior runs": the run is dispatched
 * but not followed. Once the dispatch has gone out, every failure degrades to
 * an outcome to report, never a retry.
 */
export async function dispatchWorkflowRun(params: {
  repoPath: string;
  workflowFile: string;
  ref: string;
  /** `-f key=value` inputs. */
  inputs?: Record<string, string>;
  /** Count only runs on the dispatched ref when finding the new run. */
  filterByRef?: boolean;
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
  /** Log stage prefix: `<prefix>.poll_failed`. */
  stagePrefix: string;
}): Promise<ActionsRunOutcome> {
  const { repoPath, workflowFile, ref, signal, logStep, stagePrefix } = params;
  const filter: RunFilter = { repoPath, workflowFile, ...(params.filterByRef ? { branch: ref } : {}) };

  let anchorRunId: number | undefined;
  let anchorKnown = true;
  try {
    anchorRunId = (await readLatestRun(filter)).id;
  } catch {
    anchorKnown = false;
  }

  const inputs = Object.entries(params.inputs ?? {}).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
  // The last moment a stop can still mean nothing happened.
  if (signal?.aborted) return { kind: 'stopped' };
  try {
    await __ghCli.exec(['workflow', 'run', workflowFile, '--ref', ref, ...inputs], repoPath, 60_000);
  } catch (error) {
    return { kind: 'dispatch_failed', error: error instanceof Error ? error.message : String(error) };
  }

  if (!anchorKnown) return { kind: 'unanchored' };
  return watchRun({ filter, anchorRunId, signal, logStep, stagePrefix });
}

async function watchRun(params: {
  filter: RunFilter;
  /** Newest run id observed BEFORE dispatch; the new run must differ from it. */
  anchorRunId?: number;
  signal?: AbortSignal;
  logStep?: WorkflowStepLogger;
  stagePrefix: string;
}): Promise<ActionsRunOutcome> {
  const { filter, anchorRunId, signal, logStep, stagePrefix } = params;
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // Phase 1 — identify the run this dispatch created: the newest run whose id
  // differs from the pre-dispatch anchor. Never report on the anchor run.
  const resolveDeadline = Date.now() + __deployTiming.resolveTimeoutMs;
  let runId: number | undefined;
  let runUrl: string | undefined;
  let headSha: string | undefined;
  while (Date.now() < resolveDeadline && !signal?.aborted) {
    try {
      const latest = await readLatestRun(filter);
      // Run ids grow: a newer run has a larger id than the anchor.
      if (latest.id !== undefined && (anchorRunId === undefined || latest.id > anchorRunId)) {
        runId = latest.id;
        runUrl = latest.url;
        headSha = latest.headSha;
        break;
      }
    } catch (error) {
      logStep?.({
        stage: `${stagePrefix}.poll_failed`,
        level: 'WARN',
        message: `Couldn't list deploy runs while resolving the dispatched run: ${String(error)}`,
      });
    }
    await sleep(__deployTiming.resolvePollMs);
  }
  if (runId === undefined) return { kind: 'unidentified' };

  // Phase 2 — poll THAT run (by id) to completion.
  const watchDeadline = Date.now() + __deployTiming.watchTimeoutMs;
  while (Date.now() < watchDeadline && !signal?.aborted) {
    let run: { status?: string; conclusion?: string; url?: string };
    try {
      const stdout = await __ghCli.exec(
        ['run', 'view', String(runId), '--json', 'status,conclusion,url'],
        filter.repoPath,
        30_000,
      );
      run = JSON.parse(stdout || '{}') as { status?: string; conclusion?: string; url?: string };
    } catch (error) {
      logStep?.({
        stage: `${stagePrefix}.poll_failed`,
        level: 'WARN',
        message: `Couldn't read the deploy run status: ${String(error)}`,
      });
      await sleep(__deployTiming.watchPollMs);
      continue;
    }
    runUrl = run.url ?? runUrl;

    if (run.status === 'completed') {
      return { kind: 'completed', id: runId, headSha, conclusion: run.conclusion, url: runUrl };
    }
    // A GitHub Environment holding the run for approval can take arbitrarily
    // long, so report and hand off to the person.
    if (run.status === 'waiting') return { kind: 'waiting', id: runId, headSha, url: runUrl };
    await sleep(__deployTiming.watchPollMs);
  }

  return { kind: 'running', id: runId, headSha, url: runUrl };
}

/** Recent runs of a workflow, newest first. Throws when `gh` fails. */
export async function listWorkflowRuns(params: {
  repoPath: string;
  workflowFile: string;
  /** Only runs that finished with this conclusion (`gh run list --status`). */
  status?: string;
  limit: number;
}): Promise<Array<{ id: number; headBranch?: string; status?: string; conclusion?: string }>> {
  const args = ['run', 'list', `--workflow=${params.workflowFile}`];
  if (params.status) args.push('--status', params.status);
  args.push('--limit', String(params.limit), '--json', 'databaseId,headBranch,status,conclusion');
  const rows = JSON.parse((await __ghCli.exec(args, params.repoPath, 30_000)) || '[]') as Array<{
    databaseId?: number;
    headBranch?: string;
    status?: string;
    conclusion?: string;
  }>;
  return rows
    .filter(row => typeof row.databaseId === 'number')
    .map(row => ({
      id: row.databaseId as number,
      headBranch: row.headBranch,
      status: row.status,
      conclusion: row.conclusion,
    }));
}
