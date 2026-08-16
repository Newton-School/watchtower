import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, SlackEventEnvelope, SlackReactionEvent } from '../types/contracts.js';
import { logger } from '../logging/logger.js';

type SlackEventHandler = (event: SlackEventEnvelope, client: WebClient) => Promise<void>;
type SlackReactionHandler = (event: SlackReactionEvent, client: WebClient) => Promise<void>;

/**
 * Translate a raw Slack `message` (or `app_mention`) event payload into the
 * sidecar's normalized envelope. Pulled out as a free function so unit tests
 * can exercise it without spinning up the Bolt App. Handles the
 * `message_deleted` subtype specially: the deletion notification's `ts` and
 * `user` describe the *deletion event* itself, while the deleted message
 * lives under `event.previous_message` — we want the latter for routing.
 */
export function normalizeMessageEnvelope(
  event: Record<string, unknown>,
  body: Record<string, unknown>,
): SlackEventEnvelope {
  const channelId = String(event.channel ?? '');
  const channelType = String(event.channel_type ?? '');
  const messageSubtype = event.subtype ? String(event.subtype) : undefined;

  const previousMessage =
    messageSubtype === 'message_deleted' && event.previous_message && typeof event.previous_message === 'object'
      ? (event.previous_message as Record<string, unknown>)
      : undefined;
  const deletedTs =
    messageSubtype === 'message_deleted'
      ? String(event.deleted_ts ?? previousMessage?.ts ?? '') || undefined
      : undefined;

  const eventTs = String(event.ts ?? body.event_ts ?? '');
  const threadTs = String(
    messageSubtype === 'message_deleted'
      ? (previousMessage?.thread_ts ?? previousMessage?.ts ?? deletedTs ?? eventTs)
      : (event.thread_ts ?? event.ts ?? ''),
  );
  const text = String(messageSubtype === 'message_deleted' ? (previousMessage?.text ?? '') : (event.text ?? ''));
  const userId = String(messageSubtype === 'message_deleted' ? (previousMessage?.user ?? '') : (event.user ?? ''));
  const eventId = String(body.event_id ?? `${channelId}:${eventTs}`);

  const envelope: SlackEventEnvelope = {
    eventId,
    channelId,
    channelType,
    threadTs,
    eventTs,
    userId,
    text,
    messageSubtype,
    rawEvent: event,
  };

  if (deletedTs) {
    envelope.deletedTs = deletedTs;
  }
  if (previousMessage) {
    envelope.previousMessage = {
      ts: String(previousMessage.ts ?? deletedTs ?? ''),
      userId: String(previousMessage.user ?? ''),
      threadTs: previousMessage.thread_ts ? String(previousMessage.thread_ts) : undefined,
      text: previousMessage.text ? String(previousMessage.text) : undefined,
    };
  }

  return envelope;
}

export class SocketSlackClient {
  private app: App;
  private readonly config: AppConfig;
  private readonly onEvent: SlackEventHandler;
  private readonly onReaction?: SlackReactionHandler;

  constructor(config: AppConfig, onEvent: SlackEventHandler, onReaction?: SlackReactionHandler) {
    this.config = config;
    this.onEvent = onEvent;
    this.onReaction = onReaction;
    this.app = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.app.event('app_mention', async ({ event, body, client }) => {
      const normalized = this.normalizeEnvelope(
        event as unknown as Record<string, unknown>,
        body as unknown as Record<string, unknown>,
      );
      logger.info(
        {
          component: 'slack',
          eventType: 'app_mention',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received app_mention event',
      );
      await this.onEvent(normalized, client);
    });

    this.app.event('message', async ({ event, body, client }) => {
      const normalized = this.normalizeEnvelope(
        event as unknown as Record<string, unknown>,
        body as unknown as Record<string, unknown>,
      );
      logger.info(
        {
          component: 'slack',
          eventType: 'message',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
          subtype: normalized.messageSubtype ?? null,
        },
        'received message event',
      );
      await this.onEvent(normalized, client);
    });

    this.app.event('reaction_added', async ({ event, body, client }) => {
      if (!this.onReaction) {
        return;
      }

      const normalized = this.normalizeReactionEnvelope(
        event as unknown as Record<string, unknown>,
        body as unknown as Record<string, unknown>,
      );

      logger.info(
        {
          component: 'slack',
          eventType: 'reaction_added',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
          reaction: normalized.reaction,
        },
        'received reaction_added event',
      );
      await this.onReaction(normalized, client);
    });

    this.app.command('/miniog', async ({ command, ack, client }) => {
      await ack();
      const normalized = this.normalizeCommandEnvelope(command as unknown as Record<string, unknown>);
      logger.info(
        {
          component: 'slack',
          eventType: 'command',
          command: '/miniog',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received /miniog command',
      );
      await this.onEvent(normalized, client);
    });

    this.app.command('/wt', async ({ command, ack, client }) => {
      await ack();
      // Preserve the `wt` namespace so devAssistParser.stripPrefix() (which
      // requires it) still routes prefix-dependent operator commands like
      // help / runs / trace / diagnose / cancel / policy to DEV_ASSIST.
      // Without this, those commands fell through to OWNER_AUTOPILOT.
      const normalized = this.normalizeCommandEnvelope(command as unknown as Record<string, unknown>, 'wt');
      logger.info(
        {
          component: 'slack',
          eventType: 'command',
          command: '/wt',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received /wt command',
      );
      await this.onEvent(normalized, client);
    });

    this.app.command('/watchtower', async ({ command, ack, client }) => {
      await ack();
      const normalized = this.normalizeCommandEnvelope(command as unknown as Record<string, unknown>, 'wt');
      logger.info(
        {
          component: 'slack',
          eventType: 'command',
          command: '/watchtower',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received /watchtower command',
      );
      await this.onEvent(normalized, client);
    });

    this.app.shortcut(/.*/, async ({ shortcut, ack, client }) => {
      await ack();
      const normalized = this.normalizeShortcutEnvelope(shortcut as unknown as Record<string, unknown>);
      if (!normalized) {
        logger.info(
          {
            component: 'slack',
            eventType: 'shortcut',
          },
          'received non-message shortcut; skipping enqueue',
        );
        return;
      }

      logger.info(
        {
          component: 'slack',
          eventType: 'shortcut',
          eventId: normalized.eventId,
          channelId: normalized.channelId,
          threadTs: normalized.threadTs,
        },
        'received message shortcut event',
      );
      await this.onEvent(normalized, client);
    });
  }

  private normalizeEnvelope(event: Record<string, unknown>, body: Record<string, unknown>): SlackEventEnvelope {
    return normalizeMessageEnvelope(event, body);
  }

  private normalizeCommandEnvelope(command: Record<string, unknown>, namespace?: string): SlackEventEnvelope {
    const channelId = String(command.channel_id ?? '');
    const channelType = inferChannelTypeFromChannelId(channelId);
    const eventTs = String(command.command_ts ?? `${Date.now() / 1000}`);
    const threadTs = String(command.thread_ts ?? eventTs);
    const rawText = String(command.text ?? '').trim();
    const userId = String(command.user_id ?? '');
    const eventId = `command:${channelId}:${threadTs}:${eventTs}`;
    const responseUrl = String(command.response_url ?? '');

    const namespacePart = namespace ? `${namespace} ` : '';
    return {
      eventId,
      channelId,
      channelType,
      responseUrl: responseUrl || undefined,
      threadTs,
      eventTs,
      userId,
      text: `<@${this.config.botUserId}> ${namespacePart}${rawText}`.trim(),
      rawEvent: command,
    };
  }

  private normalizeShortcutEnvelope(shortcut: Record<string, unknown>): SlackEventEnvelope | null {
    const shortcutType = String(shortcut.type ?? '');
    if (shortcutType !== 'message_action') {
      return null;
    }

    const channel = (shortcut.channel as Record<string, unknown> | undefined) ?? {};
    const message = (shortcut.message as Record<string, unknown> | undefined) ?? {};
    const user = (shortcut.user as Record<string, unknown> | undefined) ?? {};
    const channelId = String(channel.id ?? '');
    const channelType = inferChannelTypeFromChannelId(channelId);
    const messageTs = String(message.ts ?? '');
    const threadTs = String(message.thread_ts ?? messageTs);
    const eventTs = String(shortcut.action_ts ?? messageTs ?? `${Date.now() / 1000}`);
    const userId = String(user.id ?? '');
    const sourceText = String(message.text ?? '').trim();
    const eventId = `shortcut:${channelId}:${threadTs}:${eventTs}`;
    const responseUrl = String(shortcut.response_url ?? '');

    return {
      eventId,
      channelId,
      channelType,
      responseUrl: responseUrl || undefined,
      threadTs,
      eventTs,
      userId,
      text: `<@${this.config.botUserId}> ${sourceText}`.trim(),
      rawEvent: shortcut,
    };
  }

  private normalizeReactionEnvelope(event: Record<string, unknown>, body: Record<string, unknown>): SlackReactionEvent {
    const item = (event.item as Record<string, unknown> | undefined) ?? {};
    const channelId = String(item.channel ?? '');
    const threadTs = String(item.ts ?? '');
    const eventTs = String(event.event_ts ?? body.event_ts ?? '');
    const eventId = String(body.event_id ?? `${channelId}:${eventTs}:reaction`);
    const reaction = String(event.reaction ?? '');
    const userId = String(event.user ?? '');
    const itemUserId = event.item_user ? String(event.item_user) : undefined;

    return {
      eventId,
      channelId,
      threadTs,
      eventTs,
      userId,
      reaction,
      itemUserId,
      rawEvent: event,
    };
  }

  async start(): Promise<void> {
    logger.info({ component: 'slack' }, 'starting socket mode');
    await this.app.start();
    logger.info({ component: 'slack' }, 'socket mode started');
  }

  /**
   * Tear down and re-establish the Socket Mode connection. Used by the
   * zombie-socket watchdog: a stop() on an already-dead websocket can throw,
   * which must not prevent the fresh start().
   */
  async restart(): Promise<void> {
    logger.warn({ component: 'slack' }, 'restarting socket mode connection');
    try {
      await this.app.stop();
    } catch (error) {
      logger.warn(
        { component: 'slack', error: String(error) },
        'stopping stale socket mode app failed; starting anyway',
      );
    }
    await this.app.start();
    logger.info({ component: 'slack' }, 'socket mode restarted');
  }

  get webClient() {
    return this.app.client;
  }
}

function inferChannelTypeFromChannelId(channelId: string): string {
  if (channelId.startsWith('D')) {
    return 'im';
  }
  if (channelId.startsWith('G')) {
    return 'mpim';
  }
  if (channelId.startsWith('C')) {
    return 'channel';
  }
  return '';
}
