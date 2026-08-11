import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgenticEntry } from '../src/agentic/agenticEntry.js';
import type { NormalizedTask } from '../src/types/contracts.js';
import type { JobStore } from '../src/state/jobStore.js';

// Pins the per-mode MODE_POLICY: informational = high tier @ medium effort,
// conversational = light tier (sonnet on the live backend), qa = high tier @
// high effort (bounded by QA_TIMEOUT_MS, where xhigh would spend the budget
// thinking instead of driving the browser).

const runClaudeAgentic = vi.fn();
vi.mock('../src/agentic/runClaude.js', () => ({
  runClaudeAgentic: (...args: unknown[]) => runClaudeAgentic(...args),
}));
vi.mock('../src/github/githubAuth.js', () => ({
  resolveGithubTokenForCodex: vi.fn(async () => undefined),
}));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  refreshSharedRepoToDefaultBranch: vi.fn(async () => ({ branch: 'main', head: 'abc123' })),
}));
vi.mock('../src/backends/registry.js', () => ({
  getBackend: () => ({ isAvailable: () => true }),
}));
vi.mock('../src/slack/imageUploader.js', () => ({
  parseScreenshotManifest: (reply: string) => ({ visibleText: reply, screenshots: [] }),
  uploadScreenshots: vi.fn(async () => 0),
}));

function makeTask(text: string): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: 'C1',
      threadTs: '1.2',
      eventTs: '1.2',
      userId: 'U1',
      text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'INFORMATIONAL',
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const config: any = {
  repoPaths: { newtonWeb: '/tmp/nw', newtonApi: '/tmp/na' },
  miniOgRepoRoot: '/tmp',
};
const slack: any = { chat: { postMessage: vi.fn(async () => ({ ts: '9.9' })) } };
const store = {} as JobStore;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('runAgenticEntry per-mode model policy', () => {
  beforeEach(() => {
    runClaudeAgentic.mockReset();
    runClaudeAgentic.mockResolvedValue({ ok: true, reason: 'ok', reply: 'hello' });
  });

  it('informational runs the high tier at medium effort, no timeout', async () => {
    await runAgenticEntry({ mode: 'informational', task: makeTask('where is X?'), config, slack, store });
    expect(runClaudeAgentic).toHaveBeenCalledWith(expect.objectContaining({ tier: 'high', effort: 'medium' }));
    expect(runClaudeAgentic.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
  });

  it('conversational runs the light tier (sonnet on the live backend)', async () => {
    await runAgenticEntry({ mode: 'conversational', task: makeTask('thanks!'), config, slack, store });
    expect(runClaudeAgentic).toHaveBeenCalledWith(expect.objectContaining({ tier: 'light', effort: undefined }));
  });

  it('qa runs the high tier at high (not xhigh) with the QA timeout and pinned backend', async () => {
    await runAgenticEntry({
      mode: 'qa',
      task: makeTask('qa https://app.example.com/login please'),
      config,
      slack,
      store,
    });
    expect(runClaudeAgentic).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'high',
        effort: 'high',
        forceBackend: 'claude-code',
        timeoutMs: 20 * 60 * 1000,
      }),
    );
  });
});
