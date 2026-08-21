import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import type { ExportLog } from '../src/egress/exportLog.js';
import type { ConversationStore } from '../src/state/conversationStore.js';

const NOW = new Date();
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const QUIET_MINUTES = 30;
const MAX_ATTEMPTS = 3;
// Comfortably past the quiet window relative to NOW.
const QUIET_AGO = 2 * 3600;

/** Slack-style epoch-seconds ts, `secondsAgo` before NOW. */
function ts(secondsAgo: number, seq = 100): string {
  return `${NOW_EPOCH - secondsAgo}.${String(seq).padStart(6, '0')}`;
}

/** ISO timestamp `secondsAgo` before NOW — for deterministic updated_at ordering. */
function iso(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

describe('exportLog', () => {
  let dbDir: string;
  let store: JobStore;
  let log: ExportLog;
  let conv: ConversationStore;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-exportlog-'));
    store = new JobStore(path.join(dbDir, 'watchtower.db'));
    log = store.exportLog();
    conv = store.conversationStore();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function seedThread(
    channelId: string,
    threadTs: string,
    opts: { visibility?: 'org' | 'private'; messageTs?: string[] } = {},
  ): void {
    const result = conv.recordMessages({
      channelId,
      threadTs,
      channelType: 'channel',
      visibility: opts.visibility ?? 'org',
      messages: (opts.messageTs ?? [threadTs]).map((messageTs, i) => ({
        messageTs,
        userId: i === 0 ? 'UASKER' : 'UOTHER',
        isBot: false,
        text: `seed message ${i}`,
      })),
    });
    if ('skipped' in result) throw new Error('seed thread unexpectedly skipped');
  }

  /** recordSuccess/touch stamp real now — pin updated_at by hand when ordering matters. */
  function setThreadUpdatedAt(channelId: string, threadTs: string, isoTime: string): void {
    store['db']
      .prepare('UPDATE conversation_threads SET updated_at = ? WHERE channel_id = ? AND thread_ts = ?')
      .run(isoTime, channelId, threadTs);
  }

  function setExportUpdatedAt(channelId: string, threadTs: string, isoTime: string): void {
    store['db']
      .prepare("UPDATE egress_exports SET updated_at = ? WHERE surface = 'github' AND channel_id = ? AND thread_ts = ?")
      .run(isoTime, channelId, threadTs);
  }

  function recordSuccess(
    channelId: string,
    threadTs: string,
    overrides: { commitSha?: string; contentHash?: string } = {},
  ): void {
    log.recordSuccess({
      surface: 'github',
      channelId,
      threadTs,
      targetPath: `conversations/${channelId}.md`,
      targetUrl: `https://github.com/o/r/blob/main/conversations/${channelId}.md`,
      contentHash: overrides.contentHash ?? 'hash-1',
      commitSha: overrides.commitSha,
    });
  }

  function candidates(overrides: Partial<{ quietMinutes: number; maxAttempts: number; limit: number }> = {}) {
    return log.listPublishCandidates({
      surface: 'github',
      quietMinutes: QUIET_MINUTES,
      maxAttempts: MAX_ATTEMPTS,
      limit: 10,
      now: NOW,
      ...overrides,
    });
  }

  describe('DDL and accessor', () => {
    it('migrate() creates egress_exports, the accessor is cached, and get() is undefined for unknown keys', () => {
      const tables = store['db']
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'egress_exports'`)
        .all() as Array<{ name: string }>;
      expect(tables.map(t => t.name)).toEqual(['egress_exports']);
      expect(store.exportLog()).toBe(log);
      expect(log.get('github', 'CNOPE', ts(60))).toBeUndefined();
    });
  });

  describe('recordSuccess / recordFailure', () => {
    it('recordSuccess inserts a SUCCESS row and later upserts reset attempts and clear the error', () => {
      const threadTs = ts(QUIET_AGO);
      recordSuccess('C1', threadTs, { commitSha: 'abc123' });

      const first = log.get('github', 'C1', threadTs);
      expect(first).toMatchObject({
        surface: 'github',
        channelId: 'C1',
        threadTs,
        targetPath: 'conversations/C1.md',
        targetUrl: 'https://github.com/o/r/blob/main/conversations/C1.md',
        contentHash: 'hash-1',
        commitSha: 'abc123',
        status: 'SUCCESS',
        attempts: 0,
      });
      expect(first?.lastError).toBeUndefined();
      expect(first?.lastExportedAt).toBeDefined();
      expect(first?.createdAt).toBe(first?.updatedAt);

      log.recordFailure({ surface: 'github', channelId: 'C1', threadTs, error: 'push rejected' });
      log.recordFailure({ surface: 'github', channelId: 'C1', threadTs, error: 'still rejected' });
      const failed = log.get('github', 'C1', threadTs);
      expect(failed?.status).toBe('FAILED');
      expect(failed?.attempts).toBe(2);
      expect(failed?.lastError).toBe('still rejected');
      // A failed republish keeps what was already published where.
      expect(failed?.targetPath).toBe('conversations/C1.md');
      expect(failed?.targetUrl).toBe('https://github.com/o/r/blob/main/conversations/C1.md');
      expect(failed?.contentHash).toBe('hash-1');
      expect(failed?.lastExportedAt).toBe(first?.lastExportedAt);

      recordSuccess('C1', threadTs, { contentHash: 'hash-2' });
      const republished = log.get('github', 'C1', threadTs);
      expect(republished).toMatchObject({ status: 'SUCCESS', attempts: 0, contentHash: 'hash-2' });
      expect(republished?.lastError).toBeUndefined();
      // commitSha omitted on the republish → overwritten to empty, not carried over.
      expect(republished?.commitSha).toBeUndefined();
      expect(republished?.createdAt).toBe(first?.createdAt);
      expect(republished!.lastExportedAt! >= first!.lastExportedAt!).toBe(true);
    });

    it('recordFailure on a fresh key inserts a FAILED row with attempts=1 and truncates the error to 500 chars', () => {
      const threadTs = ts(QUIET_AGO);
      log.recordFailure({ surface: 'github', channelId: 'CF', threadTs, error: 'x'.repeat(600) });
      const record = log.get('github', 'CF', threadTs);
      expect(record).toMatchObject({ status: 'FAILED', attempts: 1 });
      expect(record?.lastError).toHaveLength(500);
      expect(record?.targetPath).toBeUndefined();
      expect(record?.targetUrl).toBeUndefined();
      expect(record?.lastExportedAt).toBeUndefined();
    });
  });

  describe('touch and delete', () => {
    it('touch() advances updated_at and changes nothing else', () => {
      const threadTs = ts(QUIET_AGO);
      recordSuccess('CT', threadTs, { commitSha: 'sha-t' });
      setExportUpdatedAt('CT', threadTs, iso(3600));
      const before = log.get('github', 'CT', threadTs)!;
      expect(before.updatedAt).toBe(iso(3600));

      log.touch('github', 'CT', threadTs);
      const after = log.get('github', 'CT', threadTs)!;
      expect(after.updatedAt > before.updatedAt).toBe(true);
      expect({ ...after, updatedAt: 'pinned' }).toEqual({ ...before, updatedAt: 'pinned' });

      // Unknown key: a silent no-op.
      expect(() => log.touch('github', 'CGHOST', threadTs)).not.toThrow();
      expect(log.get('github', 'CGHOST', threadTs)).toBeUndefined();
    });

    it('delete() removes the row and is a no-op on unknown keys', () => {
      const threadTs = ts(QUIET_AGO);
      recordSuccess('CD', threadTs);
      expect(log.get('github', 'CD', threadTs)).toBeDefined();

      log.delete('github', 'CD', threadTs);
      expect(log.get('github', 'CD', threadTs)).toBeUndefined();
      expect(log.listPublished('github')).toEqual([]);
      expect(() => log.delete('github', 'CD', threadTs)).not.toThrow();
    });
  });

  describe('listPublishCandidates', () => {
    it('lists a quiet, org-visible, never-exported thread with no export record attached', () => {
      const threadTs = ts(QUIET_AGO);
      seedThread('CNEW', threadTs);
      const due = candidates();
      expect(due).toHaveLength(1);
      expect(due[0].channelId).toBe('CNEW');
      expect(due[0].threadTs).toBe(threadTs);
      expect(due[0].export).toBeUndefined();
    });

    it('skips a thread whose export is newer than its last change, and relists it once the thread changes', () => {
      const threadTs = ts(QUIET_AGO);
      seedThread('CSTABLE', threadTs);
      recordSuccess('CSTABLE', threadTs);

      // Exported after the thread's last write → nothing new to publish.
      setThreadUpdatedAt('CSTABLE', threadTs, iso(600));
      setExportUpdatedAt('CSTABLE', threadTs, iso(300));
      expect(candidates()).toEqual([]);

      // A late reply lands (still older than the quiet window): updated_at
      // advances past the export's and the thread is due again.
      seedThread('CSTABLE', threadTs, { messageTs: [ts(QUIET_AGO - 100, 200)] });
      const due = candidates();
      expect(due).toHaveLength(1);
      expect(due[0].channelId).toBe('CSTABLE');
      expect(due[0].export?.status).toBe('SUCCESS');
      expect(due[0].export?.contentHash).toBe('hash-1');
    });

    it('lists a FAILED export with remaining attempts even when unchanged, and stops at maxAttempts until the thread changes', () => {
      const threadTs = ts(QUIET_AGO);
      seedThread('CFAIL', threadTs);
      log.recordFailure({ surface: 'github', channelId: 'CFAIL', threadTs, error: 'network down' });
      log.recordFailure({ surface: 'github', channelId: 'CFAIL', threadTs, error: 'network down' });

      // Unchanged since the failed attempt (export row is newer), but attempts remain.
      setThreadUpdatedAt('CFAIL', threadTs, iso(600));
      setExportUpdatedAt('CFAIL', threadTs, iso(300));
      const retry = candidates();
      expect(retry).toHaveLength(1);
      expect(retry[0].export).toMatchObject({ status: 'FAILED', attempts: 2 });

      // Third failure exhausts the budget → backed off while unchanged.
      log.recordFailure({ surface: 'github', channelId: 'CFAIL', threadTs, error: 'network down' });
      setThreadUpdatedAt('CFAIL', threadTs, iso(600));
      setExportUpdatedAt('CFAIL', threadTs, iso(300));
      expect(candidates()).toEqual([]);

      // The thread changing again reopens it despite exhausted attempts.
      setThreadUpdatedAt('CFAIL', threadTs, iso(60));
      const reopened = candidates();
      expect(reopened).toHaveLength(1);
      expect(reopened[0].export?.attempts).toBe(3);
    });

    it('never lists private, forgotten, empty, or not-yet-quiet threads', () => {
      const dueTs = ts(QUIET_AGO);
      seedThread('CDUE', dueTs);
      seedThread('CPRIV', ts(QUIET_AGO, 200), { visibility: 'private' });
      seedThread('CFORGOT', ts(QUIET_AGO, 300));
      conv.forgetThread('CFORGOT', ts(QUIET_AGO, 300));
      // Tracked but transcript-less thread (message_count 0, no activity).
      conv.recordMessages({ channelId: 'CEMPTY', threadTs: ts(QUIET_AGO, 400), visibility: 'org', messages: [] });
      // Last activity 60s ago — inside the 30-minute quiet window.
      seedThread('CFRESH', ts(60));

      const due = candidates();
      expect(due.map(c => c.channelId)).toEqual(['CDUE']);
      expect(due[0].threadTs).toBe(dueTs);
    });

    it('respects limit and orders by most recent activity first', () => {
      seedThread('CL1', ts(9000));
      seedThread('CL2', ts(8000));
      seedThread('CL3', ts(7000));

      expect(candidates().map(c => c.channelId)).toEqual(['CL3', 'CL2', 'CL1']);
      expect(candidates({ limit: 2 }).map(c => c.channelId)).toEqual(['CL3', 'CL2']);
    });
  });

  describe('listRetractions', () => {
    it('returns published rows whose thread was forgotten or flipped to private', () => {
      const goneTs = ts(QUIET_AGO);
      seedThread('CGONE', goneTs);
      recordSuccess('CGONE', goneTs);
      conv.forgetThread('CGONE', goneTs);

      const flipTs = ts(QUIET_AGO, 200);
      seedThread('CFLIP', flipTs);
      recordSuccess('CFLIP', flipTs);
      // Channel converted to private: an authoritative visibility flip.
      conv.recordMessages({ channelId: 'CFLIP', threadTs: flipTs, visibility: 'private', messages: [] });

      const retractions = log.listRetractions('github');
      expect(retractions.map(r => r.channelId).sort()).toEqual(['CFLIP', 'CGONE']);
      const gone = retractions.find(r => r.channelId === 'CGONE');
      expect(gone).toMatchObject({ threadTs: goneTs, targetPath: 'conversations/CGONE.md', status: 'SUCCESS' });
    });

    it('keeps healthy published rows and pathless rows out', () => {
      const healthyTs = ts(QUIET_AGO);
      seedThread('CHEALTHY', healthyTs);
      recordSuccess('CHEALTHY', healthyTs);

      // Forgotten thread, but nothing was ever published (no target_path).
      const noPathTs = ts(QUIET_AGO, 200);
      seedThread('CNOPATH', noPathTs);
      log.recordFailure({ surface: 'github', channelId: 'CNOPATH', threadTs: noPathTs, error: 'never landed' });
      conv.forgetThread('CNOPATH', noPathTs);

      expect(log.listRetractions('github')).toEqual([]);
    });
  });

  describe('listPublished', () => {
    it('keys on file-in-repo reality (target_path + commit_sha), not last-attempt status', () => {
      const okTs = ts(QUIET_AGO);
      seedThread('COK', okTs);
      recordSuccess('COK', okTs, { commitSha: 'sha-ok' });

      // Failure-only row: no path, no sha — never reached the repo.
      log.recordFailure({ surface: 'github', channelId: 'CNEVER', threadTs: ts(QUIET_AGO, 200), error: 'boom' });

      // Failure WITH an assigned path but no successful publish: still not in
      // the repo, so still excluded (no dead index links).
      log.recordFailure({
        surface: 'github',
        channelId: 'CPATHONLY',
        threadTs: ts(QUIET_AGO, 250),
        targetPath: 'conversations/CPATHONLY.md',
        error: 'boom',
      });

      // Published once, then a republish failed: the last successful version
      // is STILL in the repo, so it stays listed despite FAILED status.
      const flakyTs = ts(QUIET_AGO, 300);
      seedThread('CFLAKY', flakyTs);
      recordSuccess('CFLAKY', flakyTs, { commitSha: 'sha-flaky' });
      log.recordFailure({ surface: 'github', channelId: 'CFLAKY', threadTs: flakyTs, error: 'push rejected' });

      const published = log.listPublished('github');
      expect(published.map(r => r.channelId).sort()).toEqual(['CFLAKY', 'COK']);
      const ok = published.find(r => r.channelId === 'COK');
      expect(ok).toMatchObject({ threadTs: okTs, targetPath: 'conversations/COK.md', status: 'SUCCESS' });
      const flaky = published.find(r => r.channelId === 'CFLAKY');
      expect(flaky).toMatchObject({ status: 'FAILED', commitSha: 'sha-flaky' });

      log.delete('github', 'COK', okTs);
      log.delete('github', 'CFLAKY', flakyTs);
      expect(log.listPublished('github')).toEqual([]);
    });
  });
});
