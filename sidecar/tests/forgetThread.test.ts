import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { normalizeTask, parseMiniogSubcommand } from '../src/router/intentParser.js';
import { runMiniogDossierWorkflow } from '../src/workflows/miniogDossierWorkflow.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask, SlackEventEnvelope } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-forget-thread-')), 'watchtower.db');
}

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT1',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: ['C01H25RNLJH', 'C02BUGS'],
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

describe('parseMiniogSubcommand — forget thread', () => {
  it('parses "forget thread" without confirmation', () => {
    expect(parseMiniogSubcommand('forget thread')).toEqual({ kind: 'forget-thread', confirmed: false });
  });

  it('parses "forget thread confirm" as confirmed', () => {
    expect(parseMiniogSubcommand('forget thread confirm')).toEqual({ kind: 'forget-thread', confirmed: true });
  });

  it('parses the "forget this thread" variant with and without confirm', () => {
    expect(parseMiniogSubcommand('forget this thread')).toEqual({ kind: 'forget-thread', confirmed: false });
    expect(parseMiniogSubcommand('forget this thread confirm')).toEqual({ kind: 'forget-thread', confirmed: true });
  });

  it('tolerates a leading bot mention and mixed case', () => {
    expect(parseMiniogSubcommand('<@U123> forget thread')).toEqual({ kind: 'forget-thread', confirmed: false });
    expect(parseMiniogSubcommand('<@U123> Forget This Thread CONFIRM')).toEqual({
      kind: 'forget-thread',
      confirmed: true,
    });
  });

  it('does not parse "forget threads" (not a thread command, not a dossier field)', () => {
    expect(parseMiniogSubcommand('forget threads')).toBeNull();
  });

  it('normalizeTask routes a bot-mention "forget thread" to MINIOG_DOSSIER', () => {
    const event: SlackEventEnvelope = {
      eventId: 'Ev-forget-1',
      channelId: 'C01H25RNLJH',
      threadTs: '1755600000.000100',
      eventTs: '1755600100.000200',
      userId: 'URANDOM',
      text: '<@UBOT1> forget thread',
      rawEvent: {},
    };
    const task = normalizeTask(event, config, []);
    expect(task.mentionDetected).toBe(true);
    expect(task.intent).toBe('MINIOG_DOSSIER');
    expect(task.miniogSubcommand).toEqual({ kind: 'forget-thread', confirmed: false });
  });
});

describe('runMiniogDossierWorkflow — forget-thread handler', () => {
  const nowEpochSec = Math.floor(Date.now() / 1000);
  const CHANNEL = 'C-FORGET';
  const THREAD_TS = `${nowEpochSec - 1800}.000100`;
  const PARTICIPANT = 'UPART1';

  let dbPath: string;
  let store: JobStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = new JobStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  function makeSlackStub(): { slack: WebClient; postMessage: ReturnType<typeof vi.fn> } {
    const postMessage = vi.fn(async () => ({ ok: true }));
    const slack = { chat: { postMessage } } as unknown as WebClient;
    return { slack, postMessage };
  }

  function makeTask(opts: {
    userId: string;
    confirmed: boolean;
    isOwnerAuthor?: boolean;
    isCoreDevAuthor?: boolean;
  }): NormalizedTask {
    return {
      event: {
        eventId: 'Ev-forget-wf',
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        eventTs: `${nowEpochSec}.000900`,
        userId: opts.userId,
        text: opts.confirmed ? '<@UBOT1> forget thread confirm' : '<@UBOT1> forget thread',
        rawEvent: {},
      },
      mentionDetected: true,
      mentionType: 'bot',
      isOwnerAuthor: opts.isOwnerAuthor ?? false,
      isCoreDevAuthor: opts.isCoreDevAuthor ?? false,
      intent: 'MINIOG_DOSSIER',
      miniogSubcommand: { kind: 'forget-thread', confirmed: opts.confirmed },
    };
  }

  function seedThread(userIds: string[] = [PARTICIPANT, 'UOTHER', 'UOTHER']): number {
    const conversations = store.conversationStore();
    const result = conversations.recordMessages({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      channelType: 'channel',
      messages: userIds.map((userId, i) => ({
        messageTs: `${nowEpochSec - 1800 + i * 60}.00010${i}`,
        userId,
        isBot: false,
        text: `message ${i} from ${userId}`,
      })),
    });
    if ('skipped' in result) throw new Error('seed unexpectedly skipped');
    return result.threadId;
  }

  function postedText(postMessage: ReturnType<typeof vi.fn>): string {
    const call = postMessage.mock.calls[0] as unknown[];
    return (call[0] as { text: string }).text;
  }

  it('replies "not tracked" and SKIPs when the thread is not in the conversation store', async () => {
    const { slack, postMessage } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: PARTICIPANT, confirmed: true }),
      slack,
      store,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toBe('Forget-thread: thread not tracked.');
    expect(result.slackPosted).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    expect(postedText(postMessage)).toContain('nothing to forget');
  });

  it('prompts a participant for confirmation (with message count) and leaves the thread intact', async () => {
    seedThread();
    const { slack, postMessage } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: PARTICIPANT, confirmed: false }),
      slack,
      store,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toBe('Forget-thread requested without confirmation.');
    expect(postedText(postMessage)).toContain('3 message(s)');
    expect(postedText(postMessage)).toContain('forget thread confirm');

    const conversations = store.conversationStore();
    expect(conversations.isTracked(CHANNEL, THREAD_TS)).toBe(true);
    expect(conversations.getThread(CHANNEL, THREAD_TS)?.status).toBe('active');
    expect(conversations.getThread(CHANNEL, THREAD_TS)?.messageCount).toBe(3);
  });

  it('tombstones the thread for a confirmed participant and reports the deleted count', async () => {
    const threadId = seedThread();
    const { slack, postMessage } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: PARTICIPANT, confirmed: true }),
      slack,
      store,
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.message).toBe('Thread forgotten.');
    expect(postedText(postMessage)).toContain('3 message(s) deleted');

    const conversations = store.conversationStore();
    const thread = conversations.getThread(CHANNEL, THREAD_TS);
    expect(thread?.status).toBe('forgotten');
    expect(thread?.messageCount).toBe(0);
    expect(conversations.isTracked(CHANNEL, THREAD_TS)).toBe(false);
    expect(conversations.getMessages(threadId)).toHaveLength(0);

    // The tombstone blocks re-capture forever.
    const recapture = conversations.recordMessages({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      channelType: 'channel',
      messages: [{ messageTs: `${nowEpochSec}.000500`, userId: PARTICIPANT, isBot: false, text: 'back again' }],
    });
    expect(recapture).toEqual({ skipped: 'forgotten' });

    // A second forget attempt now lands on the "not tracked" branch.
    const { slack: slack2 } = makeSlackStub();
    const again = await runMiniogDossierWorkflow({
      task: makeTask({ userId: PARTICIPANT, confirmed: true }),
      slack: slack2,
      store,
    });
    expect(again.status).toBe('SKIPPED');
    expect(again.message).toBe('Forget-thread: thread not tracked.');
  });

  it('denies a non-participant non-admin even with confirm', async () => {
    seedThread();
    const { slack, postMessage } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: 'USTRANGER', confirmed: true }),
      slack,
      store,
    });

    expect(result.status).toBe('SKIPPED');
    expect(result.message).toBe('Forget-thread denied: not a participant or admin.');
    expect(postedText(postMessage)).toContain('Only people who took part');

    const conversations = store.conversationStore();
    expect(conversations.isTracked(CHANNEL, THREAD_TS)).toBe(true);
    expect(conversations.getThread(CHANNEL, THREAD_TS)?.messageCount).toBe(3);
  });

  it('lets the owner forget a thread they never took part in', async () => {
    seedThread();
    const { slack, postMessage } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: 'UOWNER1', confirmed: true, isOwnerAuthor: true, isCoreDevAuthor: true }),
      slack,
      store,
    });

    expect(result.status).toBe('SUCCESS');
    expect(postedText(postMessage)).toContain('3 message(s) deleted');
    expect(store.conversationStore().getThread(CHANNEL, THREAD_TS)?.status).toBe('forgotten');
  });

  it('lets a core-dev admin (non-owner, non-participant) forget the thread', async () => {
    seedThread();
    const { slack } = makeSlackStub();
    const result = await runMiniogDossierWorkflow({
      task: makeTask({ userId: 'UCOREDEV9', confirmed: true, isCoreDevAuthor: true }),
      slack,
      store,
    });

    expect(result.status).toBe('SUCCESS');
    expect(store.conversationStore().isTracked(CHANNEL, THREAD_TS)).toBe(false);
  });
});
