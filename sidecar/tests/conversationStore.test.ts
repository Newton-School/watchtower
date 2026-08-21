import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { sanitizeFtsQuery } from '../src/state/conversationStore.js';
import type { CapturedMessage, ConversationStore, RecordMessagesResult } from '../src/state/conversationStore.js';

const NOW = new Date();
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);

/** Slack-style epoch-seconds ts, `secondsAgo` before NOW. */
function ts(secondsAgo: number, seq = 100): string {
  return `${NOW_EPOCH - secondsAgo}.${String(seq).padStart(6, '0')}`;
}

function msg(messageTs: string, overrides: Partial<CapturedMessage> = {}): CapturedMessage {
  return { messageTs, userId: 'U1', isBot: false, text: 'hello from the conversation layer', ...overrides };
}

function recorded(result: RecordMessagesResult): { threadId: number; inserted: number } {
  if ('skipped' in result) throw new Error(`expected a recorded result, got skipped=${result.skipped}`);
  return result;
}

describe('conversationStore', () => {
  let dbDir: string;
  let store: JobStore;
  let conv: ConversationStore;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-convstore-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    conv = store.conversationStore();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  describe('migration and boot', () => {
    it('migrate() creates the conversation tables; the accessor is cached; FTS5 is live', () => {
      const tables = store['db']
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name IN ('conversation_threads', 'conversation_messages', 'conversation_messages_fts')`,
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(t => t.name).sort()).toEqual([
        'conversation_messages',
        'conversation_messages_fts',
        'conversation_threads',
      ]);
      expect(store.conversationStore()).toBe(conv);
      expect(conv.ftsAvailable()).toBe(true);
    });
  });

  describe('recordMessages', () => {
    it('inserts messages, dedupes on (channel, thread, message_ts), and maintains thread aggregates', () => {
      const t1 = ts(600);
      const t2 = ts(500);
      const t3 = ts(400);
      const first = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs: t1,
          messages: [
            msg(t1, { userId: 'UALICE', displayName: 'alice', text: 'deploy failed on staging' }),
            msg(t2, { userId: 'UBOB', displayName: 'bob', text: 'looking into the rollout now' }),
          ],
        }),
      );
      expect(first.inserted).toBe(2);

      // Re-capturing the same window (plus one new reply) inserts only the new row.
      const second = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs: t1,
          messages: [
            msg(t1, { userId: 'UALICE', displayName: 'alice', text: 'deploy failed on staging' }),
            msg(t2, { userId: 'UBOB', displayName: 'bob', text: 'looking into the rollout now' }),
            msg(t3, { userId: 'UALICE', displayName: 'alice', text: 'fixed by rerunning migrations' }),
          ],
        }),
      );
      expect(second.threadId).toBe(first.threadId);
      expect(second.inserted).toBe(1);

      const thread = conv.getThread('C1', t1);
      expect(thread?.messageCount).toBe(3);
      expect(thread?.firstMessageTs).toBe(t1);
      expect(thread?.lastActivityTs).toBe(t3);
      expect(thread?.status).toBe('active');
      expect(conv.isTracked('C1', t1)).toBe(true);
      expect(conv.isParticipant('C1', t1, 'UALICE')).toBe(true);
      expect(conv.isParticipant('C1', t1, 'UNOBODY')).toBe(false);
      expect(conv.getMessages(second.threadId).map(m => m.messageTs)).toEqual([t1, t2, t3]);
    });

    it('orders participants by message count and preserves isBot flags', () => {
      const threadTs = ts(900);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        messages: [
          msg(ts(900), { userId: 'UALICE', displayName: 'alice', text: 'first update' }),
          msg(ts(890), { userId: 'UALICE', displayName: 'alice', text: 'second update' }),
          msg(ts(880), { userId: 'UALICE', displayName: 'alice', text: 'third update' }),
          msg(ts(870), { userId: 'BMINIOG', displayName: 'miniOG', isBot: true, text: 'bot reply one' }),
          msg(ts(860), { userId: 'BMINIOG', displayName: 'miniOG', isBot: true, text: 'bot reply two' }),
          msg(ts(850), { userId: 'UBOB', displayName: 'bob', text: 'lone reply' }),
        ],
      });
      const participants = conv.getThread('C1', threadTs)?.participants ?? [];
      expect(participants.map(p => p.userId)).toEqual(['UALICE', 'BMINIOG', 'UBOB']);
      expect(participants[0]).toMatchObject({ displayName: 'alice', isBot: false, messageCount: 3 });
      expect(participants[1]).toMatchObject({ displayName: 'miniOG', isBot: true, messageCount: 2 });
      expect(participants[2]).toMatchObject({ displayName: 'bob', isBot: false, messageCount: 1 });
    });

    it('flips an idle thread back to active when a new message lands', () => {
      const threadTs = ts(700);
      const { threadId } = recorded(conv.recordMessages({ channelId: 'C1', threadTs, messages: [msg(threadTs)] }));
      conv.markIdle(threadId);
      expect(conv.getThread('C1', threadTs)?.status).toBe('idle');

      conv.recordMessages({ channelId: 'C1', threadTs, messages: [msg(ts(650), { text: 'late follow-up' })] });
      expect(conv.getThread('C1', threadTs)?.status).toBe('active');
    });

    it('visibility fails closed to private when unknown, and a known value is authoritative in both directions', () => {
      const threadTs = ts(800);
      // Unknown visibility (no successful conversations.info) → fail closed.
      conv.recordMessages({ channelId: 'CPRIV', threadTs, messages: [msg(threadTs)] });
      let thread = conv.getThread('CPRIV', threadTs);
      expect(thread?.visibility).toBe('private');
      expect(thread?.channelName).toBeUndefined();

      // A later authoritative lookup heals the fail-closed default to org.
      conv.recordMessages({ channelId: 'CPRIV', threadTs, visibility: 'org', messages: [] });
      expect(conv.getThread('CPRIV', threadTs)?.visibility).toBe('org');

      // Authoritative private overwrites too, with channel meta.
      conv.recordMessages({
        channelId: 'CPRIV',
        threadTs,
        channelName: 'eng-secrets',
        channelType: 'group',
        visibility: 'private',
        messages: [],
      });
      thread = conv.getThread('CPRIV', threadTs);
      expect(thread?.visibility).toBe('private');
      expect(thread?.channelName).toBe('eng-secrets');
      expect(thread?.channelType).toBe('group');

      // A later capture with UNKNOWN visibility must not change what is known.
      conv.recordMessages({ channelId: 'CPRIV', threadTs, messages: [] });
      thread = conv.getThread('CPRIV', threadTs);
      expect(thread?.visibility).toBe('private');
      expect(thread?.channelName).toBe('eng-secrets');
      expect(thread?.channelType).toBe('group');
    });
  });

  describe('edits and deletes', () => {
    it('updateMessageText sets edited=1 and FTS finds the new text, not the old', () => {
      const threadTs = ts(300);
      const target = ts(290);
      const { threadId } = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          visibility: 'org',
          messages: [msg(threadTs, { text: 'kickoff' }), msg(target, { text: 'the staging deployment is broken' })],
        }),
      );
      expect(conv.searchMessages('staging deployment', { now: NOW }).map(h => h.thread.id)).toContain(threadId);

      expect(conv.updateMessageText('C1', threadTs, target, 'rollback finished cleanly')).toBe(true);
      const edited = conv.getMessages(threadId).find(m => m.messageTs === target);
      expect(edited?.edited).toBe(true);
      expect(edited?.text).toBe('rollback finished cleanly');

      expect(conv.searchMessages('staging deployment', { now: NOW })).toHaveLength(0);
      expect(conv.searchMessages('rollback finished', { now: NOW }).map(h => h.thread.id)).toContain(threadId);

      expect(conv.updateMessageText('C1', threadTs, '9999.000001', 'nope')).toBe(false);
    });

    it('deleteMessage blanks the row, recomputes aggregates, drops it from FTS, and blocks resurrection', () => {
      const threadTs = ts(280);
      const doomed = ts(270);
      const { threadId } = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          visibility: 'org',
          messages: [msg(threadTs, { text: 'thread opener' }), msg(doomed, { text: 'contains a zanzibar codeword' })],
        }),
      );
      expect(conv.getThread('C1', threadTs)?.messageCount).toBe(2);

      expect(conv.deleteMessage('C1', threadTs, doomed)).toBe(true);
      const thread = conv.getThread('C1', threadTs);
      expect(thread?.messageCount).toBe(1);
      expect(thread?.lastActivityTs).toBe(threadTs);
      expect(conv.getMessages(threadId)).toHaveLength(1);
      expect(conv.searchMessages('zanzibar', { now: NOW })).toHaveLength(0);

      // Repeated deletion is a handled no-op (thread tracked → true).
      expect(conv.deleteMessage('C1', threadTs, doomed)).toBe(true);

      // A stale in-flight snapshot cannot resurrect the deleted content: the
      // blanked row occupies the dedupe key, so INSERT OR IGNORE is a no-op.
      const attempt = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          messages: [msg(doomed, { text: 'contains a zanzibar codeword' })],
        }),
      );
      expect(attempt.inserted).toBe(0);
      expect(conv.searchMessages('zanzibar', { now: NOW })).toHaveLength(0);
      expect(conv.getThread('C1', threadTs)?.messageCount).toBe(1);

      // Deleting a message unknown to a tracked thread plants a stub, so a
      // later stale insert of it is also blocked.
      const neverCaptured = ts(265);
      expect(conv.deleteMessage('C1', threadTs, neverCaptured)).toBe(true);
      const stubAttempt = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          messages: [msg(neverCaptured, { text: 'ghost message content' })],
        }),
      );
      expect(stubAttempt.inserted).toBe(0);
      expect(conv.searchMessages('ghost message', { now: NOW })).toHaveLength(0);

      // Untracked thread → false.
      expect(conv.deleteMessage('C1', '111.000001', '111.000002')).toBe(false);
    });

    it('deleteMessageByTs blanks a captured row when the thread key is unknown', () => {
      const threadTs = ts(260, 300);
      const target = ts(255, 300);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        visibility: 'org',
        messages: [msg(threadTs, { text: 'root note' }), msg(target, { text: 'a quimble reference here' })],
      });
      expect(conv.searchMessages('quimble', { now: NOW })).toHaveLength(1);
      expect(conv.deleteMessageByTs('C1', target)).toBe(true);
      expect(conv.searchMessages('quimble', { now: NOW })).toHaveLength(0);
      expect(conv.getThread('C1', threadTs)?.messageCount).toBe(1);
      expect(conv.deleteMessageByTs('C1', target)).toBe(false);
      expect(conv.deleteMessageByTs('C1', '222.000001')).toBe(false);
    });
  });

  describe('searchMessages', () => {
    it('finds threads by keyword with attributed snippets', () => {
      const threadTs = ts(260);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        visibility: 'org',
        messages: [
          msg(threadTs, { userId: 'UALICE', displayName: 'alice', text: 'the payment webhook retries exploded' }),
        ],
      });
      const hits = conv.searchMessages('webhook retries', { now: NOW });
      expect(hits).toHaveLength(1);
      expect(hits[0].thread.threadTs).toBe(threadTs);
      expect(hits[0].score).toBeGreaterThan(0);
      expect(hits[0].snippets[0]).toMatchObject({
        messageTs: threadTs,
        userId: 'UALICE',
        displayName: 'alice',
        isBot: false,
      });
      expect(hits[0].snippets[0].snippet).toContain('webhook');
    });

    it('neutralizes malicious FTS syntax without throwing', () => {
      const threadTs = ts(250);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        visibility: 'org',
        messages: [msg(threadTs, { text: 'ordinary chatter about launches' })],
      });
      const nasty = [
        'NEAR(launches, chatter)',
        'a" OR b',
        'title:*',
        '"unbalanced quote',
        'launches AND NOT chatter',
        '*** ^^^ ((( ---',
      ];
      for (const query of nasty) {
        expect(() => conv.searchMessages(query, { now: NOW })).not.toThrow();
      }
      // Operator words degrade to plain quoted tokens, so real tokens still match.
      expect(conv.searchMessages('NEAR(launches)', { now: NOW })).toHaveLength(1);
    });

    it('returns [] for stopword-only or empty queries', () => {
      const threadTs = ts(245);
      conv.recordMessages({
        channelId: 'C1',
        threadTs,
        messages: [msg(threadTs, { text: 'searchable content here' })],
      });
      expect(conv.searchMessages('', { now: NOW })).toEqual([]);
      expect(conv.searchMessages('the and for that with', { now: NOW })).toEqual([]);
      expect(conv.searchMessages('a an it to of', { now: NOW })).toEqual([]);
    });

    it('recency blend ranks a fresh hit above a 200-day-old hit for the same keyword', () => {
      const oldTs = ts(200 * 24 * 60 * 60);
      const freshTs = ts(3600);
      conv.recordMessages({
        channelId: 'C1',
        threadTs: oldTs,
        visibility: 'org',
        messages: [msg(oldTs, { text: 'the observability migration plan draft' })],
      });
      conv.recordMessages({
        channelId: 'C1',
        threadTs: freshTs,
        visibility: 'org',
        messages: [msg(freshTs, { text: 'the observability migration plan draft' })],
      });
      const hits = conv.searchMessages('observability migration', { now: NOW, limit: 5 });
      expect(hits).toHaveLength(2);
      expect(hits[0].thread.threadTs).toBe(freshTs);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
    });

    it('excludeThread drops the originating thread from results', () => {
      const tsA = ts(240);
      const tsB = ts(230);
      conv.recordMessages({
        channelId: 'C1',
        threadTs: tsA,
        visibility: 'org',
        messages: [msg(tsA, { text: 'quarterly kubernetes upgrade checklist' })],
      });
      conv.recordMessages({
        channelId: 'C1',
        threadTs: tsB,
        visibility: 'org',
        messages: [msg(tsB, { text: 'kubernetes upgrade retro notes' })],
      });
      const hits = conv.searchMessages('kubernetes upgrade', {
        now: NOW,
        limit: 5,
        excludeThread: { channelId: 'C1', threadTs: tsA },
      });
      expect(hits.map(h => h.thread.threadTs)).toEqual([tsB]);
    });

    it('excludes private threads from cross-channel recall unless same channel or includePrivate', () => {
      const privTs = ts(220);
      conv.recordMessages({
        channelId: 'CPRIV',
        threadTs: privTs,
        channelType: 'group',
        visibility: 'private',
        messages: [msg(privTs, { text: 'confidential compensation banding sheet' })],
      });
      expect(conv.searchMessages('compensation banding', { now: NOW })).toHaveLength(0);
      expect(conv.searchMessages('compensation banding', { now: NOW, channelId: 'COTHER' })).toHaveLength(0);
      expect(conv.searchMessages('compensation banding', { now: NOW, channelId: 'CPRIV' })).toHaveLength(1);
      expect(conv.searchMessages('compensation banding', { now: NOW, includePrivate: true })).toHaveLength(1);
    });
  });

  describe('sanitizeFtsQuery', () => {
    it('quotes tokens, strips mentions and stopwords, and caps token count', () => {
      expect(sanitizeFtsQuery('what did <@U123> say about the deploy?')).toBe('"say" OR "deploy"');
      expect(sanitizeFtsQuery('the and for you')).toBe('');
      expect(sanitizeFtsQuery('NEAR(a,b) title:* "x')).toBe('"near" OR "title"');
      const many = Array.from({ length: 15 }, (_, i) => `token${i}alpha`).join(' ');
      expect(sanitizeFtsQuery(many).split(' OR ')).toHaveLength(12);
    });
  });

  describe('forgetThread', () => {
    it('tombstones the thread: transcript gone, synthesis nulled, capture refused, recall silent', () => {
      const threadTs = ts(210);
      const { threadId } = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          messages: [
            msg(threadTs, { text: 'embarrassing production incident postmortem' }),
            msg(ts(205), { text: 'more incident details' }),
          ],
        }),
      );
      conv.saveSynthesis(threadId, {
        title: 'Incident retro',
        summary: 'What went wrong and why',
        decisions: ['roll back the release'],
        actionItems: ['add a saturation alert'],
        messageCount: 2,
      });
      expect(conv.getThread('C1', threadTs)?.title).toBe('Incident retro');

      expect(conv.forgetThread('C1', threadTs)).toEqual({ messagesDeleted: 2 });

      const thread = conv.getThread('C1', threadTs);
      expect(thread?.status).toBe('forgotten');
      expect(thread?.title).toBeUndefined();
      expect(thread?.summary).toBeUndefined();
      expect(thread?.decisions).toEqual([]);
      expect(thread?.actionItems).toEqual([]);
      expect(thread?.participants).toEqual([]);
      expect(thread?.messageCount).toBe(0);
      expect(conv.getMessages(threadId)).toHaveLength(0);

      expect(conv.isTracked('C1', threadTs)).toBe(false);
      expect(conv.searchMessages('production incident postmortem', { now: NOW })).toHaveLength(0);

      // No capture path may resurrect the thread.
      const attempt = conv.recordMessages({
        channelId: 'C1',
        threadTs,
        messages: [msg(ts(200), { text: 'resurrection attempt' })],
      });
      expect(attempt).toEqual({ skipped: 'forgotten' });
      expect(conv.getThread('C1', threadTs)?.messageCount).toBe(0);
      expect(conv.searchMessages('resurrection attempt', { now: NOW })).toHaveLength(0);
    });

    it('returns undefined for a thread that was never captured', () => {
      expect(conv.forgetThread('C1', '123.000001')).toBeUndefined();
    });
  });

  describe('pruneIdleMessages', () => {
    it('deletes only pre-cutoff messages in idle threads; active threads and thread rows survive', () => {
      const idleTs = ts(90 * 24 * 60 * 60);
      const idleFresh = ts(3600, 200);
      const activeTs = ts(91 * 24 * 60 * 60);
      const idle = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs: idleTs,
          messages: [msg(idleTs, { text: 'ancient idle chatter' }), msg(idleFresh, { text: 'recent idle chatter' })],
        }),
      );
      const active = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs: activeTs,
          messages: [msg(activeTs, { text: 'ancient active chatter' })],
        }),
      );
      conv.markIdle(idle.threadId);

      expect(conv.pruneIdleMessages(30, NOW)).toBe(1);
      expect(conv.getMessages(idle.threadId).map(m => m.text)).toEqual(['recent idle chatter']);
      expect(conv.getMessages(active.threadId).map(m => m.text)).toEqual(['ancient active chatter']);
      // Thread rows always survive retention ("raw text can age out; knowledge persists").
      expect(conv.getThread('C1', idleTs)?.status).toBe('idle');
      expect(conv.getThread('C1', activeTs)?.status).toBe('active');
    });
  });

  describe('getKnownUserNames', () => {
    it('resolves display names from user_dossiers, preferring display_name over real_name', () => {
      store.dossierStore().firstSeen({ userId: 'UALICE', displayName: 'alice', realName: 'Alice Anderson' });
      store.dossierStore().firstSeen({ userId: 'UBOB', realName: 'Bob Builder' });
      const names = conv.getKnownUserNames(['UALICE', 'UBOB', 'UGHOST', '', 'UALICE']);
      expect(names.get('UALICE')).toBe('alice');
      expect(names.get('UBOB')).toBe('Bob Builder');
      expect(names.has('UGHOST')).toBe(false);
      expect(conv.getKnownUserNames([]).size).toBe(0);
    });
  });

  describe('JobStore.pruneOldRows isolation', () => {
    it('never touches conversation tables even when their rows are past the cutoff', () => {
      const threadTs = ts(120);
      const { threadId } = recorded(
        conv.recordMessages({
          channelId: 'C1',
          threadTs,
          visibility: 'org',
          messages: [msg(threadTs, { text: 'retention survivor' })],
        }),
      );

      const db = store['db'];
      const oldIso = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE conversation_threads SET created_at = ?, updated_at = ? WHERE id = ?').run(
        oldIso,
        oldIso,
        threadId,
      );
      db.prepare('UPDATE conversation_messages SET captured_at = ? WHERE thread_id = ?').run(oldIso, threadId);

      // Seed an old terminal job so the sweep provably ran and deleted something.
      store.createJob({
        id: 'job-old',
        eventId: 'e-old',
        dedupeKey: 'dk-old',
        workflow: 'PR_REVIEW',
        channelId: 'C1',
        threadTs: 't-old',
        payload: {},
      });
      store.markJob('job-old', 'SUCCESS');
      db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(oldIso, 'job-old');

      const pruned = store.pruneOldRows(1);
      expect(pruned.jobs).toBe(1);
      expect(conv.getThread('C1', threadTs)?.messageCount).toBe(1);
      expect(conv.getMessages(threadId)).toHaveLength(1);
      expect(conv.searchMessages('retention survivor', { now: NOW })).toHaveLength(1);
    });
  });
});
