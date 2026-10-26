import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

// Same hermetic stubs as agenticEntryCancel.test.ts.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({ refreshSharedRepoToDefaultBranch: vi.fn() }));
// The lookup's own copy could not be set up, so it reads the shared clones (see lookupWorkspace.test.ts).
vi.mock('../src/workspaces/lookupWorkspace.js', () => ({ createLookupWorkspace: vi.fn(async () => undefined) }));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ isAvailable: () => true }) }));
vi.mock('../src/slack/imageUploader.js', () => ({
  parseScreenshotManifest: (reply: string) => ({ visibleText: reply, screenshots: [] }),
  uploadScreenshots: vi.fn(async () => ({ uploaded: 0, undelivered: [] })),
  QA_LIMITS: { maxFiles: 8, maxFileBytes: 5 * 1024 * 1024 },
}));

const config = {
  botUserId: 'UBOT',
  ownerSlackUserIds: [],
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
  miniOgRepoRoot: '/repos',
} as unknown as AppConfig;

const task: NormalizedTask = {
  event: {
    eventId: 'Ev1',
    channelId: 'C123',
    threadTs: '1791000000.000100',
    eventTs: '1791000000.000100',
    userId: 'U111',
    text: 'does interviewUrl include showPendingInterviewFeedback?',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'INFORMATIONAL',
};

// Issue #446: a lookup clone 707 commits behind was logged as "Refreshed" and
// read from disk, and the answer was "that param doesn't exist anywhere".
describe('runAgenticEntry reading a shared clone that is behind origin', () => {
  let dbDir: string;
  let store: JobStore;
  let slack: WebClient;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-stale-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage: vi.fn(async () => ({ ok: true, ts: '2.2' })) },
    } as unknown as WebClient;
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply: 'Yes, since 2026-09-17.' } as never);
    vi.mocked(refreshSharedRepoToDefaultBranch)
      .mockReset()
      .mockImplementation(async repoPath =>
        repoPath.endsWith('newton-web')
          ? {
              branch: 'master',
              head: 'eae5d68bb',
              upstream: 'origin/master',
              behind: 707,
              staleReason: 'dirty_tree',
              dirtyFiles: ['package-lock.json', 'package.json'],
            }
          : { branch: 'master', head: 'ac56c6935', upstream: 'origin/master', behind: 0 },
      );
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  const run = async (mode: 'informational' | 'conversational' = 'informational') => {
    const logStep = vi.fn();
    await runAgenticEntry({ mode, task, config, slack, store, logStep });
    return {
      prompt: vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt as string,
      refreshLogs: logStep.mock.calls.map(call => call[0]).filter(entry => entry.stage === 'agentic.repo_refresh'),
    };
  };

  it('logs the truth about each clone instead of "Refreshed"', async () => {
    const { refreshLogs } = await run();

    const web = refreshLogs.find(entry => entry.data.repoPath === '/repos/newton-web');
    expect(web.level).toBe('WARN');
    expect(web.message).toContain('newton-web is 707 commits behind origin/master and was not updated');
    expect(web.data).toMatchObject({ behind: 707, staleReason: 'dirty_tree', head: 'eae5d68bb' });
    const api = refreshLogs.find(entry => entry.data.repoPath === '/repos/newton-api');
    expect(api).toMatchObject({ level: 'INFO', message: 'Refreshed newton-api to master @ ac56c6935.' });
  });

  it('tells the agent to read the stale repo from origin, and only that repo', async () => {
    const { prompt } = await run();

    expect(prompt).toContain('STALE CHECKOUTS');
    expect(prompt).toContain('- newton-web: the files on disk are 707 commits behind origin/master');
    expect(prompt).toContain('  cd /repos/newton-web\n  git show origin/master:<path>');
    // The repo that is current is not in the block (the base prompt lists every repo above it).
    expect(prompt.slice(prompt.indexOf('STALE CHECKOUTS'))).not.toContain('newton-api');
  });

  it('adds nothing to the prompt when every clone is current', async () => {
    vi.mocked(refreshSharedRepoToDefaultBranch).mockResolvedValue({
      branch: 'master',
      head: 'ac56c6935',
      upstream: 'origin/master',
      behind: 0,
    });

    const { prompt } = await run();

    expect(prompt).not.toContain('STALE CHECKOUTS');
  });

  it('does not refresh, or mention checkouts, for a chat reply that reads no code', async () => {
    const { prompt, refreshLogs } = await run('conversational');

    expect(refreshSharedRepoToDefaultBranch).not.toHaveBeenCalled();
    expect(refreshLogs).toEqual([]);
    expect(prompt).not.toContain('STALE CHECKOUTS');
  });
});
