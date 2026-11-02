import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PrInfo } from '../personal/prInfo.js';

/** What the owner sees an item as: the inbox's tabs. Sessions have their own tab. */
export type PersonalItemState = 'needs_you' | 'ready' | 'waiting' | 'working' | 'done';
/** Work the nightly run can do for him. */
export type PersonalWorkKind = 'review_pr' | 're_review_pr' | 'fix_own_pr' | 'open_pr';
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
  prInfo: Record<string, PrInfo>;
  /** What his last Merge or Approve came to. */
  tapResult?: string;
  action?: PersonalWorkKind;
  actionDetail?: string;
  askerId?: string;
  /** Triage's own reads showed it this message, so a reply can be drafted there. */
  askConfirmed: boolean;
  /** The launchpad request its work runs under. */
  requestId?: string;
  /** The job or question the item was last brought up to date with. */
  settledOn?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastRunId: string;
}

export type PersonalItemInput = Omit<
  PersonalItem,
  | 'firstSeenAt'
  | 'lastSeenAt'
  | 'ownerClosed'
  | 'draftStatus'
  | 'draftError'
  | 'prStates'
  | 'prInfo'
  | 'tapResult'
  | 'askConfirmed'
  | 'requestId'
  | 'settledOn'
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
  prepareOnly: boolean;
}

/** A request from the app for the sidecar to act on, polled like launchpad requests. */
export type PersonalActionKind = 'run_now' | 'start_item' | 'merge' | 'approve';

export interface PersonalAction {
  id: string;
  kind: PersonalActionKind;
  /** For run_now: `3d` or a date, or nothing for "since the last run". */
  span?: string;
  /** For run_now: work everything out, and leave Slack untouched. */
  prepareOnly: boolean;
  /** For start_item: the item, and his answer if there is one. */
  itemKey?: string;
  text?: string;
  /** For merge and approve: the PR, and the commit he saw. */
  prUrl?: string;
  head?: string;
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
  /** Why it failed, when it did. */
  error?: string;
}

/** The launchpad request behind an item's work. */
export interface PersonalRequest {
  status: string;
  channelId?: string;
  anchorTs?: string;
  errorMessage?: string;
  createdAt: string;
}

/** What a piece of work came to, for its item. */
export interface WorkOutcome {
  state: PersonalItemState;
  doneSummary?: string;
  nextStep?: string;
  replyText?: string;
  prUrls?: string[];
  jobId?: string;
  settled?: string;
  /** No more to run: the item stays open for him, with nothing to start. */
  clearAction?: boolean;
}

export interface PersonalStore {
  startRun(params: {
    trigger: PersonalRun['trigger'];
    windowStart: string;
    windowEnd: string;
    prepareOnly?: boolean;
  }): PersonalRun;
  addGaps(id: string, gaps: string[]): void;
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
  setAskConfirmed(key: string, confirmed: boolean): void;
  item(key: string): PersonalItem | undefined;
  /** What this run found that could be started and hasn't been. */
  workToStart(runId: string): PersonalItem[];
  workInFlight(): PersonalItem[];
  /** Every open item with a job to follow, whether it's working or waiting on him. */
  itemsWithJobs(): PersonalItem[];
  setWorkStarted(key: string, requestId: string): void;
  setItemJob(key: string, jobId: string): void;
  setItemState(key: string, state: PersonalItemState): void;
  finishWork(key: string, outcome: WorkOutcome): void;
  requestOf(requestId: string): PersonalRequest | undefined;
  /** PRs this run has already started work on, so two asks don't review one PR twice. */
  startedPrUrls(runId: string): string[];
  transaction(work: () => void): void;
  /** The item whose work runs in this thread. */
  itemKeyForAnchor(channelId: string, threadTs: string): string | undefined;
  jobResult(jobId: string): Record<string, unknown> | undefined;
  setPrInfo(key: string, info: Record<string, PrInfo>): void;
  setTapResult(key: string, result: string): void;
  /** Items with PRs worth knowing about: open ones, and what finished in the last week. */
  itemsWithPrs(): PersonalItem[];
  takeActions(kinds: PersonalActionKind[]): PersonalAction[];
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
  pr_info_json: string;
  tap_result: string | null;
  action: PersonalWorkKind | null;
  action_detail: string | null;
  asker_id: string | null;
  ask_confirmed: number;
  request_id: string | null;
  settled_on: string | null;
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
  prepare_only: number;
}

interface JobRow {
  id: string;
  workflow: string;
  status: string;
  channel_id: string;
  thread_ts: string;
  event_ts: string | null;
  error_message: string | null;
  created_at: string;
}

/** `workflow` is only the router's first guess; what actually ran is in `executed_workflow`. */
const JOB_SELECT = `SELECT id, COALESCE(NULLIF(executed_workflow, ''), workflow) AS workflow, status, channel_id, thread_ts,
         json_extract(payload_json, '$.eventTs') AS event_ts, error_message, created_at
    FROM jobs`;

function toJob(row: JobRow): MiniogJob {
  return {
    id: row.id,
    workflow: row.workflow,
    status: row.status,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    eventTs: row.event_ts ?? undefined,
    error: row.error_message ?? undefined,
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
    prInfo: parseStates(row.pr_info_json) as unknown as Record<string, PrInfo>,
    tapResult: row.tap_result ?? undefined,
    action: row.action ?? undefined,
    actionDetail: row.action_detail ?? undefined,
    askerId: row.asker_id ?? undefined,
    askConfirmed: row.ask_confirmed === 1,
    requestId: row.request_id ?? undefined,
    settledOn: row.settled_on ?? undefined,
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
    prepareOnly: row.prepare_only === 1,
  };
}

export function createPersonalStore(db: Database.Database): PersonalStore {
  const upsert = db.prepare(`
    INSERT INTO personal_items (
      item_key, source, state, channel_id, channel_name, thread_ts, message_ts, permalink, asker, asked_at, ask,
      done_summary, reply_text, next_step, evidence, pr_urls_json, job_id, session_id, session_cwd,
      action, action_detail, asker_id, first_seen_at, last_seen_at, last_run_id
    )
    VALUES (
      @key, @source, @state, @channelId, @channelName, @threadTs, @messageTs, @permalink, @asker, @askedAt, @ask,
      @doneSummary, @replyText, @nextStep, @evidence, @prUrlsJson, @jobId, @sessionId, @sessionCwd,
      @action, @actionDetail, @askerId, @now, @now, @lastRunId
    )
    ON CONFLICT(item_key) DO UPDATE SET
      source = excluded.source,
      -- What he closed stays closed, and work under way decides its own state when it ends.
      -- Work that stopped and is waiting on him can still turn out to be done.
      state = CASE
        WHEN personal_items.owner_closed IS NOT NULL OR personal_items.state = 'working' THEN personal_items.state
        WHEN personal_items.request_id IS NOT NULL AND excluded.state != 'done' THEN personal_items.state
        ELSE excluded.state
      END,
      channel_id = excluded.channel_id,
      channel_name = excluded.channel_name,
      thread_ts = excluded.thread_ts,
      message_ts = excluded.message_ts,
      permalink = excluded.permalink,
      asker = excluded.asker,
      asked_at = excluded.asked_at,
      ask = excluded.ask,
      done_summary = CASE WHEN personal_items.request_id IS NOT NULL THEN personal_items.done_summary ELSE excluded.done_summary END,
      -- A saved draft's text stays what Slack holds. Any other outcome gets another try.
      reply_text = CASE WHEN personal_items.draft_status = 'saved' OR personal_items.request_id IS NOT NULL THEN personal_items.reply_text ELSE excluded.reply_text END,
      draft_status = CASE WHEN personal_items.draft_status = 'saved' THEN 'saved' ELSE NULL END,
      draft_error = NULL,
      next_step = CASE WHEN personal_items.request_id IS NOT NULL THEN personal_items.next_step ELSE excluded.next_step END,
      evidence = excluded.evidence,
      pr_urls_json = CASE WHEN personal_items.request_id IS NOT NULL THEN personal_items.pr_urls_json ELSE excluded.pr_urls_json END,
      job_id = COALESCE(personal_items.job_id, excluded.job_id),
      action = CASE WHEN personal_items.request_id IS NOT NULL THEN personal_items.action ELSE excluded.action END,
      action_detail = CASE WHEN personal_items.request_id IS NOT NULL THEN personal_items.action_detail ELSE excluded.action_detail END,
      asker_id = COALESCE(excluded.asker_id, personal_items.asker_id),
      session_id = excluded.session_id,
      session_cwd = excluded.session_cwd,
      last_seen_at = excluded.last_seen_at,
      last_run_id = excluded.last_run_id
  `);

  return {
    startRun({ trigger, windowStart, windowEnd, prepareOnly = false }) {
      const run: PersonalRun = {
        id: randomUUID(),
        trigger,
        status: 'RUNNING',
        windowStart,
        windowEnd,
        startedAt: new Date().toISOString(),
        gaps: [],
        prepareOnly,
      };
      db.prepare(
        `INSERT INTO personal_runs (id, trigger, status, window_start, window_end, started_at, gaps_json, prepare_only)
         VALUES (?, ?, 'RUNNING', ?, ?, ?, '[]', ?)`,
      ).run(run.id, trigger, windowStart, windowEnd, run.startedAt, prepareOnly ? 1 : 0);
      return run;
    },

    finishRun(id, { status, gaps, error }) {
      db.prepare(
        `UPDATE personal_runs SET status = ?, finished_at = ?, gaps_json = ?, error_message = ? WHERE id = ?`,
      ).run(status, new Date().toISOString(), JSON.stringify(gaps ?? []), error ?? null, id);
    },

    addGaps(id, gaps) {
      const row = db.prepare(`SELECT gaps_json FROM personal_runs WHERE id = ?`).get(id) as
        | { gaps_json: string }
        | undefined;
      if (!row || gaps.length === 0) return;
      db.prepare(`UPDATE personal_runs SET gaps_json = ? WHERE id = ?`).run(
        JSON.stringify([...parseStrings(row.gaps_json), ...gaps]),
        id,
      );
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
        action: item.action ?? null,
        actionDetail: item.actionDetail ?? null,
        askerId: item.askerId ?? null,
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
              AND reply_text IS NOT NULL AND draft_status IS NULL
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

    setAskConfirmed(key, confirmed) {
      db.prepare(`UPDATE personal_items SET ask_confirmed = ? WHERE item_key = ?`).run(confirmed ? 1 : 0, key);
    },

    item(key) {
      const row = db.prepare(`SELECT * FROM personal_items WHERE item_key = ?`).get(key) as ItemRow | undefined;
      return row ? toItem(row) : undefined;
    },

    workToStart(runId) {
      const rows = db
        .prepare(
          `SELECT * FROM personal_items
            WHERE last_run_id = ? AND state = 'needs_you' AND action IS NOT NULL
              AND request_id IS NULL AND owner_closed IS NULL
            ORDER BY first_seen_at`,
        )
        .all(runId) as ItemRow[];
      return rows.map(toItem);
    },

    workInFlight() {
      const rows = db.prepare(`SELECT * FROM personal_items WHERE state = 'working'`).all() as ItemRow[];
      return rows.map(toItem);
    },

    itemsWithJobs() {
      const rows = db
        .prepare(
          `SELECT * FROM personal_items
            WHERE request_id IS NOT NULL AND owner_closed IS NULL AND state IN ('working', 'needs_you')`,
        )
        .all() as ItemRow[];
      return rows.map(toItem);
    },

    setWorkStarted(key, requestId) {
      db.prepare(
        `UPDATE personal_items
            SET state = 'working', request_id = ?, job_id = NULL, settled_on = NULL, last_seen_at = ?
          WHERE item_key = ?`,
      ).run(requestId, new Date().toISOString(), key);
    },

    setItemJob(key, jobId) {
      db.prepare(`UPDATE personal_items SET job_id = ? WHERE item_key = ?`).run(jobId, key);
    },

    setItemState(key, state) {
      db.prepare(`UPDATE personal_items SET state = ?, settled_on = NULL WHERE item_key = ?`).run(state, key);
    },

    finishWork(key, outcome) {
      const item = db.prepare(`SELECT * FROM personal_items WHERE item_key = ?`).get(key) as ItemRow | undefined;
      if (!item) return;
      db.prepare(
        `UPDATE personal_items
            SET state = ?, done_summary = ?, next_step = ?, reply_text = ?, pr_urls_json = ?,
                job_id = ?, settled_on = ?, action = ?, last_seen_at = ?
          WHERE item_key = ?`,
      ).run(
        outcome.state,
        outcome.doneSummary ?? item.done_summary,
        outcome.nextStep ?? (outcome.state === 'done' || outcome.state === 'ready' ? null : item.next_step),
        outcome.replyText ?? item.reply_text,
        outcome.prUrls ? JSON.stringify(outcome.prUrls) : item.pr_urls_json,
        outcome.jobId ?? item.job_id,
        outcome.settled ?? item.settled_on,
        outcome.clearAction ? null : item.action,
        new Date().toISOString(),
        key,
      );
    },

    requestOf(requestId) {
      const row = db
        .prepare(
          `SELECT status, slack_channel_id, anchor_ts, error_message, created_at FROM launchpad_requests WHERE id = ?`,
        )
        .get(requestId) as
        | {
            status: string;
            slack_channel_id: string | null;
            anchor_ts: string | null;
            error_message: string | null;
            created_at: string;
          }
        | undefined;
      return row
        ? {
            status: row.status,
            channelId: row.slack_channel_id ?? undefined,
            anchorTs: row.anchor_ts ?? undefined,
            errorMessage: row.error_message ?? undefined,
            createdAt: row.created_at,
          }
        : undefined;
    },

    startedPrUrls(runId) {
      const rows = db
        .prepare(`SELECT pr_urls_json FROM personal_items WHERE last_run_id = ? AND request_id IS NOT NULL`)
        .all(runId) as Array<{ pr_urls_json: string }>;
      return rows.flatMap(row => parseStrings(row.pr_urls_json));
    },

    transaction(work) {
      db.transaction(work)();
    },

    itemKeyForAnchor(channelId, threadTs) {
      // From the request itself, so every thread an item has ever run in keeps its limits.
      const row = db
        .prepare(
          `SELECT personal_item_key FROM launchpad_requests
            WHERE slack_channel_id = ? AND anchor_ts = ? AND personal_item_key IS NOT NULL
            LIMIT 1`,
        )
        .get(channelId, threadTs) as { personal_item_key: string } | undefined;
      return row?.personal_item_key;
    },

    jobResult(jobId) {
      const row = db.prepare(`SELECT result_json FROM jobs WHERE id = ?`).get(jobId) as
        | { result_json: string | null }
        | undefined;
      if (!row?.result_json) return undefined;
      try {
        const value: unknown = JSON.parse(row.result_json);
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    },

    setPrInfo(key, info) {
      const states = Object.fromEntries(Object.entries(info).map(([url, entry]) => [url, entry.state]));
      db.prepare(`UPDATE personal_items SET pr_info_json = ?, pr_states_json = ? WHERE item_key = ?`).run(
        JSON.stringify(info),
        JSON.stringify(states),
        key,
      );
    },

    setTapResult(key, result) {
      db.prepare(`UPDATE personal_items SET tap_result = ? WHERE item_key = ?`).run(result, key);
    },

    itemsWithPrs() {
      const rows = db
        .prepare(
          `SELECT * FROM personal_items
            WHERE pr_urls_json != '[]' AND source != 'session'
              AND (state != 'done' OR last_seen_at >= ?)`,
        )
        .all(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()) as ItemRow[];
      return rows.map(toItem);
    },

    takeActions(kinds) {
      return db.transaction(() => {
        const marks = kinds.map(() => '?').join(', ');
        const rows = db
          .prepare(
            `SELECT id, kind, span, prepare_only, item_key, text, pr_url, head FROM personal_actions
              WHERE taken_at IS NULL AND kind IN (${marks}) ORDER BY created_at`,
          )
          .all(...kinds) as Array<{
          id: string;
          kind: PersonalActionKind;
          span: string | null;
          prepare_only: number;
          item_key: string | null;
          text: string | null;
          pr_url: string | null;
          head: string | null;
        }>;
        const mark = db.prepare(`UPDATE personal_actions SET taken_at = ? WHERE id = ?`);
        for (const row of rows) mark.run(new Date().toISOString(), row.id);
        return rows.map(row => ({
          id: row.id,
          kind: row.kind,
          span: row.span ?? undefined,
          prepareOnly: row.prepare_only === 1,
          itemKey: row.item_key ?? undefined,
          text: row.text ?? undefined,
          prUrl: row.pr_url ?? undefined,
          head: row.head ?? undefined,
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
