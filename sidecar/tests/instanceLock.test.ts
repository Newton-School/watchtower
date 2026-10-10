import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceLock,
  instanceLockPath,
  isHolderAlive,
  readInstanceLock,
  releaseInstanceLock,
  tryAcquireInstanceLock,
  type InstanceLockInfo,
} from '../src/runtime/instanceLock.js';

let dir: string;
let lockPath: string;

const current: InstanceLockInfo = {
  pid: 4242,
  entry: '/Applications/watchtower.app/Contents/Resources/_up_/sidecar/dist/index.js',
  version: '0.6.83',
  startedAt: '2026-10-10T16:00:00.000Z',
};
const older: InstanceLockInfo = {
  pid: 1111,
  entry: '/Applications/watchtower.app.bak/Contents/Resources/_up_/sidecar/dist/index.js',
  version: '0.6.82',
  startedAt: '2026-10-10T15:00:00.000Z',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-lock-'));
  lockPath = instanceLockPath(path.join(dir, 'watchtower.db'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('instanceLockPath', () => {
  it('sits beside the database the sidecars share', () => {
    expect(lockPath).toBe(path.join(dir, 'sidecar.lock'));
  });
});

describe('tryAcquireInstanceLock', () => {
  it('takes a free lock and records who holds it', () => {
    expect(tryAcquireInstanceLock({ lockPath, self: current })).toEqual({ acquired: true });
    expect(readInstanceLock(lockPath)).toEqual(current);
  });

  it('refuses while a live sidecar holds it, and leaves the holder in place', () => {
    tryAcquireInstanceLock({ lockPath, self: older });

    const result = tryAcquireInstanceLock({ lockPath, self: current, isAlive: () => true });

    expect(result).toEqual({ acquired: false, holder: older });
    expect(readInstanceLock(lockPath)).toEqual(older);
  });

  it('takes over a lock whose holder is gone', () => {
    tryAcquireInstanceLock({ lockPath, self: older });

    const result = tryAcquireInstanceLock({ lockPath, self: current, isAlive: () => false });

    expect(result).toEqual({ acquired: true, replaced: older });
    expect(readInstanceLock(lockPath)).toEqual(current);
    expect(fs.readdirSync(dir)).toEqual(['sidecar.lock']);
  });

  it('is idempotent for the process that already holds it', () => {
    tryAcquireInstanceLock({ lockPath, self: current });
    expect(tryAcquireInstanceLock({ lockPath, self: current, isAlive: () => true })).toEqual({ acquired: true });
  });

  it('waits on a fresh unreadable lock, which is a holder mid-write', () => {
    fs.writeFileSync(lockPath, '');
    const result = tryAcquireInstanceLock({ lockPath, self: current });
    expect(result).toEqual({ acquired: false, holder: undefined });
  });

  it('takes over an unreadable lock once it is old', () => {
    fs.writeFileSync(lockPath, '{not json');
    const result = tryAcquireInstanceLock({ lockPath, self: current, now: () => Date.now() + 60_000 });
    expect(result).toEqual({ acquired: true, replaced: undefined });
    expect(readInstanceLock(lockPath)).toEqual(current);
  });
});

describe('isHolderAlive', () => {
  it('is false for a pid that does not exist', () => {
    expect(isHolderAlive({ ...older, pid: 2 ** 22 + 12345 })).toBe(false);
  });

  it('is false when the pid is alive but runs something else (a recycled pid)', () => {
    expect(isHolderAlive({ ...older, pid: process.pid })).toBe(false);
  });

  it('is true when the pid is alive and runs the recorded entry', () => {
    // `ps` reports this test process by its real command line; use a token from it.
    expect(isHolderAlive({ ...current, pid: process.pid, entry: 'node' })).toBe(true);
  });
});

describe('acquireInstanceLock', () => {
  it('stands by while the holder lives and takes over when it exits', async () => {
    tryAcquireInstanceLock({ lockPath, self: older });
    let holderAlive = true;
    const standby: (InstanceLockInfo | undefined)[] = [];

    const result = await acquireInstanceLock({
      lockPath,
      self: current,
      isAlive: () => holderAlive,
      onStandby: holder => standby.push(holder),
      sleep: async () => {
        if (standby.length === 2) holderAlive = false;
      },
    });

    expect(standby).toEqual([older, older]);
    expect(result).toEqual({ replaced: older });
    expect(readInstanceLock(lockPath)).toEqual(current);
  });
});

describe('releaseInstanceLock', () => {
  it('removes the lock this process holds', () => {
    tryAcquireInstanceLock({ lockPath, self: current });
    releaseInstanceLock(lockPath, current.pid);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('leaves a lock that another sidecar took over', () => {
    tryAcquireInstanceLock({ lockPath, self: older });
    releaseInstanceLock(lockPath, current.pid);
    expect(readInstanceLock(lockPath)).toEqual(older);
  });

  it('does nothing when there is no lock', () => {
    expect(() => releaseInstanceLock(lockPath, current.pid)).not.toThrow();
  });
});
