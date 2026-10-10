import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn(() => 'claude-code'),
}));
vi.mock('../src/codex/modelProfiles.js', () => ({
  lightweightProfile: vi.fn(() => ({ model: 'haiku-test', reasoningEffort: 'low' })),
}));

import { runCodex } from '../src/codex/runCodex.js';
import { JobStore } from '../src/state/jobStore.js';
import {
  __resetVaultWriterForTests,
  configureVaultWriter,
  flushVault,
  scheduleVaultRender,
  shutdownVaultWriter,
} from '../src/vault/vaultWriter.js';
import { threadNotePath } from '../src/vault/vaultPaths.js';
import { synthesizeThread } from '../src/conversation/threadSynthesizer.js';
import type { CapturedMessage, ConversationStore } from '../src/state/conversationStore.js';
import type { CodexRunResult } from '../src/types/contracts.js';

const BASE_EPOCH = Math.floor(Date.now() / 1000) - 3600;
const CHANNEL_ID = 'C1DEV';

/** Slack-style epoch-seconds ts, `offset` seconds after the thread root. */
function ts(offset: number): string {
  return `${BASE_EPOCH + offset}.000100`;
}

const THREAD_TS = ts(0);

function captured(i: number): CapturedMessage {
  const isBot = i % 2 === 1;
  return {
    messageTs: ts(i),
    userId: isBot ? 'B01' : 'U1',
    displayName: isBot ? 'miniOG' : 'theOG',
    isBot,
    text: `message number ${i} about the deploy pipeline`,
  };
}

function codexResult(overrides: Partial<CodexRunResult>): CodexRunResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    durationMs: 10,
    backend: 'claude-code',
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('threadNotePath', () => {
  it('places thread notes under miniog/threads/<slug>.md', () => {
    expect(threadNotePath('/vault', 'c1dev-1755741600-000100')).toBe(
      path.join('/vault', 'miniog', 'threads', 'c1dev-1755741600-000100.md'),
    );
  });
});

describe('vault thread mirror', () => {
  let dbDir: string;
  let vaultDir: string;
  let store: JobStore;
  let conv: ConversationStore;

  beforeEach(() => {
    __resetVaultWriterForTests();
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-vault-mirror-db-'));
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-vault-mirror-vault-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    conv = store.conversationStore();
  });

  afterEach(() => {
    shutdownVaultWriter();
    __resetVaultWriterForTests();
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vi.mocked(runCodex).mockReset();
  });

  function seedOrgThread(count = 5): number {
    const result = conv.recordMessages({
      channelId: CHANNEL_ID,
      threadTs: THREAD_TS,
      channelName: 'eng-updates',
      visibility: 'org',
      messages: Array.from({ length: count }, (_, i) => captured(i)),
    });
    if ('skipped' in result) throw new Error('unexpected skip while seeding');
    return result.threadId;
  }

  function synthesize(threadId: number, title = 'GA4 rollout decision'): void {
    conv.saveSynthesis(threadId, {
      title,
      summary: 'theOG asked about the GA4 rollout; miniOG confirmed it is safe to ship.',
      decisions: ['Ship the GA4 rollout on Friday'],
      actionItems: ['theOG to update the dashboard'],
      messageCount: 5,
    });
  }

  /** Expected note path: <vault>/miniog/threads/<channelSlug>-<ts with dots as dashes>.md */
  function notePath(): string {
    return path.join(vaultDir, 'miniog', 'threads', `c1dev-${THREAD_TS.replace(/\./g, '-')}.md`);
  }

  function configureEnabled(): void {
    configureVaultWriter({ store, vaultPath: vaultDir, enabled: true });
  }

  async function renderThread(): Promise<void> {
    scheduleVaultRender({ kind: 'thread', channelId: CHANNEL_ID, threadTs: THREAD_TS });
    await flushVault();
  }

  it('writes a frontmatter + synthesis note without a transcript for a synthesized org thread', async () => {
    const threadId = seedOrgThread();
    synthesize(threadId);
    configureEnabled();
    await renderThread();

    const file = notePath();
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toMatch(/^miniog_rendered_at: \d{4}-\d{2}-\d{2}T/m);
    expect(content).toContain(`channel_id: ${CHANNEL_ID}`);
    expect(content).toContain(`thread_ts: "${THREAD_TS}"`);
    expect(content).toContain('# GA4 rollout decision');
    expect(content).toContain('## TL;DR');
    expect(content).toContain('theOG asked about the GA4 rollout; miniOG confirmed it is safe to ship.');
    expect(content).toContain('## Decisions');
    expect(content).toContain('- Ship the GA4 rollout on Friday');
    expect(content).not.toContain('## Transcript');
    expect(content).not.toContain('message number 0');
  });

  it('re-rendering unchanged data leaves the file byte-identical with the same mtime', async () => {
    const threadId = seedOrgThread();
    synthesize(threadId);
    configureEnabled();
    await renderThread();
    const before = fs.readFileSync(notePath(), 'utf8');
    const mtimeBefore = fs.statSync(notePath()).mtimeMs;

    // A real rewrite would stamp a new miniog_rendered_at and a new mtime.
    await sleep(10);
    await renderThread();

    expect(fs.readFileSync(notePath(), 'utf8')).toBe(before);
    expect(fs.statSync(notePath()).mtimeMs).toBe(mtimeBefore);
  });

  it('re-synthesis with a new title updates the SAME file (slug is channel+ts, not title)', async () => {
    const threadId = seedOrgThread();
    synthesize(threadId, 'Original incident title');
    configureEnabled();
    await renderThread();
    expect(fs.readFileSync(notePath(), 'utf8')).toContain('# Original incident title');

    synthesize(threadId, 'Completely renamed follow-up');
    await renderThread();

    const content = fs.readFileSync(notePath(), 'utf8');
    expect(content).toContain('# Completely renamed follow-up');
    expect(content).not.toContain('Original incident title');
    expect(fs.readdirSync(path.join(vaultDir, 'miniog', 'threads'))).toEqual([path.basename(notePath())]);
  });

  it('deletes the note when the thread is forgotten', async () => {
    const threadId = seedOrgThread();
    synthesize(threadId);
    configureEnabled();
    await renderThread();
    expect(fs.existsSync(notePath())).toBe(true);

    expect(conv.forgetThread(CHANNEL_ID, THREAD_TS)).toEqual({ messagesDeleted: 5 });
    await renderThread();

    expect(fs.existsSync(notePath())).toBe(false);
  });

  it('renders nothing for a thread that was never captured', async () => {
    configureEnabled();
    scheduleVaultRender({ kind: 'thread', channelId: 'CNOPE', threadTs: ts(1) });
    await flushVault();
    expect(fs.existsSync(path.join(vaultDir, 'miniog'))).toBe(false);
  });

  it('scheduleVaultRender no-ops when the writer is unconfigured, disabled, or has no vault path', async () => {
    const threadId = seedOrgThread();
    synthesize(threadId);

    // Never configured.
    await renderThread();
    expect(fs.existsSync(path.join(vaultDir, 'miniog'))).toBe(false);

    // Explicitly disabled.
    configureVaultWriter({ store, vaultPath: vaultDir, enabled: false });
    await renderThread();
    expect(fs.existsSync(path.join(vaultDir, 'miniog'))).toBe(false);

    // Enabled but with a blank vault path.
    configureVaultWriter({ store, vaultPath: '   ', enabled: true });
    await renderThread();
    expect(fs.existsSync(path.join(vaultDir, 'miniog'))).toBe(false);
  });

  it('synthesizeThread schedules the mirror so the next flush writes the note', async () => {
    const threadId = seedOrgThread();
    configureEnabled();
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: {
          title: 'Deploy pipeline triage',
          summary: 'miniOG traced the deploy failure to a stale runner image.',
          decisions: ['Pin the runner image'],
          action_items: [],
        },
      }),
    );

    const out = await synthesizeThread({ threadId, store });
    expect(out.ok).toBe(true);
    // Scheduled but not yet flushed — nothing on disk yet.
    expect(fs.existsSync(notePath())).toBe(false);

    await flushVault();
    const content = fs.readFileSync(notePath(), 'utf8');
    expect(content).toContain('# Deploy pipeline triage');
    expect(content).toContain('miniOG traced the deploy failure to a stale runner image.');
    expect(content).toContain('- Pin the runner image');
  });
});
