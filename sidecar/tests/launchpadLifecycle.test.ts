import { describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { finalizeLaunchpadWorkflowResult } from '../src/launchpad/launchpadLifecycle.js';
import { notifyDesktop } from '../src/notify/desktopNotifier.js';

vi.mock('../src/notify/desktopNotifier.js', () => ({
  notifyDesktop: vi.fn(),
}));

describe('launchpadLifecycle', () => {
  it('posts a fallback completion reply and emits a success notification for launchpad runs', async () => {
    const slack = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '222.33' }),
      },
    };

    const store = {
      markLaunchpadRequestRunning: vi.fn(),
      markLaunchpadRequestFinished: vi.fn(),
    };

    await finalizeLaunchpadWorkflowResult({
      event: {
        eventId: 'launchpad:req-1:111.22',
        channelId: 'D123',
        channelType: 'im',
        threadTs: '111.22',
        eventTs: '111.22',
        userId: 'UOWNER1',
        text: '<@UBOT1> Ship the feature',
        ingestSource: 'launchpad',
        launchpadRequestId: 'req-1',
        rawEvent: {},
      },
      result: {
        workflow: 'OWNER_AUTOPILOT',
        status: 'SUCCESS',
        message: 'Feature shipped.',
        notifyDesktop: false,
        slackPosted: false,
        result: {
          status: 'success',
        },
      },
      slack: slack as unknown as WebClient,
      store,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'D123',
      thread_ts: '111.22',
      text: 'Feature shipped.',
    });
    expect(store.markLaunchpadRequestFinished).toHaveBeenCalledWith({
      id: 'req-1',
      status: 'SUCCESS',
      result: {
        status: 'success',
      },
      errorMessage: undefined,
    });
    expect(vi.mocked(notifyDesktop)).toHaveBeenCalledWith('Watchtower miniOG complete', 'Feature shipped.', 'success');
  });
  it('posts no fallback for a stopped or skipped run in a Slack thread, but still tells the DM', async () => {
    for (const [status, originThread] of [
      ['CANCELLED', true],
      ['SKIPPED', true],
      ['SKIPPED', false],
    ] as const) {
      const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };
      const store = { markLaunchpadRequestRunning: vi.fn(), markLaunchpadRequestFinished: vi.fn() };
      await finalizeLaunchpadWorkflowResult({
        event: {
          eventId: 'launchpad:req-2:1.5',
          channelId: 'C123',
          channelType: 'channel',
          threadTs: '1.0',
          eventTs: '1.5',
          userId: 'UOWNER1',
          text: '<@UBOT1> check it',
          ingestSource: 'launchpad',
          launchpadRequestId: 'req-2',
          rawEvent: { originThread },
        },
        result: {
          workflow: 'OWNER_AUTOPILOT',
          status,
          message: status === 'SKIPPED' ? 'Staying silent.' : 'Cancelled before it finished.',
          notifyDesktop: false,
          slackPosted: false,
        },
        slack: slack as unknown as WebClient,
        store,
      });
      expect(slack.chat.postMessage).toHaveBeenCalledTimes(originThread ? 0 : 1);
      expect(store.markLaunchpadRequestFinished).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'req-2', status: status === 'CANCELLED' ? 'FAILED' : 'SKIPPED' }),
      );
    }
  });
});
