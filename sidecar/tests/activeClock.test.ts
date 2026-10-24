import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveClock } from '../src/runtime/activeClock.js';

const MIN = 60_000;

// vi.setSystemTime moves the clock without running the timers in between:
// what a sleeping laptop looks like to a Node process once it wakes.
const sleepFor = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe('ActiveClock: awake time, leaving out host sleep (issue #586)', () => {
  let clock: ActiveClock;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = new ActiveClock();
  });
  afterEach(() => {
    clock.stop();
    vi.useRealTimers();
  });

  it('counts time awake as it passes', () => {
    const watch = clock.stopwatch();
    vi.advanceTimersByTime(25 * MIN);
    expect(watch.elapsedMs()).toBe(25 * MIN);
    expect(watch.sleptMs()).toBe(0);
  });

  it('leaves a sleep out, even when read before the tick has seen it', () => {
    const watch = clock.stopwatch();
    vi.advanceTimersByTime(10 * MIN);
    sleepFor(30 * MIN);
    // The tick that sees the gap counts its own 5 s as awake.
    expect(watch.elapsedMs()).toBe(10 * MIN + 5_000);
    expect(watch.sleptMs()).toBe(30 * MIN - 5_000);

    vi.advanceTimersByTime(5 * MIN);
    expect(watch.elapsedMs()).toBe(15 * MIN + 5_000);
  });

  it('counts a gap under a minute as awake, and never runs backwards when the wall clock is set back', () => {
    const watch = clock.stopwatch();
    sleepFor(30_000);
    expect(watch.elapsedMs()).toBe(30_000);
    vi.setSystemTime(Date.now() - 10 * MIN);
    expect(watch.elapsedMs()).toBe(30_000);
    vi.advanceTimersByTime(5_000);
    expect(watch.elapsedMs()).toBe(35_000);
  });

  it('only counts sleep while its tick runs: without it, a long gap just means nobody looked', () => {
    const watch = clock.stopwatch();
    clock.stop();
    sleepFor(30 * MIN);
    expect(watch.elapsedMs()).toBe(30 * MIN);
    expect(watch.sleptMs()).toBe(0);
  });

  it('tells listeners how long the host slept when it wakes, until they unsubscribe', () => {
    const slept = vi.fn();
    const unsubscribe = clock.onSlept(slept);
    sleepFor(20 * MIN);
    vi.advanceTimersByTime(5_000);
    expect(slept).toHaveBeenCalledExactlyOnceWith(20 * MIN);

    unsubscribe();
    sleepFor(20 * MIN);
    vi.advanceTimersByTime(5_000);
    expect(slept).toHaveBeenCalledTimes(1);
  });

  describe('setTimeout', () => {
    it('fires on time when nothing slept', () => {
      const fired = vi.fn();
      clock.setTimeout(fired, 120);
      vi.advanceTimersByTime(119);
      expect(fired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fired).toHaveBeenCalledOnce();
    });

    it('is put off by a sleep instead of firing when the host wakes', () => {
      const fired = vi.fn();
      clock.setTimeout(fired, 20 * MIN);
      vi.advanceTimersByTime(10 * MIN);
      sleepFor(30 * MIN);
      // 40 min on the wall clock, 10 min awake.
      vi.advanceTimersByTime(5_000);
      expect(fired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10 * MIN - 10_000);
      expect(fired).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(fired).toHaveBeenCalledOnce();
    });

    it('does not fire once cancelled', () => {
      const fired = vi.fn();
      const cancel = clock.setTimeout(fired, MIN);
      vi.advanceTimersByTime(30_000);
      cancel();
      vi.advanceTimersByTime(5 * MIN);
      expect(fired).not.toHaveBeenCalled();
    });
  });
});
