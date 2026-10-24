import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import type { WorkflowStepLogger } from '../../types/contracts.js';
import { toolchainEnv } from '../../backends/codexBackend.js';
import { currentWork, notePlannedFiles, type WorkEntry } from '../../state/workLedger.js';
import { buildSlackThreadLink } from './workflowUtils.js';

const execFileAsync = promisify(execFile);

/**
 * Two change runs editing the same file (issue #602).
 *
 * Two requests two minutes apart, both editing `batch-momentum.tsx`, became
 * two runs and two PRs, and the second PR conflicted once the first merged.
 * Waiting would not have avoided that: the first run's PR is still open when
 * it ends, so the second still branches from a base without it, and a human
 * merge is not something miniOG controls. So the run says so instead: before
 * it starts editing, if another run approved earlier, or an open miniOG PR
 * from another thread, is changing the same files in the same repo, it posts
 * one line naming it and carries on. Folding the second change into the
 * first PR is the follow-up.
 */

export interface OpenPr {
  number: number;
  url: string;
  headRefName: string;
  files: string[];
}

export type SameFileOverlap =
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

/**
 * The files both lists name. A planner sometimes drops leading directories,
 * so a path also matches the end of a longer one, but only when it has a
 * directory of its own: `page.tsx` or `index.ts` alone names nothing.
 */
export function sharedFiles(planned: string[], other: string[]): string[] {
  const theirs = other.map(normalizeRepoPath).filter(Boolean);
  const shared = new Set<string>();
  const tailOf = (longer: string, shorter: string) => shorter.includes('/') && longer.endsWith(`/${shorter}`);
  for (const raw of planned) {
    const mine = normalizeRepoPath(raw);
    if (!mine) continue;
    if (theirs.some(file => file === mine || tailOf(file, mine) || tailOf(mine, file))) shared.add(mine);
  }
  return [...shared];
}

/** PR numbers a text names: by link, "#1475" or "PR 1475". The run is about those PRs, not colliding with them. */
export function namedPrNumbers(texts: string[]): Set<number> {
  const numbers = new Set<number>();
  for (const text of texts) {
    for (const match of text.matchAll(/\/pull\/(\d+)|(?:^|[^\w&])#(\d+)\b|\bPRs?\s*#?(\d+)\b/gi)) {
      numbers.add(Number(match[1] ?? match[2] ?? match[3]));
    }
  }
  return numbers;
}

/**
 * Whether a PR came from a run in this thread. Its branch ends with the
 * thread's ts: dashed when the coder names it, dotted when the pipeline does.
 */
function isFromThread(pr: OpenPr, threadTs: string): boolean {
  return pr.headRefName.includes(threadTs) || pr.headRefName.includes(threadTs.replace('.', '-'));
}

export function findSameFileOverlaps(params: {
  jobId: string;
  threadTs: string;
  repo: string;
  files: string[];
  /** When this run's plan was noted: only runs approved earlier are named. */
  notedAtMs: number;
  work: WorkEntry[];
  openPrs: OpenPr[];
  namedPrs: Set<number>;
}): SameFileOverlap[] {
  const { jobId, threadTs, repo, files, notedAtMs, work, openPrs, namedPrs } = params;
  const overlaps: SameFileOverlap[] = [];
  for (const pr of openPrs) {
    if (isFromThread(pr, threadTs) || namedPrs.has(pr.number)) continue;
    const shared = sharedFiles(files, pr.files);
    if (shared.length > 0) overlaps.push({ kind: 'pr', number: pr.number, url: pr.url, files: shared });
  }
  for (const entry of work) {
    if (entry.jobId === jobId || entry.threadTs === threadTs || !entry.plan || entry.endedAtMs !== undefined) continue;
    if (entry.plan.repo !== repo || entry.plan.notedAtMs >= notedAtMs) continue;
    const shared = sharedFiles(files, entry.plan.files);
    if (shared.length > 0) {
      overlaps.push({
        kind: 'run',
        jobId: entry.jobId,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        files: shared,
      });
    }
  }
  return overlaps;
}

/** Open PRs miniOG opened in the repo checked out at `cwd`, with the files each one changes. */
export async function listOpenMiniogPrs(cwd: string): Promise<OpenPr[]> {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'list', '--label', 'miniog', '--state', 'open', '--limit', '50', '--json', 'number,url,headRefName,files'],
    { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: toolchainEnv() },
  );
  const parsed = JSON.parse(stdout) as Array<{
    number: number;
    url: string;
    headRefName?: string;
    files?: Array<{ path?: string }>;
  }>;
  return parsed.map(pr => ({
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName ?? '',
    files: (pr.files ?? []).map(file => file.path ?? '').filter(Boolean),
  }));
}

function describeFiles(files: string[]): string {
  const names = [...new Set(files.map(file => path.basename(file)))];
  const shown = names
    .slice(0, 2)
    .map(name => `\`${name}\``)
    .join(' and ');
  return names.length > 2 ? `${shown} and ${names.length - 2} more` : shown;
}

export function sameFileHeadsUpText(overlap: SameFileOverlap): string {
  const files = describeFiles(overlap.files);
  return overlap.kind === 'pr'
    ? `Heads-up: <${overlap.url}|PR #${overlap.number}> is also changing ${files}. If it merges first, I'll need \`@miniOG sync it\` here.`
    : `Heads-up: <${buildSlackThreadLink(overlap.channelId, overlap.threadTs)}|another request> is also changing ${files}. If its PR merges first, I'll need \`@miniOG sync it\` here.`;
}

/**
 * Notes this run's planned files (so a later run can name it), then posts
 * one line when something else is changing any of them. Never waits, and
 * says nothing when GitHub can't be read.
 */
export async function headsUpOnSameFiles(params: {
  jobId?: string;
  channelId: string;
  threadTs: string;
  /** Same value for every run on the same repo. */
  repo: string;
  cwd: string;
  files: string[];
  /** The ask, the thread and the plan: a PR they name is what this run is about. */
  context: string[];
  slack: WebClient;
  logStep?: WorkflowStepLogger;
  /** Test seam. */
  listOpenPrs?: (cwd: string) => Promise<OpenPr[]>;
}): Promise<SameFileOverlap | undefined> {
  const { jobId, channelId, threadTs, repo, cwd, context, slack, logStep } = params;
  const listOpenPrs = params.listOpenPrs ?? listOpenMiniogPrs;
  // A planner may name a file by its absolute path in this worktree; other runs' worktrees differ.
  const files = params.files.map(file => (file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file));
  if (!jobId || files.length === 0) return undefined;
  const notedAtMs = notePlannedFiles(jobId, repo, files);
  // A run the router did not start (nothing noted it) is not checked.
  if (notedAtMs === undefined) return undefined;

  let openPrs: OpenPr[];
  try {
    openPrs = await listOpenPrs(cwd);
  } catch (error) {
    logStep?.({
      stage: 'implementation.same_file.pr_lookup_failed',
      message: "Couldn't list open miniOG PRs, so no heads-up about the same files.",
      level: 'WARN',
      data: { error: String(error) },
    });
    return undefined;
  }
  const [overlap, ...more] = findSameFileOverlaps({
    jobId,
    threadTs,
    repo,
    files,
    notedAtMs,
    work: currentWork(),
    openPrs,
    namedPrs: namedPrNumbers(context),
  });
  if (!overlap) return undefined;
  const text = sameFileHeadsUpText(overlap);
  logStep?.({
    stage: 'implementation.same_file.heads_up',
    message: text,
    data: { overlaps: [overlap, ...more], files },
  });
  await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }).catch(() => {});
  return overlap;
}
