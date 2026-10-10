import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

// Same hermetic stubs as agenticEntryThreadContext.test.ts.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  refreshSharedRepoToDefaultBranch: vi.fn(async () => ({ branch: 'main', head: 'abc123' })),
}));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ isAvailable: () => true }) }));
vi.mock('../src/slack/imageUploader.js', () => ({
  parseScreenshotManifest: (reply: string) => ({ visibleText: reply, screenshots: [] }),
  uploadScreenshots: vi.fn(async () => 0),
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
    text: 'hey, you there?',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'CONVERSATIONAL',
};

// Issue #438: a cancelled lookup posted its (empty) reply, which Slack rejects
// with no_text, and was then recorded FAILED.
describe('runAgenticEntry when the run is cancelled or has nothing to say', () => {
  let dbDir: string;
  let store: JobStore;
  let postMessage: ReturnType<typeof vi.fn>;
  let slack: WebClient;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-agentic-cancel-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    postMessage = vi.fn(async () => ({ ok: true, ts: '2.2' }));
    slack = {
      conversations: { replies: vi.fn(async () => ({ messages: [] })) },
      chat: { postMessage },
    } as unknown as WebClient;
    vi.mocked(runClaudeAgentic).mockReset();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('returns CANCELLED and posts nothing when the run was aborted', async () => {
    const controller = new AbortController();
    vi.mocked(runClaudeAgentic).mockImplementation(async () => {
      controller.abort();
      return { ok: false, reason: 'aborted', reply: '', error: 'aborted' };
    });

    const result = await runAgenticEntry({
      mode: 'conversational',
      task,
      config,
      slack,
      store,
      signal: controller.signal,
    });

    expect(result.status).toBe('CANCELLED');
    expect(result.workflow).toBe('CONVERSATIONAL');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('never posts an empty message when a run fails without any text', async () => {
    vi.mocked(runClaudeAgentic).mockResolvedValue({
      ok: false,
      reason: 'error',
      reply: '   ',
      error: 'agent exited 1',
    });

    const result = await runAgenticEntry({ mode: 'conversational', task, config, slack, store });

    expect(postMessage).not.toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
    expect(result.message).toBe('agent exited 1');
    expect(result.slackPosted).toBe(false);
  });

  it('still posts the reply of a normal run', async () => {
    vi.mocked(runClaudeAgentic).mockResolvedValue({ ok: true, reason: 'ok', reply: 'Here, what do you need?' });

    const result = await runAgenticEntry({ mode: 'conversational', task, config, slack, store });

    expect(result.status).toBe('SUCCESS');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].text).toBe('Here, what do you need?');
  });

  it('keeps a reply that finished before the cancel landed', async () => {
    const controller = new AbortController();
    vi.mocked(runClaudeAgentic).mockImplementation(async () => {
      controller.abort();
      return { ok: true, reason: 'ok', reply: 'Done before you stopped me.' };
    });

    const result = await runAgenticEntry({
      mode: 'conversational',
      task,
      config,
      slack,
      store,
      signal: controller.signal,
    });

    expect(result.status).toBe('SUCCESS');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
