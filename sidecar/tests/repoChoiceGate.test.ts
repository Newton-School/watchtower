/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForRepoChoice } from '../src/agents/pipeline.js';
import { runCodex } from '../src/codex/runCodex.js';
import { fetchThreadContext } from '../src/slack/threadContext.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn(),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

const mockRunCodex = runCodex as unknown as ReturnType<typeof vi.fn>;
const mockFetchThread = fetchThreadContext as unknown as ReturnType<typeof vi.fn>;

function makeSlack() {
  const postMessage = vi.fn().mockResolvedValue({ ts: 'post.1' });
  return {
    chat: { postMessage },
  } as any;
}

describe('waitForRepoChoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunCodex.mockReset();
    mockFetchThread.mockReset();
  });

  async function advancePollCycles(n: number) {
    for (let i = 0; i < n; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
  }

  it('resolves to newton-web on short-circuit regex match for "web"', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'web' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    const result = await promise;

    expect(result.outcome).toBe('newton-web');
    expect(result.approverId).toBe('UADMIN');
    // Short-circuit means classifier model was never called.
    expect(mockRunCodex).not.toHaveBeenCalled();
  });

  it('resolves to newton-api on "newton-api" shorthand', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'newton-api' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('newton-api');
  });

  it('uses the AI classifier for non-shorthand replies', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'the python one, django side' }]);
    mockRunCodex.mockResolvedValueOnce({
      ok: true,
      parsedJson: { intent: 'api', reasoning: 'python/django signals backend' },
    });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('newton-api');
    expect(mockRunCodex).toHaveBeenCalledTimes(1);
  });

  it('ignores replies from non-admin users and waits for an admin', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'USTRANGER', text: 'api' }]).mockResolvedValueOnce([
      { ts: 'post.2', user: 'USTRANGER', text: 'api' },
      { ts: 'post.3', user: 'UADMIN', text: 'web' },
    ]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-web');

    // Non-admin got nudged once.
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Only admins can pick the target repo'),
      }),
    );
  });

  it('returns "cancelled" when admin says "cancel"', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'cancel' }]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('cancelled');
  });

  it('keeps waiting when the admin reply is classified as "unclear"', async () => {
    const slack = makeSlack();
    mockFetchThread
      .mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'not sure yet' }])
      .mockResolvedValueOnce([
        { ts: 'post.2', user: 'UADMIN', text: 'not sure yet' },
        { ts: 'post.3', user: 'UADMIN', text: 'api' },
      ]);
    mockRunCodex.mockResolvedValueOnce({ ok: true, parsedJson: { intent: 'unclear' } });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-api');
  });

  it('acknowledges "both" once and resolves when the admin then picks a repo (#394)', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'both' }]).mockResolvedValueOnce([
      { ts: 'post.2', user: 'UADMIN', text: 'both' },
      { ts: 'post.3', user: 'UADMIN', text: 'web' },
    ]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-web');
    // "both" and "web" both hit the cheap regex — the classifier model is never called.
    expect(mockRunCodex).not.toHaveBeenCalled();
    // The cross-repo guidance is posted exactly once, even though "both" is re-seen on both polls.
    const guidanceCalls = slack.chat.postMessage.mock.calls.filter((c: any[]) =>
      String(c[0]?.text ?? '').includes('one repo per run'),
    );
    expect(guidanceCalls).toHaveLength(1);
  });

  it.each(['marketing', 'mweb', 'nmw', 'landing', 'marketing web', 'newton-marketing-web'])(
    'resolves to newton-marketing-web on shorthand %j without calling the classifier',
    async shorthand => {
      const slack = makeSlack();
      mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: shorthand }]);

      const promise = waitForRepoChoice({
        slack,
        channelId: 'C01',
        threadTs: '111.00',
        approverUserIds: ['UADMIN'],
        promptTs: 'post.1',
        logStep: () => {},
        botUserId: 'UBOT',
      });

      await advancePollCycles(1);
      expect((await promise).outcome).toBe('newton-marketing-web');
      expect(mockRunCodex).not.toHaveBeenCalled();
    },
  );

  it('resolves marketing via the AI classifier for free-text replies', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'the webflow one' }]);
    mockRunCodex.mockResolvedValueOnce({
      ok: true,
      parsedJson: { intent: 'marketing', reasoning: 'webflow = marketing site' },
    });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(1);
    expect((await promise).outcome).toBe('newton-marketing-web');
  });

  it('on a two-repo host: the LLM prompt and both-guidance never mention marketing', async () => {
    const slack = makeSlack();
    mockFetchThread
      .mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'we need to touch several parts' }])
      .mockResolvedValueOnce([
        { ts: 'post.2', user: 'UADMIN', text: 'we need to touch several parts' },
        { ts: 'post.3', user: 'UADMIN', text: 'both' },
        { ts: 'post.4', user: 'UADMIN', text: 'web' },
      ]);
    mockRunCodex.mockResolvedValue({ ok: true, parsedJson: { intent: 'unclear' } });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
      allowedRepos: ['newton-web', 'newton-api'],
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-web');
    // The free-text reply went to the LLM — with a two-repo prompt.
    const llmPrompt = String(mockRunCodex.mock.calls[0][0]?.prompt ?? '');
    expect(llmPrompt).not.toContain('newton-marketing-web');
    expect(llmPrompt).toContain('one of five categories');
    // The both-guidance copy matches the host's repos.
    const guidance = slack.chat.postMessage.mock.calls
      .map((c: any[]) => String(c[0]?.text ?? ''))
      .find((t: string) => t.includes('one repo per run'));
    expect(guidance).toContain('*web* or *api*');
    expect(guidance).not.toContain('marketing');
  });

  it('rejects a repo outside allowedRepos with a one-time notice and keeps waiting', async () => {
    const slack = makeSlack();
    mockFetchThread.mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'marketing' }]).mockResolvedValueOnce([
      { ts: 'post.2', user: 'UADMIN', text: 'marketing' },
      { ts: 'post.3', user: 'UADMIN', text: 'web' },
    ]);

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
      allowedRepos: ['newton-web', 'newton-api'],
    });

    await advancePollCycles(2);
    expect((await promise).outcome).toBe('newton-web');
    const notices = slack.chat.postMessage.mock.calls.filter((c: any[]) =>
      String(c[0]?.text ?? '').includes("isn't configured on this host"),
    );
    expect(notices).toHaveLength(1);
  });

  it('classifies a free-text cross-repo reply as "both" via the AI classifier (#394)', async () => {
    const slack = makeSlack();
    mockFetchThread
      .mockResolvedValueOnce([{ ts: 'post.2', user: 'UADMIN', text: 'we need to touch frontend and backend' }])
      .mockResolvedValueOnce([
        { ts: 'post.2', user: 'UADMIN', text: 'we need to touch frontend and backend' },
        { ts: 'post.3', user: 'UADMIN', text: 'api' },
      ]);
    // Free text → classifier returns 'both' (re-seen each poll, so use a persistent mock).
    mockRunCodex.mockResolvedValue({ ok: true, parsedJson: { intent: 'both', reasoning: 'spans both repos' } });

    const promise = waitForRepoChoice({
      slack,
      channelId: 'C01',
      threadTs: '111.00',
      approverUserIds: ['UADMIN'],
      promptTs: 'post.1',
      logStep: () => {},
      botUserId: 'UBOT',
    });

    await advancePollCycles(2);
    // "api" on the second poll short-circuits via regex and resolves.
    expect((await promise).outcome).toBe('newton-api');
    const guidanceCalls = slack.chat.postMessage.mock.calls.filter((c: any[]) =>
      String(c[0]?.text ?? '').includes('one repo per run'),
    );
    expect(guidanceCalls).toHaveLength(1);
  });
});
