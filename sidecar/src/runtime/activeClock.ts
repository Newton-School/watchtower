import { logger } from '../logging/logger.js';

/**
 * Time the host was awake, for budgets on agent work (issue #586).
 *
 * The sidecar runs on a laptop, and closing the lid sleeps it even while
 * caffeinate holds (runtime/keepAwake.ts). Node's clocks keep counting through
 * that sleep on macOS: `Date.now()`, and also `performance.now()` and
 * `process.hrtime` (on Node 20 / libuv 1.46 they track `os.uptime()`, which
 * includes every sleep since boot). A timer that came due while asleep fires
 * the moment the machine wakes. So a 26-minute sleep was charged to a
 * 45-minute change run, which timed out a second after the coder's retry
 * finished (job 980d3d7f).
 *
 * Node has no clock that stops while asleep, so sleep is spotted instead: a
 * tick every few seconds that comes a minute or more late means the host
 * slept (or froze) through the gap, and the gap is left out of awake time.
 * Readings add up gaps rather than subtract two times, so a wall clock set
 * back never makes time run backwards.
 */

const TICK_MS = 5_000;
/** How late a tick must be to count as sleep. Shorter gaps count as awake. */
const MIN_SLEEP_MS = 60_000;

export interface Stopwatch {
  /** Awake time since the stopwatch started, in ms. */
  elapsedMs(): number;
  /** Host sleep seen since the stopwatch started, in ms. */
  sleptMs(): number;
}

export class ActiveClock {
  private last: number;
  private awake = 0;
  private asleep = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(sleptMs: number) => void>();

  constructor(private readonly now: () => number = () => Date.now()) {
    this.last = now();
  }

  /** A stopwatch on awake time. Starts the tick that spots sleep. */
  stopwatch(): Stopwatch {
    this.start();
    const awakeAt = this.awake;
    const asleepAt = this.asleep;
    return {
      elapsedMs: () => {
        this.observe();
        return this.awake - awakeAt;
      },
      sleptMs: () => {
        this.observe();
        return this.asleep - asleepAt;
      },
    };
  }

  /**
   * Like setTimeout, but only awake time counts: a timer that comes due while
   * the host sleeps is put off by the length of the sleep, instead of firing
   * on wake. Checked at least every tick, so it fires within a few ms of its
   * time when nothing slept. Returns the cancel.
   */
  setTimeout(fn: () => void, ms: number): () => void {
    const watch = this.stopwatch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const left = ms - watch.elapsedMs();
      if (left <= 0) {
        fn();
        return;
      }
      timer = setTimeout(check, Math.min(left, TICK_MS));
    };
    timer = setTimeout(check, Math.min(ms, TICK_MS));
    return () => clearTimeout(timer);
  }

  /** Called with the length of each sleep, when the host wakes. Returns the unsubscribe. */
  onSlept(listener: (sleptMs: number) => void): () => void {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stops the tick; for tests. Readings go on, counting every gap as awake. */
  stop(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private start(): void {
    if (this.ticker) return;
    this.observe();
    this.ticker = setInterval(() => this.observe(), TICK_MS);
    this.ticker.unref?.();
  }

  private observe(): void {
    const now = this.now();
    const gap = Math.max(0, now - this.last);
    this.last = now;
    // Without the tick a long gap only means nobody looked.
    if (!this.ticker || gap < TICK_MS + MIN_SLEEP_MS) {
      this.awake += gap;
      return;
    }
    const slept = gap - TICK_MS;
    this.awake += TICK_MS;
    this.asleep += slept;
    for (const listener of this.listeners) {
      try {
        listener(slept);
      } catch (error) {
        logger.warn({ error: String(error) }, 'a host-sleep listener failed');
      }
    }
  }
}

/** The sidecar's one awake-time clock. */
export const activeClock = new ActiveClock();
