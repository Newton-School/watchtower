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
