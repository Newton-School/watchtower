import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';
import { buildThreadBlock } from '../src/agentic/agenticEntry.js';
import { formatThreadContextForClassifier } from '../src/workflows/shared/workflowUtils.js';
import { JobStore } from '../src/state/jobStore.js';
import type { AppConfig, NormalizedTask, NormalizedThreadMessage } from '../src/types/contracts.js';

// buildThreadBlock spawns nothing itself, but agenticEntry.ts pulls in the
// backend/runner modules at import time — stub them out like
// agenticEntryEffort.test.ts does so this suite stays hermetic.
vi.mock('../src/agentic/runClaude.js', () => ({ runClaudeAgentic: vi.fn() }));
vi.mock('../src/github/githubAuth.js', () => ({ resolveGithubTokenForCodex: vi.fn(async () => undefined) }));
vi.mock('../src/workspaces/workspaceManager.js', () => ({
  refreshSharedRepoToDefaultBranch: vi.fn(async () => ({ branch: 'main', head: 'abc123' })),
}));
vi.mock('../src/backends/registry.js', () => ({ getBackend: () => ({ isAvailable: () => true }) }));
vi.mock('../src/slack/imageUploader.js', () => ({
  parseScreenshotManifest: (reply: string) => ({ visibleText: reply, screenshots: [] }),
  uploadScreenshots: vi.fn(async () => 0),
}));

const BOT_USER_ID = 'UBOT';
const CHANNEL = 'C123';

// Recent epoch base so tsClock renders and any recency math sees fresh messages.
const BASE_EPOCH = Math.floor(Date.now() / 1000) - 3600;

function ts(offsetSeconds: number): string {
  return `${BASE_EPOCH + offsetSeconds}.000100`;
}

const THREAD_TS = ts(0);
const TRIGGER_TS = ts(500);

const config = { botUserId: BOT_USER_ID } as AppConfig;

function makeTask(opts?: { threadMessages?: NormalizedThreadMessage[]; text?: string }): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      eventTs: TRIGGER_TS,
      userId: 'U111',
      text: opts?.text ?? 'when did this go live?',
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: false,
    isCoreDevAuthor: false,
    intent: 'INFORMATIONAL',
    threadMessages: opts?.threadMessages,
  };
}

function makeSlack(impl?: () => Promise<unknown>): { slack: WebClient; replies: ReturnType<typeof vi.fn> } {
  const replies = vi.fn(impl ?? (async () => ({ messages: [] })));
  const slack = { conversations: { replies } } as unknown as WebClient;
  return { slack, replies };
}

describe('buildThreadBlock', () => {
  let dbDir: string;
  let store: JobStore;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-threadblock-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('renders intake threadMessages oldest-first with speaker labels, excluding the trigger', async () => {
    store.dossierStore().firstSeen({ userId: 'U111', displayName: 'dipesh' });
    const task = makeTask({
      threadMessages: [
        { text: 'the banner is broken on prod', user: 'U111', ts: ts(10) },
        { text: 'looking into it now', user: BOT_USER_ID, ts: ts(20) },
        { text: 'deploy notification', user: '', ts: ts(30), subtype: 'bot_message', botId: 'B999' },
        { text: 'any update here?', user: 'U999', ts: ts(40) },
        { text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS },
      ],
    });
    const { slack, replies } = makeSlack();

    const block = await buildThreadBlock({ task, config, slack, store });

    expect(
      block.startsWith("=== THREAD SO FAR (oldest first; the user's current message follows separately) ==="),
    ).toBe(true);
    expect(block.endsWith('=== END THREAD ===')).toBe(true);
    expect(block).toContain('dipesh: the banner is broken on prod');
    expect(block).toContain('miniOG: looking into it now');
    expect(block).toContain('miniOG: deploy notification');
    expect(block).toContain('U999: any update here?');
    expect(block).not.toContain('when did this go live?');
    expect(block.indexOf('the banner is broken')).toBeLessThan(block.indexOf('looking into it now'));
    expect(block.indexOf('looking into it now')).toBeLessThan(block.indexOf('any update here?'));
    expect(replies).not.toHaveBeenCalled();
  });

  it('clips a single message to 500 chars with an ellipsis', async () => {
    const task = makeTask({
      threadMessages: [{ text: `start-marker ${'x'.repeat(600)}`, user: 'U222', ts: ts(10) }],
    });
    const { slack } = makeSlack();

    const block = await buildThreadBlock({ task, config, slack, store });

    expect(block).toContain('start-marker');
    expect(block).toContain('…');
    const line = block.split('\n').find(l => l.includes('start-marker'));
    expect(line).toBeDefined();
    expect(line?.endsWith('…')).toBe(true);
    // 500 kept chars + the ellipsis, never the full 600-char tail.
    expect(line).not.toContain('x'.repeat(501));
  });

  it('falls back to the conversation store when intake messages are empty, without calling Slack', async () => {
    const conversations = store.conversationStore();
    conversations.recordMessages({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      channelType: 'channel',
      messages: [
        { messageTs: ts(10), userId: 'U333', displayName: 'Shiv', isBot: false, text: 'ship the fix today?' },
        { messageTs: ts(20), userId: BOT_USER_ID, isBot: true, text: 'PR is up for review' },
        { messageTs: TRIGGER_TS, userId: 'U111', isBot: false, text: 'when did this go live?' },
      ],
    });
    const { slack, replies } = makeSlack();

    const block = await buildThreadBlock({ task: makeTask({ threadMessages: [] }), config, slack, store });

    expect(block).toContain('Shiv: ship the fix today?');
    expect(block).toContain('miniOG: PR is up for review');
    expect(block).not.toContain('when did this go live?');
    expect(replies).not.toHaveBeenCalled();
  });

  it('skips a forgotten thread and falls through to the Slack fetch', async () => {
    const conversations = store.conversationStore();
    conversations.recordMessages({
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      messages: [{ messageTs: ts(10), userId: 'U333', isBot: false, text: 'pre-forget message' }],
    });
    conversations.forgetThread(CHANNEL, THREAD_TS);
    const { slack, replies } = makeSlack(async () => ({
      messages: [
        { text: 'fetched from slack', user: 'U444', ts: ts(15) },
        { text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS },
      ],
    }));

    const block = await buildThreadBlock({ task: makeTask(), config, slack, store });

    expect(replies).toHaveBeenCalledTimes(1);
    expect(block).toContain('U444: fetched from slack');
    expect(block).not.toContain('pre-forget message');
  });

  it('fetches from Slack as a last resort and labels bot-subtype messages miniOG', async () => {
    const { slack, replies } = makeSlack(async () => ({
      messages: [
        { text: 'root question', user: 'U555', ts: ts(10) },
        { text: 'automated reply', user: '', ts: ts(20), subtype: 'bot_message', bot_id: 'B42' },
        { text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS },
      ],
    }));

    const block = await buildThreadBlock({ task: makeTask(), config, slack, store });

    expect(replies).toHaveBeenCalledWith({ channel: CHANNEL, ts: THREAD_TS, inclusive: true, limit: 200 });
    expect(block).toContain('U555: root question');
    expect(block).toContain('miniOG: automated reply');
    expect(block).not.toContain('when did this go live?');
  });

  it('returns an empty string when the Slack fetch fails', async () => {
    const { slack } = makeSlack(async () => {
      throw new Error('ratelimited');
    });

    const block = await buildThreadBlock({ task: makeTask(), config, slack, store });

    expect(block).toBe('');
  });

  it('returns an empty string when the thread holds only the trigger (no framing-only noise)', async () => {
    const task = makeTask({
      threadMessages: [
        { text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS },
        { text: '   ', user: 'U999', ts: ts(5) },
      ],
    });
    const { slack, replies } = makeSlack();

    const block = await buildThreadBlock({ task, config, slack, store });

    expect(block).toBe('');
    expect(replies).not.toHaveBeenCalled();
  });

  it('keeps only the last 25 prior messages', async () => {
    const threadMessages: NormalizedThreadMessage[] = [];
    for (let i = 0; i < 30; i++) {
      threadMessages.push({ text: `note-${String(i).padStart(2, '0')}`, user: 'U777', ts: ts(10 + i) });
    }
    threadMessages.push({ text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS });
    const { slack } = makeSlack();

    const block = await buildThreadBlock({ task: makeTask({ threadMessages }), config, slack, store });

    expect(block).not.toContain('note-04');
    expect(block).toContain('note-05');
    expect(block).toContain('note-29');
    // 25 message lines framed by the two marker lines.
    expect(block.split('\n')).toHaveLength(27);
  });

  it('drops oldest messages to fit the ~4800-char budget', async () => {
    const threadMessages: NormalizedThreadMessage[] = [];
    for (let i = 0; i < 12; i++) {
      threadMessages.push({
        text: `pad-${String(i).padStart(2, '0')} ${'x'.repeat(600)}`,
        user: 'U1',
        ts: ts(10 + i),
      });
    }
    threadMessages.push({ text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS });
    const { slack } = makeSlack();

    const block = await buildThreadBlock({ task: makeTask({ threadMessages }), config, slack, store });

    const lines = block.split('\n');
    const body = lines.slice(1, -1);
    expect(body.join('\n').length).toBeLessThanOrEqual(4800);
    expect(body.length).toBeLessThan(12);
    expect(block).not.toContain('pad-00');
    expect(block).not.toContain('pad-01');
    expect(block).toContain('pad-11');
  });
});

describe('formatThreadContextForClassifier', () => {
  it('returns undefined when there are no prior messages', () => {
    expect(formatThreadContextForClassifier(makeTask())).toBeUndefined();
    expect(
      formatThreadContextForClassifier(
        makeTask({ threadMessages: [{ text: 'when did this go live?', user: 'U111', ts: TRIGGER_TS }] }),
      ),
    ).toBeUndefined();
  });

  it('renders only the last 6 prior messages, excluding the trigger', () => {
    const threadMessages: NormalizedThreadMessage[] = [];
    for (let i = 0; i < 8; i++) {
      threadMessages.push({ text: `ctx-${i}`, user: `U${i}`, ts: ts(10 + i) });
    }
    threadMessages.push({ text: 'the banner pls check the complete thread', user: 'U111', ts: TRIGGER_TS });

    const rendered = formatThreadContextForClassifier(makeTask({ threadMessages }));

    expect(rendered).toBeDefined();
    const lines = rendered?.split('\n') ?? [];
    expect(lines).toHaveLength(6);
    expect(rendered).not.toContain('ctx-0');
    expect(rendered).not.toContain('ctx-1');
    expect(lines[0]).toBe('[U2] ctx-2');
    expect(lines[5]).toBe('[U7] ctx-7');
    expect(rendered).not.toContain('the banner pls check');
  });

  it('clips each message to 200 chars with an ellipsis', () => {
    const rendered = formatThreadContextForClassifier(
      makeTask({ threadMessages: [{ text: `clip-me ${'y'.repeat(300)}`, user: 'U9', ts: ts(10) }] }),
    );

    expect(rendered).toBeDefined();
    expect(rendered?.startsWith('[U9] clip-me')).toBe(true);
    expect(rendered?.endsWith('…')).toBe(true);
    // '[U9] ' + 200 kept chars + ellipsis
    expect(rendered).toHaveLength(5 + 200 + 1);
  });
});
