import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { JobStore } from '../src/state/jobStore.js';
import {
  __resetThreadCaptureCachesForTests,
  captureLiveMessage,
  captureThreadFromMessages,
  shouldCapture,
} from '../src/conversation/threadCapture.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';
import type { ThreadMessage } from '../src/slack/threadContext.js';

const config: AppConfig = {
  platformPolicy: 'macos_only',
  bundleTargets: ['app', 'dmg'],
  ownerSlackUserIds: ['UOWNER1'],
  coreDevSlackUserIds: ['UOWNER1'],
  coreDevSlackUserGroup: '',
  botUserId: 'UBOT',
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  bugsAndUpdatesChannelId: 'C01H25RNLJH',
  allowedChannelsForBugFix: [],
  repoPaths: {
    newtonWeb: '/tmp/newton-web',
    newtonApi: '/tmp/newton-api',
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
  agentBackend: 'codex',
  prReviewTimeoutMs: 60_000,
  bugFixTimeoutMs: 60_000,
  pmTaskTimeoutMs: 60_000,
  metabaseMcpUrl: '',
};

// Recent epochs so recency/idle logic comparing against real now stays sane.
const baseEpoch = Math.floor(Date.now() / 1000) - 3600;

function ts(offsetSeconds: number): string {
  return `${baseEpoch + offsetSeconds}.000100`;
}

function msg(partial: Partial<ThreadMessage> & { ts: string }): ThreadMessage {
  return { text: 'hello world', user: 'UHUMAN', ...partial };
}

interface StubClient {
  client: WebClient;
  conversationsInfo: ReturnType<typeof vi.fn>;
  usersInfo: ReturnType<typeof vi.fn>;
}

function makeClient(): StubClient {
  const conversationsInfo = vi.fn().mockResolvedValue({ channel: { name: 'general', is_private: false } });
  const usersInfo = vi.fn().mockResolvedValue({ user: { name: 'someone' } });
  const client = { conversations: { info: conversationsInfo }, users: { info: usersInfo } } as unknown as WebClient;
  return { client, conversationsInfo, usersInfo };
}

function makeEvent(partial: Partial<SlackEventEnvelope>): SlackEventEnvelope {
  return {
    eventId: 'Ev-live',
    channelId: 'C123',
    channelType: 'channel',
    threadTs: ts(0),
    eventTs: ts(300),
    userId: 'UHUMAN',
    text: 'a live reply',
    rawEvent: {},
    ...partial,
  };
}

let dbDir: string;
let store: JobStore;

beforeEach(() => {
  __resetThreadCaptureCachesForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-threadcap-'));
  store = new JobStore(path.join(dbDir, 'watchtower.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('shouldCapture', () => {
  it('skips IMs, MPIMs, and D-prefixed channels', () => {
    expect(shouldCapture('im', 'D123')).toBe('skip');
    expect(shouldCapture('im', 'C123')).toBe('skip');
    expect(shouldCapture('mpim', 'C123')).toBe('skip');
    expect(shouldCapture(undefined, 'D123')).toBe('skip');
  });

  it('marks group channels and G-prefixed ids private', () => {
    expect(shouldCapture('group', 'C123')).toBe('private');
    expect(shouldCapture('group', 'G123')).toBe('private');
    expect(shouldCapture(undefined, 'G123')).toBe('private');
  });

  it('defaults C-prefixed channels to org', () => {
    expect(shouldCapture('channel', 'C123')).toBe('org');
    expect(shouldCapture(undefined, 'C123')).toBe('org');
  });
});

describe('captureThreadFromMessages', () => {
  it('captures a public thread with messages and files metadata', async () => {
    const { client, usersInfo } = makeClient();
    usersInfo.mockResolvedValue({ user: { profile: { display_name: 'Dipesh' } } });

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C123',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [
        msg({ ts: ts(0), text: 'kicking off the thread' }),
        msg({
          ts: ts(60),
          text: 'here is the screenshot',
          files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', url_private_download: 'https://x/f1' }],
        }),
      ],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    expect(result.inserted).toBe(2);

    const thread = store.conversationStore().getThread('C123', ts(0));
    expect(thread).toBeDefined();
    expect(thread?.visibility).toBe('org');
    expect(thread?.channelName).toBe('general');
    expect(thread?.messageCount).toBe(2);

    const rows = store.conversationStore().getMessages(result.threadId);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('kicking off the thread');
    expect(rows[0].displayName).toBe('Dipesh');
    expect(rows[1].files).toEqual([{ id: 'F1', name: 'shot.png', mimetype: 'image/png' }]);
  });

  it('marks the thread private when conversations.info says is_private', async () => {
    const { client, conversationsInfo } = makeClient();
    conversationsInfo.mockResolvedValue({ channel: { name: 'secret-ops', is_private: true } });

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C777',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [msg({ ts: ts(0) })],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    const thread = store.conversationStore().getThread('C777', ts(0));
    expect(thread?.visibility).toBe('private');
    expect(thread?.channelType).toBe('group');
  });

  it('returns null and captures nothing when conversations.info says is_im', async () => {
    const { client, conversationsInfo } = makeClient();
    conversationsInfo.mockResolvedValue({ channel: { is_im: true } });

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C888',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [msg({ ts: ts(0) })],
    });

    expect(result).toBeNull();
    expect(store.conversationStore().getThread('C888', ts(0))).toBeUndefined();
    expect(store.conversationStore().isTracked('C888', ts(0))).toBe(false);
  });

  it('fails closed to private visibility (but still captures) when conversations.info fails', async () => {
    const { client, conversationsInfo } = makeClient();
    conversationsInfo.mockRejectedValue(new Error('channel_not_found'));

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C999',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [msg({ ts: ts(0) })],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    expect(result.inserted).toBe(1);
    const thread = store.conversationStore().getThread('C999', ts(0));
    // Unverified channel privacy must never default to org-wide exposure.
    expect(thread?.visibility).toBe('private');
    expect(thread?.channelName).toBeUndefined();

    // A later capture with a healthy conversations.info heals it to org.
    conversationsInfo.mockReset();
    conversationsInfo.mockResolvedValue({ channel: { name: 'general', is_private: false } });
    __resetThreadCaptureCachesForTests();
    await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C999',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [msg({ ts: ts(0) })],
    });
    const healed = store.conversationStore().getThread('C999', ts(0));
    expect(healed?.visibility).toBe('org');
    expect(healed?.channelName).toBe('general');
  });

  it('detects bots via botUserId, bot_message subtype, and botId — and never resolves them', async () => {
    const { client, usersInfo } = makeClient();
    usersInfo.mockResolvedValue({ user: { profile: { display_name: 'Human' } } });

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C123',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [
        msg({ ts: ts(0), user: 'UBOT', text: 'miniOG here' }),
        msg({ ts: ts(10), user: 'UAPP', subtype: 'bot_message', text: 'integration says hi' }),
        msg({ ts: ts(20), user: 'UINT', botId: 'B123', text: 'another integration' }),
        msg({ ts: ts(30), user: 'UHUMAN', text: 'actual human' }),
      ],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    const rows = store.conversationStore().getMessages(result.threadId);
    expect(rows.map(r => r.isBot)).toEqual([true, true, true, false]);
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith({ user: 'UHUMAN' });
  });

  it('filters out non-content subtypes like channel_join', async () => {
    const { client } = makeClient();

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C123',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [
        msg({ ts: ts(0), text: 'real content' }),
        msg({ ts: ts(5), subtype: 'channel_join', text: '<@U1> has joined the channel' }),
      ],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    expect(result.inserted).toBe(1);
    const rows = store.conversationStore().getMessages(result.threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('real content');
  });

  it('resolves names from user_dossiers first, users.info as fallback with a firstSeen piggyback', async () => {
    store.dossierStore().firstSeen({ userId: 'UKNOWN', displayName: 'Known One' });
    const { client, usersInfo } = makeClient();
    usersInfo.mockResolvedValue({ user: { profile: { display_name: 'Stranger Dan' }, real_name: 'Stranger Daniel' } });

    const result = await captureThreadFromMessages({
      client,
      store,
      config,
      channelId: 'C123',
      threadTs: ts(0),
      channelType: 'channel',
      messages: [msg({ ts: ts(0), user: 'UKNOWN' }), msg({ ts: ts(10), user: 'USTRANGER' })],
    });

    if (!result || 'skipped' in result) throw new Error('expected a capture result');
    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith({ user: 'USTRANGER' });

    const rows = store.conversationStore().getMessages(result.threadId);
    expect(rows[0].displayName).toBe('Known One');
    expect(rows[1].displayName).toBe('Stranger Dan');

    // users.info fallback piggybacks a dossier firstSeen for the stranger.
    const known = store.conversationStore().getKnownUserNames(['USTRANGER']);
    expect(known.get('USTRANGER')).toBe('Stranger Dan');
  });
});

describe('captureLiveMessage', () => {
  function trackThread(channelId: string, threadTs: string): number {
    const result = store.conversationStore().recordMessages({
      channelId,
      threadTs,
      channelType: 'channel',
      messages: [{ messageTs: threadTs, userId: 'UHUMAN', isBot: false, text: 'thread root' }],
    });
    if ('skipped' in result) throw new Error('seed thread was skipped');
    return result.threadId;
  }

  it('no-ops for untracked threads', () => {
    const captured = captureLiveMessage({ store, config, event: makeEvent({ channelId: 'CUNTRACKED' }) });
    expect(captured).toBe(false);
    expect(store.conversationStore().getThread('CUNTRACKED', ts(0))).toBeUndefined();
  });

  it('appends a live reply (with files metadata) to a tracked thread', () => {
    const threadId = trackThread('C123', ts(0));
    store.dossierStore().firstSeen({ userId: 'UHUMAN', displayName: 'Dipesh' });

    const captured = captureLiveMessage({
      store,
      config,
      event: makeEvent({
        eventTs: ts(300),
        text: 'fresh live reply',
        rawEvent: { files: [{ id: 'F9', name: 'log.txt', mimetype: 'text/plain', url_private: 'https://x/f9' }] },
      }),
    });

    expect(captured).toBe(true);
    const rows = store.conversationStore().getMessages(threadId);
    expect(rows).toHaveLength(2);
    expect(rows[1].text).toBe('fresh live reply');
    expect(rows[1].displayName).toBe('Dipesh');
    expect(rows[1].isBot).toBe(false);
    expect(rows[1].files).toEqual([{ id: 'F9', name: 'log.txt', mimetype: 'text/plain' }]);
  });

  it('captures miniOG’s own reply with isBot set', () => {
    const threadId = trackThread('C123', ts(0));

    const captured = captureLiveMessage({
      store,
      config,
      event: makeEvent({ eventTs: ts(600), userId: 'UBOT', text: 'on it — reviewing now' }),
    });

    expect(captured).toBe(true);
    const rows = store.conversationStore().getMessages(threadId);
    expect(rows[1].userId).toBe('UBOT');
    expect(rows[1].isBot).toBe(true);
  });

  it('applies message_changed edits from rawEvent.message', () => {
    const threadId = trackThread('C123', ts(0));
    captureLiveMessage({ store, config, event: makeEvent({ eventTs: ts(300), text: 'original text' }) });

    const captured = captureLiveMessage({
      store,
      config,
      event: makeEvent({
        messageSubtype: 'message_changed',
        eventTs: ts(310),
        text: '',
        rawEvent: { message: { ts: ts(300), text: 'edited text', thread_ts: ts(0) } },
      }),
    });

    expect(captured).toBe(true);
    const rows = store.conversationStore().getMessages(threadId);
    const edited = rows.find(r => r.messageTs === ts(300));
    expect(edited?.text).toBe('edited text');
    expect(edited?.edited).toBe(true);
  });

  it('removes the row on message_deleted', () => {
    const threadId = trackThread('C123', ts(0));
    captureLiveMessage({ store, config, event: makeEvent({ eventTs: ts(300), text: 'soon deleted' }) });
    expect(store.conversationStore().getMessages(threadId)).toHaveLength(2);

    const captured = captureLiveMessage({
      store,
      config,
      event: makeEvent({
        messageSubtype: 'message_deleted',
        eventTs: ts(310),
        deletedTs: ts(300),
        threadTs: ts(0),
        text: '',
      }),
    });

    expect(captured).toBe(true);
    const rows = store.conversationStore().getMessages(threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('thread root');
    expect(store.conversationStore().getThreadById(threadId)?.messageCount).toBe(1);
  });

  it('skips D-channel events entirely', () => {
    const captured = captureLiveMessage({
      store,
      config,
      event: makeEvent({ channelId: 'D999', channelType: 'im' }),
    });
    expect(captured).toBe(false);
    expect(store.conversationStore().getThread('D999', ts(0))).toBeUndefined();
  });
});
