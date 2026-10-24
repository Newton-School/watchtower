import { logger } from '../logging/logger.js';
import { activeClock, type ActiveClock, type Stopwatch } from '../runtime/activeClock.js';

// Why this exists (issue #587, RCA 2026-07-29): after the host sleeps, the
// Socket Mode connection can stay dead for hours. Bolt reconnects on its own
// only while it believes the socket closed and the reconnect succeeds; its
// retries back off to tens of minutes, and a connection that died without a
// close looks alive. Meanwhile the 2-minute mention catch-up hides the outage
// by replaying top-level mentions late, while thread replies (stop,
// follow-ups) are lost.
//
// So the socket is restarted on three kinds of evidence:
// - the host woke up (the process's one sleep detector, activeClock, says so);
// - the socket has been closed for a while, awake, without reconnecting;
// - catch-up recovered a bot mention the socket should have delivered.

/** How often the closed-socket and retry checks run. */
const TICK_MS = 15 * 1000;
/** Mentions posted this soon after a (re)connect or a wake prove nothing. */
const CONNECT_GRACE_MS = 60 * 1000;
/** A mention younger than this may still be on its way through the socket. */
const MIN_EVIDENCE_AGE_MS = 60 * 1000;
/** Closed this long, awake, without Bolt reconnecting: restart it ourselves. */
const DOWN_RESTART_MS = 2 * 60 * 1000;
/** Closed this long, awake, and a restart has failed: tell the owner. */
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
  reconnect: (reason: SocketRestartReason) => Promise<void>;
  /** The owner hears about an outage once, not about a routine wake. */
  alert?: (info: SocketAlert) => Promise<void> | void;
  /** Slack messages since this time (epoch seconds) may not have come through the socket. */
  onGap?: (sinceEpochSeconds: number) => void;
  now?: () => number;
  clock?: Pick<ActiveClock, 'onSlept' | 'stopwatch'>;
};

export class SocketWatchdog {
  private readonly deps: SocketWatchdogDeps;
  private readonly clock: Pick<ActiveClock, 'onSlept' | 'stopwatch'>;
  private readonly delivered = new Set<string>();
  /** Reading it makes the clock look for a sleep it has not reported yet. */
  private readonly awake: Stopwatch;
  private connectedAtMs = 0;
  /** Closed since, and for how much awake time. */
  private down: { sinceMs: number; watch: Stopwatch } | null = null;
  private lastWakeAtMs = 0;
  private lastLiveEventMs = 0;
  private lastRestartAtMs = 0;
  private restarting = false;
  private failures = 0;
  private retry: { atMs: number; reason: SocketRestartReason } | null = null;
  private alertedAtMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeSlept: (() => void) | undefined;

  constructor(deps: SocketWatchdogDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? activeClock;
    this.awake = this.clock.stopwatch();
  }

  /** Listens for the host waking and runs the closed-socket checks every few seconds. */
  start(): void {
    this.unsubscribeSlept = this.clock.onSlept(sleptMs => this.onWake(sleptMs));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribeSlept?.();
  }

  /** The socket said hello: it is connected. */
  markConnected(): void {
    this.connectedAtMs = this.now();
    this.down = null;
    this.failures = 0;
    this.retry = null;
  }

  /** The socket closed; Bolt may still reconnect it. */
  markDisconnected(): void {
    if (!this.down) this.down = { sinceMs: this.now(), watch: this.clock.stopwatch() };
  }

  /** A message came through the socket. */
  noteDelivered(channelId: string, ts: string): void {
    this.lastLiveEventMs = this.now();
    // A connection made since the alert works: the next outage gets its own.
    if (this.alertedAtMs && !this.down && this.connectedAtMs >= this.alertedAtMs) this.alertedAtMs = 0;
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
    this.awake.elapsedMs();
    const now = this.now();
    // Awake time only: a socket that closed as the lid shut was not down for the night.
    const downFor = this.down ? this.down.watch.elapsedMs() : 0;
    if (this.failures > 0 && downFor >= DOWN_ALERT_MS) this.alertOnce({ reason: 'disconnected' });
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
   * an edit that adds the mention never comes as an app_mention, and anything
   * posted before the connection, or while the host slept, is the backlog
   * catch-up exists for.
   */
  noteCatchupRecovery(info: {
    channelId: string;
    eventTs: string;
    mentionType: 'bot' | 'owner' | 'none';
    edited?: boolean;
  }): void {
    if (info.mentionType !== 'bot' || info.edited) return;
    // Catch-up's timer can fire before the clock's on waking.
    this.awake.elapsedMs();
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

  private onWake(sleptMs: number): void {
    const now = this.now();
    this.lastWakeAtMs = now;
    logger.warn(
      { component: 'slack-watchdog', sleptForSeconds: Math.round(sleptMs / 1000) },
      'the host was asleep; restarting the Slack socket',
    );
    // A minute of margin: the clock only sees sleep to within its tick.
    this.deps.onGap?.(Math.floor((now - sleptMs) / 1000) - 60);
    this.restart('wake', { ignoreCooldown: true });
  }

  private restart(reason: SocketRestartReason, opts: { ignoreCooldown?: boolean } = {}): void {
    if (this.restarting) return;
    const now = this.now();
    if (!opts.ignoreCooldown && now - this.lastRestartAtMs < RESTART_COOLDOWN_MS) return;
    this.restarting = true;
    this.lastRestartAtMs = now;
    // Messages after the last one the socket delivered may be missing.
    const gapSinceMs = reason === 'disconnected' ? this.down?.sinceMs : this.lastLiveEventMs || this.connectedAtMs;
    void this.runRestart(reason, gapSinceMs ?? 0);
  }

  private async runRestart(reason: SocketRestartReason, gapSinceMs: number): Promise<void> {
    try {
      await this.deps.reconnect(reason);
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
