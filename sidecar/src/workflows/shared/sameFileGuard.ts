import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../../types/contracts.js';
import { toolchainEnv } from '../../backends/codexBackend.js';
import { jobSlots } from '../../runtime/jobSlots.js';
import { currentWork, notePlannedFiles, type WorkEntry } from '../../state/workLedger.js';
import { buildSlackThreadLink } from './workflowUtils.js';

const execFileAsync = promisify(execFile);

/**
 * Two change runs editing the same file (issue #602).
 *
 * Two requests two minutes apart, both editing `batch-momentum.tsx`, became
 * two runs and two PRs, and the second PR conflicted once the first merged.
 * Before a change run starts editing, it now checks what else is changing the
 * files its approved plan names:
 * - another change run in the same repo whose plan was approved first and is
 *   still going: wait for it to finish;
 * - an open miniOG PR from another thread that changes those files: give it
 *   up to an hour from when it was opened to be merged or closed. Most
 *   marketing PRs merge within the hour; waiting on one a person has left
 *   open for a day would only make this request slow.
 * After any wait the run starts from the latest base, so a merged first PR is
 * in it. Two hours of waiting at most, after which it starts anyway and says
 * how to fix a clash. The wait lends the job's slot out, as a wait on a
 * person does.
 */

/** The longest a run waits for its turn on a file. */
export const SAME_FILE_WAIT_MAX_MS = 2 * 60 * 60_000;
/** An open PR on the same file holds a run back until it is this old. */
export const OPEN_PR_GRACE_MS = 60 * 60_000;
const POLL_MS = 60_000;

export interface OpenPr {
  number: number;
  url: string;
  headRefName: string;
  createdAt: string;
  files: string[];
}

export type SameFileBlocker =
  | { kind: 'run'; jobId: string; channelId: string; threadTs: string; files: string[] }
  | { kind: 'pr'; number: number; url: string; files: string[] };

/** A repo-relative path as planners and GitHub write it: no `./`, no leading `/`, no `:line`. */
export function normalizeRepoPath(file: string): string {
  return file
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^\.?\//, '')
    .replace(/:\d+(?:[-:]\d+)?$/, '');
}

/** The files both lists name. A planner sometimes drops a leading directory, so a path matches its tail. */
export function sharedFiles(planned: string[], other: string[]): string[] {
  const theirs = other.map(normalizeRepoPath).filter(Boolean);
  const shared = new Set<string>();
  for (const raw of planned) {
    const mine = normalizeRepoPath(raw);
    if (!mine) continue;
    if (theirs.some(file => file === mine || file.endsWith(`/${mine}`) || mine.endsWith(`/${file}`))) {
      shared.add(mine);
    }
  }
  return [...shared];
}

/**
 * Whether a PR came from a run in this thread. Its branch ends with the
 * thread's ts: dashed when the coder names it, dotted when the pipeline does.
 */
function isFromThread(pr: OpenPr, threadTs: string): boolean {
  return pr.headRefName.includes(threadTs) || pr.headRefName.includes(threadTs.replace('.', '-'));
}

export function findSameFileBlockers(params: {
  jobId: string;
  threadTs: string;
  repo: string;
  files: string[];
  /** When this run's plan was noted: only runs noted earlier hold it back, so two runs never wait on each other. */
  notedAtMs: number;
  work: WorkEntry[];
  openPrs: OpenPr[];
  nowMs: number;
}): SameFileBlocker[] {
  const { jobId, threadTs, repo, files, notedAtMs, work, openPrs, nowMs } = params;
  const blockers: SameFileBlocker[] = [];
  for (const entry of work) {
    if (entry.jobId === jobId || entry.threadTs === threadTs || !entry.plan || entry.endedAtMs !== undefined) continue;
    if (entry.plan.repo !== repo || entry.plan.notedAtMs >= notedAtMs) continue;
    const shared = sharedFiles(files, entry.plan.files);
    if (shared.length > 0) {
      blockers.push({
        kind: 'run',
        jobId: entry.jobId,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        files: shared,
      });
    }
  }
  for (const pr of openPrs) {
    if (isFromThread(pr, threadTs)) continue;
    const openedAt = Date.parse(pr.createdAt);
    if (!Number.isFinite(openedAt) || nowMs - openedAt >= OPEN_PR_GRACE_MS) continue;
    const shared = sharedFiles(files, pr.files);
    if (shared.length > 0) blockers.push({ kind: 'pr', number: pr.number, url: pr.url, files: shared });
  }
  return blockers;
}

/** Open PRs miniOG opened in the repo checked out at `cwd`, with the files each one changes. */
export async function listOpenMiniogPrs(cwd: string): Promise<OpenPr[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'list',
      '--label',
      'miniog',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,url,headRefName,createdAt,files',
    ],
    { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: toolchainEnv() },
  );
  const parsed = JSON.parse(stdout) as Array<{
    number: number;
    url: string;
    headRefName?: string;
    createdAt?: string;
    files?: Array<{ path?: string }>;
  }>;
  return parsed.map(pr => ({
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName ?? '',
    createdAt: pr.createdAt ?? '',
    files: (pr.files ?? []).map(file => file.path ?? '').filter(Boolean),
  }));
}

function describeBlocker(blocker: SameFileBlocker): string {
  return blocker.kind === 'pr'
    ? `<${blocker.url}|PR #${blocker.number}>`
    : `<${buildSlackThreadLink(blocker.channelId, blocker.threadTs)}|another request>`;
}

function describeFiles(files: string[]): string {
  const names = [...new Set(files.map(file => path.basename(file)))];
  const shown = names
    .slice(0, 2)
    .map(name => `\`${name}\``)
    .join(' and ');
  return names.length > 2 ? `${shown} and ${names.length - 2} more` : shown;
}

export function sameFileWaitingText(blocker: SameFileBlocker): string {
  const when = blocker.kind === 'pr' ? "once it's merged" : "once it's done and its PR is merged";
  return `Waiting my turn: ${describeBlocker(blocker)} is already changing ${describeFiles(blocker.files)}. I'll start ${when} (two hours at most), so the two PRs don't clash.`;
}

export function sameFileGaveUpText(blocker: SameFileBlocker): string {
  return `Starting now rather than waiting longer on ${describeBlocker(blocker)}. If the two PRs clash once that one merges, mention me here with \`sync it\`.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface SameFileTurn {
  outcome: 'clear' | 'gave_up' | 'cancelled';
  /** The run waited: its worktree should move to the latest base before editing. */
  waited: boolean;
}

/**
 * Notes this run's planned files, then waits while another run or a fresh
 * open PR is changing any of them.
 */
export async function waitForSameFileTurn(params: {
  jobId?: string;
  channelId: string;
  threadTs: string;
  /** Same value for every run on the same repo. */
  repo: string;
  cwd: string;
  files: string[];
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /** Test seams. */
  deps?: { listOpenPrs?: (cwd: string) => Promise<OpenPr[]>; sleep?: typeof sleep; now?: () => number };
}): Promise<SameFileTurn> {
  const { jobId, channelId, threadTs, repo, cwd, slack, logStep, signal } = params;
  const listOpenPrs = params.deps?.listOpenPrs ?? listOpenMiniogPrs;
  const wait = params.deps?.sleep ?? sleep;
  const now = params.deps?.now ?? Date.now;
  // A planner may name a file by its absolute path in this worktree; other runs' worktrees differ.
  const files = params.files.map(file => (file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file));
  if (!jobId || files.length === 0) return { outcome: 'clear', waited: false };

  const notedAtMs = notePlannedFiles(jobId, repo, files, now());
  // A run the router did not start (nothing noted it) is not checked.
  if (notedAtMs === undefined) return { outcome: 'clear', waited: false };
  let prLookupFailed = false;
  let openPrs: OpenPr[] = [];
  const check = async (): Promise<SameFileBlocker[]> => {
    openPrs = [];
    try {
      openPrs = await listOpenPrs(cwd);
    } catch (error) {
      // GitHub can't be read: the open-PR half of the check is skipped, never the run.
      if (!prLookupFailed) {
        prLookupFailed = true;
        logStep?.({
          stage: 'implementation.same_file.pr_lookup_failed',
          message: "Couldn't list open miniOG PRs; checking other runs only.",
          level: 'WARN',
          data: { error: String(error) },
        });
      }
    }
    const nowMs = now();
    return findSameFileBlockers({ jobId, threadTs, repo, files, notedAtMs, work: currentWork(nowMs), openPrs, nowMs });
  };

  let blockers = await check();
  if (signal?.aborted) return { outcome: 'cancelled', waited: false };
  if (blockers.length === 0) return { outcome: 'clear', waited: false };

  const startedAt = now();
  const first = blockers[0];
  logStep?.({
    stage: 'implementation.same_file.waiting',
    message: 'Another change is editing the same files — waiting for it before editing.',
    data: { blockers, files },
  });
  await slack.chat
    .postMessage({ channel: channelId, thread_ts: threadTs, text: sameFileWaitingText(first) })
    .catch(() => {});

  // The PRs that held this run back. One still open when the wait ends was not merged in time.
  const heldBy = new Map<number, SameFileBlocker>();
  const remember = (found: SameFileBlocker[]) => {
    for (const blocker of found) if (blocker.kind === 'pr') heldBy.set(blocker.number, blocker);
  };
  remember(blockers);
  const outcome = await jobSlots.whileWaitingOnHuman(
    async (): Promise<SameFileTurn['outcome']> => {
      for (;;) {
        await wait(POLL_MS, signal);
        if (signal?.aborted) return 'cancelled';
        blockers = await check();
        remember(blockers);
        if (blockers.length === 0) {
          const stillOpen = openPrs.map(pr => heldBy.get(pr.number)).find(Boolean);
          if (!stillOpen) return 'clear';
          blockers = [stillOpen];
          return 'gave_up';
        }
        if (now() - startedAt >= SAME_FILE_WAIT_MAX_MS) return 'gave_up';
      }
    },
    { signal, logStep },
  );
  const waitedMs = now() - startedAt;

  if (outcome === 'gave_up') {
    logStep?.({
      stage: 'implementation.same_file.gave_up',
      message: 'Waited the longest allowed for the same files — starting anyway.',
      level: 'WARN',
      data: { blockers, waitedMs },
    });
    await slack.chat
      .postMessage({ channel: channelId, thread_ts: threadTs, text: sameFileGaveUpText(blockers[0] ?? first) })
      .catch(() => {});
  } else if (outcome === 'clear') {
    logStep?.({
      stage: 'implementation.same_file.clear',
      message: 'Nothing else is editing the same files now — starting.',
      data: { waitedMs },
    });
  }
  return { outcome, waited: true };
}
