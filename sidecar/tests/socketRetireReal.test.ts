import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SocketModeClient } from '@slack/socket-mode';
import { ErrorCode } from '@slack/web-api';
import { retireSocketConnection } from '../src/slack/socketClient.js';

// Issue #587, against the real @slack/socket-mode client: socket-mode's own
// reconnect calls start() with no catch, so retiring a client must never make
// that start() reject — Node would end the sidecar on the unhandled
// rejection. And the private request hook a retired client is parked through
// must still be there: if a socket-mode upgrade renames it, this fails rather
// than the retire silently doing nothing.

type Internals = {
  webClient: {
    apps: { connections: { open: () => Promise<unknown> } };
    axios: { interceptors: { request: { handlers: unknown[] } } };
  };
};

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** How a promise stands after `ms`: still pending, or how it settled. */
function standing(promise: Promise<unknown>, ms: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>(resolve => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('retireSocketConnection with the real socket-mode client', () => {
  it('does not make a start() mid-handshake reject', async () => {
    // Accepts TCP but never answers the websocket upgrade: start() waits for a hello.
    const server = net.createServer(() => {});
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    const client = new SocketModeClient({ appToken: 'xapp-test', logLevel: 'error' as never });
    const internals = client as unknown as Internals;
    internals.webClient.apps.connections.open = async () => ({ ok: true, url: `ws://127.0.0.1:${port}/` });
    const started = client.start();
    await new Promise(resolve => setTimeout(resolve, 200));

    await retireSocketConnection(client as never, 1000);

    expect(await standing(started, 300)).toBe('pending');
  });

  it('does not make an apps.connections.open already under way reject when Slack refuses it', async () => {
    const client = new SocketModeClient({ appToken: 'xapp-test', logLevel: 'error' as never, clientPingTimeout: 50 });
    const internals = client as unknown as Internals;
    internals.webClient.apps.connections.open = () =>
      new Promise((_resolve, reject) =>
        setTimeout(() => {
          reject(Object.assign(new Error('internal_error'), { code: ErrorCode.PlatformError, data: { ok: false } }));
        }, 100),
      );
    const started = client.start();
    await new Promise(resolve => setTimeout(resolve, 20));

    await retireSocketConnection(client as never, 1000);

    expect(await standing(started, 400)).toBe('pending');
  });

  it('parks the retired client through the private request hook it still has', async () => {
    const client = new SocketModeClient({ appToken: 'xapp-test', logLevel: 'error' as never });
    const hooks = (client as unknown as Internals).webClient.axios.interceptors.request.handlers;
    const before = hooks.length;
    await retireSocketConnection(client as never, 50);
    expect(hooks.length).toBe(before + 1);
  });
});
