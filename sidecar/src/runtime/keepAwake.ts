import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { logger } from '../logging/logger.js';

/**
 * Keeps the Mac from sleeping while a job is running an agent (issue #439).
 *
 * The sidecar runs on a laptop. When it sleeps mid-run the network goes,
 * the agent's API call fails, and the time asleep is charged to the job.
 * `caffeinate` holds off idle sleep (and system sleep on mains power) for as
 * long as it runs, so it is started when the first job takes a slot and
 * stopped when the last one gives it back. A job waiting on a person has
 * given its slot back, so a plan left unapproved overnight does not keep
 * the machine up. The display may still sleep, and closing the lid on
 * battery still sleeps the machine: caffeinate cannot prevent that.
 *
 * `-w <sidecar pid>` makes caffeinate exit with the sidecar, so a crash
 * never leaves the machine pinned awake. Off with `WATCHTOWER_KEEP_AWAKE=0`.
 */

const CAFFEINATE = '/usr/bin/caffeinate';

export function isKeepAwakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WATCHTOWER_KEEP_AWAKE?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

export class KeepAwake {
  private child: ChildProcess | undefined;

  constructor(
    private readonly deps: {
      spawnFn?: typeof spawn;
      platform?: NodeJS.Platform;
      available?: () => boolean;
      pid?: number;
      enabled?: () => boolean;
    } = {},
  ) {}

  /** Whether caffeinate is running now. */
  get awake(): boolean {
    return Boolean(this.child);
  }

  /** Keep the machine awake while `busy`, and let it sleep again when not. */
  set(busy: boolean): void {
    if (busy) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.child) return;
    const platform = this.deps.platform ?? process.platform;
    const enabled = this.deps.enabled ?? (() => isKeepAwakeEnabled());
    const available = this.deps.available ?? (() => fs.existsSync(CAFFEINATE));
    if (platform !== 'darwin' || !enabled() || !available()) return;
    try {
      const child = (this.deps.spawnFn ?? spawn)(CAFFEINATE, ['-i', '-s', '-w', String(this.deps.pid ?? process.pid)], {
        stdio: 'ignore',
      });
      child.on('exit', () => {
        if (this.child === child) this.child = undefined;
      });
      child.on('error', error => {
        if (this.child === child) this.child = undefined;
        logger.warn({ error: String(error) }, 'keep-awake: caffeinate failed');
      });
      this.child = child;
      logger.info({ pid: child.pid }, 'keep-awake: a job is running, holding off sleep');
    } catch (error) {
      logger.warn({ error: String(error) }, 'keep-awake: could not start caffeinate');
    }
  }

  private stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.kill();
    logger.info('keep-awake: no job is running, sleep allowed again');
  }
}

export const keepAwake = new KeepAwake();

/**
 * Keeps the Mac awake for as long as the sidecar runs and the Mac is on mains
 * power, so miniOG stays reachable between jobs (issue #727; it was offline
 * whenever the laptop slept, #585). `caffeinate -s` is honoured only on AC
 * power: on battery the Mac sleeps as before. Closing the lid still sleeps it
 * unless an external display is attached; no assertion changes that.
 *
 * `-w <sidecar pid>` ends it with the sidecar. If caffeinate exits on its own
 * it is started again after a short wait, a few times, then left off with a
 * warning. Off with `WATCHTOWER_STAY_AWAKE_ON_POWER=0` or the sidecar_state
 * key `stay_awake_on_power` set to `off`.
 */
export const STAY_AWAKE_ON_POWER_STATE_KEY = 'stay_awake_on_power';
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
/** A caffeinate that ran this long before exiting counts as healthy: the retries start over. */
const HEALTHY_RUN_MS = 60_000;

export function isStayAwakeOnPowerEnabled(env: NodeJS.ProcessEnv = process.env, stateValue?: string): boolean {
  const off = (raw: string | undefined) => {
    const value = raw?.trim().toLowerCase();
    return value === '0' || value === 'false' || value === 'off';
  };
  return !off(env.WATCHTOWER_STAY_AWAKE_ON_POWER) && !off(stateValue);
}

export class StayAwakeOnPower {
  private child: ChildProcess | undefined;
  private stopped = true;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: {
      spawnFn?: typeof spawn;
      platform?: NodeJS.Platform;
      available?: () => boolean;
      pid?: number;
      enabled?: () => boolean;
      now?: () => number;
      setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
    } = {},
  ) {}

  /** Whether caffeinate is running now. */
  get awake(): boolean {
    return Boolean(this.child);
  }

  start(): void {
    if (!this.stopped) return;
    const platform = this.deps.platform ?? process.platform;
    const enabled = this.deps.enabled ?? (() => isStayAwakeOnPowerEnabled());
    const available = this.deps.available ?? (() => fs.existsSync(CAFFEINATE));
    if (platform !== 'darwin' || !enabled() || !available()) return;
    this.stopped = false;
    this.restarts = 0;
    if (this.spawn()) logger.info("keep-awake: keeping the Mac awake while it's on power");
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      (this.deps.clearTimeoutFn ?? clearTimeout)(this.restartTimer);
      this.restartTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private spawn(): boolean {
    const now = this.deps.now ?? Date.now;
    try {
      const child = (this.deps.spawnFn ?? spawn)(CAFFEINATE, ['-s', '-w', String(this.deps.pid ?? process.pid)], {
        stdio: 'ignore',
      });
      const startedAt = now();
      const ended = (reason: string) => {
        if (this.child !== child) return;
        this.child = undefined;
        if (this.stopped) return;
        if (now() - startedAt >= HEALTHY_RUN_MS) this.restarts = 0;
        this.scheduleRestart(reason);
      };
      child.on('exit', code => ended(`exited (${String(code)})`));
      child.on('error', error => ended(String(error)));
      this.child = child;
      return true;
    } catch (error) {
      this.scheduleRestart(String(error));
      return false;
    }
  }

  private scheduleRestart(reason: string): void {
    if (this.stopped || this.restartTimer) return;
    const delay = RESTART_DELAYS_MS[this.restarts];
    if (delay === undefined) {
      logger.warn({ reason }, 'keep-awake: caffeinate keeps stopping; the Mac may sleep on power');
      return;
    }
    this.restarts += 1;
    const timer = (this.deps.setTimeoutFn ?? setTimeout)(() => {
      this.restartTimer = undefined;
      if (!this.stopped && !this.child) this.spawn();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.restartTimer = timer;
  }
}

export const stayAwakeOnPower = new StayAwakeOnPower();
