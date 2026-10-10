import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: vi.fn(() => 'claude-code'),
}));
vi.mock('../src/codex/modelProfiles.js', () => ({
  lightweightProfile: vi.fn(() => ({ model: 'haiku-test', reasoningEffort: 'low' })),
}));

import { runCodex } from '../src/codex/runCodex.js';
import { JobStore } from '../src/state/jobStore.js';
import {
  buildTranscriptSample,
  fallbackTitle,
  startThreadSynthesizerScheduler,
  stopThreadSynthesizerScheduler,
  synthesizeThread,
  SYNTHESIS_MAX_TRANSCRIPT_CHARS,
  TITLE_MAX_CHARS,
  __resetThreadSynthesizerSchedulerForTests,
} from '../src/conversation/threadSynthesizer.js';
import type { CapturedMessage, ConversationMessageRow } from '../src/state/conversationStore.js';
import type { CodexRunResult } from '../src/types/contracts.js';

const BASE_EPOCH = Math.floor(Date.now() / 1000) - 3600;

function ts(offset: number): string {
  return `${BASE_EPOCH + offset}.000100`;
}

function captured(i: number, text?: string): CapturedMessage {
  const isBot = i % 2 === 1;
  return {
    messageTs: ts(i),
    userId: isBot ? 'B01' : 'U1',
    displayName: isBot ? 'miniOG' : 'theOG',
    isBot,
    text: text ?? `message number ${i} about the deploy pipeline`,
  };
}

const cleanups: Array<() => void> = [];

function createStore(): JobStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-thread-synth-'));
  const store = new JobStore(path.join(dir, 'watchtower.db'));
  cleanups.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seedThread(store: JobStore, count: number, startAt = 0): number {
  const result = store.conversationStore().recordMessages({
    channelId: 'C100',
    threadTs: ts(0),
    channelName: 'eng-updates',
    messages: Array.from({ length: count }, (_, i) => captured(startAt + i)),
  });
  if ('skipped' in result) throw new Error('unexpected skip while seeding');
  return result.threadId;
}

function codexResult(overrides: Partial<CodexRunResult>): CodexRunResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '',
    stderr: '',
    lastMessage: '',
    durationMs: 10,
    backend: 'claude-code',
    ...overrides,
  };
}

function msgRow(i: number, text: string, opts?: { isBot?: boolean }): ConversationMessageRow {
  return {
    id: i + 1,
    threadId: 1,
    channelId: 'C100',
    threadTs: ts(0),
    messageTs: ts(i),
    userId: opts?.isBot ? 'B01' : 'U1',
    displayName: opts?.isBot ? 'miniOG' : 'theOG',
    isBot: opts?.isBot ?? false,
    subtype: undefined,
    text,
    files: [],
    edited: false,
    capturedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  vi.mocked(runCodex).mockReset();
});

describe('synthesizeThread — guardrails', () => {
  it('returns not-found for an unknown thread id', async () => {
    const store = createStore();
    const out = await synthesizeThread({ threadId: 9999, store });
    expect(out).toEqual({ ok: false, reason: 'not-found' });
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('skips threads with fewer than the minimum messages', async () => {
    const store = createStore();
    const threadId = seedThread(store, 3);
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: false, reason: 'too-few-messages' });
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('skips when fewer than the minimum new messages arrived since the last synthesis', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    store.conversationStore().saveSynthesis(threadId, {
      title: 'Old title',
      summary: 'Old summary',
      decisions: [],
      actionItems: [],
      messageCount: 4,
    });
    seedThread(store, 2, 4); // delta of 2 < SYNTHESIS_MIN_NEW_MESSAGES
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: false, reason: 'no-new-messages' });
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('skips when the last synthesis is within the recency window', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    store.conversationStore().saveSynthesis(threadId, {
      title: 'Old title',
      summary: 'Old summary',
      decisions: [],
      actionItems: [],
      messageCount: 4,
    });
    seedThread(store, 3, 4); // delta of 3 passes the new-messages gate
    const out = await synthesizeThread({ threadId, store, now: new Date() });
    expect(out).toEqual({ ok: false, reason: 'too-recent' });
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('force:true bypasses the delta and recency guards', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    store.conversationStore().saveSynthesis(threadId, {
      title: 'Old title',
      summary: 'Old summary',
      decisions: [],
      actionItems: [],
      messageCount: 4,
    });
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: { title: 'Forced title', summary: 'Forced summary', decisions: [], action_items: [] },
      }),
    );
    const out = await synthesizeThread({ threadId, store, now: new Date(), force: true });
    expect(out).toEqual({ ok: true, title: 'Forced title', summary: 'Forced summary', decisions: [], actionItems: [] });
    expect(runCodex).toHaveBeenCalledTimes(1);
  });
});

describe('synthesizeThread — happy path', () => {
  it('persists title, summary, decisions, and action items to the thread row', async () => {
    const store = createStore();
    const threadId = seedThread(store, 5);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: {
          title: 'GA4 NSAT metric investigation',
          summary: 'theOG asked about NSAT numbers; miniOG traced them to a GA4 misconfig.',
          decisions: ['Use GA4 as the NSAT source of truth'],
          action_items: ['theOG to update the dashboard'],
        },
      }),
    );

    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({
      ok: true,
      title: 'GA4 NSAT metric investigation',
      summary: 'theOG asked about NSAT numbers; miniOG traced them to a GA4 misconfig.',
      decisions: ['Use GA4 as the NSAT source of truth'],
      actionItems: ['theOG to update the dashboard'],
    });

    const request = vi.mocked(runCodex).mock.calls[0][0];
    expect(request.prompt).toContain('#eng-updates');
    expect(request.model).toBe('haiku-test');

    const thread = store.conversationStore().getThreadById(threadId);
    expect(thread?.title).toBe('GA4 NSAT metric investigation');
    expect(thread?.summary).toBe('theOG asked about NSAT numbers; miniOG traced them to a GA4 misconfig.');
    expect(thread?.decisions).toEqual(['Use GA4 as the NSAT source of truth']);
    expect(thread?.actionItems).toEqual(['theOG to update the dashboard']);
    expect(thread?.synthesizedMessageCount).toBe(5);
    expect(thread?.synthesizedAt).toBeTruthy();
  });

  it('clamps the title to the max title length', async () => {
    const store = createStore();
    const threadId = seedThread(store, 5);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: { title: 'x'.repeat(100), summary: 'A summary.', decisions: [], action_items: [] },
      }),
    );
    const out = await synthesizeThread({ threadId, store });
    if (!out.ok) throw new Error('expected ok outcome');
    expect(out.title).toBe('x'.repeat(TITLE_MAX_CHARS));
    expect(store.conversationStore().getThreadById(threadId)?.title).toBe('x'.repeat(TITLE_MAX_CHARS));
  });

  it('drops non-string and blank entries from decisions and action items', async () => {
    const store = createStore();
    const threadId = seedThread(store, 5);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: {
          title: 'Cleanup test',
          summary: 'A summary.',
          decisions: ['keep this', 42, null, '  trim me  ', ''],
          action_items: ['do the thing', { owner: 'theOG' }, false],
        },
      }),
    );
    const out = await synthesizeThread({ threadId, store });
    if (!out.ok) throw new Error('expected ok outcome');
    expect(out.decisions).toEqual(['keep this', 'trim me']);
    expect(out.actionItems).toEqual(['do the thing']);
    const thread = store.conversationStore().getThreadById(threadId);
    expect(thread?.decisions).toEqual(['keep this', 'trim me']);
    expect(thread?.actionItems).toEqual(['do the thing']);
  });
});

describe('synthesizeThread — JSON in text output', () => {
  it('parses a fenced JSON object from lastMessage when parsedJson is absent', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        lastMessage: '```json\n{"title":"Fenced title","summary":"From text","decisions":[],"action_items":[]}\n```',
      }),
    );
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: true, title: 'Fenced title', summary: 'From text', decisions: [], actionItems: [] });
  });

  it('parses a bare JSON object embedded in surrounding prose', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        lastMessage: 'Here you go: {"title":"Plain title","summary":"Also text","decisions":["d1"],"action_items":[]}',
      }),
    );
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: true, title: 'Plain title', summary: 'Also text', decisions: ['d1'], actionItems: [] });
  });

  it('unwraps JSON carried in a parsedJson.result string (claude-code wrapper shape)', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(
      codexResult({
        parsedJson: {
          result: '{"title":"Wrapped title","summary":"From result field","decisions":[],"action_items":[]}',
        },
      }),
    );
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({
      ok: true,
      title: 'Wrapped title',
      summary: 'From result field',
      decisions: [],
      actionItems: [],
    });
  });
});

describe('synthesizeThread — failure modes', () => {
  it('returns empty-output on unparseable text and leaves the existing synthesis untouched', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    store.conversationStore().saveSynthesis(threadId, {
      title: 'Existing title',
      summary: 'Existing summary',
      decisions: ['old decision'],
      actionItems: ['old item'],
      messageCount: 4,
    });
    seedThread(store, 3, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(codexResult({ lastMessage: 'total garbage with no braces at all' }));

    const out = await synthesizeThread({ threadId, store, force: true });
    expect(out).toEqual({ ok: false, reason: 'empty-output' });

    const thread = store.conversationStore().getThreadById(threadId);
    expect(thread?.title).toBe('Existing title');
    expect(thread?.summary).toBe('Existing summary');
    expect(thread?.decisions).toEqual(['old decision']);
    expect(thread?.synthesizedMessageCount).toBe(4);
  });

  it('returns llm-failed when runCodex throws', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockRejectedValueOnce(new Error('spawn failed'));
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: false, reason: 'llm-failed' });
  });

  it('returns llm-failed when runCodex resolves with ok:false', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(codexResult({ ok: false, exitCode: 1, stderr: 'boom' }));
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: false, reason: 'llm-failed' });
  });

  it('returns llm-failed when the backend reports a status error payload', async () => {
    const store = createStore();
    const threadId = seedThread(store, 4);
    vi.mocked(runCodex).mockResolvedValueOnce(codexResult({ parsedJson: { status: 'error' } }));
    const out = await synthesizeThread({ threadId, store });
    expect(out).toEqual({ ok: false, reason: 'llm-failed' });
  });
});

describe('buildTranscriptSample', () => {
  it('renders every message with timestamp and speaker labels when under budget', () => {
    const rows = [
      msgRow(0, 'can we ship the deploy today?'),
      msgRow(1, 'checking the pipeline now', { isBot: true }),
      msgRow(2, 'thanks!'),
    ];
    const out = buildTranscriptSample(rows);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] theOG: can we ship the deploy today\?/);
    expect(out).toContain('miniOG (bot): checking the pipeline now');
    expect(out).not.toContain('elided');
  });

  it('keeps the head and tail and elides the middle when over budget', () => {
    const rows = Array.from({ length: 60 }, (_, i) => msgRow(i, `msg-${i} ${'lorem '.repeat(49)}`));
    const out = buildTranscriptSample(rows);
    expect(out).toMatch(/\[… \d+ message\(s\) elided …\]/);
    expect(out).toContain('msg-0 ');
    expect(out).toContain('msg-59 ');
    expect(out.length).toBeLessThanOrEqual(SYNTHESIS_MAX_TRANSCRIPT_CHARS + 100);
  });

  it('truncates individual messages to the per-message cap', () => {
    const out = buildTranscriptSample([msgRow(0, 'B'.repeat(450))]);
    expect(out).toContain(`${'B'.repeat(400)}…`);
    expect(out).not.toContain('B'.repeat(401));
  });
});

describe('fallbackTitle', () => {
  it('strips mentions, collapses whitespace, and truncates to 80 chars', () => {
    const text = `<@U05EUC842KD>   please check the GA4 NSAT numbers ${'z'.repeat(100)}`;
    const out = fallbackTitle([msgRow(0, text)]);
    expect(out.startsWith('please check the GA4 NSAT numbers')).toBe(true);
    expect(out).toHaveLength(80);
    expect(out).not.toContain('<@');
  });

  it('prefers the first human message over a leading bot message', () => {
    const rows = [msgRow(0, 'bot speaks first', { isBot: true }), msgRow(1, 'human question about deploys')];
    expect(fallbackTitle(rows)).toBe('human question about deploys');
  });

  it('falls back to a generic title when there are no messages', () => {
    expect(fallbackTitle([])).toBe('Slack thread');
  });
});

describe('scheduler', () => {
  it('start is idempotent, stop clears, and a fresh start reinstalls the timer', () => {
    __resetThreadSynthesizerSchedulerForTests();
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const store = createStore();

    startThreadSynthesizerScheduler(store);
    startThreadSynthesizerScheduler(store);
    expect(setSpy).toHaveBeenCalledTimes(1);

    stopThreadSynthesizerScheduler();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    stopThreadSynthesizerScheduler();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    startThreadSynthesizerScheduler(store);
    expect(setSpy).toHaveBeenCalledTimes(2);
    stopThreadSynthesizerScheduler();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
