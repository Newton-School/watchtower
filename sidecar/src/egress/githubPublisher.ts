import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { git } from '../workspaces/gitState.js';
import type { JobStore } from '../state/jobStore.js';
import type { ConversationThreadRow } from '../state/conversationStore.js';
import {
  contentHash,
  renderChannelIndex,
  renderDecisionsIndex,
  renderThreadMarkdown,
  slugify,
  threadFilePath,
  type DecisionEntry,
  type IndexEntry,
} from './threadMarkdownRenderer.js';

const execFileAsync = promisify(execFile);

/**
 * GitHub conversation publisher (M4): mirrors captured org-visible threads
 * into a private markdown repo — one file per thread, a README index per
 * channel, and a rolling top-level DECISIONS.md.
 *
 * Poll, don't hook: a 5-min unref'd interval publishes threads quiet for
 * ≥10 min whose content changed since the last export, as ONE batch commit
 * per tick from a dedicated clone under ~/.watchtower/egress. A GitHub outage
 * can never touch the Slack event path; failures back off per thread via
 * egress_exports (attempts capped, retried on content change). Retractions
 * (forgotten threads, threads no longer org-visible) delete their files.
 *
 * Auth: plain `git` over the host's ambient credentials — the same trust
 * model as every PR branch the pipeline already pushes.
 */

export const GITHUB_EGRESS_SURFACE = 'github' as const;
export const PUBLISH_INTERVAL_MS = 5 * 60 * 1000;
export const PUBLISH_QUIET_MINUTES = 10;
export const PUBLISH_MAX_ATTEMPTS = 5;
export const PUBLISH_THREADS_PER_TICK = 30;
const CLONE_TIMEOUT_MS = 120_000;

export interface GithubPublisherDeps {
  store: JobStore;
  /** Used only to resolve Slack permalinks for published files; optional. */
  slack?: WebClient;
}

export interface GithubEgressSettings {
  enabled: boolean;
  repo: string;
  branch: string;
  includeTranscript: boolean;
}

export interface PublishTickResult {
  skipped?: 'disabled' | 'idle' | 'overlap' | 'sync-failed';
  published: number;
  unchanged: number;
  retracted: number;
  failed: number;
  commitSha?: string;
}

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function remoteUrlFor(repo: string): string {
  return OWNER_REPO_RE.test(repo) ? `https://github.com/${repo}.git` : repo;
}

/**
 * Strip any embedded credentials from a repo spec before it is displayed,
 * logged, or persisted. Operators commonly configure
 * `https://x-access-token:ghp_xxx@github.com/org/repo.git` for unattended
 * auth — that token must never reach egress_exports.target_url (which
 * `handoff link` posts verbatim into Slack) or the logs.
 */
export function sanitizeRepoSpec(repo: string): string {
  try {
    const url = new URL(repo);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString();
    }
    return repo;
  } catch {
    return repo;
  }
}

function fileUrlFor(repo: string, branch: string, filePath: string): string {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return OWNER_REPO_RE.test(repo)
    ? `https://github.com/${repo}/blob/${branch}/${encoded}`
    : `${sanitizeRepoSpec(repo)}#${filePath}`;
}

export function egressCloneDir(repo: string): string {
  // Slug + content hash: the slug alone is lossy ('/', '_', '.' all collapse
  // to '-'), and two different repo specs must never share a clone dir.
  const digest = crypto.createHash('sha256').update(repo, 'utf8').digest('hex').slice(0, 10);
  return path.join(os.homedir(), '.watchtower', 'egress', `${slugify(repo, 60)}-${digest}`);
}

const permalinkCache = new Map<string, string | null>();

async function resolvePermalink(
  slack: WebClient | undefined,
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  if (!slack) return undefined;
  const key = `${channelId}:${threadTs}`;
  const cached = permalinkCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const response = await slack.chat.getPermalink({ channel: channelId, message_ts: threadTs });
    const permalink = typeof response.permalink === 'string' ? response.permalink : null;
    permalinkCache.set(key, permalink);
    return permalink ?? undefined;
  } catch (err) {
    logger.debug({ channelId, threadTs, err: String(err) }, 'github publisher: getPermalink failed');
    permalinkCache.set(key, null);
    return undefined;
  }
}

async function freshClone(cloneDir: string, remote: string): Promise<void> {
  await fs.rm(cloneDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(cloneDir), { recursive: true });
  await execFileAsync('git', ['clone', '--no-tags', remote, cloneDir], {
    timeout: CLONE_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  });
}

/**
 * Bring the clone to EXACTLY origin/<branch> (or a pristine empty tree when
 * the remote branch doesn't exist yet), destroying any local state — commits,
 * staged files, mid-rebase/merge wreckage. The clone is a build artifact; a
 * tick rebuilds everything it publishes, so nothing local is ever worth
 * keeping. This is load-bearing for the retraction invariant: a stale staged
 * or locally-committed file from a failed tick must never ride into a later
 * batch commit (it may contain content that was forgotten in the meantime).
 * On any sync failure the clone is thrown away and re-cloned once.
 */
async function ensureCloneSynced(cloneDir: string, remote: string, branch: string): Promise<void> {
  const sync = async (): Promise<void> => {
    if (!fsSync.existsSync(path.join(cloneDir, '.git'))) {
      await freshClone(cloneDir, remote);
    } else {
      // A repo-setting change must not silently keep pushing to the old
      // remote through a reused clone dir.
      const currentRemote = await git(cloneDir, ['remote', 'get-url', 'origin']).catch(() => '');
      if (currentRemote !== remote) {
        await freshClone(cloneDir, remote);
      }
    }
    // Recovery preamble: clear any in-progress rebase/merge and local edits
    // left by a crash or a failed push retry. Each step is best-effort — on a
    // healthy clone they are no-ops; on an unborn HEAD reset fails harmlessly.
    await git(cloneDir, ['rebase', '--abort']).catch(() => {});
    await git(cloneDir, ['merge', '--abort']).catch(() => {});
    await git(cloneDir, ['reset', '--hard']).catch(() => {});

    await git(cloneDir, ['fetch', 'origin']);
    const hasRemoteBranch = await git(cloneDir, ['rev-parse', '--verify', `origin/${branch}`])
      .then(() => true)
      .catch(() => false);
    if (hasRemoteBranch) {
      await git(cloneDir, ['checkout', '-B', branch, `origin/${branch}`]);
      await git(cloneDir, ['reset', '--hard', `origin/${branch}`]);
      await git(cloneDir, ['clean', '-fd']);
    } else {
      // Remote branch doesn't exist yet (new/empty repo). Local commits from
      // a previous failed tick would otherwise stack up and ride into the
      // next batch — including files whose threads were forgotten since. A
      // fresh clone of an empty repo is cheap; do that instead of trusting
      // any local state.
      const hasLocalCommits = await git(cloneDir, ['rev-parse', '--verify', 'HEAD'])
        .then(() => true)
        .catch(() => false);
      if (hasLocalCommits) {
        await freshClone(cloneDir, remote);
      }
      await git(cloneDir, ['checkout', '-B', branch]).catch(async () => {
        await git(cloneDir, ['checkout', '--orphan', branch]);
      });
      await git(cloneDir, ['clean', '-fd']).catch(() => {});
    }
  };

  try {
    await sync();
  } catch (firstErr) {
    // Corrupted clone (index.lock, broken refs, …): burn it down and retry
    // once from scratch before giving up on the tick.
    logger.warn({ cloneDir, err: String(firstErr) }, 'github publisher: sync failed; re-cloning from scratch');
    await freshClone(cloneDir, remote);
    await sync();
  }
}

interface WrittenThread {
  channelId: string;
  threadTs: string;
  targetPath: string;
  targetUrl: string;
  hash: string;
}

/** One publish pass. Exported for tests; the scheduler calls it on a timer. */
export async function runGithubPublishOnce(
  deps: GithubPublisherDeps,
  opts?: { now?: Date; settings?: GithubEgressSettings },
): Promise<PublishTickResult> {
  const { store, slack } = deps;
  const now = opts?.now ?? new Date();
  const settings = opts?.settings ?? store.readGithubEgressSettings();
  const none: PublishTickResult = { published: 0, unchanged: 0, retracted: 0, failed: 0 };
  if (!settings.enabled || !settings.repo) {
    return { ...none, skipped: 'disabled' };
  }

  const exportLog = store.exportLog();
  const conversations = store.conversationStore();

  const retractions = exportLog.listRetractions(GITHUB_EGRESS_SURFACE);
  const candidates = exportLog.listPublishCandidates({
    surface: GITHUB_EGRESS_SURFACE,
    quietMinutes: PUBLISH_QUIET_MINUTES,
    maxAttempts: PUBLISH_MAX_ATTEMPTS,
    limit: PUBLISH_THREADS_PER_TICK,
    now,
  });
  if (retractions.length === 0 && candidates.length === 0) {
    return { ...none, skipped: 'idle' };
  }

  const cloneDir = egressCloneDir(settings.repo);
  try {
    await ensureCloneSynced(cloneDir, remoteUrlFor(settings.repo), settings.branch);
  } catch (err) {
    logger.warn(
      { repo: sanitizeRepoSpec(settings.repo), cloneDir, err: String(err) },
      'github publisher: clone/sync failed; skipping tick',
    );
    return { ...none, skipped: 'sync-failed' };
  }

  // ── Apply retractions to the working tree ────────────────────────────────
  for (const retraction of retractions) {
    if (retraction.targetPath) {
      await fs.rm(path.join(cloneDir, retraction.targetPath), { force: true });
    }
  }
  const retractedKeys = new Set(retractions.map(r => `${r.channelId}:${r.threadTs}`));

  // ── Render + write changed threads ───────────────────────────────────────
  const written: WrittenThread[] = [];
  let unchanged = 0;
  for (const candidate of candidates) {
    const thread = conversations.getThread(candidate.channelId, candidate.threadTs);
    if (!thread || thread.status === 'forgotten' || thread.visibility !== 'org' || thread.messageCount === 0) {
      continue;
    }
    // Publish only after first synthesis (mirrors the SQL gate): the path
    // slug comes from the title and is locked in at first publish.
    if (!thread.title) {
      continue;
    }
    // Newest-first + reverse: getMessages' default ascending LIMIT would keep
    // the OLDEST rows and silently drop the newest on very long threads.
    const messages = conversations.getMessages(thread.id, { limit: 2000, order: 'desc' }).reverse();
    const slackPermalink = await resolvePermalink(slack, thread.channelId, thread.threadTs);
    const markdown = renderThreadMarkdown(thread, messages, {
      includeTranscript: settings.includeTranscript,
      slackPermalink,
    });
    const hash = contentHash(markdown);
    if (candidate.export?.status === 'SUCCESS' && candidate.export.contentHash === hash) {
      exportLog.touch(GITHUB_EGRESS_SURFACE, candidate.channelId, candidate.threadTs);
      unchanged += 1;
      continue;
    }
    const targetPath = candidate.export?.targetPath ?? threadFilePath(thread);
    const absolute = path.join(cloneDir, targetPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, markdown, 'utf8');
    written.push({
      channelId: candidate.channelId,
      threadTs: candidate.threadTs,
      targetPath,
      targetUrl: fileUrlFor(settings.repo, settings.branch, targetPath),
      hash,
    });
  }

  if (written.length === 0 && retractions.length === 0) {
    return { ...none, unchanged, skipped: 'idle' };
  }

  // ── Regenerate channel indexes + DECISIONS.md from the full published set ─
  const publishedSet = new Map<string, { thread: ConversationThreadRow; targetPath: string }>();
  for (const record of exportLog.listPublished(GITHUB_EGRESS_SURFACE)) {
    const key = `${record.channelId}:${record.threadTs}`;
    if (retractedKeys.has(key) || !record.targetPath) continue;
    const thread = conversations.getThread(record.channelId, record.threadTs);
    if (!thread || thread.status === 'forgotten' || thread.visibility !== 'org') continue;
    publishedSet.set(key, { thread, targetPath: record.targetPath });
  }
  for (const entry of written) {
    const thread = conversations.getThread(entry.channelId, entry.threadTs);
    if (thread) publishedSet.set(`${entry.channelId}:${entry.threadTs}`, { thread, targetPath: entry.targetPath });
  }

  const byChannelDir = new Map<string, { label: string; entries: IndexEntry[] }>();
  const decisions: DecisionEntry[] = [];
  for (const { thread, targetPath } of publishedSet.values()) {
    const parts = targetPath.split('/');
    if (parts.length < 3 || parts[0] !== 'threads') continue;
    const channelDir = `${parts[0]}/${parts[1]}`;
    const date = (Number(thread.lastActivityTs) > 0 ? new Date(Number(thread.lastActivityTs) * 1000) : now)
      .toISOString()
      .slice(0, 10);
    const bucket = byChannelDir.get(channelDir) ?? {
      label: thread.channelName ? `#${thread.channelName}` : thread.channelId,
      entries: [],
    };
    bucket.entries.push({
      title: thread.title ?? 'Slack thread',
      date,
      summary: thread.summary,
      relPath: parts.slice(2).join('/'),
    });
    byChannelDir.set(channelDir, bucket);
    for (const decision of thread.decisions) {
      decisions.push({ decision, threadTitle: thread.title ?? 'Slack thread', date, path: targetPath });
    }
  }

  for (const [channelDir, bucket] of byChannelDir) {
    const readmePath = path.join(cloneDir, channelDir, 'README.md');
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    await fs.writeFile(readmePath, renderChannelIndex(bucket.label, bucket.entries), 'utf8');
  }
  // Channel dirs emptied by retractions lose their stale README.
  for (const retraction of retractions) {
    if (!retraction.targetPath) continue;
    const parts = retraction.targetPath.split('/');
    if (parts.length >= 3 && parts[0] === 'threads' && !byChannelDir.has(`${parts[0]}/${parts[1]}`)) {
      await fs.rm(path.join(cloneDir, parts[0], parts[1], 'README.md'), { force: true });
    }
  }
  await fs.writeFile(path.join(cloneDir, 'DECISIONS.md'), renderDecisionsIndex(decisions), 'utf8');

  // ── One batch commit + push ──────────────────────────────────────────────
  await git(cloneDir, ['add', '-A']);
  const dirty = (await git(cloneDir, ['status', '--porcelain'])).length > 0;
  if (!dirty) {
    // Repo already holds this content (e.g. export rows lost/reset): record
    // reality without a commit.
    const head = await git(cloneDir, ['rev-parse', 'HEAD']).catch(() => undefined);
    for (const entry of written) {
      exportLog.recordSuccess({
        surface: GITHUB_EGRESS_SURFACE,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        targetPath: entry.targetPath,
        targetUrl: entry.targetUrl,
        contentHash: entry.hash,
        commitSha: head,
      });
    }
    for (const retraction of retractions) {
      exportLog.delete(GITHUB_EGRESS_SURFACE, retraction.channelId, retraction.threadTs);
    }
    return { ...none, published: written.length, unchanged, retracted: retractions.length };
  }

  const changeCount = written.length + retractions.length;
  try {
    await git(cloneDir, [
      '-c',
      'user.name=miniOG',
      '-c',
      'user.email=miniog-bot@newtonschool.co',
      'commit',
      '-m',
      `chore: sync ${changeCount} conversation${changeCount === 1 ? '' : 's'}`,
    ]);
    try {
      await git(cloneDir, ['push', 'origin', settings.branch]);
    } catch {
      // One concurrent-push retry; the clone is hard-reset next tick anyway.
      await git(cloneDir, ['pull', '--rebase', 'origin', settings.branch]);
      await git(cloneDir, ['push', 'origin', settings.branch]);
    }
  } catch (err) {
    const error = String(err);
    // Don't leave the clone mid-rebase for the whole 5-min interval; the next
    // tick's recovery preamble would clear it anyway, but tidy up now.
    await git(cloneDir, ['rebase', '--abort']).catch(() => {});
    logger.warn({ repo: sanitizeRepoSpec(settings.repo), err: error }, 'github publisher: commit/push failed');
    for (const entry of written) {
      // targetPath rides along so a thread that is forgotten (or flips
      // private) after a failed publish is still retractable — listRetractions
      // keys on target_path.
      exportLog.recordFailure({
        surface: GITHUB_EGRESS_SURFACE,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        targetPath: entry.targetPath,
        error,
      });
    }
    // Retraction rows are left in place — retried next tick from a clean sync.
    return { ...none, unchanged, failed: written.length };
  }

  const commitSha = await git(cloneDir, ['rev-parse', 'HEAD']).catch(() => undefined);
  for (const entry of written) {
    exportLog.recordSuccess({
      surface: GITHUB_EGRESS_SURFACE,
      channelId: entry.channelId,
      threadTs: entry.threadTs,
      targetPath: entry.targetPath,
      targetUrl: entry.targetUrl,
      contentHash: entry.hash,
      commitSha,
    });
  }
  for (const retraction of retractions) {
    exportLog.delete(GITHUB_EGRESS_SURFACE, retraction.channelId, retraction.threadTs);
  }

  logger.info(
    {
      repo: sanitizeRepoSpec(settings.repo),
      published: written.length,
      retracted: retractions.length,
      unchanged,
      commitSha,
    },
    'github publisher: sync complete',
  );
  return { ...none, published: written.length, unchanged, retracted: retractions.length, commitSha };
}

// ─────────────────────────────────────────────────────────────────────────
// Scheduler (vaultWriter timer discipline: unref'd interval, overlap guard)
// ─────────────────────────────────────────────────────────────────────────

let publisherTimer: NodeJS.Timeout | null = null;
let publisherRunning = false;

export function configureGithubPublisher(deps: GithubPublisherDeps): void {
  if (publisherTimer) return;
  publisherTimer = setInterval(() => {
    if (publisherRunning) return;
    publisherRunning = true;
    void runGithubPublishOnce(deps)
      .catch(err => logger.warn({ err: String(err) }, 'github publisher tick failed'))
      .finally(() => {
        publisherRunning = false;
      });
  }, PUBLISH_INTERVAL_MS);
  if (typeof publisherTimer.unref === 'function') publisherTimer.unref();
  logger.info('github conversation publisher started');
}

export function shutdownGithubPublisher(): void {
  if (!publisherTimer) return;
  clearInterval(publisherTimer);
  publisherTimer = null;
}

/** Test-only helper. */
export function __resetGithubPublisherForTests(): void {
  publisherTimer = null;
  publisherRunning = false;
  permalinkCache.clear();
}
