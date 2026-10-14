import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { isKeepAwakeEnabled, KeepAwake } from '../src/runtime/keepAwake.js';
import { JobSlots } from '../src/runtime/jobSlots.js';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  child.pid = 4242;
  child.kill = vi.fn(() => {
    child.emit('exit', 0);
    return true;
  });
  return child;
}

function keepAwakeWith(overrides: Partial<ConstructorParameters<typeof KeepAwake>[0]> = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const keepAwake = new KeepAwake({
    spawnFn: spawnFn as never,
    platform: 'darwin',
    available: () => true,
    enabled: () => true,
    pid: 777,
    ...overrides,
  });
  return { keepAwake, spawnFn, children };
}

// Issue #439: the sidecar runs on a laptop; asleep mid-run, the network goes
// and the agent's API call fails.
describe('KeepAwake', () => {
  it('holds off sleep with caffeinate while busy, tied to the sidecar process', () => {
    const { keepAwake, spawnFn } = keepAwakeWith();

    keepAwake.set(true);

    expect(spawnFn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-s', '-w', '777'], { stdio: 'ignore' });
    expect(keepAwake.awake).toBe(true);
  });

  it('starts one caffeinate however often it is told, and stops it when idle', () => {
    const { keepAwake, spawnFn, children } = keepAwakeWith();

    keepAwake.set(true);
    keepAwake.set(true);
    keepAwake.set(false);

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(keepAwake.awake).toBe(false);
  });

  it('starts again after caffeinate exits on its own', () => {
    const { keepAwake, spawnFn, children } = keepAwakeWith();

    keepAwake.set(true);
    children[0].emit('exit', 1);
    keepAwake.set(true);

    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('does nothing off macOS, without caffeinate, or when switched off', () => {
    for (const overrides of [{ platform: 'linux' as const }, { available: () => false }, { enabled: () => false }]) {
      const { keepAwake, spawnFn } = keepAwakeWith(overrides);
      keepAwake.set(true);
      expect(spawnFn).not.toHaveBeenCalled();
      expect(keepAwake.awake).toBe(false);
    }
  });

  it('is on unless switched off', () => {
    expect(isKeepAwakeEnabled({})).toBe(true);
    expect(isKeepAwakeEnabled({ WATCHTOWER_KEEP_AWAKE: '0' })).toBe(false);
  });
});

describe('JobSlots reports how many slots are in use', () => {
  it('as jobs take and give back slots, and lend them while waiting on a person', async () => {
    const slots = new JobSlots();
    const seen: number[] = [];
    slots.configure({ max: () => 2, onFree: () => {}, onActiveChange: active => seen.push(active) });

    expect(slots.tryAcquire()).toBe(true);
    let release!: () => void;
    const job = slots.run(() => slots.whileWaitingOnHuman(() => new Promise<void>(resolve => (release = resolve))));
    await Promise.resolve();
    // The job lent its slot for the wait: nothing is running, the machine may sleep.
    expect(seen).toEqual([1, 0]);

    release();
    await job;
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('does not report a slot handed straight to a job coming back from a wait', async () => {
    const slots = new JobSlots();
    const seen: number[] = [];
    slots.configure({ max: () => 1, onFree: () => {}, onActiveChange: active => seen.push(active) });

    expect(slots.tryAcquire()).toBe(true);
    let release!: () => void;
    const waiting = slots.run(() => slots.whileWaitingOnHuman(() => new Promise<void>(resolve => (release = resolve))));
    await Promise.resolve();
    // Another job takes the lent slot; the waiting one's answer arrives meanwhile.
    expect(slots.tryAcquire()).toBe(true);
    let finishOther!: () => void;
    const other = slots.run(() => new Promise<void>(resolve => (finishOther = resolve)));
    release();
    await Promise.resolve();
    finishOther();
    await other;
    await waiting;

    // 1 (first), 0 (lent), 1 (second job), handed over without a change, 0 (all done).
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it('keeps a job running when the listener throws', async () => {
    const slots = new JobSlots();
    slots.configure({
      max: () => 1,
      onFree: () => {},
      onActiveChange: () => {
        throw new Error('listener bug');
      },
    });

    expect(slots.tryAcquire()).toBe(true);
    await expect(slots.run(async () => 'done')).resolves.toBe('done');
    expect(slots.active).toBe(0);
  });
});
