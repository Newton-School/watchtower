import type { WebClient } from '@slack/web-api';
import { logger } from '../logging/logger.js';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import type { JobStore } from '../state/jobStore.js';
import type { AppConfig, LaunchpadRequestRecord, SlackEventEnvelope } from '../types/contracts.js';

const LAUNCHPAD_POLL_INTERVAL_MS = 5_000;

export function buildLaunchpadEnvelope(params: {
  config: AppConfig;
  request: {
    id: string;
    ownerUserId: string;
    prompt: string;
    requestedForUserId?: string;
    answerForJobId?: string;
  };
  channelId: string;
  anchorTs: string;
  /** The message the run starts from, when not the thread's first message. */
  eventTs?: string;
  /** Anchored in the Slack thread the request names, not the owner's DM. */
  originThread?: boolean;
}): SlackEventEnvelope {
  const { config, request, channelId, anchorTs } = params;
  const eventTs = params.eventTs ?? anchorTs;

  return {
    eventId: `launchpad:${request.id}:${eventTs}`,
    channelId,
    // Origin-thread anchors (issue #343) land in real channels; the legacy
    // anchor is always the owner DM.
    channelType: channelId.startsWith('D') ? 'im' : 'channel',
    threadTs: anchorTs,
    eventTs,
    // Permissions evaluate the owner who queued the retrigger; the real
    // requester travels separately for attribution + dossier recall.
    userId: request.ownerUserId,
    requestedForUserId: request.requestedForUserId,
    answersJobId: request.answerForJobId,
    text: `<@${config.botUserId}> ${request.prompt}`.trim(),
    ingestSource: 'launchpad',
    launchpadRequestId: request.id,
    rawEvent: {
      type: 'launchpad_request',
      originThread: params.originThread ?? false,
      requestId: request.id,
      ownerUserId: request.ownerUserId,
      requestedForUserId: request.requestedForUserId,
      answersJobId: request.answerForJobId,
      prompt: request.prompt,
      anchorTs,
      eventTs,
    },
  };
}

/**
 * Deletes the ask the app posted for a request that won't run, so it doesn't
 * wait in the thread for an answer that never comes. A silent run's
 * timestamp names no message, and the bot can only delete its own messages,
 * so anything else fails harmlessly. True when an ask was taken back.
 */
export async function takeBackPostedAsk(
  webClient: WebClient,
  request: { originChannelId?: string; originEventTs?: string },
): Promise<boolean> {
  if (!request.originChannelId || !request.originEventTs) return false;
  try {
    await webClient.chat.delete({ channel: request.originChannelId, ts: request.originEventTs });
    return true;
  } catch {
    return false;
  }
}

function isMissingConversationWriteScope(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const data = (
    error as {
      data?: {
        error?: unknown;
        needed?: unknown;
        acceptedScopes?: unknown;
        response_metadata?: { acceptedScopes?: unknown };
      };
    }
  ).data;
  if (!data || data.error !== 'missing_scope') {
    return false;
  }

  const acceptedScopes = [
    ...(Array.isArray(data.acceptedScopes)
      ? data.acceptedScopes.filter((value): value is string => typeof value === 'string')
      : []),
    ...(Array.isArray(data.response_metadata?.acceptedScopes)
      ? data.response_metadata.acceptedScopes.filter((value): value is string => typeof value === 'string')
      : []),
  ];
  const needed = typeof data.needed === 'string' ? data.needed : '';
  return (
    acceptedScopes.some(scope => scope === 'im:write' || scope === 'mpim:write') ||
    needed.includes('im:write') ||
    needed.includes('mpim:write')
  );
}

async function postLaunchpadAnchor(params: {
  webClient: WebClient;
  request: {
    id: string;
    ownerUserId: string;
    prompt: string;
  };
}): Promise<{ anchorTs: string; channelId: string }> {
  const { webClient, request } = params;

  try {
    const dm = await webClient.conversations.open({
      users: request.ownerUserId,
    });
    const channelId = String(dm.channel?.id ?? '');
    if (!channelId) {
      throw new Error('launchpad DM open did not return a channel id');
    }

    const anchor = await webClient.chat.postMessage({
      channel: channelId,
      text: request.prompt,
    });
    const anchorTs = String(anchor.ts ?? '');
    if (!anchorTs) {
      throw new Error('launchpad anchor post did not return a timestamp');
    }

    return { channelId, anchorTs };
  } catch (error) {
    if (!isMissingConversationWriteScope(error)) {
      throw error;
    }

    logger.warn(
      {
        requestId: request.id,
        ownerUserId: request.ownerUserId,
      },
      'launchpad DM open missing write scope; falling back to direct user-id post',
    );

    const anchor = await webClient.chat.postMessage({
      channel: request.ownerUserId,
      text: request.prompt,
    });
    const channelId = String(anchor.channel ?? '');
    const anchorTs = String(anchor.ts ?? '');
    if (!channelId || !anchorTs) {
      throw new Error('launchpad fallback post did not return channel/timestamp');
    }

    return { channelId, anchorTs };
  }
}

export interface LaunchpadIntake {
  webClient: WebClient;
  config: AppConfig;
  store: JobStore;
  enqueue: (event: SlackEventEnvelope, client: WebClient, source: 'launchpad') => Promise<void>;
}

export async function runLaunchpadRequestPoller(params: LaunchpadIntake): Promise<void> {
  const requests = params.store.claimPendingLaunchpadRequests();

  if (requests.length === 0) {
    return;
  }

  logger.info({ count: requests.length }, 'processing pending launchpad requests');

  for (const request of requests) {
    await startLaunchpadRequest(params, request);
  }
}

/** Turns a claimed request into a mention of miniOG and queues it. */
export async function startLaunchpadRequest(params: LaunchpadIntake, request: LaunchpadRequestRecord): Promise<void> {
  const { webClient, config, store, enqueue } = params;
  try {
    // Origin-thread anchoring (issue #343): when the request names the
    // thread it came from, run there — progress, approvals, and the PR
    // link land where the original requester is, and no DM anchor is
    // posted. Falls back to the legacy owner-DM anchor otherwise.
    const inThread = Boolean(request.originChannelId && request.originThreadTs);
    const { channelId, anchorTs } =
      request.originChannelId && request.originThreadTs
        ? { channelId: request.originChannelId, anchorTs: request.originThreadTs }
        : await postLaunchpadAnchor({
            webClient,
            request,
          });

    store.markLaunchpadRequestQueued({
      id: request.id,
      slackChannelId: channelId,
      anchorTs,
    });

    const event = buildLaunchpadEnvelope({
      config,
      request,
      channelId,
      anchorTs,
      // A run started from the app's thread view starts from its posted ask,
      // or, when silent, from a timestamp of its own.
      eventTs: inThread ? request.originEventTs : undefined,
      originThread: inThread,
    });

    await enqueue(event, webClient, 'launchpad');

    logger.info(
      {
        requestId: request.id,
        channelId,
        anchorTs,
      },
      'launchpad request converted into synthetic slack event',
    );
  } catch (error) {
    await takeBackPostedAsk(webClient, request);
    const errorMessage = `Launchpad request failed before execution: ${String(error)}`;
    store.markLaunchpadRequestFinished({
      id: request.id,
      status: 'FAILED',
      errorMessage,
    });

    logger.error(
      {
        requestId: request.id,
        error: String(error),
      },
      'launchpad request intake failed',
    );

    notifyDesktop('Watchtower miniOG launch failed', errorMessage);
  }
}

export function startLaunchpadRequestPoller(params: LaunchpadIntake & { pollIntervalMs?: number }): void {
  const poll = async (): Promise<void> => {
    try {
      await runLaunchpadRequestPoller(params);
    } catch (error) {
      logger.error({ error: String(error) }, 'launchpad request poller tick failed');
    }
  };

  void poll();
  setInterval(() => {
    void poll();
  }, params.pollIntervalMs ?? LAUNCHPAD_POLL_INTERVAL_MS);
}
