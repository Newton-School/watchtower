import type Database from 'better-sqlite3';
import { logger } from '../logging/logger.js';

/**
 * Conversation layer: every miniOG Slack thread persisted as a first-class
 * object (`conversation_threads`) plus its full transcript
 * (`conversation_messages`), searchable via FTS5.
 *
 * This layer deliberately stores raw user text — an owner-approved reversal of
 * the dossier layer's no-raw-text invariant (dossierStore.ts:151), scoped to
 * THIS layer only: dossier rollups and the profile synthesizer must never
 * start consuming these tables. IMs/MPIMs are never captured (enforced by the
 * capture pipeline via `shouldCapture`); private channels are captured but
 * tagged `visibility='private'` and excluded from cross-channel recall.
 */

export interface CapturedMessage {
  messageTs: string;
  userId: string;
  displayName?: string;
  isBot: boolean;
  subtype?: string;
  text: string;
  files?: Array<{ id: string; name: string; mimetype: string }>;
}

export interface ConversationParticipant {
  userId: string;
  displayName?: string;
  isBot: boolean;
  messageCount: number;
}

export interface ConversationThreadRow {
  id: number;
  channelId: string;
  threadTs: string;
  channelName?: string;
  channelType: string;
  visibility: 'org' | 'private';
  status: 'active' | 'idle' | 'forgotten';
  title?: string;
  summary?: string;
  decisions: string[];
  actionItems: string[];
  participants: ConversationParticipant[];
  messageCount: number;
  firstMessageTs?: string;
  lastActivityTs?: string;
  lastCapturedAt?: string;
  synthesizedAt?: string;
  synthesizedMessageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRow {
  id: number;
  threadId: number;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  displayName?: string;
  isBot: boolean;
  subtype?: string;
  text: string;
  files: Array<{ id: string; name: string; mimetype: string }>;
  edited: boolean;
  capturedAt: string;
}

/**
 * Slack-deleted messages are BLANKED, not row-deleted: the row keeps its
 * (channel, thread, message_ts) dedupe key with `deleted=1`, text/files
 * cleared. This makes deletion commute with the capture paths — a stale
 * in-flight snapshot's INSERT OR IGNORE can never resurrect deleted content.
 * Deleted rows are excluded from reads, aggregates, and search.
 */

export interface ConversationSearchSnippet {
  messageTs: string;
  userId: string;
  displayName?: string;
  isBot: boolean;
  snippet: string;
}

export interface ConversationSearchHit {
  thread: ConversationThreadRow;
  score: number;
  snippets: ConversationSearchSnippet[];
}

export interface RecordMessagesInput {
  channelId: string;
  threadTs: string;
  channelType?: string;
  channelName?: string;
  /**
   * Authoritative visibility when KNOWN (successful conversations.info):
   * overwrites in either direction. Omit when unknown — a new thread then
   * fails CLOSED to 'private' and an existing thread keeps its value, so a
   * transient meta-lookup failure can never mark private content org-wide.
   */
  visibility?: 'org' | 'private';
  messages: CapturedMessage[];
}

export type RecordMessagesResult = { threadId: number; inserted: number } | { skipped: 'forgotten' };

export interface ConversationStore {
  recordMessages(input: RecordMessagesInput): RecordMessagesResult;
  /** Apply a Slack `message_changed` edit. Returns false when the message isn't captured (or is deleted). */
  updateMessageText(channelId: string, threadTs: string, messageTs: string, text: string): boolean;
  /**
   * Apply a Slack `message_deleted`: blanks the captured row, or plants a
   * deleted stub when the message hasn't been captured yet (so a stale
   * in-flight snapshot can't insert it later). Returns false only when the
   * thread itself isn't tracked.
   */
  deleteMessage(channelId: string, threadTs: string, messageTs: string): boolean;
  /**
   * Deletion fallback when Slack's message_deleted event carries no
   * previous_message (so the real thread_ts is unknown): blank any captured
   * row matching (channel, message_ts) across threads.
   */
  deleteMessageByTs(channelId: string, messageTs: string): boolean;
  getThread(channelId: string, threadTs: string): ConversationThreadRow | undefined;
  getThreadById(threadId: number): ConversationThreadRow | undefined;
  /** Hot-path gate for the live message tap: one prepared indexed SELECT. */
  isTracked(channelId: string, threadTs: string): boolean;
  /**
   * Whether the user authored a (non-deleted) message in the thread.
   * `beforeTs` restricts to messages strictly older — pass the triggering
   * command's ts so the command itself can never self-grant participation.
   */
  isParticipant(channelId: string, threadTs: string, userId: string, opts?: { beforeTs?: string }): boolean;
  getMessages(threadId: number, opts?: { limit?: number; order?: 'asc' | 'desc' }): ConversationMessageRow[];
  /** Advance last_captured_at without touching anything else (sweeper failure path). */
  touchCaptured(threadId: number): void;
  /** Non-forgotten, non-empty threads by recency. Used by the MCP server + vault mirror. */
  listRecentThreads(opts: { limit: number }): ConversationThreadRow[];
  /** Non-forgotten threads carrying at least one extracted decision, by recency. */
  listThreadsWithDecisions(opts: { limit: number }): ConversationThreadRow[];
  listThreadsNeedingSynthesis(opts: {
    idleMinutes: number;
    minNewMessages: number;
    /** Threads below this size are never listed (they can never synthesize). */
    minMessages: number;
    limit: number;
    now?: Date;
  }): ConversationThreadRow[];
  listActiveThreadsForSweep(opts: {
    maxAgeDays: number;
    staleCaptureMinutes: number;
    limit: number;
    now?: Date;
  }): ConversationThreadRow[];
  saveSynthesis(
    threadId: number,
    input: { title: string; summary: string; decisions: string[]; actionItems: string[]; messageCount: number },
  ): void;
  markIdle(threadId: number): void;
  /**
   * Flip every active thread whose last activity predates the cutoff to
   * idle in one statement. Catches threads that went quiet while the
   * sidecar was down (the per-thread sweep only visits recently-active
   * ones). Returns the number of threads flipped.
   */
  markStaleThreadsIdle(olderThanDays: number, now?: Date): number;
  searchMessages(
    query: string,
    opts?: {
      limit?: number;
      /** Channel the query originates from — private-channel hits are only returned for their own channel. */
      channelId?: string;
      includePrivate?: boolean;
      excludeThread?: { channelId: string; threadTs: string };
      now?: Date;
    },
  ): ConversationSearchHit[];
  /**
   * Tombstone a thread: transcript deleted, synthesis nulled, status set to
   * 'forgotten' so no capture path (intake / live tap / sweeper / backfill)
   * can ever resurrect it. The row itself is kept as the tombstone.
   */
  forgetThread(channelId: string, threadTs: string): { messagesDeleted: number } | undefined;
  /**
   * Optional retention: delete messages older than the cutoff from idle
   * threads only. Thread rows + synthesis always survive ("raw text can age
   * out; knowledge persists"). Returns deleted-row count.
   */
  pruneIdleMessages(retentionDays: number, now?: Date): number;
  /**
   * Bulk display-name lookup from user_dossiers (no users.info round-trip).
   * Missing users are simply absent from the map.
   */
  getKnownUserNames(userIds: string[]): Map<string, string>;
  /** Whether FTS5 is available (search degrades to LIKE when false). */
  ftsAvailable(): boolean;
}

const SEARCH_CANDIDATE_LIMIT = 50;
const SEARCH_RECENCY_HALF_LIFE_DAYS = 45;
const MAX_SNIPPETS_PER_THREAD = 3;
const MAX_QUERY_TOKENS = 12;
const PARTICIPANT_CAP = 30;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'was',
  'are',
  'you',
  'not',
  'but',
  'can',
  'what',
  'when',
  'where',
  'why',
  'how',
  'did',
  'does',
  'has',
  'have',
  'had',
  'will',
  'about',
  'please',
  'there',
  'here',
  'from',
  'into',
  'they',
  'them',
  'their',
  'our',
  'your',
  'its',
  'is',
  'it',
  'to',
  'of',
  'in',
  'on',
  'at',
  'we',
  'me',
  'my',
  'do',
  'be',
  'an',
  'a',
]);

/**
 * Sanitize a free-text query into an FTS5 MATCH expression. Every token is
 * double-quoted so FTS5 operator syntax (NEAR, ^, *, column filters) in user
 * input can never change query semantics or throw.
 */
export function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/<@[^>]+>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const unique = [...new Set(tokens)].slice(0, MAX_QUERY_TOKENS);
  if (unique.length === 0) return '';
  return unique.map(t => `"${t}"`).join(' OR ');
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface RawThreadRow {
  id: number;
  channel_id: string;
  thread_ts: string;
  channel_name: string | null;
  channel_type: string;
  visibility: string;
  status: string;
  title: string | null;
  summary: string | null;
  decisions_json: string | null;
  action_items_json: string | null;
  participants_json: string;
  message_count: number;
  first_message_ts: string | null;
  last_activity_ts: string | null;
  last_captured_at: string | null;
  synthesized_at: string | null;
  synthesized_message_count: number;
  created_at: string;
  updated_at: string;
}

function mapThreadRow(row: RawThreadRow): ConversationThreadRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    channelName: row.channel_name ?? undefined,
    channelType: row.channel_type,
    visibility: row.visibility === 'private' ? 'private' : 'org',
    status: row.status === 'idle' ? 'idle' : row.status === 'forgotten' ? 'forgotten' : 'active',
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    decisions: parseJsonArray<string>(row.decisions_json),
    actionItems: parseJsonArray<string>(row.action_items_json),
    participants: parseJsonArray<ConversationParticipant>(row.participants_json),
    messageCount: row.message_count,
    firstMessageTs: row.first_message_ts ?? undefined,
    lastActivityTs: row.last_activity_ts ?? undefined,
    lastCapturedAt: row.last_captured_at ?? undefined,
    synthesizedAt: row.synthesized_at ?? undefined,
    synthesizedMessageCount: row.synthesized_message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RawMessageRow {
  id: number;
  thread_id: number;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  user_id: string;
  display_name: string | null;
  is_bot: number;
  subtype: string | null;
  text: string;
  files_json: string | null;
  edited: number;
  captured_at: string;
  deleted: number;
}

function mapMessageRow(row: RawMessageRow): ConversationMessageRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    messageTs: row.message_ts,
    userId: row.user_id,
    displayName: row.display_name ?? undefined,
    isBot: row.is_bot === 1,
    subtype: row.subtype ?? undefined,
    text: row.text,
    files: parseJsonArray<{ id: string; name: string; mimetype: string }>(row.files_json),
    edited: row.edited === 1,
    capturedAt: row.captured_at,
  };
}

const THREAD_COLS = `
  id, channel_id, thread_ts, channel_name, channel_type, visibility, status,
  title, summary, decisions_json, action_items_json, participants_json,
  message_count, first_message_ts, last_activity_ts, last_captured_at,
  synthesized_at, synthesized_message_count, created_at, updated_at
`;

const MESSAGE_COLS = `
  id, thread_id, channel_id, thread_ts, message_ts, user_id, display_name,
  is_bot, subtype, text, files_json, edited, captured_at, deleted
`;

/**
 * Create the FTS5 virtual tables + sync triggers. Guarded: on an SQLite build
 * without FTS5 this fails soft and search degrades to LIKE. When the virtual
 * table is newly created over a table that already has rows (e.g. FTS failed
 * on a previous boot), the index is rebuilt so it can't silently miss them.
 */
function ensureFts(db: Database.Database): boolean {
  const hadMessagesFts = Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE name = 'conversation_messages_fts'`).get(),
  );
  const hadThreadsFts = Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE name = 'conversation_threads_fts'`).get(),
  );
  // Both virtual tables already exist (the sidecar created them): nothing to
  // create, so skip the DDL entirely. This keeps FTS available on READ-ONLY
  // handles (the local MCP server opens the DB readonly — the CREATE-IF-NOT-
  // EXISTS exec would throw there and wrongly degrade search to LIKE).
  if (hadMessagesFts && hadThreadsFts) {
    return true;
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
        text, content='conversation_messages', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ai AFTER INSERT ON conversation_messages BEGIN
        INSERT INTO conversation_messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_msg_fts_ad AFTER DELETE ON conversation_messages BEGIN
        INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, text)
          VALUES('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_msg_fts_au AFTER UPDATE OF text ON conversation_messages BEGIN
        INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, text)
          VALUES('delete', old.id, old.text);
        INSERT INTO conversation_messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_threads_fts USING fts5(
        title, summary, content='conversation_threads', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS conv_thr_fts_ai AFTER INSERT ON conversation_threads BEGIN
        INSERT INTO conversation_threads_fts(rowid, title, summary)
          VALUES (new.id, new.title, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_thr_fts_ad AFTER DELETE ON conversation_threads BEGIN
        INSERT INTO conversation_threads_fts(conversation_threads_fts, rowid, title, summary)
          VALUES('delete', old.id, old.title, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_thr_fts_au AFTER UPDATE OF title, summary ON conversation_threads BEGIN
        INSERT INTO conversation_threads_fts(conversation_threads_fts, rowid, title, summary)
          VALUES('delete', old.id, old.title, old.summary);
        INSERT INTO conversation_threads_fts(rowid, title, summary)
          VALUES (new.id, new.title, new.summary);
      END;
    `);
  } catch (err) {
    logger.warn({ err: String(err) }, 'conversation store: FTS5 unavailable — search degrades to LIKE');
    return false;
  }

  // Rebuild each index independently over pre-existing rows — a crash between
  // the two CREATEs can leave one virtual table present and the other missing,
  // and the missing one must not come up empty over old rows.
  try {
    if (!hadMessagesFts) {
      const existing = db.prepare(`SELECT COUNT(*) AS c FROM conversation_messages`).get() as { c: number };
      if (existing.c > 0) {
        db.exec(`INSERT INTO conversation_messages_fts(conversation_messages_fts) VALUES('rebuild')`);
        logger.info({ rows: existing.c }, 'conversation store: rebuilt message FTS over pre-existing rows');
      }
    }
    if (!hadThreadsFts) {
      const existing = db.prepare(`SELECT COUNT(*) AS c FROM conversation_threads`).get() as { c: number };
      if (existing.c > 0) {
        db.exec(`INSERT INTO conversation_threads_fts(conversation_threads_fts) VALUES('rebuild')`);
        logger.info({ rows: existing.c }, 'conversation store: rebuilt thread FTS over pre-existing rows');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'conversation store: FTS rebuild failed');
  }
  return true;
}

export function createConversationStore(db: Database.Database): ConversationStore {
  const fts = ensureFts(db);

  const selectThread = db.prepare(
    `SELECT ${THREAD_COLS} FROM conversation_threads WHERE channel_id = ? AND thread_ts = ?`,
  );
  const selectThreadById = db.prepare(`SELECT ${THREAD_COLS} FROM conversation_threads WHERE id = ?`);
  const selectTracked = db.prepare(
    `SELECT status FROM conversation_threads WHERE channel_id = ? AND thread_ts = ? LIMIT 1`,
  );
  const selectParticipant = db.prepare(
    `SELECT 1 FROM conversation_messages
     WHERE channel_id = ? AND thread_ts = ? AND user_id = ? AND deleted = 0 LIMIT 1`,
  );
  const selectParticipantBefore = db.prepare(
    `SELECT 1 FROM conversation_messages
     WHERE channel_id = ? AND thread_ts = ? AND user_id = ? AND deleted = 0
       AND CAST(message_ts AS REAL) < CAST(? AS REAL) LIMIT 1`,
  );
  // Visibility: @visibility NULL = unknown -> new threads fail CLOSED to
  // 'private' and existing threads keep their value; a known value is
  // authoritative (from a successful conversations.info) and overwrites in
  // either direction, healing an earlier fail-closed default.
  const insertThread = db.prepare(`
    INSERT INTO conversation_threads (
      channel_id, thread_ts, channel_name, channel_type, visibility, status,
      participants_json, message_count, synthesized_message_count, created_at, updated_at
    )
    VALUES (@channelId, @threadTs, @channelName, @channelType, COALESCE(@visibility, 'private'),
            'active', '[]', 0, 0, @now, @now)
    ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
      channel_name = COALESCE(excluded.channel_name, channel_name),
      channel_type = CASE WHEN excluded.channel_type != 'channel' OR channel_type = 'channel'
                          THEN excluded.channel_type ELSE channel_type END,
      visibility = CASE WHEN @visibility IS NULL THEN visibility ELSE @visibility END,
      updated_at = excluded.updated_at
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO conversation_messages (
      thread_id, channel_id, thread_ts, message_ts, user_id, display_name,
      is_bot, subtype, text, files_json, edited, captured_at
    )
    VALUES (@threadId, @channelId, @threadTs, @messageTs, @userId, @displayName,
            @isBot, @subtype, @text, @filesJson, 0, @now)
  `);
  const updateText = db.prepare(`
    UPDATE conversation_messages SET text = ?, edited = 1
    WHERE channel_id = ? AND thread_ts = ? AND message_ts = ? AND deleted = 0
  `);
  const blankMessageStmt = db.prepare(`
    UPDATE conversation_messages
    SET text = '', files_json = NULL, display_name = NULL, deleted = 1
    WHERE channel_id = ? AND thread_ts = ? AND message_ts = ? AND deleted = 0
  `);
  const insertDeletedStub = db.prepare(`
    INSERT OR IGNORE INTO conversation_messages (
      thread_id, channel_id, thread_ts, message_ts, user_id, display_name,
      is_bot, subtype, text, files_json, edited, captured_at, deleted
    )
    VALUES (@threadId, @channelId, @threadTs, @messageTs, '', NULL, 0, NULL, '', NULL, 0, @now, 1)
  `);
  const selectRowsByChannelTs = db.prepare(
    `SELECT thread_id AS threadId, thread_ts AS threadTs FROM conversation_messages
     WHERE channel_id = ? AND message_ts = ? AND deleted = 0`,
  );
  const blankByChannelTsStmt = db.prepare(`
    UPDATE conversation_messages
    SET text = '', files_json = NULL, display_name = NULL, deleted = 1
    WHERE channel_id = ? AND message_ts = ? AND deleted = 0
  `);
  const selectMessagesAsc = db.prepare(
    `SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE thread_id = ? AND deleted = 0
     ORDER BY CAST(message_ts AS REAL) ASC LIMIT ?`,
  );
  const selectMessagesDesc = db.prepare(
    `SELECT ${MESSAGE_COLS} FROM conversation_messages WHERE thread_id = ? AND deleted = 0
     ORDER BY CAST(message_ts AS REAL) DESC LIMIT ?`,
  );
  const aggregateStats = db.prepare(`
    SELECT COUNT(*) AS messageCount,
           MIN(CAST(message_ts AS REAL)) AS firstTs,
           MAX(CAST(message_ts AS REAL)) AS lastTs
    FROM conversation_messages WHERE thread_id = ? AND deleted = 0
  `);
  const aggregateParticipants = db.prepare(`
    SELECT user_id AS userId, MAX(display_name) AS displayName, is_bot AS isBot, COUNT(*) AS messageCount
    FROM conversation_messages WHERE thread_id = ? AND deleted = 0
    GROUP BY user_id, is_bot ORDER BY messageCount DESC LIMIT ${PARTICIPANT_CAP}
  `);
  const selectBoundaryTs = db.prepare(`
    SELECT
      (SELECT message_ts FROM conversation_messages WHERE thread_id = @id AND deleted = 0
        ORDER BY CAST(message_ts AS REAL) ASC LIMIT 1) AS firstMessageTs,
      (SELECT message_ts FROM conversation_messages WHERE thread_id = @id AND deleted = 0
        ORDER BY CAST(message_ts AS REAL) DESC LIMIT 1) AS lastMessageTs
  `);
  const updateAggregates = db.prepare(`
    UPDATE conversation_threads SET
      message_count = @messageCount,
      first_message_ts = @firstMessageTs,
      last_activity_ts = @lastActivityTs,
      participants_json = @participantsJson,
      synthesized_message_count = MIN(synthesized_message_count, @messageCount),
      last_captured_at = @now,
      status = CASE WHEN status = 'forgotten' THEN status ELSE @status END,
      updated_at = @now
    WHERE id = @id
  `);
  const saveSynthesisStmt = db.prepare(`
    UPDATE conversation_threads SET
      title = @title, summary = @summary, decisions_json = @decisionsJson,
      action_items_json = @actionItemsJson, synthesized_at = @now,
      synthesized_message_count = @messageCount, updated_at = @now
    WHERE id = @id AND status != 'forgotten'
  `);
  const touchCapturedStmt = db.prepare(
    `UPDATE conversation_threads SET last_captured_at = ?, updated_at = ? WHERE id = ?`,
  );
  const markIdleStmt = db.prepare(
    `UPDATE conversation_threads SET status = 'idle', updated_at = ? WHERE id = ? AND status = 'active'`,
  );
  const markStaleIdleStmt = db.prepare(`
    UPDATE conversation_threads SET status = 'idle', updated_at = @now
    WHERE status = 'active'
      AND last_activity_ts IS NOT NULL
      AND CAST(last_activity_ts AS REAL) < @cutoffEpoch
  `);
  const forgetStmt = db.prepare(`
    UPDATE conversation_threads SET
      status = 'forgotten', title = NULL, summary = NULL, decisions_json = NULL,
      action_items_json = NULL, participants_json = '[]', message_count = 0, updated_at = @now
    WHERE id = @id
  `);
  const deleteThreadMessages = db.prepare(`DELETE FROM conversation_messages WHERE thread_id = ?`);
  const listForSynthesis = db.prepare(`
    SELECT ${THREAD_COLS} FROM conversation_threads
    WHERE status != 'forgotten'
      AND message_count >= @minMessages
      AND message_count - synthesized_message_count >= @minNewMessages
      AND CAST(last_activity_ts AS REAL) <= @idleCutoffEpoch
    ORDER BY CAST(last_activity_ts AS REAL) DESC
    LIMIT @limit
  `);
  const listRecentStmt = db.prepare(`
    SELECT ${THREAD_COLS} FROM conversation_threads
    WHERE status != 'forgotten' AND message_count > 0
    ORDER BY CAST(last_activity_ts AS REAL) DESC
    LIMIT ?
  `);
  const listDecisionsStmt = db.prepare(`
    SELECT ${THREAD_COLS} FROM conversation_threads
    WHERE status != 'forgotten'
      AND decisions_json IS NOT NULL AND decisions_json != '[]'
    ORDER BY CAST(last_activity_ts AS REAL) DESC
    LIMIT ?
  `);
  const listForSweep = db.prepare(`
    SELECT ${THREAD_COLS} FROM conversation_threads
    WHERE status = 'active'
      AND CAST(last_activity_ts AS REAL) >= @minActivityEpoch
      AND (last_captured_at IS NULL OR last_captured_at <= @staleCaptureIso)
    ORDER BY last_captured_at ASC
    LIMIT @limit
  `);
  const pruneIdleStmt = db.prepare(`
    DELETE FROM conversation_messages
    WHERE CAST(message_ts AS REAL) < @cutoffEpoch
      AND thread_id IN (SELECT id FROM conversation_threads WHERE status = 'idle')
  `);
  const selectPrunableThreadIds = db.prepare(`
    SELECT DISTINCT thread_id AS threadId FROM conversation_messages
    WHERE CAST(message_ts AS REAL) < @cutoffEpoch
      AND thread_id IN (SELECT id FROM conversation_threads WHERE status = 'idle')
  `);

  function refreshAggregates(threadId: number, now: string, opts?: { reactivate?: boolean }): void {
    const stats = aggregateStats.get(threadId) as {
      messageCount: number;
      firstTs: number | null;
      lastTs: number | null;
    };
    const bounds = selectBoundaryTs.get({ id: threadId }) as {
      firstMessageTs: string | null;
      lastMessageTs: string | null;
    };
    const participants = (
      aggregateParticipants.all(threadId) as Array<{
        userId: string;
        displayName: string | null;
        isBot: number;
        messageCount: number;
      }>
    ).map(p => ({
      userId: p.userId,
      displayName: p.displayName ?? undefined,
      isBot: p.isBot === 1,
      messageCount: p.messageCount,
    }));
    const current = selectThreadById.get(threadId) as RawThreadRow | undefined;
    updateAggregates.run({
      id: threadId,
      messageCount: stats.messageCount,
      firstMessageTs: bounds.firstMessageTs,
      lastActivityTs: bounds.lastMessageTs,
      participantsJson: JSON.stringify(participants),
      status: opts?.reactivate === false ? (current?.status ?? 'active') : 'active',
      now,
    });
  }

  function getThreadRaw(channelId: string, threadTs: string): RawThreadRow | undefined {
    return selectThread.get(channelId, threadTs) as RawThreadRow | undefined;
  }

  const recordTxn = db.transaction((input: RecordMessagesInput): RecordMessagesResult => {
    const now = new Date().toISOString();
    const existing = getThreadRaw(input.channelId, input.threadTs);
    if (existing?.status === 'forgotten') {
      return { skipped: 'forgotten' };
    }
    insertThread.run({
      channelId: input.channelId,
      threadTs: input.threadTs,
      channelName: input.channelName ?? null,
      channelType: input.channelType ?? 'channel',
      visibility: input.visibility ?? null,
      now,
    });
    const thread = getThreadRaw(input.channelId, input.threadTs);
    if (!thread) {
      throw new Error('conversation thread upsert did not produce a row');
    }
    let inserted = 0;
    for (const message of input.messages) {
      if (!message.messageTs) continue;
      const result = insertMessage.run({
        threadId: thread.id,
        channelId: input.channelId,
        threadTs: input.threadTs,
        messageTs: message.messageTs,
        userId: message.userId ?? '',
        displayName: message.displayName ?? null,
        isBot: message.isBot ? 1 : 0,
        subtype: message.subtype ?? null,
        text: message.text ?? '',
        filesJson: message.files && message.files.length > 0 ? JSON.stringify(message.files) : null,
        now,
      });
      inserted += result.changes;
    }
    // Refresh even on zero inserts so last_captured_at advances (the sweeper
    // keys staleness off it).
    refreshAggregates(thread.id, now);
    return { threadId: thread.id, inserted };
  });

  const deleteTxn = db.transaction((channelId: string, threadTs: string, messageTs: string): boolean => {
    const thread = getThreadRaw(channelId, threadTs);
    if (!thread || thread.status === 'forgotten') return false;
    const now = new Date().toISOString();
    const blanked = blankMessageStmt.run(channelId, threadTs, messageTs).changes;
    if (blanked === 0) {
      // Not captured yet — plant a deleted stub occupying the dedupe key so a
      // stale in-flight snapshot's INSERT OR IGNORE can't resurrect it.
      insertDeletedStub.run({
        threadId: thread.id,
        channelId,
        threadTs,
        messageTs,
        now,
      });
    }
    // A deletion is not activity — keep an idle thread idle.
    refreshAggregates(thread.id, now, { reactivate: false });
    return true;
  });

  const deleteByTsTxn = db.transaction((channelId: string, messageTs: string): boolean => {
    const rows = selectRowsByChannelTs.all(channelId, messageTs) as Array<{ threadId: number; threadTs: string }>;
    if (rows.length === 0) return false;
    blankByChannelTsStmt.run(channelId, messageTs);
    const now = new Date().toISOString();
    for (const row of rows) {
      refreshAggregates(row.threadId, now, { reactivate: false });
    }
    return true;
  });

  const forgetTxn = db.transaction((channelId: string, threadTs: string): { messagesDeleted: number } | undefined => {
    const thread = getThreadRaw(channelId, threadTs);
    if (!thread) return undefined;
    const deleted = deleteThreadMessages.run(thread.id).changes;
    forgetStmt.run({ id: thread.id, now: new Date().toISOString() });
    return { messagesDeleted: deleted };
  });

  interface MessageHitRow {
    threadId: number;
    channelId: string;
    threadTs: string;
    messageTs: string;
    userId: string;
    displayName: string | null;
    isBot: number;
    snippet: string;
    rank: number;
  }

  const searchMessagesFtsStmt = fts
    ? db.prepare(`
        SELECT m.thread_id AS threadId, m.channel_id AS channelId, m.thread_ts AS threadTs,
               m.message_ts AS messageTs, m.user_id AS userId, m.display_name AS displayName,
               m.is_bot AS isBot,
               snippet(conversation_messages_fts, 0, '', '', '…', 16) AS snippet,
               bm25(conversation_messages_fts) AS rank
        FROM conversation_messages_fts
        JOIN conversation_messages m ON m.id = conversation_messages_fts.rowid
        WHERE conversation_messages_fts MATCH ?
        ORDER BY rank
        LIMIT ${SEARCH_CANDIDATE_LIMIT}
      `)
    : null;
  const searchThreadsFtsStmt = fts
    ? db.prepare(`
        SELECT conversation_threads_fts.rowid AS threadId, bm25(conversation_threads_fts) AS rank
        FROM conversation_threads_fts
        WHERE conversation_threads_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `)
    : null;
  const searchMessagesLikeStmt = db.prepare(`
    SELECT thread_id AS threadId, channel_id AS channelId, thread_ts AS threadTs,
           message_ts AS messageTs, user_id AS userId, display_name AS displayName,
           is_bot AS isBot, substr(text, 1, 160) AS snippet, -1.0 AS rank
    FROM conversation_messages
    WHERE deleted = 0 AND text LIKE ? ESCAPE '\\'
    ORDER BY CAST(message_ts AS REAL) DESC
    LIMIT ${SEARCH_CANDIDATE_LIMIT}
  `);

  return {
    recordMessages(input) {
      return recordTxn(input);
    },

    updateMessageText(channelId, threadTs, messageTs, text) {
      return updateText.run(text, channelId, threadTs, messageTs).changes > 0;
    },

    deleteMessage(channelId, threadTs, messageTs) {
      return deleteTxn(channelId, threadTs, messageTs);
    },

    deleteMessageByTs(channelId, messageTs) {
      return deleteByTsTxn(channelId, messageTs);
    },

    getThread(channelId, threadTs) {
      const row = getThreadRaw(channelId, threadTs);
      return row ? mapThreadRow(row) : undefined;
    },

    getThreadById(threadId) {
      const row = selectThreadById.get(threadId) as RawThreadRow | undefined;
      return row ? mapThreadRow(row) : undefined;
    },

    isTracked(channelId, threadTs) {
      const row = selectTracked.get(channelId, threadTs) as { status?: string } | undefined;
      return Boolean(row) && row?.status !== 'forgotten';
    },

    isParticipant(channelId, threadTs, userId, opts) {
      if (opts?.beforeTs) {
        return Boolean(selectParticipantBefore.get(channelId, threadTs, userId, opts.beforeTs));
      }
      return Boolean(selectParticipant.get(channelId, threadTs, userId));
    },

    getMessages(threadId, opts) {
      const limit = opts?.limit ?? 500;
      const stmt = opts?.order === 'desc' ? selectMessagesDesc : selectMessagesAsc;
      return (stmt.all(threadId, limit) as RawMessageRow[]).map(mapMessageRow);
    },

    touchCaptured(threadId) {
      const now = new Date().toISOString();
      touchCapturedStmt.run(now, now, threadId);
    },

    listRecentThreads(opts) {
      return (listRecentStmt.all(opts.limit) as RawThreadRow[]).map(mapThreadRow);
    },

    listThreadsWithDecisions(opts) {
      return (listDecisionsStmt.all(opts.limit) as RawThreadRow[]).map(mapThreadRow);
    },

    listThreadsNeedingSynthesis(opts) {
      const nowMs = (opts.now ?? new Date()).getTime();
      const rows = listForSynthesis.all({
        minNewMessages: opts.minNewMessages,
        minMessages: opts.minMessages,
        idleCutoffEpoch: nowMs / 1000 - opts.idleMinutes * 60,
        limit: opts.limit,
      }) as RawThreadRow[];
      return rows.map(mapThreadRow);
    },

    listActiveThreadsForSweep(opts) {
      const now = opts.now ?? new Date();
      const rows = listForSweep.all({
        minActivityEpoch: now.getTime() / 1000 - opts.maxAgeDays * 24 * 60 * 60,
        staleCaptureIso: new Date(now.getTime() - opts.staleCaptureMinutes * 60 * 1000).toISOString(),
        limit: opts.limit,
      }) as RawThreadRow[];
      return rows.map(mapThreadRow);
    },

    saveSynthesis(threadId, input) {
      saveSynthesisStmt.run({
        id: threadId,
        title: input.title,
        summary: input.summary,
        decisionsJson: JSON.stringify(input.decisions),
        actionItemsJson: JSON.stringify(input.actionItems),
        messageCount: input.messageCount,
        now: new Date().toISOString(),
      });
    },

    markIdle(threadId) {
      markIdleStmt.run(new Date().toISOString(), threadId);
    },

    markStaleThreadsIdle(olderThanDays, now) {
      const at = now ?? new Date();
      return markStaleIdleStmt.run({
        now: at.toISOString(),
        cutoffEpoch: at.getTime() / 1000 - Math.max(1, olderThanDays) * 24 * 60 * 60,
      }).changes;
    },

    searchMessages(query, opts) {
      const limit = opts?.limit ?? 3;
      const nowMs = (opts?.now ?? new Date()).getTime();

      let messageHits: MessageHitRow[] = [];
      const threadRankBoost = new Map<number, number>();
      if (fts && searchMessagesFtsStmt && searchThreadsFtsStmt) {
        const match = sanitizeFtsQuery(query);
        if (!match) return [];
        try {
          messageHits = searchMessagesFtsStmt.all(match) as MessageHitRow[];
          for (const row of searchThreadsFtsStmt.all(match) as Array<{ threadId: number; rank: number }>) {
            threadRankBoost.set(row.threadId, -row.rank);
          }
        } catch (err) {
          logger.warn({ err: String(err) }, 'conversation search: FTS query failed');
          return [];
        }
      } else {
        const tokens = sanitizeFtsQuery(query)
          .split(' OR ')
          .map(t => t.replace(/"/g, ''))
          .filter(Boolean)
          .slice(0, 2);
        if (tokens.length === 0) return [];
        const escaped = tokens[0].replace(/[\\%_]/g, c => `\\${c}`);
        messageHits = searchMessagesLikeStmt.all(`%${escaped}%`) as MessageHitRow[];
      }

      const byThread = new Map<number, { score: number; snippets: ConversationSearchSnippet[] }>();
      for (const hit of messageHits) {
        const ageDays = Math.max(0, (nowMs / 1000 - Number(hit.messageTs)) / 86_400);
        // bm25 is negative-is-better; flip so bigger = better, then decay.
        const base = hit.rank < 0 ? -hit.rank : 1;
        const score = base * Math.exp(-ageDays / SEARCH_RECENCY_HALF_LIFE_DAYS);
        const entry = byThread.get(hit.threadId) ?? { score: 0, snippets: [] };
        entry.score += score;
        if (entry.snippets.length < MAX_SNIPPETS_PER_THREAD) {
          entry.snippets.push({
            messageTs: hit.messageTs,
            userId: hit.userId,
            displayName: hit.displayName ?? undefined,
            isBot: hit.isBot === 1,
            snippet: hit.snippet,
          });
        }
        byThread.set(hit.threadId, entry);
      }
      for (const [threadId, boost] of threadRankBoost) {
        const entry = byThread.get(threadId) ?? { score: 0, snippets: [] };
        entry.score += boost;
        byThread.set(threadId, entry);
      }

      const hits: ConversationSearchHit[] = [];
      for (const [threadId, entry] of byThread) {
        const row = selectThreadById.get(threadId) as RawThreadRow | undefined;
        if (!row || row.status === 'forgotten') continue;
        const thread = mapThreadRow(row);
        if (
          opts?.excludeThread &&
          thread.channelId === opts.excludeThread.channelId &&
          thread.threadTs === opts.excludeThread.threadTs
        ) {
          continue;
        }
        if (thread.visibility === 'private' && !opts?.includePrivate && thread.channelId !== opts?.channelId) {
          continue;
        }
        hits.push({ thread, score: entry.score, snippets: entry.snippets });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit);
    },

    forgetThread(channelId, threadTs) {
      return forgetTxn(channelId, threadTs);
    },

    pruneIdleMessages(retentionDays, now) {
      const days = Math.max(1, Math.floor(retentionDays));
      const cutoffEpoch = (now ?? new Date()).getTime() / 1000 - days * 24 * 60 * 60;
      const prune = db.transaction((): number => {
        const affected = selectPrunableThreadIds.all({ cutoffEpoch }) as Array<{ threadId: number }>;
        const deleted = pruneIdleStmt.run({ cutoffEpoch }).changes;
        // Keep thread aggregates truthful after the deletions (message_count,
        // participants, boundary ts) — pruning is not activity, so idle stays.
        const at = new Date().toISOString();
        for (const row of affected) {
          refreshAggregates(row.threadId, at, { reactivate: false });
        }
        return deleted;
      });
      return prune();
    },

    getKnownUserNames(userIds) {
      const map = new Map<string, string>();
      const ids = [...new Set(userIds.filter(Boolean))];
      if (ids.length === 0) return map;
      const placeholders = ids.map(() => '?').join(',');
      try {
        const rows = db
          .prepare(
            `SELECT user_id AS userId, display_name AS displayName, real_name AS realName
             FROM user_dossiers WHERE user_id IN (${placeholders})`,
          )
          .all(...ids) as Array<{ userId: string; displayName: string | null; realName: string | null }>;
        for (const row of rows) {
          const name = row.displayName || row.realName;
          if (name) map.set(row.userId, name);
        }
      } catch (err) {
        logger.debug({ err: String(err) }, 'conversation store: user_dossiers name lookup failed');
      }
      return map;
    },

    ftsAvailable() {
      return fts;
    },
  };
}
