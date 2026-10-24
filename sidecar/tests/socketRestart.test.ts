import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { retireSocketConnection } from '../src/slack/socketClient.js';

// Issue #587: a restart closes the old Socket Mode connection before opening a
// new one. A dead connection never answers the close frame, so it is dropped
// after a grace period instead of holding the restart for half a minute.

class FakeConnection extends EventEmitter {
  disconnects = 0;
  terminated = false;
  websocket: { terminate: () => void } | null = { terminate: () => (this.terminated = true) };
  constructor(private readonly answersClose: boolean) {
    super();
  }
  disconnect(): Promise<void> {
    this.disconnects += 1;
    return this.answersClose ? Promise.resolve() : new Promise(() => {});
  }
}

describe('retireSocketConnection', () => {
  it('closes a live connection without dropping it', async () => {
    const socket = new FakeConnection(true);
    await retireSocketConnection(socket, 50);
    expect(socket.disconnects).toBe(1);
    expect(socket.terminated).toBe(false);
  });

  it('drops a dead connection that never answers the close', async () => {
    const socket = new FakeConnection(false);
    await retireSocketConnection(socket, 20);
    expect(socket.terminated).toBe(true);
  });

  it('closes it again if a reconnect already under way connects anyway', async () => {
    const socket = new FakeConnection(true);
    await retireSocketConnection(socket, 50);
    socket.emit('connected');
    expect(socket.disconnects).toBe(2);
  });
});
