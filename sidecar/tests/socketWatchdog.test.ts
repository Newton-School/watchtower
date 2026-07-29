import { describe, expect, it, vi } from 'vitest';
import { SocketWatchdog } from '../src/slack/socketWatchdog.js';

// The watchdog turns catch-up recoveries into zombie-socket evidence: an
// event posted while the socket claimed to be connected, yet only surfaced by
// catch-up, must force a reconnect. Backlog from before the connection (the
// normal after-downtime catch-up) must not.

function makeWatchdog(overrides?: { reconnect?: () => Promise<void>; alert?: () => void }) {
  let nowMs = 1_000_000_000_000;
  const reconnects: number[] = [];
  const watchdog = new SocketWatchdog({
    reconnect:
      overrides?.reconnect ??
      (async () => {
        reconnects.push(nowMs);
      }),
    alert: overrides?.alert,
    now: () => nowMs,
  });
  return {
    watchdog,
    reconnects,
    advance: (ms: number) => {
      nowMs += ms;
    },
    nowSeconds: () => Math.floor(nowMs / 1000),
  };
}

describe('SocketWatchdog', () => {
  it('ignores recoveries of events from before the current connection', async () => {
    const { watchdog, reconnects, nowSeconds } = makeWatchdog();
    watchdog.markConnected();
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 3600}.000100`);
    await Promise.resolve();
    expect(reconnects.length).toBe(0);
  });

  it('ignores events inside the post-connect grace window', async () => {
    const { watchdog, reconnects, advance, nowSeconds } = makeWatchdog();
    watchdog.markConnected();
    advance(30_000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds()}.000100`);
    await Promise.resolve();
    expect(reconnects.length).toBe(0);
  });

  it('does nothing before markConnected (catch-up racing boot)', async () => {
    const { watchdog, reconnects, nowSeconds } = makeWatchdog();
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() + 999}.000100`);
    await Promise.resolve();
    expect(reconnects.length).toBe(0);
  });

  it('reconnects once on zombie evidence and debounces repeats within the cooldown', async () => {
    const alerts: number[] = [];
    const { watchdog, reconnects, advance, nowSeconds } = makeWatchdog({ alert: () => alerts.push(1) });
    watchdog.markConnected();
    advance(10 * 60 * 1000);

    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000100`);
    await vi.waitFor(() => expect(reconnects.length).toBe(1));
    expect(alerts.length).toBe(1);

    // Second piece of evidence 1 minute later: inside cooldown, no second restart.
    advance(60 * 1000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000200`);
    await Promise.resolve();
    expect(reconnects.length).toBe(1);
  });

  it('allows another reconnect after the cooldown when evidence post-dates the new connection', async () => {
    const { watchdog, reconnects, advance, nowSeconds } = makeWatchdog();
    watchdog.markConnected();
    advance(10 * 60 * 1000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000100`);
    await vi.waitFor(() => expect(reconnects.length).toBe(1));

    // markConnected ran on success — evidence must post-date the NEW connection.
    advance(10 * 60 * 1000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000200`);
    await vi.waitFor(() => expect(reconnects.length).toBe(2));
  });

  it('a failed reconnect clears the in-flight flag so a later attempt can run', async () => {
    let attempts = 0;
    const { watchdog, advance, nowSeconds } = makeWatchdog({
      reconnect: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('websocket refused');
        }
      },
    });
    watchdog.markConnected();
    advance(10 * 60 * 1000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000100`);
    await vi.waitFor(() => expect(attempts).toBe(1));

    advance(6 * 60 * 1000);
    watchdog.noteCatchupRecovery('C1', `${nowSeconds() - 10}.000200`);
    await vi.waitFor(() => expect(attempts).toBe(2));
  });
});
