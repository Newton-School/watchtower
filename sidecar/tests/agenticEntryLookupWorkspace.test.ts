import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { refreshSharedRepoToDefaultBranch } from '../src/workspaces/workspaceManager.js';
import { createLookupWorkspace } from '../src/workspaces/lookupWorkspace.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

// Same hermetic stubs as agenticEntryStaleCheckout.test.ts.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({ refreshSharedRepoToDefaultBranch: vi.fn() }));
vi.mock('../src/workspaces/lookupWorkspace.js', () => ({ createLookupWorkspace: vi.fn() }));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ isAvailable: () => true }) }));

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
    text: 'where is the interview feedback banner rendered?',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'INFORMATIONAL',
};

// Issue #446: a lookup reads its own copy of the repos at origin's head.
describe('runAgenticEntry with the lookup copy of the repos', () => {
  let dbDir: string;
  let store: JobStore;
  let slack: WebClient;
  let postMessage: ReturnType<typeof vi.fn>;
  let cleanup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-lookup-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    postMessage = vi.fn(async () => ({ ok: true, ts: '2.2' }));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage },
    } as unknown as WebClient;
    cleanup = vi.fn(async () => {});
    vi.mocked(createLookupWorkspace).mockReset().mockResolvedValue({ cwd: '/lookups/lookup-1', repos: [], cleanup });
    vi.mocked(refreshSharedRepoToDefaultBranch).mockReset();
    vi.mocked(runClaudeAgentic)
      .mockReset()
      .mockResolvedValue({ ok: true, reason: 'ok', reply: 'In `InterviewBanner.tsx:42`.' } as never);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('runs the agent in the copy, leaves the shared clones alone, and removes the copy after posting', async () => {
    await runAgenticEntry({ mode: 'informational', task, config, slack, store });

    expect(vi.mocked(runClaudeAgentic).mock.calls[0][0].cwd).toBe('/lookups/lookup-1');
    expect(refreshSharedRepoToDefaultBranch).not.toHaveBeenCalled();
    expect(vi.mocked(runClaudeAgentic).mock.calls[0][0].systemPrompt).not.toContain('STALE CHECKOUTS');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(postMessage.mock.invocationCallOrder[0]);
  });

  it('removes the copy when the run throws', async () => {
    vi.mocked(runClaudeAgentic).mockRejectedValue(new Error('boom'));

    await expect(runAgenticEntry({ mode: 'informational', task, config, slack, store })).rejects.toThrow('boom');

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('makes no copy for a chat reply', async () => {
    await runAgenticEntry({ mode: 'conversational', task, config, slack, store });

    expect(createLookupWorkspace).not.toHaveBeenCalled();
    expect(vi.mocked(runClaudeAgentic).mock.calls[0][0].cwd).toBe('/repos');
  });
});
