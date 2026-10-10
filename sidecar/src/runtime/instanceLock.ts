import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance guard for the sidecar (issue #450).
 *
 * Two sidecars on one database both open the Slack app's Socket Mode
 * connection, so Slack splits mentions between them, and whichever starts
 * second marks the other's RUNNING jobs FAILED in cleanupOrphanedRunningJobs.
 * The lock lives beside the database because the database is what they share:
 * a dev sidecar pointed at its own DB is not blocked.
 *
 * Builds from before this guard do not take the lock, so it cannot stop an old
 * bundle that is already running — the build stamp on `job.created` is what
 * makes that case visible.
 */
export interface InstanceLockInfo {
  pid: number;
  /** Script the holder runs (process.argv[1]); also tells builds apart. */
  entry: string;
  version: string;
  startedAt: string;
}

export type AcquireResult =
  | { acquired: true; replaced?: InstanceLockInfo }
  | { acquired: false; holder: InstanceLockInfo | undefined };

/** An unreadable lock younger than this is a holder mid-write, not a stale file. */
const UNREADABLE_GRACE_MS = 5_000;

export function instanceLockPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'sidecar.lock');
}

export function readInstanceLock(lockPath: string): InstanceLockInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<InstanceLockInfo>;
    if (typeof raw.pid !== 'number' || typeof raw.entry !== 'string') return undefined;
    return {
      pid: raw.pid,
      entry: raw.entry,
      version: typeof raw.version === 'string' ? raw.version : 'unknown',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * The holder counts as alive only if its pid exists AND still runs the entry
 * recorded in the lock. A pid check alone would let a recycled pid strand
 * every later sidecar in standby after a crash.
 */
export function isHolderAlive(holder: InstanceLockInfo): boolean {
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(holder.pid)], { encoding: 'utf8' });
    return command.includes(holder.entry);
  } catch {
    return false;
  }
}

function writeExclusive(lockPath: string, self: InstanceLockInfo): boolean {
  try {
    fs.writeFileSync(lockPath, JSON.stringify(self), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function lockAgeMs(lockPath: string, now: number): number {
  try {
    return now - fs.statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * One attempt. Returns `acquired: false` with the holder while a live sidecar
 * owns the lock; takes over a lock whose holder is gone.
 */
export function tryAcquireInstanceLock(params: {
  lockPath: string;
  self: InstanceLockInfo;
  isAlive?: (holder: InstanceLockInfo) => boolean;
  now?: () => number;
}): AcquireResult {
  const { lockPath, self } = params;
  const isAlive = params.isAlive ?? isHolderAlive;
  const now = params.now ?? Date.now;

  if (writeExclusive(lockPath, self)) return { acquired: true };

  const holder = readInstanceLock(lockPath);
  if (holder?.pid === self.pid) return { acquired: true };
  if (holder ? isAlive(holder) : lockAgeMs(lockPath, now()) < UNREADABLE_GRACE_MS) {
    return { acquired: false, holder };
  }

  // Stale. Replace it atomically, then read it back: when two sidecars take
  // over at once the later rename wins, and only that one may proceed.
  const tmpPath = `${lockPath}.${self.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(self));
  fs.renameSync(tmpPath, lockPath);
  const winner = readInstanceLock(lockPath);
  if (winner?.pid === self.pid) return { acquired: true, replaced: holder };
  return { acquired: false, holder: winner };
}

/**
 * Blocks until this process owns the lock. Standing by (rather than exiting)
 * keeps the app's supervisor from respawning the sidecar in a loop, and lets
 * it take over as soon as the holder exits.
 */
export async function acquireInstanceLock(params: {
  lockPath: string;
  self: InstanceLockInfo;
  pollMs?: number;
  onStandby?: (holder: InstanceLockInfo | undefined) => void;
  isAlive?: (holder: InstanceLockInfo) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ replaced?: InstanceLockInfo }> {
  const pollMs = params.pollMs ?? 5_000;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (;;) {
    const result = tryAcquireInstanceLock({ lockPath: params.lockPath, self: params.self, isAlive: params.isAlive });
    if (result.acquired) return { replaced: result.replaced };
    params.onStandby?.(result.holder);
    await sleep(pollMs);
  }
}

/** Removes the lock only if this process still owns it. */
export function releaseInstanceLock(lockPath: string, pid: number = process.pid): void {
  if (readInstanceLock(lockPath)?.pid !== pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}
