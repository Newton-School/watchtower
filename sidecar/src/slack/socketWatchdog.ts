import { logger } from '../logging/logger.js';

// Why this exists (issue #587, RCA 2026-07-29): after the host sleeps, the
// Socket Mode connection can stay dead for hours. Bolt reconnects on its own
// only while it believes the socket closed and the reconnect succeeds; a
// reconnect attempted before the network is back gives up for good, and a
// connection that died without a close looks alive. Meanwhile the 2-minute
// mention catch-up hides the outage by replaying top-level mentions late,
// while thread replies (stop, follow-ups) are lost.
//
// So the socket is restarted on three kinds of evidence:
// - the host woke up (the wall clock jumped past the timer);
// - the socket has been closed for a while without reconnecting;
// - catch-up recovered a bot mention the socket should have delivered.

/** How often the wake check runs. */
const TICK_MS = 15 * 1000;
/** A tick this much later than due means the host slept (or the process stalled). */
const WAKE_GAP_MS = 60 * 1000;
/** Mentions posted this soon after a (re)connect or a wake prove nothing. */
const CONNECT_GRACE_MS = 60 * 1000;
/** A mention younger than this may still be on its way through the socket. */
const MIN_EVIDENCE_AGE_MS = 60 * 1000;
/** Closed this long without Bolt reconnecting: restart it ourselves. */
const DOWN_RESTART_MS = 2 * 60 * 1000;
/** Closed this long: tell the owner. */
const DOWN_ALERT_MS = 10 * 60 * 1000;
/** Restarts on missed-event evidence are at least this far apart. */
const RESTART_COOLDOWN_MS = 2 * 60 * 1000;
/** A failed restart is retried after 30s, 1m, 2m … up to this. */
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Messages the socket delivered, remembered so catch-up does not replay them. */
const DELIVERED_MEMORY = 2000;

export type SocketRestartReason = 'wake' | 'missed_event' | 'disconnected';

export type SocketAlert = {
  reason: 'missed_event' | 'disconnected';
  /** Where the missed mention was, for `missed_event`. */
  channelId?: string;
};

type SocketWatchdogDeps = {
  reconnect: () => Promise<void>;
  /** The owner hears about an outage once, not about a routine wake. */
  alert?: (info: SocketAlert) => Promise<void> | void;
  /** Slack messages since this time (epoch seconds) may not have come through the socket. */
  onGap?: (sinceEpochSeconds: number) => void;
  now?: () => number;
};

export class SocketWatchdog {
  private readonly deps: SocketWatchdogDeps;
  private readonly delivered = new Set<string>();
  private connectedAtMs = 0;
  private downSinceMs: number | null = null;
  private lastTickMs = 0;
  private lastWakeAtMs = 0;
  private lastLiveEventMs = 0;
  private lastRestartAtMs = 0;
  private restarting = false;
  private failures = 0;
  private retry: { atMs: number; reason: SocketRestartReason } | null = null;
  private alertedAtMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SocketWatchdogDeps) {
    this.deps = deps;
  }

  /** Runs the wake and closed-socket checks every few seconds. */
  start(): void {
    this.lastTickMs = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The socket said hello: it is connected. */
  markConnected(): void {
    this.connectedAtMs = this.now();
    this.downSinceMs = null;
    this.failures = 0;
    this.retry = null;
  }

  /** The socket closed; Bolt may still reconnect it. */
  markDisconnected(): void {
    if (this.downSinceMs === null) this.downSinceMs = this.now();
  }

  /** A message came through the socket. */
  noteDelivered(channelId: string, ts: string): void {
    this.lastLiveEventMs = this.now();
    // A connection made since the alert works: the next outage gets its own.
    if (this.alertedAtMs && this.downSinceMs === null && this.connectedAtMs >= this.alertedAtMs) this.alertedAtMs = 0;
    if (!channelId || !ts) return;
    this.delivered.add(`${channelId}:${ts}`);
    if (this.delivered.size > DELIVERED_MEMORY) {
      this.delivered.delete(this.delivered.values().next().value as string);
    }
  }

  wasDelivered(channelId: string, ts: string): boolean {
    return this.delivered.has(`${channelId}:${ts}`);
  }

  tick(): void {
    this.detectWake();
    const now = this.now();
    const downFor = this.downSinceMs === null ? 0 : now - this.downSinceMs;
    if (downFor >= DOWN_ALERT_MS) this.alertOnce({ reason: 'disconnected' });
    if (this.restarting) return;
    if (this.retry) {
      if (now < this.retry.atMs) return;
      const { reason } = this.retry;
      this.retry = null;
      this.restart(reason, { ignoreCooldown: true });
      return;
    }
    if (downFor >= DOWN_RESTART_MS) this.restart('disconnected');
  }

  /**
   * Catch-up queued a message the socket never delivered. Only a bot mention
   * posted while this connection was up counts: tags of the owner arrive
   * through catch-up by design (the bot is not subscribed to every message),
   * and anything posted before the connection, or while the host slept, is
   * the backlog catch-up exists for.
   */
  noteCatchupRecovery(info: { channelId: string; eventTs: string; mentionType: 'bot' | 'owner' | 'none' }): void {
    if (info.mentionType !== 'bot') return;
    this.detectWake();
    if (this.connectedAtMs === 0 || this.wasDelivered(info.channelId, info.eventTs)) return;
    const postedMs = Number(info.eventTs) * 1000;
    if (!Number.isFinite(postedMs) || postedMs <= 0) return;
    if (postedMs <= this.connectedAtMs + CONNECT_GRACE_MS) return;
    if (this.lastWakeAtMs && postedMs <= this.lastWakeAtMs + CONNECT_GRACE_MS) return;
    if (this.now() - postedMs < MIN_EVIDENCE_AGE_MS) return;

    logger.error(
      {
        component: 'slack-watchdog',
        channelId: info.channelId,
        eventTs: info.eventTs,
        connectedAtMs: this.connectedAtMs,
      },
      'catch-up recovered a mention the live socket should have delivered; restarting the socket',
    );
    this.alertOnce({ reason: 'missed_event', channelId: info.channelId });
    this.restart('missed_event');
  }

  private detectWake(): void {
    const now = this.now();
    const last = this.lastTickMs;
    this.lastTickMs = now;
    if (!last || now - last < TICK_MS + WAKE_GAP_MS) return;
    this.lastWakeAtMs = now;
    logger.warn(
      { component: 'slack-watchdog', sleptForSeconds: Math.round((now - last) / 1000) },
      'the host was asleep; restarting the Slack socket',
    );
    this.deps.onGap?.(Math.floor(last / 1000));
    this.restart('wake', { ignoreCooldown: true });
  }

  private restart(reason: SocketRestartReason, opts: { ignoreCooldown?: boolean } = {}): void {
    if (this.restarting) return;
    const now = this.now();
    if (!opts.ignoreCooldown && now - this.lastRestartAtMs < RESTART_COOLDOWN_MS) return;
    this.restarting = true;
    this.lastRestartAtMs = now;
    // Messages after the last one the socket delivered may be missing.
    const gapSinceMs = reason === 'disconnected' ? this.downSinceMs : this.lastLiveEventMs || this.connectedAtMs;
    void this.runRestart(reason, gapSinceMs);
  }

  private async runRestart(reason: SocketRestartReason, gapSinceMs: number | null): Promise<void> {
    try {
      await this.deps.reconnect();
      this.markConnected();
      logger.info({ component: 'slack-watchdog', reason }, 'Slack socket restarted');
      if (reason !== 'wake' && gapSinceMs) this.deps.onGap?.(Math.floor(gapSinceMs / 1000));
    } catch (error) {
      this.failures += 1;
      const delay = Math.min(30 * 1000 * 2 ** (this.failures - 1), MAX_RETRY_DELAY_MS);
      this.retry = { atMs: this.now() + delay, reason };
      this.markDisconnected();
      logger.error(
        {
          component: 'slack-watchdog',
          reason,
          failures: this.failures,
          retryInSeconds: delay / 1000,
          error: String(error),
        },
        'Slack socket restart failed; trying again',
      );
    } finally {
      this.restarting = false;
    }
  }

  private alertOnce(info: SocketAlert): void {
    if (this.alertedAtMs) return;
    this.alertedAtMs = this.now();
    void Promise.resolve()
      .then(() => this.deps.alert?.(info))
      .catch(error => logger.warn({ component: 'slack-watchdog', error: String(error) }, 'socket alert failed'));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
