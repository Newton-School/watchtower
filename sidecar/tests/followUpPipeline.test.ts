/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentPipeline } from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import { NO_PUSH_TO_GITHUB_ENV } from '../src/github/noPush.js';
import { checkCoderProducedChanges, currentHead, getDiffVsBase } from '../src/workspaces/gitState.js';
import type { AgentContext, PipelineConfig } from '../src/agents/types.js';

vi.mock('../src/codex/runCodex.js', () => ({ runCodex: vi.fn(), getActiveBackendId: vi.fn(() => 'claude-code') }));
vi.mock('../src/workspaces/gitState.js', () => ({
  currentHead: vi.fn().mockResolvedValue('headafteranswer'),
  checkCoderProducedChanges: vi.fn(),
  getDiffVsBase: vi.fn().mockResolvedValue('diff --git a/footer.txt b/footer.txt'),
}));

// Issue #730: a follow-up's coder commits to an open PR's branch. Its git
// can't push to GitHub, and every commit since the PR commit the run started
// from is reviewed, also when the pipeline restarts after a coder question.
const PR = 'https://github.com/Newton-School/newton-marketing-web/pull/1484';
const pipelineConfig = {
  agents: ['coder'],
  maxRetryLoops: 1,
  totalTimeoutMs: 600_000,
  perAgentTimeoutMs: 300_000,
  abortOnCriticalFinding: false,
  slackProgressUpdates: false,
} as PipelineConfig;
const ctxWith = (extra: Partial<AgentContext>): AgentContext =>
  ({
    workflowIntent: 'IMPLEMENTATION',
    task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'UREQ', text: 'change the footer', eventTs: '1.2' } },
    config: { botUserId: 'UBOT' },
    repoPath: '/ws/newton-marketing-web/1-1',
    threadContext: '',
    previousSteps: [
      {
        role: 'planner',
        status: 'passed',
        output: { planMarkdown: '# Footer\n\n1. Edit it.' },
        findings: [],
        durationMs: 1,
      },
    ],
    pipelineConfig,
    ...extra,
  }) as unknown as AgentContext;
const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '9.9' }), update: vi.fn() } } as any;

beforeEach(() => {
  vi.mocked(runCodex)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: { status: 'done', summary: 'Changed the footer.', prUrl: '', branch: 'raj/hero-copy' },
    } as any);
  vi.mocked(checkCoderProducedChanges)
    .mockReset()
    .mockResolvedValue({
      producedChanges: true,
      filesChanged: ['footer.txt'],
      newCommits: 1,
      hasUncommitted: false,
      headMoved: true,
    } as any);
  vi.mocked(currentHead).mockClear();
  vi.mocked(getDiffVsBase).mockClear();
});

describe("a follow-up's coder", () => {
  it("runs with git that can't push to GitHub, and is checked against the commit the run started from", async () => {
    const result = await runAgentPipeline({
      ctx: ctxWith({ followUp: { prUrl: PR, branch: 'raj/hero-copy' }, diffBaseSha: 'prstart1' }),
      slack,
      logStep: vi.fn(),
    });

    expect(result.finalStatus).toBe('passed');
    expect(vi.mocked(runCodex).mock.calls[0][0].extraEnv).toEqual(NO_PUSH_TO_GITHUB_ENV);
    // After a coder question the worktree's HEAD has moved: the original start commit is the base.
    expect(currentHead).not.toHaveBeenCalled();
    expect(checkCoderProducedChanges).toHaveBeenCalledWith(expect.objectContaining({ baseSha: 'prstart1' }));
    expect(getDiffVsBase).toHaveBeenCalledWith('/ws/newton-marketing-web/1-1', 'prstart1');
  });

  it('a change with its own PR is untouched: its git pushes as usual, from the current commit', async () => {
    await runAgentPipeline({ ctx: ctxWith({}), slack, logStep: vi.fn() });

    expect(vi.mocked(runCodex).mock.calls[0][0].extraEnv).toBeUndefined();
    expect(checkCoderProducedChanges).toHaveBeenCalledWith(expect.objectContaining({ baseSha: 'headafteranswer' }));
  });
});
