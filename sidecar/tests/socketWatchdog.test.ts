import { describe, expect, it, vi } from 'vitest';
import { SocketWatchdog, type SocketAlert } from '../src/slack/socketWatchdog.js';

// Issue #587: after the host sleeps the Slack socket can stay dead for hours.
// The watchdog restarts it when the host wakes, when it stays closed, and when
// catch-up recovers a bot mention the socket should have delivered. Tags of
// the owner reach miniOG through catch-up by design and prove nothing.

function makeWatchdog(opts: { reconnect?: () => Promise<void> } = {}) {
  let nowMs = 1_800_000_000_000;
  const reconnects: number[] = [];
  const alerts: SocketAlert[] = [];
  const gaps: number[] = [];
  const watchdog = new SocketWatchdog({
    reconnect:
      opts.reconnect ??
      (async () => {
        reconnects.push(nowMs);
      }),
    alert: alert => {
      alerts.push(alert);
    },
    onGap: since => gaps.push(since),
    now: () => nowMs,
  });
  const advance = (ms: number) => {
    nowMs += ms;
  };
  // Time passing with the host awake: the watchdog's timer ticks every 15s.
  const awake = (ms: number) => {
    watchdog.tick();
    for (let left = ms; left > 0; left -= 15_000) {
      nowMs += Math.min(15_000, left);
      watchdog.tick();
    }
  };
  // A message posted `agoMs` before now, as a Slack ts.
  const ts = (agoMs: number) => ((nowMs - agoMs) / 1000).toFixed(6);
  return { watchdog, reconnects, alerts, gaps, advance, awake, ts, now: () => nowMs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SocketWatchdog: missed mentions', () => {
  it('restarts once, and alerts once, when catch-up finds a bot mention the socket never delivered', async () => {
    const { watchdog, reconnects, alerts, awake, ts } = makeWatchdog();
    watchdog.markConnected();
    awake(10 * 60 * 1000);

    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(1));
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

    // Still broken after the restart: restart again, no second alert.
    awake(5 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(2));
    expect(alerts.length).toBe(1);

    // The socket delivers again: the outage is over. A later one is news.
    watchdog.noteDelivered('C2', ts(0));
    awake(60 * 60 * 1000);
    watchdog.noteCatchupRecovery({ channelId: 'C3', eventTs: ts(90_000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(3));
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
  it('restarts the socket when the host wakes, sweeps from when it fell asleep, and does not alert', async () => {
    const { watchdog, reconnects, alerts, gaps, advance, now } = makeWatchdog();
    watchdog.markConnected();
    watchdog.tick();
    advance(15 * 1000);
    watchdog.tick();
    const asleepAt = Math.floor(now() / 1000);

    advance(45 * 60 * 1000); // lid closed: no ticks
    watchdog.tick();
    await vi.waitFor(() => expect(reconnects.length).toBe(1));
    expect(gaps).toEqual([asleepAt]);
    expect(alerts).toEqual([]);
  });

  it('does not take mentions sent while the host slept as a dead socket, even if catch-up runs first on waking', async () => {
    const { watchdog, reconnects, alerts, advance, ts } = makeWatchdog();
    watchdog.markConnected();
    watchdog.tick();
    advance(45 * 60 * 1000);
    // Catch-up's timer fires before the watchdog's on waking.
    watchdog.noteCatchupRecovery({ channelId: 'C1', eventTs: ts(20 * 60 * 1000), mentionType: 'bot' });
    await vi.waitFor(() => expect(reconnects.length).toBe(1)); // the wake restart
    expect(alerts).toEqual([]);
  });

  it('restarts a socket that stays closed, retries a failed restart with backoff, and alerts once after 10 minutes', async () => {
    let attempts = 0;
    const { watchdog, alerts, advance } = makeWatchdog({
      reconnect: async () => {
        attempts += 1;
        throw new Error('getaddrinfo ENOTFOUND slack.com');
      },
    });
    watchdog.markConnected();
    watchdog.tick();
    watchdog.markDisconnected();

    advance(60 * 1000);
    watchdog.tick();
    await settle();
    expect(attempts).toBe(0); // Bolt gets two minutes to reconnect by itself

    advance(75 * 1000);
    watchdog.tick();
    await vi.waitFor(() => expect(attempts).toBe(1));

    advance(15 * 1000);
    watchdog.tick();
    await settle();
    expect(attempts).toBe(1); // first retry waits 30s

    advance(15 * 1000);
    watchdog.tick();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(alerts).toEqual([]);

    for (let i = 0; i < 40; i += 1) {
      advance(15 * 1000);
      watchdog.tick();
      await settle();
    }
    expect(alerts).toEqual([{ reason: 'disconnected' }]);
    expect(attempts).toBeGreaterThan(2);
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
