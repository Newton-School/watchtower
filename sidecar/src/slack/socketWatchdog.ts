import { logger } from '../logging/logger.js';

// A catch-up recovery is proof the live socket missed an event it should have
// delivered: conversations.history showed a mention, no job existed for it,
// and the bot hadn't replied. When that missed event was posted while the
// socket claimed to be connected, the websocket is a zombie — TCP established
// but app-level dead, so Bolt never reconnects on its own (observed
// 2026-07-26 → 29: three days of silent non-delivery behind an ESTABLISHED
// connection to wss-primary.slack.com). The only reliable recovery is forcing
// a Socket Mode restart.
const CONNECT_GRACE_SECONDS = 60;
const RECONNECT_COOLDOWN_MS = 5 * 60 * 1000;

type SocketWatchdogDeps = {
  reconnect: () => Promise<void>;
  alert?: (info: { channelId: string; eventTs: string }) => Promise<void> | void;
  now?: () => number;
};

export class SocketWatchdog {
  private readonly deps: SocketWatchdogDeps;
  private connectedAtEpochSeconds = 0;
  private lastReconnectStartedAtMs = 0;
  private reconnecting = false;

  constructor(deps: SocketWatchdogDeps) {
    this.deps = deps;
  }

  /** Call after every successful Socket Mode (re)connect. */
  markConnected(): void {
    this.connectedAtEpochSeconds = Math.floor(this.now() / 1000);
  }

  /**
   * Called for every mention the catch-up scanner had to recover. Events from
   * before the current connection (startup backlog after downtime) prove
   * nothing; events posted while this connection was supposedly live mean the
   * socket is dead and trigger a debounced reconnect.
   */
  noteCatchupRecovery(channelId: string, eventTs: string): void {
    if (this.connectedAtEpochSeconds === 0) {
      return;
    }
    const eventEpoch = Number(eventTs);
    if (!Number.isFinite(eventEpoch) || eventEpoch <= this.connectedAtEpochSeconds + CONNECT_GRACE_SECONDS) {
      return;
    }

    logger.error(
      {
        component: 'slack-watchdog',
        channelId,
        eventTs,
        connectedAtEpochSeconds: this.connectedAtEpochSeconds,
      },
      'catch-up recovered a mention the live socket should have delivered; socket looks zombie',
    );

    if (this.reconnecting || this.now() - this.lastReconnectStartedAtMs < RECONNECT_COOLDOWN_MS) {
      return;
    }
    this.lastReconnectStartedAtMs = this.now();
    this.reconnecting = true;
    void this.runReconnect(channelId, eventTs);
  }

  private async runReconnect(channelId: string, eventTs: string): Promise<void> {
    try {
      await this.deps.alert?.({ channelId, eventTs });
    } catch (error) {
      logger.warn({ component: 'slack-watchdog', error: String(error) }, 'zombie-socket alert failed');
    }
    try {
      await this.deps.reconnect();
      this.markConnected();
      logger.info({ component: 'slack-watchdog' }, 'socket mode reconnected after zombie detection');
    } catch (error) {
      logger.error(
        { component: 'slack-watchdog', error: String(error) },
        'socket mode reconnect failed; will retry on next zombie evidence after cooldown',
      );
    } finally {
      this.reconnecting = false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
