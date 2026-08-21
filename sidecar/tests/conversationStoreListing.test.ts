import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { createConversationStore } from '../src/state/conversationStore.js';
import type { CapturedMessage, ConversationStore, RecordMessagesResult } from '../src/state/conversationStore.js';

const NOW = new Date();
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

/** Slack-style epoch-seconds ts, `secondsAgo` before NOW. */
function ts(secondsAgo: number, seq = 100): string {
  return `${NOW_EPOCH - secondsAgo}.${String(seq).padStart(6, '0')}`;
}

function msg(messageTs: string, overrides: Partial<CapturedMessage> = {}): CapturedMessage {
  return { messageTs, userId: 'U1', isBot: false, text: 'hello from the listing layer', ...overrides };
}

function recorded(result: RecordMessagesResult): { threadId: number; inserted: number } {
  if ('skipped' in result) throw new Error(`expected a recorded result, got skipped=${result.skipped}`);
  return result;
}

describe('conversation listings and known thread refs', () => {
  let dbDir: string;
  let dbPath: string;
  let store: JobStore;
  let conv: ConversationStore;

  /** Seed a single-message org thread rooted (and last active) at `threadTs`. */
  function seedThread(channelId: string, threadTs: string, text = 'seed message'): number {
    const result = conv.recordMessages({ channelId, threadTs, visibility: 'org', messages: [msg(threadTs, { text })] });
    return recorded(result).threadId;
  }

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-convlisting-'));
    dbPath = path.join(dbDir, 'watchtower.db');
    store = new JobStore(dbPath);
    conv = store.conversationStore();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  describe('listRecentThreads', () => {
    it('orders threads newest-first by last activity, regardless of insertion order', () => {
      const oldest = ts(300);
      const middle = ts(200);
      const newest = ts(100);
      seedThread('C1', oldest);
      seedThread('C1', newest);
      seedThread('C1', middle);

      const listed = conv.listRecentThreads({ limit: 10 });
      expect(listed.map(t => t.threadTs)).toEqual([newest, middle, oldest]);
      expect(listed[0].messageCount).toBe(1);
      expect(listed[0].status).toBe('active');
    });

    it('ranks by last message ts, not the thread root ts', () => {
      const rootedOld = ts(500, 111);
      const freshReply = ts(50, 222);
      const rootedNewer = ts(400, 333);
      conv.recordMessages({
        channelId: 'C1',
        threadTs: rootedOld,
        visibility: 'org',
        messages: [msg(rootedOld), msg(freshReply, { text: 'late reply bumps the thread' })],
      });
      seedThread('C1', rootedNewer);

      expect(conv.listRecentThreads({ limit: 10 }).map(t => t.threadTs)).toEqual([rootedOld, rootedNewer]);
    });

    it('excludes forgotten threads even when they would sort first', () => {
      const kept = ts(200);
      const dropped = ts(100);
      seedThread('C1', kept);
      seedThread('C1', dropped);
      expect(conv.forgetThread('C1', dropped)).toEqual({ messagesDeleted: 1 });

      expect(conv.listRecentThreads({ limit: 10 }).map(t => t.threadTs)).toEqual([kept]);
    });

    it('excludes a thread emptied by message deletion even though it is not forgotten', () => {
      const kept = ts(200);
      const emptied = ts(100);
      seedThread('C1', kept);
      seedThread('C1', emptied);
      expect(conv.deleteMessage('C1', emptied, emptied)).toBe(true);

      // The emptied thread is still tracked and active — exclusion is purely message_count = 0.
      const emptiedThread = conv.getThread('C1', emptied);
      expect(emptiedThread?.status).toBe('active');
      expect(emptiedThread?.messageCount).toBe(0);
      expect(conv.listRecentThreads({ limit: 10 }).map(t => t.threadTs)).toEqual([kept]);
    });

    it('respects the limit', () => {
      const a = ts(300);
      const b = ts(200);
      const c = ts(100);
      seedThread('C1', a);
      seedThread('C1', b);
      seedThread('C1', c);

      expect(conv.listRecentThreads({ limit: 2 }).map(t => t.threadTs)).toEqual([c, b]);
      expect(conv.listRecentThreads({ limit: 1 }).map(t => t.threadTs)).toEqual([c]);
    });
  });

  describe('listThreadsWithDecisions', () => {
    function synthesize(threadId: number, decisions: string[]): void {
      conv.saveSynthesis(threadId, {
        title: 'Thread title',
        summary: 'Thread summary',
        decisions,
        actionItems: [],
        messageCount: 1,
      });
    }

    it('lists only threads with a non-empty decisions array, newest activity first', () => {
      const decidedOld = ts(400);
      const decidedNew = ts(150);
      const emptyDecisions = ts(90);
      const neverSynthesized = ts(80);
      const decidedOldId = seedThread('C1', decidedOld);
      const decidedNewId = seedThread('C1', decidedNew);
      const emptyId = seedThread('C1', emptyDecisions);
      seedThread('C1', neverSynthesized);

      // Synthesize out of activity order to prove ordering comes from last activity, not synthesis time.
      synthesize(decidedNewId, ['adopt the new retry policy', 'ship behind a flag']);
      synthesize(emptyId, []);
      synthesize(decidedOldId, ['rollback first']);

      const listed = conv.listThreadsWithDecisions({ limit: 10 });
      expect(listed.map(t => t.threadTs)).toEqual([decidedNew, decidedOld]);
      expect(listed[0].decisions).toEqual(['adopt the new retry policy', 'ship behind a flag']);
      expect(listed[1].decisions).toEqual(['rollback first']);
    });

    it('respects the limit', () => {
      const older = ts(300);
      const newer = ts(100);
      synthesize(seedThread('C1', older), ['keep the cron']);
      synthesize(seedThread('C1', newer), ['drop the cron']);

      expect(conv.listThreadsWithDecisions({ limit: 1 }).map(t => t.threadTs)).toEqual([newer]);
    });

    it('drops a decision-bearing thread once it is forgotten', () => {
      const threadTs = ts(100);
      const threadId = seedThread('C1', threadTs);
      synthesize(threadId, ['decommission the importer']);
      expect(conv.listThreadsWithDecisions({ limit: 10 })).toHaveLength(1);

      conv.forgetThread('C1', threadTs);
      expect(conv.listThreadsWithDecisions({ limit: 10 })).toEqual([]);
    });
  });

  describe('JobStore.listKnownThreadRefs', () => {
    function job(id: string, channelId: string, threadTs: string): void {
      store.createJob({
        id,
        eventId: `evt-${id}`,
        dedupeKey: `dk-${id}`,
        workflow: 'PR_REVIEW',
        channelId,
        threadTs,
        payload: {},
      });
    }

    it('returns the distinct union of jobs and events coords, skipping blank and null refs', () => {
      const shared = ts(900, 111);
      const jobsOnly = ts(800, 222);
      const eventsOnly = ts(700, 333);
      job('job-1', 'C1', shared);
      job('job-2', 'C1', shared); // duplicate coords within jobs
      job('job-3', 'C2', jobsOnly);
      store.recordEvent('evt-a', 'C1', shared); // duplicates a jobs row across the union
      store.recordEvent('evt-b', 'C3', eventsOnly);
      store.recordEvent('evt-blank-channel', '', ts(600, 444));
      store.recordEvent('evt-blank-thread', 'C4', '');
      store['db']
        .prepare('INSERT INTO events(event_id, channel_id, thread_ts, created_at) VALUES(?, NULL, NULL, ?)')
        .run('evt-null-refs', new Date().toISOString());

      const refs = store.listKnownThreadRefs();
      expect(refs.map(r => `${r.channelId}|${r.threadTs}`).sort()).toEqual([
        `C1|${shared}`,
        `C2|${jobsOnly}`,
        `C3|${eventsOnly}`,
      ]);
    });

    it('honors the limit parameter', () => {
      job('job-1', 'C1', ts(500, 111));
      job('job-2', 'C2', ts(400, 222));
      store.recordEvent('evt-a', 'C3', ts(300, 333));

      const all = store.listKnownThreadRefs();
      expect(all).toHaveLength(3);
      const limited = store.listKnownThreadRefs(2);
      expect(limited).toHaveLength(2);
      for (const ref of limited) {
        expect(all).toContainEqual(ref);
      }
    });
  });

  describe('ensureFts over a second read-only handle', () => {
    it('keeps FTS available without DDL, and search runs the FTS path (OR semantics), not LIKE', () => {
      const threadTs = ts(120, 400);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        visibility: 'org',
        messages: [msg(threadTs, { text: 'kafka consumer rebalancing storm mitigation notes' })],
      });

      // The sidecar handle (store) stays open; the MCP server opens the same
      // file read-only. ensureFts must detect the existing virtual tables and
      // skip the CREATE DDL — on a readonly handle that exec would throw and
      // wrongly degrade search to LIKE.
      const db2 = new Database(dbPath, { readonly: true });
      try {
        const conv2 = createConversationStore(db2);
        expect(conv2.ftsAvailable()).toBe(true);

        // Multi-token OR query where only the SECOND token exists in the
        // corpus: the LIKE fallback searches just the first token, so a hit
        // here proves the FTS path is live on the read-only handle.
        expect(() => conv2.searchMessages('zzznotinthecorpus rebalancing', { now: NOW, limit: 5 })).not.toThrow();
        const hits = conv2.searchMessages('zzznotinthecorpus rebalancing', { now: NOW, limit: 5 });
        expect(hits).toHaveLength(1);
        expect(hits[0].thread.threadTs).toBe(threadTs);
        expect(hits[0].snippets[0].snippet).toContain('rebalancing');

        expect(conv2.searchMessages('mitigation storm', { now: NOW, limit: 5 })).toHaveLength(1);
      } finally {
        db2.close();
      }
    });
  });
});
