import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/types/contracts.js';

// Issue #587: a restart closes the old Socket Mode connection before opening a
// new one. A dead connection never answers the close frame, so it is dropped
// after a grace period; a retired client stops retrying for good; the new App
// gets the same handlers once, and the connection-state listeners move to it.

const bolt = vi.hoisted(() => ({
  apps: [] as Array<{
    opts: Record<string, unknown>;
    registrations: string[];
    starts: number;
    client: { auth: { test: () => Promise<{ bot_id: string; user_id: string }> } };
  }>,
  receivers: [] as Array<{ client: EventEmitter & { disconnects: number } }>,
  authTests: 0,
}));

vi.mock('@slack/bolt', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeSocketClient extends Emitter {
    disconnects = 0;
    disconnect() {
      this.disconnects += 1;
      this.emit('disconnected'); // as the real client does once closed
      return Promise.resolve();
    }
  }
  class SocketModeReceiver {
    client = new FakeSocketClient();
    constructor() {
      bolt.receivers.push(this as never);
    }
  }
  class App {
    registrations: string[] = [];
    starts = 0;
    client = {
      auth: {
        test: async () => {
          bolt.authTests += 1;
          return { bot_id: 'B1', user_id: 'UBOT' };
        },
      },
    };
    constructor(public opts: Record<string, unknown>) {
      bolt.apps.push(this as never);
    }
    event(name: string) {
      this.registrations.push(`event:${name}`);
    }
    command(name: string) {
      this.registrations.push(`command:${name}`);
    }
    action() {
      this.registrations.push('action');
    }
    shortcut() {
      this.registrations.push('shortcut');
    }
    async start() {
      this.starts += 1;
    }
  }
  const exports = { App, SocketModeReceiver, LogLevel: { INFO: 'info' } };
  return { ...exports, default: exports };
});

const { retireSocketConnection, SocketSlackClient } = await import('../src/slack/socketClient.js');

class FakeConnection extends EventEmitter {
  disconnects = 0;
  terminated = false;
  autoReconnectEnabled = true;
  interceptors: Array<() => unknown> = [];
  webClient = { axios: { interceptors: { request: { use: (fn: () => unknown) => this.interceptors.push(fn) } } } };
  websocket: { terminate: () => void } | null = { terminate: () => (this.terminated = true) };
  constructor(private readonly answersClose: boolean) {
    super();
  }
  disconnect(): Promise<void> {
    this.disconnects += 1;
    if (!this.answersClose) return new Promise(() => {});
    this.emit('disconnected'); // as the real client does once closed
    return Promise.resolve();
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

  it('stops the client retrying without making its start() reject: requests park, disconnected listeners go', async () => {
    const socket = new FakeConnection(true);
    let startRejected = false;
    socket.on('disconnected', () => (startRejected = true)); // what a pending start() listens with
    await retireSocketConnection(socket, 50);
    socket.emit('disconnected');
    expect(startRejected).toBe(false);
    expect(socket.autoReconnectEnabled).toBe(true); // off would make a failed apps.connections.open throw
    expect(socket.interceptors.length).toBe(1);
    const parked = socket.interceptors[0]() as Promise<unknown>;
    const settled = await Promise.race([
      parked.then(
        () => 'settled',
        () => 'settled',
      ),
      Promise.resolve('pending'),
    ]);
    expect(settled).toBe('pending');
  });
});

describe('SocketSlackClient.restart', () => {
  const config = { slackBotToken: 'xoxb-test', slackAppToken: 'xapp-test', botUserId: 'UBOT' } as AppConfig;
  const handlers = [
    'event:app_mention',
    'event:message',
    'event:reaction_added',
    'action',
    'command:/miniog',
    'command:/wt',
    'command:/watchtower',
    'shortcut',
  ];

  it('moves the connection listeners and the handlers to a fresh App, once each', async () => {
    bolt.apps.length = 0;
    bolt.receivers.length = 0;
    bolt.authTests = 0;
    const states: string[] = [];
    const client = new SocketSlackClient(
      config,
      async () => {},
      async () => {},
      state => states.push(state),
    );
    const firstWebClient = client.webClient;
    expect(bolt.apps[0].registrations.sort()).toEqual([...handlers].sort());
    bolt.receivers[0].client.emit('connected');
    expect(states).toEqual(['connected']);

    await client.restart();

    expect(bolt.apps.length).toBe(2);
    expect(bolt.apps[1].registrations.sort()).toEqual([...handlers].sort());
    expect(bolt.apps[0].registrations.length).toBe(handlers.length); // the old App got nothing new
    expect(bolt.apps[1].starts).toBe(1);
    // The new App is told who the bot is, so it does not check the token again.
    expect(bolt.apps[1].opts).toMatchObject({ botId: 'B1', botUserId: 'UBOT', receiver: bolt.receivers[1] });
    expect(bolt.receivers[0].client.disconnects).toBe(1);

    // The old client no longer reports state; the new one does.
    bolt.receivers[0].client.emit('close');
    bolt.receivers[1].client.emit('close');
    bolt.receivers[1].client.emit('connected');
    expect(states).toEqual(['connected', 'closed', 'connected']);

    // Callers keep one Web API client across restarts, and the bot is looked up once.
    await client.restart();
    expect(client.webClient).toBe(firstWebClient);
    expect(bolt.authTests).toBe(1);
    expect(bolt.apps.length).toBe(3);
  });
});
