import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** What the owner sees an item as: the inbox's tabs. Sessions have their own tab. */
export type PersonalItemState = 'needs_you' | 'ready' | 'waiting' | 'done';
export type PersonalItemSource = 'slack' | 'github' | 'session';
export type PersonalRunStatus = 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED';
/** `blocked`: a draft is already in that conversation, an earlier one or his own. */
export type DraftStatus = 'saved' | 'failed' | 'blocked';

export interface PersonalItem {
  /** Stable from night to night: how a later run recognises the same ask. */
  key: string;
  source: PersonalItemSource;
  state: PersonalItemState;
  channelId?: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  permalink?: string;
  asker?: string;
  askedAt?: string;
  ask: string;
  doneSummary?: string;
  replyText?: string;
  nextStep?: string;
  evidence?: string;
  prUrls: string[];
  /** The miniOG run this item is linked to. */
  jobId?: string;
  sessionId?: string;
  sessionCwd?: string;
  /** He closed it himself: `skipped` or `done`. A later run leaves it closed. */
  ownerClosed?: string;
  draftStatus?: DraftStatus;
  draftError?: string;
  prStates: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRunId: string;
}

export type PersonalItemInput = Omit<
  PersonalItem,
  'firstSeenAt' | 'lastSeenAt' | 'ownerClosed' | 'draftStatus' | 'draftError' | 'prStates'
>;

export interface PersonalRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: PersonalRunStatus;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt?: string;
  gaps: string[];
  error?: string;
}

/** A request from the app for the sidecar to act on, polled like launchpad requests. */
export interface PersonalAction {
  id: string;
  kind: 'run_now';
  /** For run_now: `3d` or a date, or nothing for "since the last run". */
  span?: string;
  /** For run_now: work everything out, and leave Slack untouched. */
  prepareOnly: boolean;
}

/** A miniOG run, as far as deciding whether it already handled an ask. */
export interface MiniogJob {
  id: string;
  workflow: string;
  status: string;
  channelId: string;
  threadTs: string;
  /** The message that started it. */
  eventTs?: string;
  createdAt: string;
}

export interface PersonalStore {
  startRun(params: { trigger: PersonalRun['trigger']; windowStart: string; windowEnd: string }): PersonalRun;
  finishRun(
    id: string,
    params: { status: Exclude<PersonalRunStatus, 'RUNNING'>; gaps?: string[]; error?: string },
  ): void;
  /** A run left RUNNING by a sidecar that stopped: closes it so the next one isn't blocked. */
  failInterruptedRuns(reason: string): number;
  lastRun(): PersonalRun | undefined;
  /** The newest run that read every source, which the next window starts from. */
  lastFinishedRun(): PersonalRun | undefined;
  upsertItem(item: PersonalItemInput): void;
  /** A session item that no longer has anything unfinished. */
  closeItem(key: string, runId: string, doneSummary: string): void;
  openItems(): PersonalItem[];
  openSessionKeys(): string[];
  /** Replies this run's triage confirmed, waiting to be saved: a saved one is never saved twice. */
  repliesToDraft(runId: string): PersonalItem[];
  /** What he closed himself lately, so a later run doesn't raise it again under a new key. */
  closedByOwner(): PersonalItem[];
  setDraftResult(key: string, result: { status: DraftStatus; error?: string }): void;
  setPrStates(key: string, states: Record<string, string>): void;
  takeActions(): PersonalAction[];
  jobsSince(iso: string): MiniogJob[];
  /** However old: a carried item's run may be from before this window. */
  jobsInThread(channelId: string, threadTs: string): MiniogJob[];
  /** What the run's agents cost, from the telemetry they record under `spendKey(run)`. */
  runCostUsd(runId: string): number;
}

/** The job id a run's agent calls are recorded under. */
export function spendKey(runId: string): string {
  return `personal:${runId}`;
}

interface ItemRow {
  item_key: string;
  source: PersonalItemSource;
  state: PersonalItemState;
  channel_id: string | null;
  channel_name: string | null;
  thread_ts: string | null;
  message_ts: string | null;
  permalink: string | null;
  asker: string | null;
  asked_at: string | null;
  ask: string;
  done_summary: string | null;
  reply_text: string | null;
  next_step: string | null;
  evidence: string | null;
  pr_urls_json: string;
  job_id: string | null;
  session_id: string | null;
  session_cwd: string | null;
  owner_closed: string | null;
  draft_status: DraftStatus | null;
  draft_error: string | null;
  pr_states_json: string;
  first_seen_at: string;
  last_seen_at: string;
  last_run_id: string;
}

interface RunRow {
  id: string;
  trigger: PersonalRun['trigger'];
  status: PersonalRunStatus;
  window_start: string;
  window_end: string;
  started_at: string;
  finished_at: string | null;
  gaps_json: string;
  error_message: string | null;
}

interface JobRow {
  id: string;
  workflow: string;
  status: string;
  channel_id: string;
  thread_ts: string;
  event_ts: string | null;
  created_at: string;
}

/** `workflow` is only the router's first guess; what actually ran is in `executed_workflow`. */
const JOB_SELECT = `SELECT id, COALESCE(NULLIF(executed_workflow, ''), workflow) AS workflow, status, channel_id, thread_ts,
         json_extract(payload_json, '$.eventTs') AS event_ts, created_at
    FROM jobs`;

function toJob(row: JobRow): MiniogJob {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    eventTs: row.event_ts ?? undefined,
    createdAt: row.created_at,
  };
}

function parseStrings(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseStates(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function toItem(row: ItemRow): PersonalItem {
  return {
    key: row.item_key,
    source: row.source,
    state: row.state,
    channelId: row.channel_id ?? undefined,
    channelName: row.channel_name ?? undefined,
    threadTs: row.thread_ts ?? undefined,
    messageTs: row.message_ts ?? undefined,
    permalink: row.permalink ?? undefined,
    asker: row.asker ?? undefined,
    askedAt: row.asked_at ?? undefined,
    ask: row.ask,
    doneSummary: row.done_summary ?? undefined,
    replyText: row.reply_text ?? undefined,
    nextStep: row.next_step ?? undefined,
    evidence: row.evidence ?? undefined,
    prUrls: parseStrings(row.pr_urls_json),
    jobId: row.job_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    sessionCwd: row.session_cwd ?? undefined,
    ownerClosed: row.owner_closed ?? undefined,
    draftStatus: row.draft_status ?? undefined,
    draftError: row.draft_error ?? undefined,
    prStates: parseStates(row.pr_states_json),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastRunId: row.last_run_id,
  };
}

function toRun(row: RunRow): PersonalRun {
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    gaps: parseStrings(row.gaps_json),
    error: row.error_message ?? undefined,
  };
}

export function createPersonalStore(db: Database.Database): PersonalStore {
  const upsert = db.prepare(`
    INSERT INTO personal_items (
      item_key, source, state, channel_id, channel_name, thread_ts, message_ts, permalink, asker, asked_at, ask,
      done_summary, reply_text, next_step, evidence, pr_urls_json, job_id, session_id, session_cwd,
      first_seen_at, last_seen_at, last_run_id
    )
    VALUES (
      @key, @source, @state, @channelId, @channelName, @threadTs, @messageTs, @permalink, @asker, @askedAt, @ask,
      @doneSummary, @replyText, @nextStep, @evidence, @prUrlsJson, @jobId, @sessionId, @sessionCwd,
      @now, @now, @lastRunId
    )
    ON CONFLICT(item_key) DO UPDATE SET
      source = excluded.source,
      -- What he closed himself stays closed, and a saved draft's text stays what Slack holds.
      state = CASE WHEN personal_items.owner_closed IS NOT NULL THEN personal_items.state ELSE excluded.state END,
      channel_id = excluded.channel_id,
      channel_name = excluded.channel_name,
      thread_ts = excluded.thread_ts,
      message_ts = excluded.message_ts,
      permalink = excluded.permalink,
      asker = excluded.asker,
      asked_at = excluded.asked_at,
      ask = excluded.ask,
      done_summary = excluded.done_summary,
      reply_text = CASE WHEN personal_items.draft_status = 'saved' THEN personal_items.reply_text ELSE excluded.reply_text END,
      next_step = excluded.next_step,
      evidence = excluded.evidence,
      pr_urls_json = excluded.pr_urls_json,
      job_id = excluded.job_id,
      session_id = excluded.session_id,
      session_cwd = excluded.session_cwd,
      last_seen_at = excluded.last_seen_at,
      last_run_id = excluded.last_run_id
  `);

  return {
    startRun({ trigger, windowStart, windowEnd }) {
      const run: PersonalRun = {
        id: randomUUID(),
        trigger,
        status: 'RUNNING',
        windowStart,
        windowEnd,
        startedAt: new Date().toISOString(),
        gaps: [],
      };
      db.prepare(
        `INSERT INTO personal_runs (id, trigger, status, window_start, window_end, started_at, gaps_json)
         VALUES (?, ?, 'RUNNING', ?, ?, ?, '[]')`,
      ).run(run.id, trigger, windowStart, windowEnd, run.startedAt);
      return run;
    },

    finishRun(id, { status, gaps, error }) {
      db.prepare(
        `UPDATE personal_runs SET status = ?, finished_at = ?, gaps_json = ?, error_message = ? WHERE id = ?`,
      ).run(status, new Date().toISOString(), JSON.stringify(gaps ?? []), error ?? null, id);
    },

    failInterruptedRuns(reason) {
      return db
        .prepare(
          `UPDATE personal_runs SET status = 'FAILED', finished_at = ?, error_message = ? WHERE status = 'RUNNING'`,
        )
        .run(new Date().toISOString(), reason).changes;
    },

    lastRun() {
      const row = db.prepare(`SELECT * FROM personal_runs ORDER BY started_at DESC LIMIT 1`).get() as
        | RunRow
        | undefined;
      return row ? toRun(row) : undefined;
    },

    lastFinishedRun() {
      const row = db
        .prepare(`SELECT * FROM personal_runs WHERE status = 'OK' ORDER BY started_at DESC LIMIT 1`)
        .get() as RunRow | undefined;
      return row ? toRun(row) : undefined;
    },

    upsertItem(item) {
      upsert.run({
        key: item.key,
        source: item.source,
        state: item.state,
        channelId: item.channelId ?? null,
        channelName: item.channelName ?? null,
        threadTs: item.threadTs ?? null,
        messageTs: item.messageTs ?? null,
        permalink: item.permalink ?? null,
        asker: item.asker ?? null,
        askedAt: item.askedAt ?? null,
        ask: item.ask,
        doneSummary: item.doneSummary ?? null,
        replyText: item.replyText ?? null,
        nextStep: item.nextStep ?? null,
        evidence: item.evidence ?? null,
        prUrlsJson: JSON.stringify(item.prUrls),
        jobId: item.jobId ?? null,
        sessionId: item.sessionId ?? null,
        sessionCwd: item.sessionCwd ?? null,
        now: new Date().toISOString(),
        lastRunId: item.lastRunId,
      });
    },

    closeItem(key, runId, doneSummary) {
      db.prepare(
        `UPDATE personal_items SET state = 'done', done_summary = ?, last_run_id = ?, last_seen_at = ? WHERE item_key = ?`,
      ).run(doneSummary, runId, new Date().toISOString(), key);
    },

    openItems() {
      const rows = db
        .prepare(`SELECT * FROM personal_items WHERE state != 'done' AND source != 'session' ORDER BY first_seen_at`)
        .all() as ItemRow[];
      return rows.map(toItem);
    },

    openSessionKeys() {
      const rows = db
        .prepare(`SELECT item_key FROM personal_items WHERE state != 'done' AND source = 'session'`)
        .all() as Array<{ item_key: string }>;
      return rows.map(row => row.item_key);
    },

    closedByOwner() {
      const rows = db
        .prepare(`SELECT * FROM personal_items WHERE owner_closed IS NOT NULL ORDER BY last_seen_at DESC LIMIT 100`)
        .all() as ItemRow[];
      return rows.map(toItem);
    },

    repliesToDraft(runId) {
      const rows = db
        .prepare(
          `SELECT * FROM personal_items
            WHERE last_run_id = ? AND state = 'ready' AND source = 'slack' AND owner_closed IS NULL
              AND reply_text IS NOT NULL AND COALESCE(draft_status, '') != 'saved'
            ORDER BY first_seen_at`,
        )
        .all(runId) as ItemRow[];
      return rows.map(toItem);
    },

    setDraftResult(key, { status, error }) {
      db.prepare(`UPDATE personal_items SET draft_status = ?, draft_error = ? WHERE item_key = ?`).run(
        status,
        error ?? null,
        key,
      );
    },

    setPrStates(key, states) {
      db.prepare(`UPDATE personal_items SET pr_states_json = ? WHERE item_key = ?`).run(JSON.stringify(states), key);
    },

    takeActions() {
      return db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT id, kind, span, prepare_only FROM personal_actions WHERE taken_at IS NULL ORDER BY created_at`,
          )
          .all() as Array<{ id: string; kind: PersonalAction['kind']; span: string | null; prepare_only: number }>;
        const mark = db.prepare(`UPDATE personal_actions SET taken_at = ? WHERE id = ?`);
        for (const row of rows) mark.run(new Date().toISOString(), row.id);
        return rows.map(row => ({
          id: row.id,
          kind: row.kind,
          span: row.span ?? undefined,
          prepareOnly: row.prepare_only === 1,
        }));
      })();
    },

    jobsSince(iso) {
      const rows = db.prepare(`${JOB_SELECT} WHERE created_at >= ? ORDER BY created_at`).all(iso) as JobRow[];
      return rows.map(toJob);
    },

    jobsInThread(channelId, threadTs) {
      const rows = db
        .prepare(`${JOB_SELECT} WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at`)
        .all(channelId, threadTs) as JobRow[];
      return rows.map(toJob);
    },

    runCostUsd(runId) {
      const row = db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM agent_calls WHERE job_id = ?`)
        .get(spendKey(runId)) as { total: number };
      return row.total;
    },
  };
}
