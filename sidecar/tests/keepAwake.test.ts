import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  isKeepAwakeEnabled,
  isStayAwakeOnPowerEnabled,
  KeepAwake,
  StayAwakeOnPower,
} from '../src/runtime/keepAwake.js';
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

function stayAwakeWith(overrides: Partial<ConstructorParameters<typeof StayAwakeOnPower>[0]> = {}) {
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn = vi.fn(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const setTimeoutFn = vi.fn((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  });
  let clock = 0;
  const stay = new StayAwakeOnPower({
    spawnFn: spawnFn as never,
    platform: 'darwin',
    available: () => true,
    enabled: () => true,
    pid: 777,
    now: () => clock,
    setTimeoutFn,
    clearTimeoutFn: vi.fn(),
    ...overrides,
  });
  const runNextTimer = () => timers.shift()?.fn();
  return { stay, spawnFn, children, timers, runNextTimer, advance: (ms: number) => (clock += ms) };
}

// Issue #727: miniOG was offline whenever the laptop slept (#585). On mains
// power the Mac stays awake for as long as the sidecar runs.
describe('StayAwakeOnPower', () => {
  it('holds a mains-power-only assertion tied to the sidecar process from startup', () => {
    const { stay, spawnFn } = stayAwakeWith();

    stay.start();

    expect(spawnFn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-s', '-w', '777'], { stdio: 'ignore' });
    expect(stay.awake).toBe(true);
  });

  it('never runs two caffeinates however often it is started', () => {
    const { stay, spawnFn } = stayAwakeWith();

    stay.start();
    stay.start();

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('does nothing off macOS, without caffeinate, or when switched off', () => {
    for (const overrides of [{ platform: 'linux' as const }, { available: () => false }, { enabled: () => false }]) {
      const { stay, spawnFn } = stayAwakeWith(overrides);
      stay.start();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(stay.awake).toBe(false);
    }
  });

  it('starts caffeinate again after it exits on its own, waiting longer each time, then gives up', () => {
    const { stay, spawnFn, children, timers, runNextTimer } = stayAwakeWith();
    stay.start();

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      children[children.length - 1].emit('exit', 1);
      expect(stay.awake).toBe(false);
      delays.push(timers[0].ms);
      runNextTimer();
      expect(stay.awake).toBe(true);
    }
    expect(delays).toEqual([1_000, 5_000, 30_000]);

    // A fourth quick exit: no more tries.
    children[children.length - 1].emit('exit', 1);
    expect(timers).toHaveLength(0);
    expect(spawnFn).toHaveBeenCalledTimes(4);
    expect(stay.awake).toBe(false);
  });

  it('counts tries from the start again after caffeinate ran for a while', () => {
    const { stay, children, timers, runNextTimer, advance } = stayAwakeWith();
    stay.start();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      advance(120_000);
      children[children.length - 1].emit('exit', 1);
      expect(timers[0].ms).toBe(1_000);
      runNextTimer();
    }
    expect(stay.awake).toBe(true);
  });

  it('only one restart is pending when caffeinate both errors and exits', () => {
    const { stay, children, timers } = stayAwakeWith();
    stay.start();

    children[0].emit('error', new Error('spawn failed'));
    children[0].emit('exit', 1);

    expect(timers).toHaveLength(1);
  });

  it('stops with the sidecar and does not start again', () => {
    const { stay, spawnFn, children, timers } = stayAwakeWith();
    stay.start();

    stay.stop();

    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(stay.awake).toBe(false);
  });

  it('a stop while a restart is pending cancels it', () => {
    const { stay, spawnFn, children, runNextTimer } = stayAwakeWith();
    stay.start();
    children[0].emit('exit', 1);

    stay.stop();
    runNextTimer();

    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(stay.awake).toBe(false);
  });

  it('is on unless the env switch or the stored setting turns it off', () => {
    expect(isStayAwakeOnPowerEnabled({})).toBe(true);
    expect(isStayAwakeOnPowerEnabled({}, 'on')).toBe(true);
    expect(isStayAwakeOnPowerEnabled({ WATCHTOWER_STAY_AWAKE_ON_POWER: '0' })).toBe(false);
    expect(isStayAwakeOnPowerEnabled({ WATCHTOWER_STAY_AWAKE_ON_POWER: 'off' })).toBe(false);
    expect(isStayAwakeOnPowerEnabled({}, 'off')).toBe(false);
    expect(isStayAwakeOnPowerEnabled({}, '0')).toBe(false);
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
