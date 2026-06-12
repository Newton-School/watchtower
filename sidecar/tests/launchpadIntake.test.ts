/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { runLaunchpadRequestPoller } from '../src/launchpad/launchpadIntake.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, SlackEventEnvelope } from '../src/types/contracts.js';

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

const repoRoot = path.resolve(process.cwd(), '..');

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
  allowedChannelsForBugFix: ['C01H25RNLJH'],
  repoPaths: {
    newtonWeb: repoRoot,
    newtonApi: repoRoot,
  },
  unknownTaskPolicy: 'desktop_only',
  uncertainRepoPolicy: 'desktop_only',
  unmappedPrRepoPolicy: 'desktop_only',
  maxConcurrentJobs: 2,
  repoClassifierThreshold: 0.75,
  allowedPrOrg: 'Newton-School',
  multiAgentEnabled: false,
};

function createStore(): { dbPath: string; store: JobStore } {
  const dbPath = path.join(os.tmpdir(), `watchtower-launchpad-intake-${uuidv4()}.db`);
  return {
    dbPath,
    store: new JobStore(dbPath),
  };
}

describe('launchpadIntake', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('claims a pending request, creates a DM anchor, and enqueues a synthetic launchpad event', async () => {
    const { dbPath, store } = createStore();
    store.createLaunchpadRequest({
      id: 'req-1',
      target: 'miniog',
      prompt: 'Ship the feature',
      ownerUserId: 'UOWNER1',
    });

    const webClient = {
      conversations: {
        open: vi.fn().mockResolvedValue({
          ok: true,
          channel: {
            id: 'D123',
          },
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({
          ok: true,
          ts: '1711.42',
        }),
      },
    };

    const enqueue = vi
      .fn<(event: SlackEventEnvelope, client: typeof webClient, source: 'launchpad') => Promise<void>>()
      .mockResolvedValue(undefined);

    await runLaunchpadRequestPoller({
      webClient: webClient as any,
      config,
      store,
      enqueue,
    });

    const request = store.getLaunchpadRequest('req-1');
    expect(request?.status).toBe('QUEUED');
    expect(request?.slackChannelId).toBe('D123');
    expect(request?.anchorTs).toBe('1711.42');
    expect(webClient.conversations.open).toHaveBeenCalledWith({
      users: 'UOWNER1',
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D123',
      text: 'Ship the feature',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'D123',
        channelType: 'im',
        threadTs: '1711.42',
        eventTs: '1711.42',
        userId: 'UOWNER1',
        text: '<@UBOT1> Ship the feature',
        ingestSource: 'launchpad',
        launchpadRequestId: 'req-1',
      }),
      webClient,
      'launchpad',
    );

    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('falls back to direct user-id post when conversations.open is missing write scope', async () => {
    const { dbPath, store } = createStore();
    store.createLaunchpadRequest({
      id: 'req-2',
      target: 'miniog',
      prompt: 'Fix the launchpad',
      ownerUserId: 'UOWNER1',
    });

    const webClient = {
      conversations: {
        open: vi.fn().mockRejectedValue({
          data: {
            error: 'missing_scope',
            needed: 'channels:write,groups:write,mpim:write,im:write',
            response_metadata: {
              acceptedScopes: ['channels:write', 'groups:write', 'mpim:write', 'im:write'],
            },
          },
        }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({
          ok: true,
          channel: 'D555',
          ts: '1888.91',
        }),
      },
    };

    const enqueue = vi
      .fn<(event: SlackEventEnvelope, client: typeof webClient, source: 'launchpad') => Promise<void>>()
      .mockResolvedValue(undefined);

    await runLaunchpadRequestPoller({
      webClient: webClient as any,
      config,
      store,
      enqueue,
    });

    const request = store.getLaunchpadRequest('req-2');
    expect(request?.status).toBe('QUEUED');
    expect(request?.slackChannelId).toBe('D555');
    expect(request?.anchorTs).toBe('1888.91');
    expect(webClient.conversations.open).toHaveBeenCalledWith({
      users: 'UOWNER1',
    });
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'UOWNER1',
      text: 'Fix the launchpad',
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'D555',
        threadTs: '1888.91',
        launchpadRequestId: 'req-2',
      }),
      webClient,
      'launchpad',
    );

    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('anchors at the origin thread with on-behalf-of attribution when origin fields are set (issue #343)', async () => {
    const { dbPath, store } = createStore();
    store.createLaunchpadRequest({
      id: 'req-origin',
      target: 'miniog',
      prompt: 'Make the due date mandatory',
      ownerUserId: 'UOWNER1',
      requestedForUserId: 'U_ARSHIYA',
      originChannelId: 'C0AQMNHHUE9',
      originThreadTs: '1781276720.916409',
    });

    const webClient = {
      conversations: { open: vi.fn() },
      chat: { postMessage: vi.fn() },
    };
    const enqueue = vi
      .fn<(event: SlackEventEnvelope, client: typeof webClient, source: 'launchpad') => Promise<void>>()
      .mockResolvedValue(undefined);

    await runLaunchpadRequestPoller({
      webClient: webClient as any,
      config,
      store,
      enqueue,
    });

    // No DM anchor: the origin thread IS the anchor.
    expect(webClient.conversations.open).not.toHaveBeenCalled();
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();

    const request = store.getLaunchpadRequest('req-origin');
    expect(request?.status).toBe('QUEUED');
    expect(request?.slackChannelId).toBe('C0AQMNHHUE9');
    expect(request?.anchorTs).toBe('1781276720.916409');

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'C0AQMNHHUE9',
        channelType: 'channel',
        threadTs: '1781276720.916409',
        eventTs: '1781276720.916409',
        // Permissions stay with the owner; attribution carries the requester.
        userId: 'UOWNER1',
        requestedForUserId: 'U_ARSHIYA',
        ingestSource: 'launchpad',
        launchpadRequestId: 'req-origin',
      }),
      webClient,
      'launchpad',
    );

    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('round-trips the new launchpad columns through create + claim', async () => {
    const { dbPath, store } = createStore();
    store.createLaunchpadRequest({
      id: 'req-cols',
      target: 'miniog',
      prompt: 'p',
      ownerUserId: 'UOWNER1',
      requestedForUserId: 'U_REQ',
      originChannelId: 'C_ORIG',
      originThreadTs: '1.2',
    });

    const claimed = store.claimPendingLaunchpadRequests();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: 'req-cols',
      requestedForUserId: 'U_REQ',
      originChannelId: 'C_ORIG',
      originThreadTs: '1.2',
    });

    store.close();
    fs.rmSync(dbPath, { force: true });
  });
});
