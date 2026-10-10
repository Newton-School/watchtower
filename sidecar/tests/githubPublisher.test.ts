import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import type { ConversationStore, ConversationThreadRow, RecordMessagesResult } from '../src/state/conversationStore.js';
import {
  __resetGithubPublisherForTests,
  egressCloneDir,
  runGithubPublishOnce,
  type GithubEgressSettings,
} from '../src/egress/githubPublisher.js';
import { contentHash, threadFilePath } from '../src/egress/threadMarkdownRenderer.js';

const execFileAsync = promisify(execFile);

const NOW_EPOCH = Math.floor(Date.now() / 1000);

/** Slack-style epoch-seconds ts, `secondsAgo` before now (quiet gate compares against real now). */
function ts(secondsAgo: number, seq = 100): string {
  return `${NOW_EPOCH - secondsAgo}.${String(seq).padStart(6, '0')}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Bare origin seeded with an initial commit on `main`, so clones resolve origin/main. */
async function initOrigin(baseDir: string): Promise<string> {
  const origin = path.join(baseDir, 'origin.git');
  await git(baseDir, ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(baseDir, 'seed');
  await git(baseDir, ['clone', '-q', origin, seed]);
  await git(seed, ['checkout', '-q', '-B', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
  await git(seed, ['add', '.']);
  await git(seed, [
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'seed',
  ]);
  await git(seed, ['push', '-q', 'origin', 'HEAD:main']);
  return origin;
}

async function remoteFiles(origin: string): Promise<string[]> {
  const out = await git(origin, ['ls-tree', '-r', '--name-only', 'main']);
  return out ? out.split('\n') : [];
}

/** Exact blob content (untrimmed) of a file on the remote's main branch. */
async function remoteShow(origin: string, file: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', `main:${file}`], { cwd: origin });
  return stdout;
}

async function remoteSha(origin: string): Promise<string> {
  return git(origin, ['rev-parse', 'main']);
}

function recorded(result: RecordMessagesResult): { threadId: number; inserted: number } {
  if ('skipped' in result) throw new Error(`expected a recorded result, got skipped=${result.skipped}`);
  return result;
}

describe('githubPublisher lifecycle against a real local bare remote', () => {
  let baseDir: string;
  let origin: string;
  let cloneDir: string;
  let store: JobStore;
  let conv: ConversationStore;
  let settings: GithubEgressSettings;

  const CHANNEL = 'CEGRESS';
  const threadA = ts(20 * 60);
  const threadB = ts(30 * 60, 200);
  let pathA = '';
  let pathB = '';

  function threadRow(threadTs: string): ConversationThreadRow {
    const row = conv.getThread(CHANNEL, threadTs);
    if (!row) throw new Error(`thread ${threadTs} not found`);
    return row;
  }

  /** Force candidate selection: advance the thread's updated_at past the export row's. */
  function bumpThreadUpdatedAt(threadTs: string, msAhead: number): void {
    store['db']
      .prepare('UPDATE conversation_threads SET updated_at = ? WHERE channel_id = ? AND thread_ts = ?')
      .run(new Date(Date.now() + msAhead).toISOString(), CHANNEL, threadTs);
  }

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-egress-'));
    origin = await initOrigin(baseDir);
    cloneDir = egressCloneDir(origin);
    settings = { enabled: true, repo: origin, branch: 'main', includeTranscript: false };
    store = new JobStore(path.join(baseDir, 'watchtower.db'));
    conv = store.conversationStore();
  });

  beforeEach(() => {
    __resetGithubPublisherForTests();
  });

  afterAll(() => {
    store.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(cloneDir, { recursive: true, force: true });
  });

  it('skips as "disabled" without ever creating the clone dir', async () => {
    const result = await runGithubPublishOnce({ store }, { settings: { ...settings, enabled: false } });
    expect(result).toEqual({ skipped: 'disabled', published: 0, unchanged: 0, retracted: 0, failed: 0 });
    expect(fs.existsSync(cloneDir)).toBe(false);
  });

  it('skips as "idle" when there is nothing to publish or retract', async () => {
    const result = await runGithubPublishOnce({ store }, { settings });
    expect(result).toEqual({ skipped: 'idle', published: 0, unchanged: 0, retracted: 0, failed: 0 });
    expect(fs.existsSync(cloneDir)).toBe(false);
  });

  it('first publish lands thread files, channel README, DECISIONS.md, and SUCCESS export rows on the remote', async () => {
    const a = recorded(
      conv.recordMessages({
        channelId: CHANNEL,
        threadTs: threadA,
        channelName: 'eng-egress',
        visibility: 'org',
        messages: [
          { messageTs: threadA, userId: 'UALICE', displayName: 'alice', isBot: false, text: 'deploys keep colliding' },
          {
            messageTs: ts(19 * 60, 101),
            userId: 'UBOB',
            displayName: 'bob',
            isBot: false,
            text: 'blue-green would fix it',
          },
        ],
      }),
    );
    conv.saveSynthesis(a.threadId, {
      title: 'Deploy pipeline revamp',
      summary: 'Agreed to move newton-web to blue-green deploys.',
      decisions: ['Adopt blue-green deploys'],
      actionItems: ['Write the rollout runbook'],
      messageCount: 2,
    });
    const b = recorded(
      conv.recordMessages({
        channelId: CHANNEL,
        threadTs: threadB,
        channelName: 'eng-egress',
        visibility: 'org',
        messages: [
          { messageTs: threadB, userId: 'UBOB', displayName: 'bob', isBot: false, text: 'sentry quota blown again' },
        ],
      }),
    );
    conv.saveSynthesis(b.threadId, {
      title: 'Sentry quota triage',
      summary: 'Sentry quota blown by noisy staging errors.',
      decisions: ['Cap Sentry ingestion at 2M events'],
      actionItems: [],
      messageCount: 1,
    });
    pathA = threadFilePath(threadRow(threadA));
    pathB = threadFilePath(threadRow(threadB));
    expect(pathA).toMatch(/^threads\/eng-egress\/\d{4}-\d{2}\/\d+-\d{6}-deploy-pipeline-revamp\.md$/);

    const result = await runGithubPublishOnce({ store }, { settings });
    expect(result.skipped).toBeUndefined();
    expect(result.published).toBe(2);
    expect(result.retracted).toBe(0);
    expect(result.failed).toBe(0);
    const sha = await remoteSha(origin);
    expect(result.commitSha).toBe(sha);

    const files = await remoteFiles(origin);
    expect(files).toContain(pathA);
    expect(files).toContain(pathB);
    expect(files).toContain('threads/eng-egress/README.md');
    expect(files).toContain('DECISIONS.md');

    const fileA = await remoteShow(origin, pathA);
    expect(fileA).toContain('# Deploy pipeline revamp');
    expect(fileA).toContain('Agreed to move newton-web to blue-green deploys.');
    expect(fileA).toContain('- **Channel:** #eng-egress');
    expect(fileA).not.toContain('## Transcript');

    const decisions = await remoteShow(origin, 'DECISIONS.md');
    expect(decisions).toContain('Adopt blue-green deploys');
    expect(decisions).toContain('Cap Sentry ingestion at 2M events');
    expect(decisions).toContain(`(./${pathA})`);

    const readme = await remoteShow(origin, 'threads/eng-egress/README.md');
    expect(readme).toContain('# #eng-egress — miniOG conversations');
    expect(readme).toContain('[Deploy pipeline revamp]');
    expect(readme).toContain('[Sentry quota triage]');
    expect(readme).toContain(`(./${pathA.split('/').slice(2).join('/')})`);

    const row = store.exportLog().get('github', CHANNEL, threadA);
    expect(row).toMatchObject({ status: 'SUCCESS', targetPath: pathA, attempts: 0, commitSha: sha });
    expect(row?.targetUrl).toBe(`${origin}#${pathA}`);
    expect(row?.contentHash).toBe(contentHash(fileA));
  });

  it('counts an unchanged candidate as unchanged and pushes no new commit', async () => {
    bumpThreadUpdatedAt(threadA, 60_000);
    const before = await remoteSha(origin);
    const result = await runGithubPublishOnce({ store }, { settings });
    expect(result.published).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.retracted).toBe(0);
    expect(result.failed).toBe(0);
    expect(await remoteSha(origin)).toBe(before);
  });

  it('republishes changed content to the SAME target path even when the title/slug changes', async () => {
    conv.saveSynthesis(threadRow(threadA).id, {
      title: 'Canary rollout decision',
      summary: 'Pivoted: canary deploys instead of blue-green.',
      decisions: ['Switch newton-web to canary deploys'],
      actionItems: ['Update the rollout runbook'],
      messageCount: 2,
    });
    bumpThreadUpdatedAt(threadA, 120_000);
    const before = await remoteSha(origin);
    const result = await runGithubPublishOnce({ store }, { settings });
    expect(result.published).toBe(1);
    const after = await remoteSha(origin);
    expect(after).not.toBe(before);
    expect(result.commitSha).toBe(after);

    // Path stability: the file stays where it was first published; no new-slug file appears.
    const files = await remoteFiles(origin);
    expect(files).toContain(pathA);
    expect(files.some(f => f.includes('canary-rollout-decision'))).toBe(false);

    const content = await remoteShow(origin, pathA);
    expect(content).toContain('# Canary rollout decision');
    expect(content).toContain('Pivoted: canary deploys instead of blue-green.');

    const row = store.exportLog().get('github', CHANNEL, threadA);
    expect(row?.targetPath).toBe(pathA);
    expect(row?.contentHash).toBe(contentHash(content));
    expect(row?.commitSha).toBe(after);

    const decisions = await remoteShow(origin, 'DECISIONS.md');
    expect(decisions).toContain('Switch newton-web to canary deploys');
    expect(decisions).not.toContain('Adopt blue-green deploys');
  });

  it('retracts a forgotten thread: file deleted from the remote, decision dropped, export row gone', async () => {
    expect(conv.forgetThread(CHANNEL, threadB)).toEqual({ messagesDeleted: 1 });
    const before = await remoteSha(origin);
    const result = await runGithubPublishOnce({ store }, { settings });
    expect(result.retracted).toBe(1);
    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
    expect(await remoteSha(origin)).not.toBe(before);

    const files = await remoteFiles(origin);
    expect(files).not.toContain(pathB);
    expect(files).toContain(pathA);
    expect(files).toContain('threads/eng-egress/README.md');

    const decisions = await remoteShow(origin, 'DECISIONS.md');
    expect(decisions).not.toContain('Cap Sentry ingestion at 2M events');
    expect(decisions).toContain('Switch newton-web to canary deploys');

    const readme = await remoteShow(origin, 'threads/eng-egress/README.md');
    expect(readme).not.toContain('Sentry quota triage');
    expect(readme).toContain('Canary rollout decision');

    expect(store.exportLog().get('github', CHANNEL, threadB)).toBeUndefined();
    expect(store.exportLog().get('github', CHANNEL, threadA)?.status).toBe('SUCCESS');
  });
});

describe('githubPublisher push failure backoff', () => {
  let baseDir: string;
  let origin: string;
  let objectsDir: string;
  let cloneDir: string;
  let store: JobStore;
  let settings: GithubEgressSettings;

  const CHANNEL = 'CFAIL';
  const threadTs = ts(25 * 60, 300);
  let targetPath = '';

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-egress-fail-'));
    origin = await initOrigin(baseDir);
    objectsDir = path.join(origin, 'objects');
    cloneDir = egressCloneDir(origin);
    settings = { enabled: true, repo: origin, branch: 'main', includeTranscript: false };
    store = new JobStore(path.join(baseDir, 'watchtower.db'));
    const conv = store.conversationStore();
    const seeded = recorded(
      conv.recordMessages({
        channelId: CHANNEL,
        threadTs,
        channelName: 'eng-flaky',
        visibility: 'org',
        messages: [
          { messageTs: threadTs, userId: 'UEVE', displayName: 'eve', isBot: false, text: 'push me if you can' },
        ],
      }),
    );
    conv.saveSynthesis(seeded.threadId, {
      title: 'Unpushable thread',
      summary: 'Exists to exercise the push failure path.',
      decisions: [],
      actionItems: [],
      messageCount: 1,
    });
    const row = conv.getThread(CHANNEL, threadTs);
    if (!row) throw new Error('seed thread missing');
    targetPath = threadFilePath(row);
  });

  beforeEach(() => {
    __resetGithubPublisherForTests();
  });

  afterAll(() => {
    // Restore write permission so cleanup can delete the bare repo.
    fs.chmodSync(objectsDir, 0o755);
    store.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(cloneDir, { recursive: true, force: true });
  });

  it('records FAILED with growing attempts while the remote rejects pushes, then publishes once writable', async () => {
    // Read-only objects dir: clone/fetch still work, receive-pack cannot write.
    fs.chmodSync(objectsDir, 0o555);
    const first = await runGithubPublishOnce({ store }, { settings });
    expect(first.failed).toBe(1);
    expect(first.published).toBe(0);
    expect(first.commitSha).toBeUndefined();
    let row = store.exportLog().get('github', CHANNEL, threadTs);
    expect(row?.status).toBe('FAILED');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBeTruthy();
    expect(row?.targetPath).toBe(targetPath);
    expect(await remoteFiles(origin)).not.toContain(targetPath);

    // Failed row below the attempts cap is re-selected without any content change.
    const second = await runGithubPublishOnce({ store }, { settings });
    expect(second.failed).toBe(1);
    row = store.exportLog().get('github', CHANNEL, threadTs);
    expect(row?.attempts).toBe(2);

    fs.chmodSync(objectsDir, 0o755);
    const third = await runGithubPublishOnce({ store }, { settings });
    expect(third.failed).toBe(0);
    expect(third.published).toBe(1);
    row = store.exportLog().get('github', CHANNEL, threadTs);
    expect(row?.status).toBe('SUCCESS');
    expect(row?.attempts).toBe(0);
    expect(row?.targetPath).toBe(targetPath);
    expect(await remoteFiles(origin)).toContain(targetPath);
  });
});
