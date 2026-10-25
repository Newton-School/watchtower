/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runUnknownTaskWorkflow } from '../src/workflows/unknownTaskWorkflow.js';
import { runCodex } from '../src/codex/runCodex.js';
import { fetchThreadContext } from '../src/slack/threadContext.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn().mockReturnValue('codex'),
}));

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn(),
  assertThreadParentExists: vi.fn().mockResolvedValue(true),
}));

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: '/Users/dipesh/code/newton-web',
    newtonApi: '/Users/dipesh/code/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

function makeTask(input: { userId: string; text: string; eventId: string }): NormalizedTask {
  return {
    event: {
      eventId: input.eventId,
      channelId: 'C1',
      threadTs: '111.22',
      eventTs: '111.22',
      userId: input.userId,
      text: input.text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'UNKNOWN',
  };
}

describe('unknownTaskWorkflow', () => {
  beforeEach(() => {
    vi.mocked(runCodex).mockReset();
    vi.mocked(fetchThreadContext).mockReset();
  });

  it('classifies direct chatter and posts a plain reply', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([
      { text: 'at least he is better than me right?', user: 'U2', ts: '111.20' },
    ]);

    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        reply: 'noted.',
        reaction: 'eyes',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const result = await runUnknownTaskWorkflow({
      task: makeTask({
        userId: 'U777',
        eventId: 'EvUnknownSocial',
        text: '<@UBOT1> at least he is better than me, right?',
      }),
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.slackPosted).toBe(true);
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.2-codex',
        prompt: expect.stringContaining('Context track: direct_reply'),
        reasoningEffort: 'low',
        // A one-line reply needs no tools, so nothing runs bypassed (#695).
        noTools: true,
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('<@U777>'),
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringMatching(/\b(pr|bug|ci)\b/i),
      }),
    );
    expect(slack.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'eyes',
      }),
    );
  });

  it('posts every sentence of a multi-sentence reply', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([]);
    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: { reply: 'Yes. The deploy runs after the build passes.', reaction: 'eyes' },
    });
    const slack = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }) },
      reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
    };

    await runUnknownTaskWorkflow({
      task: makeTask({
        userId: 'U780',
        eventId: 'EvUnknownMulti',
        text: '<@UBOT1> does the deploy wait for the build?',
      }),
      config,
      slack: slack as any,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '<@U780> Yes. The deploy runs after the build passes.' }),
    );
  });

  it('strips joke clauses and keeps neutral reactions in replies', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([
      {
        text: 'Please review and merge https://github.com/Newton-School/newton-web/pull/7724',
        user: 'U2',
        ts: '111.20',
      },
    ]);

    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        reply:
          'Which proof are we greenlighting here: that 10 is solitary, or did this thread acquire another surprise deliverable?',
        reaction: 'skull',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const result = await runUnknownTaskWorkflow({
      task: {
        ...makeTask({
          userId: 'U779',
          eventId: 'EvUnknownSerious',
          text: '<@UBOT1> provide proof',
        }),
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/7724',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 7724,
        },
      },
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.2-codex',
        prompt: expect.stringContaining('No jokes, sarcasm, banter, or themed tone.'),
        reasoningEffort: 'low',
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '<@U779> Which proof are we greenlighting here: that 10 is solitary?',
      }),
    );
    expect(slack.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'eyes',
      }),
    );
  });

  it('classifies technical ambiguity and asks for one clear outcome without PR/bug/CI triad wording', async () => {
    vi.mocked(fetchThreadContext).mockResolvedValue([
      { text: 'deployment has been noisy since morning', user: 'U2', ts: '111.21' },
    ]);

    vi.mocked(runCodex).mockResolvedValue({
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      lastMessage: '',
      parsedJson: {
        reply: 'share the exact outcome you want and i will run with it.',
        reaction: 'memo',
      },
    });

    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const result = await runUnknownTaskWorkflow({
      task: makeTask({
        userId: 'U778',
        eventId: 'EvUnknownTask',
        text: '<@UBOT1> can you check why deploy keeps failing?',
      }),
      config,
      slack: slack as any,
    });

    expect(result.status).toBe('SKIPPED');
    expect(runCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.2-codex',
        prompt: expect.stringContaining('Context track: task_clarifier'),
        reasoningEffort: 'low',
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('exact outcome'),
      }),
    );
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.not.stringMatching(/\b(pr|bug|ci)\b/i),
      }),
    );
    expect(slack.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'memo',
      }),
    );
  });
});
