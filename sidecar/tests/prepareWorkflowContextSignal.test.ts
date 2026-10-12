/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveRepoOrAsk = vi.hoisted(() => vi.fn());

vi.mock('../src/workflows/shared/repoResolver.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/workflows/shared/repoResolver.js')>()),
  resolveRepoOrAsk,
}));
vi.mock('../src/slack/threadContext.js', () => ({ fetchThreadContext: vi.fn(async () => []) }));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ supportsImages: () => true }) }));
vi.mock('../src/codex/runCodex.js', () => ({ getActiveBackendId: () => 'claude-code' }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  resolveWorkspace: vi.fn(async (repoPath: string) => repoPath),
}));

import { prepareWorkflowContext } from '../src/workflows/shared/workflowUtils.js';

const config: any = {
  ownerSlackUserIds: ['UOWNER'],
  repoPaths: { newtonWeb: '/repos/newton-web', newtonApi: '/repos/newton-api' },
};

const task: any = {
  event: {
    eventId: 'Ev1',
    channelId: 'C1',
    threadTs: '1.1',
    eventTs: '1.1',
    userId: 'U_REQ',
    text: 'fix the banner',
    rawEvent: {},
  },
  mentionDetected: true,
  mentionType: 'bot',
  isOwnerAuthor: false,
  isCoreDevAuthor: false,
  intent: 'IMPLEMENTATION',
};

const slack: any = { users: { info: vi.fn(async () => ({ user: { profile: { display_name: 'Req' } } })) } };

// Issue #264: the "which repo?" wait could not see a cancel, because the job's
// signal stopped here. It then kept polling for up to six hours.
describe('prepareWorkflowContext and the abort signal', () => {
  beforeEach(() => {
    resolveRepoOrAsk.mockReset();
  });

  it("forwards the job's signal to the repo question", async () => {
    resolveRepoOrAsk.mockResolvedValue({ outcome: 'resolved', name: 'newton-web', path: '/repos/newton-web' });
    const controller = new AbortController();

    const ctx = await prepareWorkflowContext({ task, config, slack, signal: controller.signal });

    expect(resolveRepoOrAsk).toHaveBeenCalledTimes(1);
    expect(resolveRepoOrAsk.mock.calls[0][0].signal).toBe(controller.signal);
    expect(ctx.repoName).toBe('newton-web');
  });

  it('reports a cancelled repo question as cancelled, not as an unresolved repo', async () => {
    resolveRepoOrAsk.mockResolvedValue({ outcome: 'cancelled' });

    const ctx = await prepareWorkflowContext({ task, config, slack, signal: new AbortController().signal });

    expect(ctx.desktopOnly).toEqual({ reason: 'admin cancelled', cancelled: true });
  });
});
