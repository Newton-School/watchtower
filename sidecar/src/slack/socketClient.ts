import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { AppConfig, SlackEventEnvelope, SlackReactionEvent } from '../types/contracts.js';
import { logger } from '../logging/logger.js';
import { BUTTON_ACTION_RE, handleButtonClick, readButtonClick } from './buttonReplies.js';

type SlackEventHandler = (event: SlackEventEnvelope, client: WebClient) => Promise<void>;
type SlackReactionHandler = (event: SlackReactionEvent, client: WebClient) => Promise<void>;
/** `connected` when Slack says hello; `closed` when the websocket drops (Bolt may still reconnect). */
type SocketStateHandler = (state: 'connected' | 'closed') => void;

/** The parts of @slack/socket-mode's client a restart needs. */
type SocketModeConnection = {
  on(event: 'connected' | 'close', listener: () => void): unknown;
  removeListener(event: 'connected' | 'close', listener: () => void): unknown;
  disconnect(): Promise<void>;
};

/** How long a retired connection gets to close before it is dropped. */
const RETIRE_GRACE_MS = 5000;
/**
 * A restart step that takes longer than this has failed. Slack's clients keep
 * retrying by themselves (the Web API for up to half an hour), which would
 * hold the restart, and with it the watchdog's next try, that long.
 */
const RESTART_STEP_TIMEOUT_MS = 60 * 1000;

function withinTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took over ${RESTART_STEP_TIMEOUT_MS / 1000}s`)),
      RESTART_STEP_TIMEOUT_MS,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** socket-mode internals a retired client is stopped through; private in its types. */
type SocketModeInternals = {
  autoReconnectEnabled?: boolean;
  webClient?: { axios?: { interceptors?: { request?: { use(onRequest: () => unknown): unknown } } } };
  websocket?: { terminate?: () => void } | null;
};

/**
 * Close a Socket Mode connection for good. A dead connection never answers
 * the close frame (ws waits 30s and more), so after a few seconds the
 * websocket is dropped outright. The client is never started again, and it
 * stops trying by itself: auto-reconnect goes off, and the
 * apps.connections.open retries it may still have running (up to 100 of
 * them) are parked on a request that never settles. Not failed: socket-mode's
 * reconnect chain has no catch, so a rejection there would be unhandled and
 * take the sidecar down. If a reconnect connects anyway, it is closed too.
 */
export async function retireSocketConnection(socket: SocketModeConnection, graceMs = RETIRE_GRACE_MS): Promise<void> {
  const internals = socket as SocketModeInternals;
  internals.autoReconnectEnabled = false;
  internals.webClient?.axios?.interceptors?.request?.use(() => new Promise(() => {}));
  const closeAgain = () => void socket.disconnect().catch(() => {});
  socket.on('connected', closeAgain);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dropped = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      try {
        internals.websocket?.terminate?.();
      } catch {
        // already gone
      }
      resolve();
    }, graceMs);
  });
  await Promise.race([socket.disconnect().catch(() => {}), dropped]);
  if (timer) clearTimeout(timer);
}

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
  private receiver: SocketModeReceiver;
  private readonly stableWebClient: WebClient;
  private readonly config: AppConfig;
  private readonly onEvent: SlackEventHandler;
  private readonly onReaction?: SlackReactionHandler;
  private readonly onSocketState?: SocketStateHandler;
  /** Who the bot is, so an App built for a restart need not ask Slack (see restart). */
  private botIdentity: { botId: string; botUserId: string } | undefined;
  private readonly socketListeners = {
    connected: () => this.onSocketState?.('connected'),
    close: () => this.onSocketState?.('closed'),
  };

  constructor(
    config: AppConfig,
    onEvent: SlackEventHandler,
    onReaction?: SlackReactionHandler,
    onSocketState?: SocketStateHandler,
  ) {
    this.config = config;
    this.onEvent = onEvent;
    this.onReaction = onReaction;
    this.onSocketState = onSocketState;
    ({ app: this.app, receiver: this.receiver } = this.buildApp());
    // Callers keep this client for Web API calls; it outlives socket restarts.
    this.stableWebClient = this.app.client;
  }

  private buildApp(): { app: App; receiver: SocketModeReceiver } {
    const receiver = new SocketModeReceiver({ appToken: this.config.slackAppToken, logLevel: LogLevel.INFO });
    const app = new App({
      token: this.config.slackBotToken,
      ...this.botIdentity,
      receiver,
      socketMode: true,
      logLevel: LogLevel.INFO,
      // Bolt's default ignoreSelf middleware drops every event the bot itself
      // authored — which would blind the conversation-capture live tap to
      // miniOG's own replies (a transcript of questions with no answers).
      // Self events are instead filtered where they matter: processEvent's
      // bot gate still blocks job creation, and the reaction handler skips
      // bot-authored reactions explicitly.
      ignoreSelf: false,
    });
    receiver.client.on('connected', this.socketListeners.connected);
    receiver.client.on('close', this.socketListeners.close);
    this.registerHandlers(app);
    return { app, receiver };
  }

  private registerHandlers(app: App): void {
    app.event('app_mention', async ({ event, body, client }) => {
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

    app.event('message', async ({ event, body, client }) => {
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

    app.event('reaction_added', async ({ event, body, client }) => {
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

    // A button on a gate (suggestion 9): the click is kept as the reply the
    // person would have typed, for the gate that is polling; a Stop goes to
    // the stop lane. The gate decides who may act and retires the buttons
    // when it ends, so nothing is rewritten here.
    app.action(BUTTON_ACTION_RE, async ({ ack, body }) => {
      await ack();
      const click = readButtonClick(body as unknown as Record<string, unknown>);
      if (!click) return;
      logger.info(
        {
          component: 'slack',
          eventType: 'block_actions',
          channelId: click.channelId,
          threadTs: click.threadTs,
          actionId: click.actionId,
        },
        'received a button click',
      );
      await handleButtonClick(click);
    });

    app.command('/miniog', async ({ command, ack, client }) => {
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

    app.command('/wt', async ({ command, ack, client }) => {
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

    app.command('/watchtower', async ({ command, ack, client }) => {
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

    app.shortcut(/.*/, async ({ shortcut, ack, client }) => {
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
   * Drop the Socket Mode connection and open a new one (issue #587). The old
   * connection is closed first so the two never both deliver, and it gets a
   * fresh client because @slack/socket-mode's own reconnect timers would
   * otherwise race a restart of the same one.
   */
  async restart(): Promise<void> {
    logger.warn({ component: 'slack' }, 'restarting socket mode');
    // A new App checks the token once, when built, and keeps a failed check
    // for good: built while the network is still coming back after a sleep,
    // it would drop every event. Asking first also fails a restart before it
    // has closed the old connection.
    if (!this.botIdentity) {
      const auth = await withinTimeout(this.stableWebClient.auth.test(), 'auth.test');
      if (!auth.bot_id || !auth.user_id) throw new Error('auth.test did not say who the bot is');
      this.botIdentity = { botId: auth.bot_id, botUserId: auth.user_id };
    }
    const old = this.receiver.client;
    old.removeListener('connected', this.socketListeners.connected);
    old.removeListener('close', this.socketListeners.close);
    await retireSocketConnection(old as unknown as SocketModeConnection);
    ({ app: this.app, receiver: this.receiver } = this.buildApp());
    // On a timeout the next restart retires this client, which stops its retries.
    await withinTimeout(this.app.start(), 'opening the Slack socket');
    logger.info({ component: 'slack' }, 'socket mode restarted');
  }

  get webClient() {
    return this.stableWebClient;
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
