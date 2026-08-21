import type Database from 'better-sqlite3';

/**
 * Egress audit log + publisher state over the `egress_exports` table (DDL in
 * jobStore.migrate). One row per (surface, thread): what went where, when, at
 * what content hash — the dedupe/backoff source for publishers and the URL
 * source for `handoff link`.
 */

export type EgressSurface = 'github';

export interface ExportRecord {
  surface: string;
  channelId: string;
  threadTs: string;
  /** Repo-relative file path — stable across republishes once assigned. */
  targetPath?: string;
  /** Human-facing URL of the exported artifact. */
  targetUrl?: string;
  contentHash?: string;
  commitSha?: string;
  status: 'SUCCESS' | 'FAILED';
  attempts: number;
  lastError?: string;
  lastExportedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishCandidate {
  channelId: string;
  threadTs: string;
  export?: ExportRecord;
}

export interface ExportLog {
  get(surface: EgressSurface, channelId: string, threadTs: string): ExportRecord | undefined;
  recordSuccess(input: {
    surface: EgressSurface;
    channelId: string;
    threadTs: string;
    targetPath: string;
    targetUrl: string;
    contentHash: string;
    commitSha?: string;
  }): void;
  /**
   * `targetPath` should be passed when the failed attempt had a path assigned:
   * it keeps the row retractable (listRetractions keys on target_path) if the
   * thread is forgotten or flips private before a successful publish.
   */
  recordFailure(input: {
    surface: EgressSurface;
    channelId: string;
    threadTs: string;
    targetPath?: string;
    error: string;
  }): void;
  /**
   * Content-hash-unchanged republish check: advance updated_at so the thread
   * stops being selected until it actually changes again.
   */
  touch(surface: EgressSurface, channelId: string, threadTs: string): void;
  delete(surface: EgressSurface, channelId: string, threadTs: string): void;
  /**
   * Threads due for publishing: org-visible, not forgotten, non-empty,
   * SYNTHESIZED (title present — the file path slug derives from the title,
   * so a path must never be locked in before the first synthesis), quiet for
   * at least `quietMinutes`, and either never exported, changed since the
   * last export attempt, or failed fewer than `maxAttempts` times. A thread
   * that exhausted its attempts is retried only once it changes again.
   */
  listPublishCandidates(input: {
    surface: EgressSurface;
    quietMinutes: number;
    maxAttempts: number;
    limit: number;
    now?: Date;
  }): PublishCandidate[];
  /**
   * Published artifacts whose thread must no longer be public: forgotten
   * threads and threads whose visibility is no longer 'org' (e.g. the channel
   * was converted to private). The publisher deletes the files and then
   * removes these rows.
   */
  listRetractions(surface: EgressSurface): ExportRecord[];
  /** Every successfully published row for the surface (index regeneration). */
  listPublished(surface: EgressSurface): ExportRecord[];
}

interface RawRow {
  surface: string;
  channel_id: string;
  thread_ts: string;
  target_path: string | null;
  target_url: string | null;
  content_hash: string | null;
  commit_sha: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  last_exported_at: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = `
  surface, channel_id, thread_ts, target_path, target_url, content_hash,
  commit_sha, status, attempts, last_error, last_exported_at, created_at, updated_at
`;

function mapRow(row: RawRow): ExportRecord {
  return {
    surface: row.surface,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    targetPath: row.target_path ?? undefined,
    targetUrl: row.target_url ?? undefined,
    contentHash: row.content_hash ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    status: row.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    lastExportedAt: row.last_exported_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createExportLog(db: Database.Database): ExportLog {
  const selectOne = db.prepare(
    `SELECT ${COLS} FROM egress_exports WHERE surface = ? AND channel_id = ? AND thread_ts = ?`,
  );

  function getRecord(surface: string, channelId: string, threadTs: string): ExportRecord | undefined {
    const row = selectOne.get(surface, channelId, threadTs) as RawRow | undefined;
    return row ? mapRow(row) : undefined;
  }
  const upsertSuccess = db.prepare(`
    INSERT INTO egress_exports (
      surface, channel_id, thread_ts, target_path, target_url, content_hash,
      commit_sha, status, attempts, last_error, last_exported_at, created_at, updated_at
    )
    VALUES (@surface, @channelId, @threadTs, @targetPath, @targetUrl, @contentHash,
            @commitSha, 'SUCCESS', 0, NULL, @now, @now, @now)
    ON CONFLICT(surface, channel_id, thread_ts) DO UPDATE SET
      target_path = excluded.target_path,
      target_url = excluded.target_url,
      content_hash = excluded.content_hash,
      commit_sha = excluded.commit_sha,
      status = 'SUCCESS',
      attempts = 0,
      last_error = NULL,
      last_exported_at = excluded.last_exported_at,
      updated_at = excluded.updated_at
  `);
  const upsertFailure = db.prepare(`
    INSERT INTO egress_exports (
      surface, channel_id, thread_ts, target_path, status, attempts, last_error, created_at, updated_at
    )
    VALUES (@surface, @channelId, @threadTs, @targetPath, 'FAILED', 1, @error, @now, @now)
    ON CONFLICT(surface, channel_id, thread_ts) DO UPDATE SET
      target_path = COALESCE(excluded.target_path, target_path),
      status = 'FAILED',
      attempts = attempts + 1,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `);
  const touchStmt = db.prepare(
    `UPDATE egress_exports SET updated_at = ? WHERE surface = ? AND channel_id = ? AND thread_ts = ?`,
  );
  const deleteStmt = db.prepare(`DELETE FROM egress_exports WHERE surface = ? AND channel_id = ? AND thread_ts = ?`);
  const candidatesStmt = db.prepare(`
    SELECT t.channel_id AS channelId, t.thread_ts AS threadTs
    FROM conversation_threads t
    LEFT JOIN egress_exports e
      ON e.surface = @surface AND e.channel_id = t.channel_id AND e.thread_ts = t.thread_ts
    WHERE t.visibility = 'org'
      AND t.status != 'forgotten'
      AND t.message_count > 0
      AND t.title IS NOT NULL
      AND t.last_activity_ts IS NOT NULL
      AND CAST(t.last_activity_ts AS REAL) <= @quietCutoffEpoch
      AND (
        e.thread_ts IS NULL
        OR t.updated_at > e.updated_at
        OR (e.status = 'FAILED' AND e.attempts < @maxAttempts)
      )
    ORDER BY CAST(t.last_activity_ts AS REAL) DESC
    LIMIT @limit
  `);
  // Columns must be e.-qualified: the JOIN brings in conversation_threads,
  // which shares channel_id/thread_ts/status/created_at/updated_at names.
  const retractionCols = COLS.split(',')
    .map(col => `e.${col.trim()}`)
    .join(', ');
  const retractionsStmt = db.prepare(`
    SELECT ${retractionCols} FROM egress_exports e
    JOIN conversation_threads t ON t.channel_id = e.channel_id AND t.thread_ts = e.thread_ts
    WHERE e.surface = ?
      AND e.target_path IS NOT NULL
      AND (t.status = 'forgotten' OR t.visibility != 'org')
  `);
  // Keys on file-in-repo reality (a commit once carried this path), NOT on
  // last-attempt status: a published thread whose latest republish attempt
  // failed still has its last successful version in the repo and must stay in
  // the README/DECISIONS indexes. commit_sha survives recordFailure (only
  // recordSuccess writes it), so it is exactly "reached the repo at least
  // once"; a FAILED row that never published lacks it and stays out.
  const publishedStmt = db.prepare(
    `SELECT ${COLS} FROM egress_exports
     WHERE surface = ? AND target_path IS NOT NULL AND commit_sha IS NOT NULL`,
  );

  return {
    get(surface, channelId, threadTs) {
      return getRecord(surface, channelId, threadTs);
    },

    recordSuccess(input) {
      upsertSuccess.run({
        surface: input.surface,
        channelId: input.channelId,
        threadTs: input.threadTs,
        targetPath: input.targetPath,
        targetUrl: input.targetUrl,
        contentHash: input.contentHash,
        commitSha: input.commitSha ?? null,
        now: new Date().toISOString(),
      });
    },

    recordFailure(input) {
      upsertFailure.run({
        surface: input.surface,
        channelId: input.channelId,
        threadTs: input.threadTs,
        targetPath: input.targetPath ?? null,
        error: input.error.slice(0, 500),
        now: new Date().toISOString(),
      });
    },

    touch(surface, channelId, threadTs) {
      touchStmt.run(new Date().toISOString(), surface, channelId, threadTs);
    },

    delete(surface, channelId, threadTs) {
      deleteStmt.run(surface, channelId, threadTs);
    },

    listPublishCandidates(input) {
      const now = input.now ?? new Date();
      const rows = candidatesStmt.all({
        surface: input.surface,
        quietCutoffEpoch: now.getTime() / 1000 - input.quietMinutes * 60,
        maxAttempts: input.maxAttempts,
        limit: input.limit,
      }) as Array<{ channelId: string; threadTs: string }>;
      return rows.map(row => ({
        channelId: row.channelId,
        threadTs: row.threadTs,
        export: getRecord(input.surface, row.channelId, row.threadTs),
      }));
    },

    listRetractions(surface) {
      return (retractionsStmt.all(surface) as RawRow[]).map(mapRow);
    },

    listPublished(surface) {
      return (publishedStmt.all(surface) as RawRow[]).map(mapRow);
    },
  };
}
