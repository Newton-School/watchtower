import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveClock } from '../src/runtime/activeClock.js';
import { SocketWatchdog, type SocketAlert, type SocketRestartReason } from '../src/slack/socketWatchdog.js';

// Issue #587: after the host sleeps the Slack socket can stay dead for hours.
// The watchdog restarts it when the host wakes (activeClock, the process's one
// sleep detector, says so), when it stays closed for two awake minutes, and
// when catch-up recovers a bot mention the socket should have delivered. Tags
// of the owner and edits reach miniOG through catch-up by design and prove
// nothing.

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function makeWatchdog(opts: { reconnect?: () => Promise<void> } = {}) {
  let nowMs = 1_800_000_000_000;
  const clock = new ActiveClock(() => nowMs);
  const reconnects: SocketRestartReason[] = [];
  const alerts: SocketAlert[] = [];
  const gaps: number[] = [];
  const watchdog = new SocketWatchdog({
    reconnect: async reason => {
      reconnects.push(reason);
      await opts.reconnect?.();
    },
    alert: alert => {
      alerts.push(alert);
    },
    onGap: since => gaps.push(since),
    now: () => nowMs,
    clock,
  });
  watchdog.start();
  stops.push(() => {
    watchdog.stop();
    clock.stop();
  });
  // Time passing with the host awake: the watchdog's checks run every 15s.
  const awake = (ms: number) => {
    watchdog.tick();
    for (let left = ms; left > 0; left -= 15_000) {
      nowMs += Math.min(15_000, left);
      watchdog.tick();
    }
  };
  // The lid shut: nothing runs until it opens.
  const sleep = (ms: number) => {
    nowMs += ms;
  };
  // A message posted `agoMs` before now, as a Slack ts.
  const ts = (agoMs: number) => ((nowMs - agoMs) / 1000).toFixed(6);
  return { watchdog, reconnects, alerts, gaps, awake, sleep, ts, now: () => nowMs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SocketWatchdog: missed mentions', () => {
  it('restarts once, and alerts once, when catch-up finds a bot mention the socket never delivered', async () => {
    const { watchdog, reconnects, alerts, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);

    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects).toEqual(['missed_event']));
    await settle(); // the restart finishes
    expect(alerts).toEqual([{ reason: 'missed_event', channelId: 'C1' }]);

    // More evidence a minute later: inside the cooldown, and already alerted.
    awake(60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(70_000), mentionType: 'bot' });
    await settle();
    expect(reconnects.length).toBe(1);
    expect(alerts.length).toBe(1);
  });

  it('never counts a tag of the owner: those arrive through catch-up by design', async () => {
    const { watchdog, reconnects, alerts, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'owner' });
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'none' });
    await settle();
    expect(reconnects).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('never counts an edit that added the mention: Slack sends no app_mention for an edit', async () => {
    const { watchdog, reconnects, alerts, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot', edited: true });
    await settle();
    expect(reconnects).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('ignores the backlog from before this connection, the first minute after it, and anything too fresh', async () => {
    const { watchdog, reconnects, awake, ts } = makeWatchdog();
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' }); // not connected yet
    watchdog.markConnected();
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(3_600_000), mentionType: 'bot' }); // before it
    awake(30 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(0), mentionType: 'bot' }); // inside the grace
    awake(10 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(20_000), mentionType: 'bot' }); // may still be in flight
    await settle();
    expect(reconnects).toEqual([]);
  });

  it('ignores a message the socket did deliver', async () => {
    const { watchdog, reconnects, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);
    const delivered = ts(90_000);
    watchdog.noteDelivered('C1', delivered);
    expect(watchdog.wasDelivered('C1', delivered)).toBe(true);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: delivered, mentionType: 'bot' });
    await settle();
    expect(reconnects).toEqual([]);
  });

  it('alerts again only for a new outage: after a connection made since the alert has delivered a message', async () => {
    const { watchdog, reconnects, alerts, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(1));
    await settle(); // the restart finishes

    // Still broken after the restart: restart again, no second alert.
    awake(5 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(2));
    await settle(); // the restart finishes
    expect(alerts.length).toBe(1);

    // The socket delivers again: the outage is over. A later one is news.
    watchdog.noteDelivered('C2', ts(0));
    awake(60 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C3', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(3));
    await settle(); // the restart finishes
    expect(alerts).toEqual([
      { reason: 'missed_event', channelId: 'C1' },
      { reason: 'missed_event', channelId: 'C3' },
    ]);
  });

  it('asks catch-up to sweep threads from the last message the socket delivered', async () => {
    const { watchdog, gaps, awake, ts, now } = makeWatchdog();
    watchdog.markConnected();
    awake(5 * 60 * 1000);
    watchdog.noteDelivered('C1', ts(0));
    const lastLive = Math.floor(now() / 1000);
    awake(10 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(gaps).toEqual([lastLive]));
  });
});

describe('SocketWatchdog: wake and a closed socket', () => {
  it('restarts a socket that closed before the lid shut, sweeps from the sleep, and does not alert', async () => {
    const { watchdog, reconnects, alerts, gaps, awake, sleep, now } = makeWatchdog();
    watchdog.markConnected();
    awake(60 * 1000);
    watchdog.markDisconnected(); // Wi-Fi dropped, then the lid shut
    const asleepAt = Math.floor(now() / 1000);

    sleep(45 * 60 * 1000);
    awake(15 * 1000);
    await vi.waitFor(() => expect(reconnects).toEqual(['wake']));
    await settle(); // the restart finishes
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toBeLessThanOrEqual(asleepAt);
    expect(alerts).toEqual([]);
  });

  it('does not take mentions sent while the host slept as a dead socket, even if catch-up runs first on waking', async () => {
    const { watchdog, reconnects, alerts, awake, sleep, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(60 * 1000);
    sleep(45 * 60 * 1000);
    // Catch-up's timer fires before the clock's tick on waking.
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(20 * 60 * 1000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects).toEqual(['wake']));
    await settle(); // the restart finishes
    expect(alerts).toEqual([]);
  });

  it('does not count slept time as downtime, nor alert before a restart has failed', async () => {
    let fail = true;
    const { watchdog, reconnects, alerts, awake, sleep } = makeWatchdog({
      reconnect: async () => {
        if (fail) throw new Error('getaddrinfo ENOTFOUND slack.com');
      },
    });
    watchdog.markConnected();
    awake(60 * 1000);
    watchdog.markDisconnected();
    sleep(45 * 60 * 1000);
    awake(15 * 1000);
    await vi.waitFor(() => expect(reconnects).toEqual(['wake']));
    await settle(); // the restart finishes
    await settle();
    // One failed restart, but the socket has been down for seconds of awake time.
    expect(alerts).toEqual([]);
    fail = false;
    awake(30 * 1000);
    await vi.waitFor(() => expect(reconnects).toEqual(['wake', 'wake']));
    await settle(); // the restart finishes
    expect(alerts).toEqual([]);
  });

  it('restarts a socket that stays closed for two awake minutes, retries with backoff, and alerts once after 10', async () => {
    const { watchdog, reconnects, alerts, awake } = makeWatchdog({
      reconnect: async () => {
        throw new Error('getaddrinfo ENOTFOUND slack.com');
      },
    });
    watchdog.markConnected();
    awake(60 * 1000);
    watchdog.markDisconnected();

    awake(105 * 1000);
    await settle();
    expect(reconnects).toEqual([]); // Bolt gets two minutes to reconnect by itself

    awake(15 * 1000);
    await vi.waitFor(() => expect(reconnects).toEqual(['disconnected']));
    await settle(); // the restart finishes

    awake(15 * 1000);
    await settle();
    expect(reconnects.length).toBe(1); // the first retry waits 30s

    awake(15 * 1000);
    await vi.waitFor(() => expect(reconnects).toEqual(['disconnected', 'disconnected']));
    await settle(); // the restart finishes
    expect(alerts).toEqual([]);

    for (let i = 0; i < 40; i += 1) {
      awake(15 * 1000);
      await settle();
    }
    expect(alerts).toEqual([{ reason: 'disconnected' }]);
    expect(reconnects.length).toBeGreaterThan(2);
  });

  it('leaves a socket alone when Bolt reconnects it in time', async () => {
    const { watchdog, reconnects, awake } = makeWatchdog();
    watchdog.markConnected();
    watchdog.markDisconnected();
    awake(10 * 1000);
    watchdog.markConnected();
    awake(5 * 60 * 1000);
    await settle();
    expect(reconnects).toEqual([]);
  });
});
