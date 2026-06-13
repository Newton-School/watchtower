import { describe, expect, it } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { fetchChannelHistory } from '../src/slack/mentionCatchup.js';

// A WebClient stub whose conversations.history always returns a full page and a
// non-empty cursor — i.e. an infinite backlog. Without the per-channel cap the
// pagination loop would never terminate; the cap must stop it.
function infiniteHistoryClient(pageSize: number): { client: WebClient; calls: () => number } {
  let calls = 0;
  const client = {
    conversations: {
      history: async () => {
        calls += 1;
        return {
          messages: Array.from({ length: pageSize }, (_unused, i) => ({ ts: `${calls}.${i}` })),
          response_metadata: { next_cursor: `cursor-${calls}` },
        };
      },
    },
  } as unknown as WebClient;
  return { client, calls: () => calls };
}

describe('fetchChannelHistory per-channel cap', () => {
  it('stops paginating once the per-channel ceiling is reached', async () => {
    // Page size 200, cap 1000 → 5 pages then break, even though the cursor never empties.
    const { client, calls } = infiniteHistoryClient(200);
    const messages = await fetchChannelHistory(client, 'C1', 0);
    expect(messages.length).toBe(1000);
    expect(calls()).toBe(5);
  });

  it('returns everything when the backlog ends before the cap', async () => {
    let calls = 0;
    const client = {
      conversations: {
        history: async () => {
          calls += 1;
          // One short page, no further cursor.
          return { messages: [{ ts: '1.1' }, { ts: '1.2' }], response_metadata: {} };
        },
      },
    } as unknown as WebClient;
    const messages = await fetchChannelHistory(client, 'C1', 0);
    expect(messages.length).toBe(2);
    expect(calls).toBe(1);
  });
});
