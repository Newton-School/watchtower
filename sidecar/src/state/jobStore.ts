import Database from 'better-sqlite3';
import fsSync from 'node:fs';
import pathMod from 'node:path';
import { z } from 'zod';
import { logger } from '../logging/logger.js';
import type {
  AgentBackendId,
  AgentCallRecord,
  Bundle,
  CallSummarySince,
  Capability,
  CostSource,
  JobCostSummary,
  JobLogLevel,
  JobLogRecord,
  JobRecord,
  LaunchpadRequestRecord,
  LaunchpadRequestStatus,
  PersonalityMode,
  LaunchpadTarget,
  ResumeContext,
  WorkflowIntent,
} from '../types/contracts.js';
import { createInvestigationStore, type InvestigationStore } from './investigationStore.js';
import { createDossierStore, type DossierStore } from './dossierStore.js';

function normalizeStoredPersonalityMode(mode: unknown): PersonalityMode {
  return mode === 'terse' || mode === 'technical' || mode === 'casual' ? mode : 'normal';
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO-8601 timestamp for `now - offsetMs`. Timestamps are persisted via
 * `new Date().toISOString()`, so a `created_at >= ?` comparison against this
 * threshold is both chronologically correct (ISO-8601 sorts lexically) AND
 * sargable — SQLite can use an index on `created_at`. This replaces the old
 * `julianday(created_at) >= julianday('now', ...)` form, which wraps the column
 * in a function and forces a full table scan on every call.
 */
function isoSince(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

const implementationApprovalResumeSchema = z.object({
  workflow: z.enum(['IMPLEMENTATION', 'OWNER_AUTOPILOT']),
  stage: z.literal('awaiting_approval'),
  iteration: z.number().int().min(0),
  feedbackRounds: z.number().int().min(0),
  planMarkdown: z.string(),
  planAffectedFiles: z.array(z.string()),
  planScope: z.string(),
  plannerSessionId: z.string().optional(),
  plannerOutput: z.record(z.string(), z.unknown()).optional(),
  planMessageTs: z.string().optional(),
  approvalPromptTs: z.string().optional(),
  pipelineCwd: z.string(),
  pauseCount: z.number().int().min(0),
});

const implementationRevisionChoiceResumeSchema = z.object({
  workflow: z.enum(['IMPLEMENTATION', 'OWNER_AUTOPILOT']),
  stage: z.literal('awaiting_revision_choice'),
  iteration: z.number().int().min(0),
  feedbackRounds: z.number().int().min(0),
  planMarkdown: z.string(),
  planAffectedFiles: z.array(z.string()),
  planScope: z.string(),
  plannerSessionId: z.string().optional(),
  plannerOutput: z.record(z.string(), z.unknown()).optional(),
  planMessageTs: z.string().optional(),
  askReviseTs: z.string().optional(),
  pipelineCwd: z.string(),
  pauseCount: z.number().int().min(0),
});

const implementationRepoChoiceResumeSchema = z.object({
  workflow: z.enum(['IMPLEMENTATION', 'OWNER_AUTOPILOT']),
  stage: z.literal('awaiting_repo_choice'),
  promptTs: z.string().optional(),
  pauseCount: z.number().int().min(0),
});

const resumeContextSchema = z.discriminatedUnion('stage', [
  implementationApprovalResumeSchema,
  implementationRevisionChoiceResumeSchema,
  implementationRepoChoiceResumeSchema,
]);

function parseResumeContext(raw: unknown): ResumeContext | undefined {
  // Resume contexts are persisted as the top-level result_json. Tolerate
  // earlier schema-less result payloads (e.g. { prUrl: '...' }) by returning
  // undefined when parsing fails — the caller decides whether to fail the job.
  const parsed = resumeContextSchema.safeParse(raw);
  return parsed.success ? (parsed.data as ResumeContext) : undefined;
}

export class JobStore {
  private db: Database.Database;
  private _investigationStore?: InvestigationStore;
  private _dossierStore?: DossierStore;

  // Hot-path statements compiled once. better-sqlite3 does NOT cache prepared
  // statements (every .prepare() compiles a fresh one), so re-preparing on each
  // call was needless compile churn for the frequent paths: hasEvent runs on
  // every Slack message and popPendingCancels on a 2s timer. Mirrors the
  // closure-cached statement pattern already used in dossierStore.
  private hasEventStmt!: Database.Statement;
  private recordEventStmt!: Database.Statement;
  private selectPendingCancelsStmt!: Database.Statement;
  private deletePendingCancelsStmt!: Database.Statement;
  private getStateStmt!: Database.Statement;
  private setStateStmt!: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.prepareHotStatements();
  }

  private prepareHotStatements(): void {
    this.hasEventStmt = this.db.prepare('SELECT event_id FROM events WHERE event_id = ? LIMIT 1');
    this.recordEventStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events(event_id, channel_id, thread_ts, created_at)
         VALUES(?, ?, ?, ?)`,
    );
    this.selectPendingCancelsStmt = this.db.prepare('SELECT job_id FROM pending_cancel_jobs');
    this.deletePendingCancelsStmt = this.db.prepare('DELETE FROM pending_cancel_jobs');
    this.getStateStmt = this.db.prepare('SELECT value FROM sidecar_state WHERE key = ? LIMIT 1');
    this.setStateStmt = this.db.prepare(
      `INSERT INTO sidecar_state(key, value, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
    );
  }

  investigationStore(): InvestigationStore {
    if (!this._investigationStore) {
      this._investigationStore = createInvestigationStore(this.db);
    }
    return this._investigationStore;
  }

  dossierStore(): DossierStore {
    if (!this._dossierStore) {
      this._dossierStore = createDossierStore(this.db);
    }
    return this._dossierStore;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        payload_json TEXT,
        result_json TEXT,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_event_id ON jobs(event_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_channel_thread ON jobs(channel_id, thread_ts);
      -- Sargable time-window snapshots (getDevStatusSnapshot / getIncidentSnapshot /
      -- getDevChannelHeat). These back the dashboard, which polls; without them the
      -- count/group queries full-scan the jobs table and degrade as it grows.
      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_channel_status_created_at ON jobs(channel_id, status, created_at);

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        channel_id TEXT,
        thread_ts TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sidecar_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS launchpad_requests (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        job_id TEXT,
        slack_channel_id TEXT,
        anchor_ts TEXT,
        result_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_launchpad_requests_status_created_at ON launchpad_requests(status, created_at);

      CREATE TABLE IF NOT EXISTS learning_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        event_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        workflow TEXT,
        status TEXT,
        intent TEXT,
        correction_applied INTEGER NOT NULL DEFAULT 0,
        personality_mode TEXT,
        error_kind TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_learning_signals_created_at ON learning_signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_signals_channel_id ON learning_signals(channel_id);

      CREATE TABLE IF NOT EXISTS intent_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        phrase_key TEXT NOT NULL,
        corrected_intent TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, user_id, phrase_key)
      );
      CREATE INDEX IF NOT EXISTS idx_intent_corrections_channel_user ON intent_corrections(channel_id, user_id);

      CREATE TABLE IF NOT EXISTS personality_profiles (
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        source TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_personality_profiles_scope ON personality_profiles(scope, scope_id);

      CREATE TABLE IF NOT EXISTS mission_threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        goal TEXT NOT NULL,
        plan TEXT NOT NULL,
        progress TEXT NOT NULL,
        blockers TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        eta TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, thread_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_mission_threads_channel_thread ON mission_threads(channel_id, thread_ts);

      CREATE TABLE IF NOT EXISTS mission_swarm_runs (
        run_id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mission_swarm_runs_mission ON mission_swarm_runs(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS trust_policies (
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(target_type, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trust_policies_level ON trust_policies(trust_level, updated_at);

      CREATE TABLE IF NOT EXISTS replay_requests (
        request_id TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_replay_requests_source ON replay_requests(source_job_id, created_at);

      CREATE TABLE IF NOT EXISTS reaction_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        sentiment INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reaction_feedback_channel ON reaction_feedback(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS skill_registry (
        skill_name TEXT PRIMARY KEY,
        skill_path TEXT NOT NULL,
        version TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_channel_preferences (
        channel_id TEXT PRIMARY KEY,
        active_skill TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ops_feed_subscriptions (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_digest_settings (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        digest_time TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_packs (
        pack_name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        rules_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_policy_packs (
        channel_id TEXT PRIMARY KEY,
        pack_name TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incident_modes (
        channel_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_pipeline_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        pipeline_config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        retry_loops INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_pipeline_runs_job_id ON agent_pipeline_runs(job_id);

      CREATE TABLE IF NOT EXISTS job_diffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL UNIQUE,
        branch_name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        files_json TEXT NOT NULL,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_diffs_job_id ON job_diffs(job_id);

      CREATE TABLE IF NOT EXISTS pending_cancel_jobs (
        job_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        pipeline_run_id TEXT,
        role TEXT,
        backend TEXT NOT NULL,
        model TEXT,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cost_usd REAL,
        cost_source TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_calls_job_id ON agent_calls(job_id);
      CREATE INDEX IF NOT EXISTS idx_agent_calls_created_at ON agent_calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_calls_pipeline_run ON agent_calls(pipeline_run_id);

      CREATE TABLE IF NOT EXISTS investigation_findings (
        thread_ts TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        repo_name TEXT,
        repo_path TEXT,
        summary TEXT,
        findings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_investigation_findings_channel ON investigation_findings(channel_id, thread_ts);

      CREATE TABLE IF NOT EXISTS user_dossiers (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        real_name TEXT,
        tz TEXT,
        email TEXT,
        role TEXT,
        notes TEXT,
        source TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_dossiers_updated_at ON user_dossiers(updated_at);

      CREATE TABLE IF NOT EXISTS user_project_affinity (
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        computed_at TEXT NOT NULL,
        PRIMARY KEY(user_id, repo)
      );
      CREATE INDEX IF NOT EXISTS idx_user_project_affinity_user ON user_project_affinity(user_id, computed_at);

      CREATE TABLE IF NOT EXISTS user_metrics (
        user_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        metric_value TEXT NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY(user_id, metric_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_metrics_computed_at ON user_metrics(user_id, computed_at);

      CREATE INDEX IF NOT EXISTS idx_learning_signals_user_created ON learning_signals(user_id, created_at);

      CREATE TABLE IF NOT EXISTS user_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        job_id TEXT,
        workflow TEXT,
        status TEXT,
        repo TEXT,
        pr_url TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_memories_user_created ON user_memories(user_id, created_at);

      CREATE TABLE IF NOT EXISTS user_product_affinity (
        user_id TEXT NOT NULL,
        product TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        computed_at TEXT NOT NULL,
        PRIMARY KEY(user_id, product)
      );
      CREATE INDEX IF NOT EXISTS idx_user_product_affinity_user ON user_product_affinity(user_id, computed_at);

      CREATE TABLE IF NOT EXISTS user_pinned_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_pinned_facts_user ON user_pinned_facts(user_id, created_at);

      -- Signal table used by the desktop Tauri commands (save_dossier_field,
      -- forget_dossier_field, add_pinned_fact, remove_pinned_fact) to notify the
      -- sidecar that a user's dossier has been edited externally. The sidecar's
      -- dossierStore.getDossier checks this on every call; when the signal is
      -- newer than its last-seen value the cache is invalidated and a vault
      -- render is queued. This is the SQLite-only bridge between desktop and
      -- sidecar — no IPC channel is required.
      CREATE TABLE IF NOT EXISTS dossier_cache_signals (
        user_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );

      -- Capability bundles (replacement for the legacy 5-tier access_control_*
      -- tables introduced in the bundles redesign). Each row is a named set
      -- of capabilities assigned to users via a Slack subteam handle and/or
      -- a comma-delimited list of manual user IDs. Bundles are peers (no
      -- hierarchy); a user is granted the union of capabilities across every
      -- bundle they belong to. Per-bundle channel scope preserves the exact
      -- legacy evaluateAccess semantics through the migration.
      CREATE TABLE IF NOT EXISTS bundles (
        name TEXT PRIMARY KEY,
        slack_user_group_handle TEXT NOT NULL DEFAULT '',
        manual_user_ids TEXT NOT NULL DEFAULT '',
        capabilities TEXT NOT NULL DEFAULT '[]',
        allowed_channel_ids TEXT NOT NULL DEFAULT '',
        allow_im INTEGER NOT NULL DEFAULT 0,
        allow_mpim INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Signal table used by Tauri commands (save_bundle, delete_bundle) to
      -- notify the sidecar that the bundles table has been edited. The
      -- sidecar per-workflow access cache check reads this signal and
      -- reloads bundles in place when it is newer than the in-memory build.
      -- Mirrors the dossier_cache_signals + readAgentBackend hot-reload
      -- patterns (no IPC channel required).
      CREATE TABLE IF NOT EXISTS access_cache_signals (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL
      );
    `);

    try {
      this.db.exec(`ALTER TABLE learning_signals ADD COLUMN repo TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE learning_signals ADD COLUMN product TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE user_memories ADD COLUMN product TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN vault_path TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN vault_enabled INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
    // One-time vault default-on: if both fields are still default-empty/zero,
    // flip the operator into the vault experience. The default lives under
    // ~/.watchtower/vault — NOT ~/Documents — so the app never touches a
    // macOS TCC-protected folder (Documents/Desktop/Downloads) by default and
    // never triggers the per-install permission prompt. Idempotent.
    try {
      const home = process.env.HOME ?? '';
      if (home) {
        const oldDefault = `${home}/Documents/miniog-memory`;
        const defaultPath = `${home}/.watchtower/vault`;

        // Fresh install: seed the new, non-protected default.
        this.db
          .prepare(
            `UPDATE app_settings
             SET vault_path = ?, vault_enabled = 1
             WHERE id = 1
               AND COALESCE(vault_path, '') = ''
               AND COALESCE(vault_enabled, 0) = 0`,
          )
          .run(defaultPath);

        // Migration: an existing install whose vault_path is still the old
        // auto-set Documents default gets relocated off the protected folder.
        // We only repoint vault_path AFTER the data is safely at the new path
        // (or there was never any data to move) — so the DB and filesystem
        // never diverge, and a crash mid-migration self-heals on next boot
        // (old gone → repoint). Best-effort; on failure the vault keeps working
        // where it is.
        const row = this.db.prepare(`SELECT COALESCE(vault_path,'') AS vp FROM app_settings WHERE id = 1`).get() as
          | { vp?: string }
          | undefined;
        if (row?.vp === oldDefault) {
          const oldExists = fsSync.existsSync(oldDefault);
          const newExists = fsSync.existsSync(defaultPath);
          if (oldExists && newExists) {
            // Two vaults present — don't auto-pick a winner or orphan data.
            // Keep the existing Documents vault; the operator can merge and
            // repoint manually.
            logger.warn(
              { oldDefault, defaultPath },
              'vault relocation skipped: both the old (~/Documents) and new (~/.watchtower) vaults exist — merge them and set vault_path manually',
            );
          } else {
            try {
              if (oldExists) {
                fsSync.mkdirSync(pathMod.dirname(defaultPath), { recursive: true });
                try {
                  fsSync.renameSync(oldDefault, defaultPath);
                } catch {
                  // Cross-volume (EXDEV) or similar — copy then remove.
                  fsSync.cpSync(oldDefault, defaultPath, { recursive: true });
                  fsSync.rmSync(oldDefault, { recursive: true, force: true });
                }
              }
              this.db
                .prepare(`UPDATE app_settings SET vault_path = ? WHERE id = 1 AND vault_path = ?`)
                .run(defaultPath, oldDefault);
            } catch (err) {
              logger.warn(
                { oldDefault, defaultPath, error: String(err) },
                'vault relocation failed; leaving the vault at its current path',
              );
            }
          }
        }
      }
    } catch {
      /* row may not exist yet on a fresh install; harmless */
    }

    // Add PM config columns to app_settings if missing
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN pm_slack_user_ids TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN pm_task_timeout_ms INTEGER NOT NULL DEFAULT 600000`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN core_dev_slack_user_ids TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE app_settings ADD COLUMN core_dev_slack_user_group TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE app_settings ADD COLUMN mini_og_repo_root TEXT NOT NULL DEFAULT '/Users/dipesh/code/mini-og'`,
      );
    } catch {
      /* column already exists */
    }

    try {
      // Tracks the workflow that actually executed after router reclassification.
      // jobs.workflow stays as the pre-router intent (resume detection at
      // pausedResume.ts relies on it), so we surface the executed workflow via
      // a separate column. UI surfaces read COALESCE(executed_workflow, workflow).
      this.db.exec(`ALTER TABLE jobs ADD COLUMN executed_workflow TEXT`);
    } catch {
      /* column already exists */
    }

    // Launchpad on-behalf-of + origin-thread anchoring (issue #343).
    try {
      this.db.exec(`ALTER TABLE launchpad_requests ADD COLUMN requested_for_user_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE launchpad_requests ADD COLUMN origin_channel_id TEXT`);
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(`ALTER TABLE launchpad_requests ADD COLUMN origin_thread_ts TEXT`);
    } catch {
      /* column already exists */
    }

    try {
      // Slack ts of the "Want me to fix this?" prompt — needed so the reaction
      // handler can match a ✅ on the prompt message back to the saved
      // findings and dispatch a synthetic resume event without requiring the
      // user to re-tag the bot. See RCA on thread p1779086332488579 (2026-05-18).
      this.db.exec(`ALTER TABLE investigation_findings ADD COLUMN prompt_message_ts TEXT`);
    } catch {
      /* column already exists */
    }

    try {
      // User who triggered the investigation. Reaction-resume gate uses this
      // to decide whether the reactor is permitted to confirm (requester or
      // admin only).
      this.db.exec(`ALTER TABLE investigation_findings ADD COLUMN requester_user_id TEXT`);
    } catch {
      /* column already exists */
    }

    try {
      // Indexed lookup for the reaction-resume path: getByPromptMessageTs
      // joins on (channel_id, prompt_message_ts).
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS idx_investigation_findings_prompt_ts ON investigation_findings(channel_id, prompt_message_ts)`,
      );
    } catch {
      /* index already exists */
    }

    try {
      this.db.exec(`UPDATE app_settings SET agent_backend = 'codex' WHERE agent_backend = 'cursor'`);
    } catch {
      /* column may not exist on very old installs; harmless */
    }
  }

  close(): void {
    this.db.close();
  }

  /** Atomically fetch and delete all pending cancel requests (written by Tauri UI). */
  popPendingCancels(): string[] {
    const rows = this.selectPendingCancelsStmt.all() as Array<{ job_id: string }>;
    if (rows.length > 0) {
      this.deletePendingCancelsStmt.run();
    }
    return rows.map(r => r.job_id);
  }

  saveDiff(params: {
    jobId: string;
    branchName: string;
    repoPath: string;
    diffText: string;
    files: Array<{ path: string; status: string; insertions: number; deletions: number }>;
    insertions: number;
    deletions: number;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_diffs(
          job_id, branch_name, repo_path, diff_text, files_json, insertions, deletions, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.jobId,
        params.branchName,
        params.repoPath,
        params.diffText,
        JSON.stringify(params.files),
        params.insertions,
        params.deletions,
        now,
      );
  }

  getDiff(jobId: string): {
    jobId: string;
    branchName: string;
    repoPath: string;
    diffText: string;
    files: Array<{ path: string; status: string; insertions: number; deletions: number }>;
    insertions: number;
    deletions: number;
    createdAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT job_id, branch_name, repo_path, diff_text, files_json, insertions, deletions, created_at
         FROM job_diffs WHERE job_id = ? LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      jobId: row.job_id as string,
      branchName: row.branch_name as string,
      repoPath: row.repo_path as string,
      diffText: row.diff_text as string,
      files: JSON.parse(row.files_json as string),
      insertions: row.insertions as number,
      deletions: row.deletions as number,
      createdAt: row.created_at as string,
    };
  }

  recordAgentCall(record: Omit<AgentCallRecord, 'id' | 'createdAt'> & { createdAt?: string }): void {
    const createdAt = record.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_calls(
           job_id, pipeline_run_id, role, backend, model, duration_ms,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cost_usd, cost_source, ok, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.jobId,
        record.pipelineRunId ?? null,
        record.role ?? null,
        record.backend,
        record.model ?? null,
        record.durationMs,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheCreationTokens ?? null,
        record.costUsd ?? null,
        record.costSource ?? null,
        record.ok ? 1 : 0,
        createdAt,
      );
  }

  private mapAgentCallRow(row: Record<string, unknown>): AgentCallRecord {
    return {
      id: row.id as number,
      jobId: row.job_id as string,
      pipelineRunId: (row.pipeline_run_id as string | null) ?? undefined,
      role: (row.role as string | null) ?? undefined,
      backend: row.backend as AgentBackendId,
      model: (row.model as string | null) ?? undefined,
      durationMs: row.duration_ms as number,
      inputTokens: (row.input_tokens as number | null) ?? undefined,
      outputTokens: (row.output_tokens as number | null) ?? undefined,
      cacheReadTokens: (row.cache_read_tokens as number | null) ?? undefined,
      cacheCreationTokens: (row.cache_creation_tokens as number | null) ?? undefined,
      costUsd: (row.cost_usd as number | null) ?? undefined,
      costSource: ((row.cost_source as string | null) ?? undefined) as CostSource | undefined,
      ok: (row.ok as number) === 1,
      createdAt: row.created_at as string,
    };
  }

  getJobCallSummary(jobId: string): JobCostSummary {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, pipeline_run_id, role, backend, model, duration_ms,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cost_usd, cost_source, ok, created_at
         FROM agent_calls
         WHERE job_id = ?
         ORDER BY id ASC`,
      )
      .all(jobId) as Array<Record<string, unknown>>;

    const calls = rows.map(r => this.mapAgentCallRow(r));
    const totals = calls.reduce(
      (acc, c) => {
        acc.totalCostUsd += c.costUsd ?? 0;
        acc.totalDurationMs += c.durationMs;
        acc.totalInputTokens += c.inputTokens ?? 0;
        acc.totalOutputTokens += c.outputTokens ?? 0;
        acc.totalCacheReadTokens += c.cacheReadTokens ?? 0;
        acc.totalCacheCreationTokens += c.cacheCreationTokens ?? 0;
        return acc;
      },
      {
        totalCostUsd: 0,
        totalDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      },
    );

    return {
      jobId,
      ...totals,
      callCount: calls.length,
      calls,
    };
  }

  getCallSummarySince(sinceIso: string): CallSummarySince {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
           COUNT(*) AS total_calls,
           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens
         FROM agent_calls
         WHERE created_at >= ?`,
      )
      .get(sinceIso) as Record<string, number>;

    const totalInput = Number(row.total_input_tokens ?? 0);
    const totalCacheRead = Number(row.total_cache_read_tokens ?? 0);
    const denom = totalInput + totalCacheRead;
    const cacheHitRate = denom > 0 ? totalCacheRead / denom : 0;

    return {
      totalCostUsd: Number(row.total_cost_usd ?? 0),
      totalCalls: Number(row.total_calls ?? 0),
      totalInputTokens: totalInput,
      totalOutputTokens: Number(row.total_output_tokens ?? 0),
      totalCacheReadTokens: totalCacheRead,
      cacheHitRate,
    };
  }

  listCallsBetween(sinceIso: string, untilIso: string, limit = 5000): AgentCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, pipeline_run_id, role, backend, model, duration_ms,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cost_usd, cost_source, ok, created_at
         FROM agent_calls
         WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceIso, untilIso, limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapAgentCallRow(r));
  }

  hasEvent(eventId: string): boolean {
    const row = this.hasEventStmt.get(eventId) as { event_id?: string } | undefined;
    return Boolean(row?.event_id);
  }

  recordEvent(eventId: string, channelId: string, threadTs: string): void {
    this.recordEventStmt.run(eventId, channelId, threadTs, new Date().toISOString());
  }

  hasJobForEventTs(channelId: string, eventTs: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE channel_id = ?
           AND json_extract(payload_json, '$.eventTs') = ?
           AND status IN ('RUNNING', 'SUCCESS', 'PAUSED', 'SKIPPED')
         LIMIT 1`,
      )
      .get(channelId, eventTs) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  /**
   * Find the job (if any) currently RUNNING or PAUSED for a given Slack
   * message ts. Used by the `message_deleted` handler to cancel jobs whose
   * source message the author just removed. Unlike `activeJobForThread`,
   * this matches the underlying message identity (`payload_json.eventTs`)
   * rather than the thread root — so it catches the case where the deleted
   * message was a top-level mention that owns its own thread.
   */
  activeJobForEventTs(
    channelId: string,
    eventTs: string,
  ): { id: string; workflow: WorkflowIntent; status: JobRecord['status']; threadTs: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workflow, status, thread_ts
         FROM jobs
         WHERE channel_id = ?
           AND json_extract(payload_json, '$.eventTs') = ?
           AND status IN ('RUNNING', 'PAUSED')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(channelId, eventTs) as
      | { id?: string; workflow?: WorkflowIntent; status?: JobRecord['status']; thread_ts?: string }
      | undefined;

    if (!row?.id || !row?.workflow || !row?.status || row?.thread_ts === undefined) {
      return undefined;
    }

    return {
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      threadTs: row.thread_ts,
    };
  }

  listKnownChannels(limit = 200): string[] {
    const stmt = this.db.prepare(
      `SELECT channel_id
       FROM events
       WHERE channel_id IS NOT NULL AND channel_id != ''
       GROUP BY channel_id
       ORDER BY MAX(created_at) DESC
       LIMIT ?`,
    ) as unknown as {
      all: (limitArg: number) => Array<{
        channel_id: string;
      }>;
    };
    const rows = stmt.all(limit);
    return rows.map(row => row.channel_id).filter(Boolean);
  }

  getState(key: string): string | undefined {
    const row = this.getStateStmt.get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.setStateStmt.run(key, value, new Date().toISOString());
  }

  createLaunchpadRequest(input: {
    id: string;
    target: LaunchpadTarget;
    prompt: string;
    ownerUserId: string;
    status?: Extract<LaunchpadRequestStatus, 'PENDING' | 'CLAIMED' | 'QUEUED' | 'RUNNING'>;
    slackChannelId?: string;
    anchorTs?: string;
    requestedForUserId?: string;
    originChannelId?: string;
    originThreadTs?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO launchpad_requests(
           id, target, prompt, owner_user_id, status, slack_channel_id, anchor_ts,
           requested_for_user_id, origin_channel_id, origin_thread_ts, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.target,
        input.prompt,
        input.ownerUserId,
        input.status ?? 'PENDING',
        input.slackChannelId ?? null,
        input.anchorTs ?? null,
        input.requestedForUserId ?? null,
        input.originChannelId ?? null,
        input.originThreadTs ?? null,
        now,
        now,
      );
  }

  claimPendingLaunchpadRequests(limit = 10): LaunchpadRequestRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const now = new Date().toISOString();
    const rows = (
      this.db.prepare(
        `SELECT id, target, prompt, owner_user_id, status, job_id, slack_channel_id, anchor_ts,
                requested_for_user_id, origin_channel_id, origin_thread_ts,
                result_json, error_message, created_at, updated_at
         FROM launchpad_requests
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT ?`,
      ) as unknown as {
        all: (limitArg: number) => Array<{
          id: string;
          target: LaunchpadTarget;
          prompt: string;
          owner_user_id: string;
          status: LaunchpadRequestStatus;
          job_id?: string | null;
          slack_channel_id?: string | null;
          anchor_ts?: string | null;
          requested_for_user_id?: string | null;
          origin_channel_id?: string | null;
          origin_thread_ts?: string | null;
          result_json?: string | null;
          error_message?: string | null;
          created_at: string;
          updated_at: string;
        }>;
      }
    ).all(safeLimit);

    const claimed: LaunchpadRequestRecord[] = [];
    const claimStmt = this.db.prepare(
      `UPDATE launchpad_requests
       SET status = 'CLAIMED',
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
    );

    for (const row of rows) {
      const result = claimStmt.run(now, row.id);
      if (result.changes < 1) {
        continue;
      }
      claimed.push({
        id: row.id,
        target: row.target,
        prompt: row.prompt,
        ownerUserId: row.owner_user_id,
        status: 'CLAIMED',
        jobId: row.job_id ?? undefined,
        slackChannelId: row.slack_channel_id ?? undefined,
        anchorTs: row.anchor_ts ?? undefined,
        requestedForUserId: row.requested_for_user_id ?? undefined,
        originChannelId: row.origin_channel_id ?? undefined,
        originThreadTs: row.origin_thread_ts ?? undefined,
        resultJson: row.result_json ?? undefined,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at,
        updatedAt: now,
      });
    }

    return claimed;
  }

  markLaunchpadRequestQueued(input: { id: string; slackChannelId: string; anchorTs: string }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'QUEUED',
             slack_channel_id = ?,
             anchor_ts = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.slackChannelId, input.anchorTs, new Date().toISOString(), input.id);
  }

  markLaunchpadRequestRunning(input: { id: string; jobId: string }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'RUNNING',
             job_id = ?,
             error_message = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.jobId, new Date().toISOString(), input.id);
  }

  markLaunchpadRequestFinished(input: {
    id: string;
    status: Extract<LaunchpadRequestStatus, 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED'>;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = ?,
             result_json = ?,
             error_message = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.result ? JSON.stringify(input.result) : null,
        input.errorMessage ?? null,
        new Date().toISOString(),
        input.id,
      );
  }

  getLaunchpadRequest(id: string): LaunchpadRequestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, target, prompt, owner_user_id, status, job_id, slack_channel_id, anchor_ts,
                result_json, error_message, created_at, updated_at
         FROM launchpad_requests
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id) as
      | {
          id: string;
          target: LaunchpadTarget;
          prompt: string;
          owner_user_id: string;
          status: LaunchpadRequestStatus;
          job_id?: string | null;
          slack_channel_id?: string | null;
          anchor_ts?: string | null;
          result_json?: string | null;
          error_message?: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      target: row.target,
      prompt: row.prompt,
      ownerUserId: row.owner_user_id,
      status: row.status,
      jobId: row.job_id ?? undefined,
      slackChannelId: row.slack_channel_id ?? undefined,
      anchorTs: row.anchor_ts ?? undefined,
      resultJson: row.result_json ?? undefined,
      errorMessage: row.error_message ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  latestJobForThread(
    channelId: string,
    threadTs: string,
  ): { workflow: WorkflowIntent; status: JobRecord['status']; updatedAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT workflow, status, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND thread_ts = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(channelId, threadTs) as
      | {
          workflow?: WorkflowIntent;
          status?: JobRecord['status'];
          updated_at?: string;
        }
      | undefined;

    if (!row?.workflow || !row?.status || !row?.updated_at) {
      return undefined;
    }

    return {
      workflow: row.workflow,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find a PAUSED job in this thread that should be resumed by the next
   * @miniOG mention. Uses a wider stale window than activeJobForThread
   * (24h vs 45min) since paused jobs can sit overnight waiting for the user.
   */
  pausedJobForThread(
    channelId: string,
    threadTs: string,
    staleMinutes = 24 * 60,
  ): { id: string; workflow: WorkflowIntent; updatedAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workflow, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND thread_ts = ?
           AND status = 'PAUSED'
           AND updated_at > datetime('now', '-' || ? || ' minutes')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(channelId, threadTs, staleMinutes) as
      | { id?: string; workflow?: WorkflowIntent; updated_at?: string }
      | undefined;

    if (!row?.id || !row?.workflow || !row?.updated_at) {
      return undefined;
    }

    return {
      id: row.id,
      workflow: row.workflow,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Returns the channel + message-ts of the Slack event that originated this
   * job, so callers can manipulate reactions on the original mention later
   * (e.g. clear the :zzz: reaction when a paused job is resumed). The
   * channel lives on the row directly; the event-ts is stashed in
   * payload_json by processEvent at job-create time.
   */
  eventAnchorFor(jobId: string): { channelId: string; eventTs: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT channel_id, json_extract(payload_json, '$.eventTs') AS event_ts
         FROM jobs
         WHERE id = ?
         LIMIT 1`,
      )
      .get(jobId) as { channel_id?: string; event_ts?: string } | undefined;
    if (!row?.channel_id || !row?.event_ts) {
      return undefined;
    }
    return { channelId: row.channel_id, eventTs: row.event_ts };
  }

  /**
   * Returns true when the given job has logged the PR_REVIEW "asking for URL
   * in thread and pausing" stage — i.e. the workflow paused specifically to
   * wait for a follow-up reply containing a PR URL. Used to gate paused-job
   * resume on the actual cause of the pause rather than on jobs.workflow,
   * which is recorded at job-create time using the un-classified intent and
   * therefore reads OWNER_AUTOPILOT for any owner mention even when the
   * classifier subsequently routed it to PR_REVIEW.
   */
  isPausedAwaitingPrUrl(jobId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit
         FROM job_logs
         WHERE job_id = ? AND stage = 'pr_review.context.missing'
         LIMIT 1`,
      )
      .get(jobId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  }

  /**
   * Sibling of isPausedAwaitingPrUrl for the multi-PR clarify pause: the
   * agentic PR review found several PRs in the thread, no selector, and
   * asked which to review (issue #334). Keyed on the same stage string the
   * orchestrator logs before pausing.
   */
  isPausedAwaitingTargetChoice(jobId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit
         FROM job_logs
         WHERE job_id = ? AND stage = 'agentic.pr_review.targets.ambiguous'
         LIMIT 1`,
      )
      .get(jobId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  }

  /**
   * Pause cause: the implementation pipeline hit the Claude usage limit and
   * parked itself until the reset (issue #342). A "resume"/"retry" reply in
   * the thread restarts the workflow via decidePausedResume.
   */
  isPausedAwaitingUsageLimitRetry(jobId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit
         FROM job_logs
         WHERE job_id = ? AND stage = 'implementation.usage_limit.paused'
         LIMIT 1`,
      )
      .get(jobId) as { hit?: number } | undefined;
    return Boolean(row?.hit);
  }

  /**
   * Read a paused job's resume context from result_json. Returns undefined if
   * the job has no result, or if the stored payload doesn't match the
   * ResumeContext schema (caller should treat as a corrupt resume and fail
   * the job rather than re-running blind).
   */
  loadResumeContext(jobId: string): ResumeContext | undefined {
    const row = this.db.prepare('SELECT result_json FROM jobs WHERE id = ? LIMIT 1').get(jobId) as
      | { result_json?: string }
      | undefined;
    if (!row?.result_json) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(row.result_json);
    } catch {
      return undefined;
    }
    return parseResumeContext(raw);
  }

  /**
   * Flip a PAUSED job back to RUNNING when a resume mention arrives.
   * Clears result_json — the workflow will re-write it (with a new resume
   * context if it pauses again, or workflow output on completion).
   */
  markJobRunning(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'RUNNING', error_message = NULL, result_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'PAUSED'`,
      )
      .run(new Date().toISOString(), jobId);
  }

  /**
   * Find the currently-RUNNING job in a thread (if any) — the one that's
   * actively holding a worker slot. PAUSED jobs are intentionally NOT
   * considered active here: they've released their slot and a new @miniOG
   * mention should start a fresh job (a later PR can wire up "resume the
   * paused job in place" using the persisted resumeContext; today the
   * resumeContext is forward-compat groundwork + the sweeper's input).
   */
  activeJobForThread(
    channelId: string,
    threadTs: string,
    staleMinutes = 45,
  ): { id: string; workflow: WorkflowIntent; status: JobRecord['status']; updatedAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, workflow, status, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND thread_ts = ?
           AND status = 'RUNNING'
           AND updated_at > datetime('now', '-' || ? || ' minutes')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(channelId, threadTs, staleMinutes) as
      | { id?: string; workflow?: WorkflowIntent; status?: JobRecord['status']; updated_at?: string }
      | undefined;

    if (!row?.id || !row?.workflow || !row?.status || !row?.updated_at) {
      return undefined;
    }

    return {
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  hasDedupeKey(dedupeKey: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('RUNNING', 'SUCCESS', 'PAUSED', 'SKIPPED') LIMIT 1",
      )
      .get(dedupeKey) as { id?: string } | undefined;
    return Boolean(row?.id);
  }

  createJob(input: {
    id: string;
    eventId: string;
    dedupeKey: string;
    workflow: WorkflowIntent;
    channelId: string;
    threadTs: string;
    payload: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs(
           id, event_id, dedupe_key, workflow, status, channel_id, thread_ts,
           payload_json, attempts, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 'RUNNING', ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        input.id,
        input.eventId,
        input.dedupeKey,
        input.workflow,
        input.channelId,
        input.threadTs,
        JSON.stringify(input.payload),
        now,
        now,
      );
  }

  bumpAttempt(jobId: string): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(new Date().toISOString(), jobId);
  }

  /**
   * Find PAUSED jobs older than `maxAgeMinutes` so the sweeper can fail them
   * cleanly. Returns id + thread coords + cwd (so the caller can clean up the
   * worktree if it persisted one in the resume context).
   */
  stalePausedJobs(maxAgeMinutes: number): Array<{ id: string; channelId: string; threadTs: string }> {
    return this.db
      .prepare(
        `SELECT id, channel_id AS channelId, thread_ts AS threadTs
         FROM jobs
         WHERE status = 'PAUSED'
           AND updated_at < datetime('now', '-' || ? || ' minutes')
         ORDER BY updated_at ASC`,
      )
      .all(maxAgeMinutes) as Array<{ id: string; channelId: string; threadTs: string }>;
  }

  /**
   * On startup, mark any leftover RUNNING jobs as FAILED.
   * Their processes are gone (sidecar restarted) but SQLite still has them as RUNNING.
   * Returns the number of orphaned jobs cleaned up.
   */
  cleanupOrphanedRunningJobs(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'FAILED',
             error_message = 'Process lost during sidecar restart',
             updated_at = ?
         WHERE status = 'RUNNING'`,
      )
      .run(now);
    return result.changes;
  }

  /**
   * Age-based retention sweep. Nothing else prunes the high-growth tables, so
   * over a multi-day process lifetime `job_logs`, `learning_signals`,
   * `agent_calls`, `reaction_feedback`, `events` and terminal `jobs` grow
   * without bound — bloating the DB file and slowing every query and startup.
   *
   * Deletes rows older than `retentionDays` (clamped to >= 1) in a single
   * transaction. RUNNING/PAUSED jobs are never deleted (a PAUSED job is swept to
   * FAILED within 24h, so by the cutoff every surviving job is terminal anyway);
   * dossier / user-memory / pinned-fact tables are intentionally preserved —
   * they carry long-term per-user value, not operational churn. Returns the
   * per-table deletion counts.
   */
  pruneOldRows(retentionDays: number): {
    jobLogs: number;
    learningSignals: number;
    agentCalls: number;
    reactionFeedback: number;
    events: number;
    jobs: number;
  } {
    const days = Math.max(1, Math.floor(retentionDays));
    const cutoff = isoSince(days * DAY_MS);
    const sweep = this.db.transaction((cutoffIso: string) => ({
      jobLogs: this.db.prepare('DELETE FROM job_logs WHERE created_at < ?').run(cutoffIso).changes,
      learningSignals: this.db.prepare('DELETE FROM learning_signals WHERE created_at < ?').run(cutoffIso).changes,
      agentCalls: this.db.prepare('DELETE FROM agent_calls WHERE created_at < ?').run(cutoffIso).changes,
      reactionFeedback: this.db.prepare('DELETE FROM reaction_feedback WHERE created_at < ?').run(cutoffIso).changes,
      events: this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoffIso).changes,
      jobs: this.db
        .prepare(`DELETE FROM jobs WHERE created_at < ? AND status IN ('SUCCESS', 'FAILED', 'CANCELLED', 'SKIPPED')`)
        .run(cutoffIso).changes,
    }));
    return sweep(cutoff);
  }

  /**
   * On startup, revert any launchpad requests stranded in CLAIMED or QUEUED
   * back to PENDING so the next intake poll picks them up. These rows can
   * stick if the sidecar crashes after claiming a request but before
   * linking it to a job (the only state that flips them to RUNNING).
   * Without this, desktop-originated launchpad jobs would silently never
   * execute and never recover. Returns the number of rows reset.
   */
  recoverStrandedLaunchpadRequests(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'PENDING',
             slack_channel_id = NULL,
             anchor_ts = NULL,
             error_message = NULL,
             updated_at = ?
         WHERE status IN ('CLAIMED', 'QUEUED') AND job_id IS NULL`,
      )
      .run(now);
    return result.changes;
  }

  /**
   * On startup, mark any launchpad request stuck in a non-terminal state
   * (RUNNING / CLAIMED / QUEUED with a linked job_id) as FAILED when its
   * underlying job is no longer in a non-terminal state. This complements
   * `cleanupOrphanedRunningJobs` — that method fails the jobs row but never
   * touches launchpad_requests, so a RUNNING launchpad request whose job
   * just got marked FAILED would otherwise stay stranded indefinitely with
   * no DM delivered to the requester.
   *
   * Must run AFTER `cleanupOrphanedRunningJobs` so the linked job rows are
   * already in their terminal state at the time of the JOIN.
   *
   * Returns the number of launchpad_requests rows reconciled.
   */
  reconcileFailedOrphanedLaunchpadRequests(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE launchpad_requests
         SET status = 'FAILED',
             error_message = COALESCE(error_message, 'Process lost during sidecar restart'),
             updated_at = ?
         WHERE status IN ('RUNNING', 'CLAIMED', 'QUEUED')
           AND job_id IS NOT NULL
           AND job_id IN (SELECT id FROM jobs WHERE status = 'FAILED')`,
      )
      .run(now);
    return result.changes;
  }

  markJob(
    jobId: string,
    status: JobRecord['status'],
    options?: {
      errorMessage?: string;
      result?: Record<string, unknown>;
      /**
       * Workflow that actually executed (after router AI reclassification).
       * Stored in jobs.executed_workflow without overwriting jobs.workflow —
       * the latter remains the pre-router intent that pauseResume relies on
       * to detect what kind of resume signal to accept.
       */
      executedWorkflow?: WorkflowIntent;
    },
  ): void {
    if (options?.executedWorkflow !== undefined) {
      this.db
        .prepare(
          `UPDATE jobs
           SET status = ?,
               error_message = ?,
               result_json = ?,
               executed_workflow = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          options?.errorMessage ?? null,
          options?.result ? JSON.stringify(options.result) : null,
          options.executedWorkflow,
          new Date().toISOString(),
          jobId,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, error_message = ?, result_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        options?.errorMessage ?? null,
        options?.result ? JSON.stringify(options.result) : null,
        new Date().toISOString(),
        jobId,
      );
  }

  appendJobLog(input: {
    jobId: string;
    stage: string;
    message: string;
    level?: JobLogLevel;
    data?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_logs(job_id, level, stage, message, data_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.level ?? 'INFO',
        input.stage,
        input.message,
        input.data ? JSON.stringify(input.data) : null,
        new Date().toISOString(),
      );
  }

  listJobLogs(jobId: string, limit = 500): JobLogRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, job_id, level, stage, message, data_json, created_at
       FROM job_logs
       WHERE job_id = ?
       ORDER BY id ASC
       LIMIT ?`,
    ) as unknown as {
      all: (
        jobIdArg: string,
        limitArg: number,
      ) => Array<{
        id: number;
        job_id: string;
        level: JobLogLevel;
        stage: string;
        message: string;
        data_json?: string | null;
        created_at: string;
      }>;
    };

    const rows = stmt.all(jobId, limit);

    return rows.map(row => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      stage: row.stage,
      message: row.message,
      dataJson: row.data_json ?? undefined,
      createdAt: row.created_at,
    }));
  }

  saveIntentCorrection(input: {
    channelId: string;
    userId: string;
    phraseKey: string;
    correctedIntent: WorkflowIntent;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO intent_corrections(
           channel_id, user_id, phrase_key, corrected_intent, hits, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(channel_id, user_id, phrase_key) DO UPDATE SET
           corrected_intent = excluded.corrected_intent,
           hits = intent_corrections.hits + 1,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.userId, input.phraseKey, input.correctedIntent, now, now);
  }

  findIntentCorrection(input: { channelId: string; userId: string; phraseKey: string }): WorkflowIntent | undefined {
    const exact = this.db
      .prepare(
        `SELECT corrected_intent
         FROM intent_corrections
         WHERE channel_id = ?
           AND user_id = ?
           AND phrase_key = ?
         LIMIT 1`,
      )
      .get(input.channelId, input.userId, input.phraseKey) as { corrected_intent?: WorkflowIntent } | undefined;
    if (exact?.corrected_intent) {
      return exact.corrected_intent;
    }

    const stem = input.phraseKey.slice(0, 24);
    if (!stem) {
      return undefined;
    }

    const fuzzy = this.db
      .prepare(
        `SELECT corrected_intent
         FROM intent_corrections
         WHERE channel_id = ?
           AND user_id = ?
           AND phrase_key LIKE ?
         ORDER BY hits DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(input.channelId, input.userId, `${stem}%`) as { corrected_intent?: WorkflowIntent } | undefined;

    return fuzzy?.corrected_intent;
  }

  setPersonalityProfile(input: {
    scope: 'channel' | 'user';
    scopeId: string;
    mode: PersonalityMode;
    source: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO personality_profiles(scope, scope_id, mode, source, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(scope, scope_id) DO UPDATE SET
           mode = excluded.mode,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(input.scope, input.scopeId, input.mode, input.source, now);
  }

  getPersonalityMode(input: { channelId: string; userId: string }): PersonalityMode {
    const userRow = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = 'user' AND scope_id = ?
         LIMIT 1`,
      )
      .get(input.userId) as { mode?: PersonalityMode } | undefined;
    if (userRow?.mode) {
      return normalizeStoredPersonalityMode(userRow.mode);
    }

    const channelRow = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = 'channel' AND scope_id = ?
         LIMIT 1`,
      )
      .get(input.channelId) as { mode?: PersonalityMode } | undefined;
    if (channelRow?.mode) {
      return normalizeStoredPersonalityMode(channelRow.mode);
    }

    return 'normal';
  }

  getPersonalityProfile(input: { scope: 'channel' | 'user'; scopeId: string }): PersonalityMode | undefined {
    const row = this.db
      .prepare(
        `SELECT mode
         FROM personality_profiles
         WHERE scope = ? AND scope_id = ?
         LIMIT 1`,
      )
      .get(input.scope, input.scopeId) as { mode?: PersonalityMode } | undefined;
    return row?.mode ? normalizeStoredPersonalityMode(row.mode) : undefined;
  }

  /**
   * Returns every bundle row, sorted by name. Empty array on a fresh install
   * (the load path in config.ts falls back to deriving from legacy
   * `accessControl` and persisting via `setBundle` as a one-time seed).
   */
  getBundles(): Bundle[] {
    const rows = this.db
      .prepare(
        `SELECT name, slack_user_group_handle, manual_user_ids, capabilities,
                allowed_channel_ids, allow_im, allow_mpim
         FROM bundles
         ORDER BY name`,
      )
      .all() as Array<{
      name: string;
      slack_user_group_handle: string;
      manual_user_ids: string;
      capabilities: string;
      allowed_channel_ids: string;
      allow_im: number;
      allow_mpim: number;
    }>;
    return rows.map(row => {
      let capabilities: Capability[] = [];
      try {
        const parsed: unknown = JSON.parse(row.capabilities);
        if (Array.isArray(parsed)) {
          capabilities = parsed.filter((c): c is Capability => typeof c === 'string');
        }
      } catch {
        // Malformed JSON shouldn't crash the access path — fall through to
        // an empty capability set so the bundle effectively grants nothing.
      }
      const allowedChannelIds = row.allowed_channel_ids
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      return {
        name: row.name,
        slackUserGroupHandle: row.slack_user_group_handle,
        manualUserIds: row.manual_user_ids,
        // resolvedUserIds is rebuilt from the legacy resolution path
        // (`setResolvedGroupMembers`) — not stored in the table itself
        // because subteam membership lives in Slack, not in our DB.
        resolvedUserIds: [],
        capabilities,
        allowedChannelIds,
        allowIm: row.allow_im === 1,
        allowMpim: row.allow_mpim === 1,
      };
    });
  }

  /**
   * Upsert a single bundle. Stores `capabilities` as JSON (matching the
   * `mission_swarm_runs.roles_json` pattern). The `resolvedUserIds` field is
   * NOT persisted — it's derived at runtime from subteam membership.
   */
  setBundle(bundle: Bundle): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bundles(
           name, slack_user_group_handle, manual_user_ids, capabilities,
           allowed_channel_ids, allow_im, allow_mpim, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           slack_user_group_handle = excluded.slack_user_group_handle,
           manual_user_ids = excluded.manual_user_ids,
           capabilities = excluded.capabilities,
           allowed_channel_ids = excluded.allowed_channel_ids,
           allow_im = excluded.allow_im,
           allow_mpim = excluded.allow_mpim,
           updated_at = excluded.updated_at`,
      )
      .run(
        bundle.name,
        bundle.slackUserGroupHandle,
        bundle.manualUserIds,
        JSON.stringify(bundle.capabilities),
        bundle.allowedChannelIds.join(','),
        bundle.allowIm ? 1 : 0,
        bundle.allowMpim ? 1 : 0,
        now,
      );
  }

  deleteBundle(name: string): boolean {
    const result = this.db.prepare(`DELETE FROM bundles WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  /**
   * Returns the timestamp of the most recent access-cache signal, or
   * undefined if no signal has ever been written. Compared against the
   * sidecar's in-memory build time to detect when bundles need a reload.
   */
  getAccessCacheSignalAt(): string | undefined {
    const row = this.db.prepare(`SELECT updated_at FROM access_cache_signals WHERE id = 1 LIMIT 1`).get() as
      | { updated_at?: string }
      | undefined;
    return row?.updated_at;
  }

  /**
   * Bumps the access-cache signal. Called inside each Tauri command that
   * edits a bundle (save_bundle, delete_bundle) so the sidecar's per-workflow
   * reload check fires on the next request.
   */
  bumpAccessCacheSignal(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO access_cache_signals(id, updated_at)
         VALUES(1, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(now);
  }

  upsertMissionStart(input: { channelId: string; threadTs: string; goal: string; ownerUserId: string }): {
    id: string;
    status: string;
  } {
    const now = new Date().toISOString();
    const id = `mission:${input.channelId}:${input.threadTs}`;
    this.db
      .prepare(
        `INSERT INTO mission_threads(
           id, channel_id, thread_ts, goal, plan, progress, blockers, owner_user_id, eta, status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
           goal = excluded.goal,
           owner_user_id = excluded.owner_user_id,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.channelId,
        input.threadTs,
        input.goal,
        'Plan pending',
        'Not started',
        'None',
        input.ownerUserId,
        'TBD',
        'ACTIVE',
        now,
        now,
      );

    return {
      id,
      status: 'ACTIVE',
    };
  }

  getMissionThread(input: { channelId: string; threadTs: string }):
    | {
        id: string;
        goal: string;
        plan: string;
        progress: string;
        blockers: string;
        ownerUserId: string;
        eta: string;
        status: string;
        updatedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT id, goal, plan, progress, blockers, owner_user_id, eta, status, updated_at
         FROM mission_threads
         WHERE channel_id = ? AND thread_ts = ?
         LIMIT 1`,
      )
      .get(input.channelId, input.threadTs) as
      | {
          id?: string;
          goal?: string;
          plan?: string;
          progress?: string;
          blockers?: string;
          owner_user_id?: string;
          eta?: string;
          status?: string;
          updated_at?: string;
        }
      | undefined;

    if (
      !row?.id ||
      !row.goal ||
      !row.plan ||
      !row.progress ||
      !row.blockers ||
      !row.owner_user_id ||
      !row.eta ||
      !row.status ||
      !row.updated_at
    ) {
      return undefined;
    }

    return {
      id: row.id,
      goal: row.goal,
      plan: row.plan,
      progress: row.progress,
      blockers: row.blockers,
      ownerUserId: row.owner_user_id,
      eta: row.eta,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  updateMissionThread(input: {
    channelId: string;
    threadTs: string;
    plan?: string;
    progress?: string;
    blockers?: string;
    eta?: string;
    status?: string;
  }): boolean {
    const mission = this.getMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
    if (!mission) {
      return false;
    }

    this.db
      .prepare(
        `UPDATE mission_threads
         SET plan = ?, progress = ?, blockers = ?, eta = ?, status = ?, updated_at = ?
         WHERE channel_id = ? AND thread_ts = ?`,
      )
      .run(
        input.plan ?? mission.plan,
        input.progress ?? mission.progress,
        input.blockers ?? mission.blockers,
        input.eta ?? mission.eta,
        input.status ?? mission.status,
        new Date().toISOString(),
        input.channelId,
        input.threadTs,
      );

    return true;
  }

  startMissionSwarmRun(input: { channelId: string; threadTs: string; requestedBy: string }):
    | {
        runId: string;
        missionId: string;
        roles: string[];
      }
    | undefined {
    const mission = this.getMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
    if (!mission) {
      return undefined;
    }

    const runId = `swarm:${Date.now()}:${Math.floor(Math.random() * 100000)}`;
    const roles = ['planner', 'coder', 'reviewer', 'shipper'];
    const rolesJson = JSON.stringify(
      roles.map(role => ({
        role,
        status: 'queued',
      })),
    );

    this.db
      .prepare(
        `INSERT INTO mission_swarm_runs(
           run_id, mission_id, channel_id, thread_ts, requested_by, roles_json, status, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        mission.id,
        input.channelId,
        input.threadTs,
        input.requestedBy,
        rolesJson,
        'STARTED',
        new Date().toISOString(),
      );

    this.updateMissionThread({
      channelId: input.channelId,
      threadTs: input.threadTs,
      plan: 'Swarm mode: planner -> coder -> reviewer -> shipper',
      progress: 'Swarm execution started',
      status: 'RUNNING',
    });

    return {
      runId,
      missionId: mission.id,
      roles,
    };
  }

  setTrustPolicy(input: {
    targetType: 'channel' | 'user';
    targetId: string;
    trustLevel: 'observe' | 'suggest' | 'execute' | 'merge';
    updatedBy: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trust_policies(target_type, target_id, trust_level, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           trust_level = excluded.trust_level,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.targetType, input.targetId, input.trustLevel, input.updatedBy, new Date().toISOString());
  }

  getTrustPolicy(input: { targetType: 'channel' | 'user'; targetId: string }):
    | {
        trustLevel: 'observe' | 'suggest' | 'execute' | 'merge';
        updatedBy: string;
        updatedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT trust_level, updated_by, updated_at
         FROM trust_policies
         WHERE target_type = ? AND target_id = ?
         LIMIT 1`,
      )
      .get(input.targetType, input.targetId) as
      | {
          trust_level?: 'observe' | 'suggest' | 'execute' | 'merge';
          updated_by?: string;
          updated_at?: string;
        }
      | undefined;

    if (!row?.trust_level || !row.updated_by || !row.updated_at) {
      return undefined;
    }

    return {
      trustLevel: row.trust_level,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  createReplayRequest(input: {
    sourceJobId: string;
    mode: 'replay' | 'fork';
    requestedBy: string;
    channelId: string;
    threadTs: string;
  }): {
    requestId: string;
    status: string;
  } {
    const requestId = `${input.mode}:${Date.now()}:${Math.floor(Math.random() * 100000)}`;
    this.db
      .prepare(
        `INSERT INTO replay_requests(
           request_id, source_job_id, mode, requested_by, channel_id, thread_ts, status, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        input.sourceJobId,
        input.mode,
        input.requestedBy,
        input.channelId,
        input.threadTs,
        'QUEUED',
        new Date().toISOString(),
      );

    return {
      requestId,
      status: 'QUEUED',
    };
  }

  recordReactionFeedback(input: {
    eventId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    reaction: string;
    sentiment: -1 | 0 | 1;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reaction_feedback(
           event_id, channel_id, thread_ts, user_id, reaction, sentiment, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId,
        input.channelId,
        input.threadTs,
        input.userId,
        input.reaction,
        input.sentiment,
        new Date().toISOString(),
      );
  }

  getReactionFeedbackSnapshot(channelId: string): {
    positive: number;
    negative: number;
    neutral: number;
  } {
    const rows = (
      this.db.prepare(
        `SELECT sentiment, COUNT(*) as count
         FROM reaction_feedback
         WHERE channel_id = ?
         GROUP BY sentiment`,
      ) as unknown as {
        all: (channelIdArg: string) => Array<{ sentiment: number; count: number }>;
      }
    ).all(channelId);

    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const row of rows) {
      if (row.sentiment > 0) {
        positive = Number(row.count);
      } else if (row.sentiment < 0) {
        negative = Number(row.count);
      } else {
        neutral = Number(row.count);
      }
    }

    return { positive, negative, neutral };
  }

  registerSkill(input: { name: string; path: string; version: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO skill_registry(skill_name, skill_path, version, installed_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(skill_name) DO UPDATE SET
           skill_path = excluded.skill_path,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(input.name, input.path, input.version, now, now);
  }

  getSkill(name: string):
    | {
        name: string;
        path: string;
        version: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT skill_name, skill_path, version
         FROM skill_registry
         WHERE skill_name = ?
         LIMIT 1`,
      )
      .get(name) as { skill_name?: string; skill_path?: string; version?: string } | undefined;

    if (!row?.skill_name || !row.skill_path || !row.version) {
      return undefined;
    }

    return {
      name: row.skill_name,
      path: row.skill_path,
      version: row.version,
    };
  }

  setChannelSkill(input: { channelId: string; skillName: string }): void {
    this.db
      .prepare(
        `INSERT INTO skill_channel_preferences(channel_id, active_skill, updated_at)
         VALUES(?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           active_skill = excluded.active_skill,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.skillName, new Date().toISOString());
  }

  getChannelSkill(channelId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT active_skill
         FROM skill_channel_preferences
         WHERE channel_id = ?
         LIMIT 1`,
      )
      .get(channelId) as { active_skill?: string } | undefined;
    return row?.active_skill;
  }

  setOpsFeedSubscription(input: { channelId: string; enabled: boolean; updatedBy: string }): void {
    this.db
      .prepare(
        `INSERT INTO ops_feed_subscriptions(channel_id, enabled, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.enabled ? 1 : 0, input.updatedBy, new Date().toISOString());
  }

  isOpsFeedEnabled(channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT enabled
         FROM ops_feed_subscriptions
         WHERE channel_id = ?
         LIMIT 1`,
      )
      .get(channelId) as { enabled?: number } | undefined;
    return Boolean(row?.enabled);
  }

  listOpsFeedChannels(): string[] {
    const rows = (
      this.db.prepare(
        `SELECT channel_id
         FROM ops_feed_subscriptions
         WHERE enabled = 1`,
      ) as unknown as {
        all: () => Array<{ channel_id: string }>;
      }
    ).all();
    return rows.map(row => row.channel_id);
  }

  setDailyDigestSchedule(input: { channelId: string; enabled: boolean; digestTime?: string; updatedBy: string }): void {
    const existing = this.db
      .prepare(
        `SELECT digest_time
         FROM daily_digest_settings
         WHERE channel_id = ?
         LIMIT 1`,
      )
      .get(input.channelId) as { digest_time?: string } | undefined;
    const digestTime = (input.digestTime ?? existing?.digest_time ?? '09:30').trim();

    this.db
      .prepare(
        `INSERT INTO daily_digest_settings(channel_id, enabled, digest_time, updated_by, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           digest_time = excluded.digest_time,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.enabled ? 1 : 0, digestTime, input.updatedBy, new Date().toISOString());
  }

  listDailyDigestSchedules(): Array<{
    channelId: string;
    digestTime: string;
  }> {
    const rows = (
      this.db.prepare(
        `SELECT channel_id, digest_time
         FROM daily_digest_settings
         WHERE enabled = 1`,
      ) as unknown as {
        all: () => Array<{ channel_id: string; digest_time: string }>;
      }
    ).all();
    return rows.map(row => ({
      channelId: row.channel_id,
      digestTime: row.digest_time,
    }));
  }

  wasDigestSentToday(channelId: string, dateKey: string): boolean {
    return this.getState(`digest:last_sent:${channelId}`) === dateKey;
  }

  markDigestSentToday(channelId: string, dateKey: string): void {
    this.setState(`digest:last_sent:${channelId}`, dateKey);
  }

  importPolicyPack(input: { channelId: string; packName: 'frontend' | 'backend' | 'release'; updatedBy: string }): {
    packName: 'frontend' | 'backend' | 'release';
    description: string;
    rules: string[];
  } {
    const defaults: Record<'frontend' | 'backend' | 'release', { description: string; rules: string[] }> = {
      frontend: {
        description: 'Frontend safety rails for UI quality and release confidence.',
        rules: [
          'Require visual-impact summary and affected routes/components.',
          'No merge if accessibility regressions are found.',
          'Prefer squash merge after at least one passing CI run.',
        ],
      },
      backend: {
        description: 'Backend reliability and API contract guardrails.',
        rules: [
          'Require backward-compatible API change notes.',
          'Block merge on failing integration tests or migration mismatch.',
          'Require rollback note for risky DB/cache changes.',
        ],
      },
      release: {
        description: 'Release governance pack for risky deploy windows.',
        rules: [
          'No merge without release checklist sign-off.',
          'Require staged rollout plan and monitoring guard metrics.',
          'Escalate hotfixes touching auth/payments/checkout.',
        ],
      },
    };

    const selected = defaults[input.packName];
    const now = new Date().toISOString();
    const rulesJson = JSON.stringify(selected.rules);

    this.db
      .prepare(
        `INSERT INTO policy_packs(pack_name, description, rules_json, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(pack_name) DO UPDATE SET
           description = excluded.description,
           rules_json = excluded.rules_json,
           updated_at = excluded.updated_at`,
      )
      .run(input.packName, selected.description, rulesJson, now);

    this.db
      .prepare(
        `INSERT INTO channel_policy_packs(channel_id, pack_name, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           pack_name = excluded.pack_name,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.packName, input.updatedBy, now);

    return {
      packName: input.packName,
      description: selected.description,
      rules: selected.rules,
    };
  }

  getChannelPolicyPack(channelId: string):
    | {
        packName: 'frontend' | 'backend' | 'release';
        description: string;
        rules: string[];
        updatedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT c.pack_name, c.updated_at, p.description, p.rules_json
         FROM channel_policy_packs c
         JOIN policy_packs p ON p.pack_name = c.pack_name
         WHERE c.channel_id = ?
         LIMIT 1`,
      )
      .get(channelId) as
      | {
          pack_name?: 'frontend' | 'backend' | 'release';
          updated_at?: string;
          description?: string;
          rules_json?: string;
        }
      | undefined;

    if (!row?.pack_name || !row.updated_at || !row.description || !row.rules_json) {
      return undefined;
    }

    let rules: string[] = [];
    try {
      const parsed = JSON.parse(row.rules_json) as unknown;
      if (Array.isArray(parsed)) {
        rules = parsed.map(item => String(item)).filter(Boolean);
      }
    } catch {
      rules = [];
    }

    return {
      packName: row.pack_name,
      description: row.description,
      rules,
      updatedAt: row.updated_at,
    };
  }

  setIncidentMode(input: { channelId: string; enabled: boolean; updatedBy: string }): void {
    this.db
      .prepare(
        `INSERT INTO incident_modes(channel_id, enabled, updated_by, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.channelId, input.enabled ? 1 : 0, input.updatedBy, new Date().toISOString());
  }

  listIncidentChannels(): string[] {
    const rows = (
      this.db.prepare(
        `SELECT channel_id
         FROM incident_modes
         WHERE enabled = 1`,
      ) as unknown as {
        all: () => Array<{ channel_id: string }>;
      }
    ).all();
    return rows.map(row => row.channel_id);
  }

  getIncidentSnapshot(channelId: string): {
    running: number;
    failed60m: number;
    paused60m: number;
    topWorkflow: string;
  } {
    const running = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ? AND status = 'RUNNING'`,
          )
          .get(channelId) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const failed60m = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ?
             AND status = 'FAILED'
             AND created_at >= ?`,
          )
          .get(channelId, isoSince(60 * MINUTE_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const paused60m = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM jobs
           WHERE channel_id = ?
             AND status = 'PAUSED'
             AND created_at >= ?`,
          )
          .get(channelId, isoSince(60 * MINUTE_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const topWorkflow =
      (
        this.db
          .prepare(
            `SELECT workflow
             FROM jobs
             WHERE channel_id = ?
               AND status IN ('FAILED', 'PAUSED')
               AND created_at >= ?
             GROUP BY workflow
             ORDER BY COUNT(*) DESC, workflow ASC
             LIMIT 1`,
          )
          .get(channelId, isoSince(60 * MINUTE_MS)) as { workflow?: string } | undefined
      )?.workflow ?? 'none';

    return {
      running,
      failed60m,
      paused60m,
      topWorkflow,
    };
  }

  /**
   * Return the most recent learning signals for a user. Used by the recall
   * assembler (Phase v2.5) to compose a per-user context block.
   */
  recentSignalsForUser(
    userId: string,
    limit = 20,
  ): Array<{
    intent: string | null;
    workflow: string | null;
    status: string | null;
    repo: string | null;
    errorKind: string | null;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT intent, workflow, status, repo, error_kind AS errorKind, created_at AS createdAt
         FROM learning_signals
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as Array<{
      intent: string | null;
      workflow: string | null;
      status: string | null;
      repo: string | null;
      errorKind: string | null;
      createdAt: string;
    }>;
  }

  readVaultSettings(): { vaultPath: string; vaultEnabled: boolean } {
    try {
      const row = this.db
        .prepare(
          `SELECT COALESCE(vault_path, '') AS vault_path,
                  COALESCE(vault_enabled, 0) AS vault_enabled
           FROM app_settings WHERE id = 1 LIMIT 1`,
        )
        .get() as { vault_path?: string; vault_enabled?: number } | undefined;
      return {
        vaultPath: (row?.vault_path ?? '').trim(),
        vaultEnabled: Boolean(row?.vault_enabled),
      };
    } catch {
      return { vaultPath: '', vaultEnabled: false };
    }
  }

  recordLearningSignal(input: {
    jobId: string;
    eventId: string;
    channelId: string;
    userId: string;
    workflow: WorkflowIntent;
    intent: WorkflowIntent;
    status: JobRecord['status'];
    correctionApplied: boolean;
    errorKind?: string;
    personalityMode?: PersonalityMode;
    repo?: string;
    product?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO learning_signals(
           job_id, event_id, channel_id, user_id, workflow, status, intent,
           correction_applied, personality_mode, error_kind, repo, product, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.eventId,
        input.channelId,
        input.userId,
        input.workflow,
        input.status,
        input.intent,
        input.correctionApplied ? 1 : 0,
        input.personalityMode ?? 'normal',
        input.errorKind ?? null,
        input.repo ?? null,
        input.product ?? null,
        new Date().toISOString(),
      );
  }

  findLatestReviewedPrHeadSha(input: {
    channelId: string;
    threadTs: string;
    prUrl: string;
  }): { jobId: string; prHeadSha: string; updatedAt: string } | undefined {
    // COALESCE: review jobs are usually seeded as IMPLEMENTATION /
    // OWNER_AUTOPILOT pre-classifier (jobs.workflow keeps that seed for
    // pause-resume), so the workflow that actually ran lives in
    // executed_workflow. Filtering on the raw column matched nothing
    // (issue #334, bug E).
    //
    // FAILED is included because (a) under pre-#334 semantics completed
    // reviews with blocking findings were mislabeled FAILED, and (b) a
    // partially-failed multi-PR job still carries fully-reviewed PRs. The
    // real invariant is the JSON guard below: only outcomes that persisted
    // a prHeadSha count as reviewed — genuine failures never do.
    const stmt = this.db.prepare(
      `SELECT id, result_json, updated_at
       FROM jobs
       WHERE COALESCE(executed_workflow, workflow) = 'PR_REVIEW'
         AND status IN ('SUCCESS', 'FAILED')
         AND channel_id = ?
         AND thread_ts = ?
       ORDER BY updated_at DESC
       LIMIT 50`,
    ) as unknown as {
      all: (
        channelIdArg: string,
        threadTsArg: string,
      ) => Array<{
        id: string;
        result_json?: string | null;
        updated_at: string;
      }>;
    };

    const rows = stmt.all(input.channelId, input.threadTs);
    for (const row of rows) {
      if (!row.result_json) {
        continue;
      }

      try {
        const parsed = JSON.parse(row.result_json) as Record<string, unknown>;

        // Multi-PR shape: result.outcomes[] with per-PR status + head SHA.
        if (Array.isArray(parsed.outcomes)) {
          for (const candidate of parsed.outcomes) {
            if (!candidate || typeof candidate !== 'object') continue;
            const outcome = candidate as Record<string, unknown>;
            const outcomeUrl = typeof outcome.prUrl === 'string' ? outcome.prUrl : '';
            const outcomeSha = typeof outcome.prHeadSha === 'string' ? outcome.prHeadSha : '';
            if (outcomeUrl === input.prUrl && outcome.status === 'SUCCESS' && outcomeSha) {
              return { jobId: row.id, prHeadSha: outcomeSha, updatedAt: row.updated_at };
            }
          }
          continue;
        }

        // Legacy single-PR shape: top-level prUrl + prHeadSha.
        const prUrl = typeof parsed.prUrl === 'string' ? parsed.prUrl : '';
        const prHeadSha = typeof parsed.prHeadSha === 'string' ? parsed.prHeadSha : '';
        if (prUrl === input.prUrl && prHeadSha) {
          return {
            jobId: row.id,
            prHeadSha,
            updatedAt: row.updated_at,
          };
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  getDevStatusSnapshot(): {
    activeJobs: number;
    runs24h: number;
    failures24h: number;
    successRate24h: number;
  } {
    const activeJobs = Number(
      (
        this.db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'RUNNING'`).get() as
          | { count?: number }
          | undefined
      )?.count ?? 0,
    );

    const runs24h = Number(
      (
        this.db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE created_at >= ?`).get(isoSince(DAY_MS)) as
          | { count?: number }
          | undefined
      )?.count ?? 0,
    );

    const failures24h = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM jobs
           WHERE status = 'FAILED'
             AND created_at >= ?`,
          )
          .get(isoSince(DAY_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const success24h = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM jobs
           WHERE status = 'SUCCESS'
             AND created_at >= ?`,
          )
          .get(isoSince(DAY_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const successRate24h = runs24h > 0 ? Math.round((success24h / runs24h) * 1000) / 10 : 100;

    return {
      activeJobs,
      runs24h,
      failures24h,
      successRate24h,
    };
  }

  listDevRuns(
    limit: number,
    status?: JobRecord['status'],
  ): Array<{
    id: string;
    workflow: WorkflowIntent;
    status: JobRecord['status'];
    updatedAt: string;
    errorMessage?: string;
  }> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    // COALESCE(executed_workflow, workflow): when the router AI reclassifies a
    // job mid-run, executed_workflow holds the workflow that actually ran. Falling
    // back to the pre-router workflow keeps history accurate for jobs created
    // before this column existed.
    const rows = status
      ? (
          this.db.prepare(
            `SELECT id, COALESCE(executed_workflow, workflow) AS workflow, status, updated_at, error_message
           FROM jobs
           WHERE status = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          ) as unknown as {
            all: (
              statusArg: JobRecord['status'],
              limitArg: number,
            ) => Array<{
              id: string;
              workflow: WorkflowIntent;
              status: JobRecord['status'];
              updated_at: string;
              error_message?: string | null;
            }>;
          }
        ).all(status, safeLimit)
      : (
          this.db.prepare(
            `SELECT id, COALESCE(executed_workflow, workflow) AS workflow, status, updated_at, error_message
           FROM jobs
           ORDER BY updated_at DESC
           LIMIT ?`,
          ) as unknown as {
            all: (limitArg: number) => Array<{
              id: string;
              workflow: WorkflowIntent;
              status: JobRecord['status'];
              updated_at: string;
              error_message?: string | null;
            }>;
          }
        ).all(safeLimit);

    return rows.map(row => ({
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      updatedAt: row.updated_at,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  getPersonalQueue(input: { channelId: string; userId: string; limit: number }): Array<{
    id: string;
    workflow: WorkflowIntent;
    status: JobRecord['status'];
    threadTs: string;
    summary: string;
    updatedAt: string;
  }> {
    const safeLimit = Math.min(Math.max(input.limit, 1), 20);
    const rows = (
      this.db.prepare(
        `SELECT id, workflow, status, thread_ts, payload_json, updated_at
         FROM jobs
         WHERE channel_id = ?
           AND (
             json_extract(payload_json, '$.requestUserId') = ?
             OR payload_json LIKE ?
           )
         ORDER BY
           CASE status
             WHEN 'FAILED' THEN 0
             WHEN 'PAUSED' THEN 1
             WHEN 'RUNNING' THEN 2
             ELSE 3
           END ASC,
           updated_at DESC
         LIMIT ?`,
      ) as unknown as {
        all: (
          channelIdArg: string,
          userIdArg: string,
          mentionPatternArg: string,
          limitArg: number,
        ) => Array<{
          id: string;
          workflow: WorkflowIntent;
          status: JobRecord['status'];
          thread_ts: string;
          payload_json?: string | null;
          updated_at: string;
        }>;
      }
    ).all(input.channelId, input.userId, `%<@${input.userId}>%`, safeLimit);

    const mapped = rows.map(row => {
      let summary = '';
      try {
        const payload = row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
        summary = String(payload.text ?? '')
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        summary = '';
      }
      return {
        id: row.id,
        workflow: row.workflow,
        status: row.status,
        threadTs: row.thread_ts,
        summary: summary.slice(0, 140),
        updatedAt: row.updated_at,
      };
    });

    if (mapped.length > 0) {
      return mapped;
    }

    // Fallback to channel queue when user-specific queue is empty.
    return this.listDevRuns(safeLimit).map(item => ({
      id: item.id,
      workflow: item.workflow,
      status: item.status,
      threadTs: '',
      summary: item.errorMessage ?? '',
      updatedAt: item.updatedAt,
    }));
  }

  resolveJobId(prefixOrId: string): string | undefined {
    const value = prefixOrId.trim();
    if (!value) {
      return undefined;
    }

    const exact = this.db.prepare(`SELECT id FROM jobs WHERE id = ? LIMIT 1`).get(value) as { id?: string } | undefined;
    if (exact?.id) {
      return exact.id;
    }

    const fuzzy = this.db
      .prepare(
        `SELECT id
         FROM jobs
         WHERE id LIKE ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(`${value}%`) as { id?: string } | undefined;
    return fuzzy?.id;
  }

  listJobLogsTail(jobId: string, limit = 20): JobLogRecord[] {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const stmt = this.db.prepare(
      `SELECT id, job_id, level, stage, message, data_json, created_at
       FROM job_logs
       WHERE job_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    ) as unknown as {
      all: (
        jobIdArg: string,
        limitArg: number,
      ) => Array<{
        id: number;
        job_id: string;
        level: JobLogLevel;
        stage: string;
        message: string;
        data_json?: string | null;
        created_at: string;
      }>;
    };

    const rows = stmt.all(jobId, safeLimit).reverse();
    return rows.map(row => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      stage: row.stage,
      message: row.message,
      dataJson: row.data_json ?? undefined,
      createdAt: row.created_at,
    }));
  }

  getJobSummary(jobId: string):
    | {
        id: string;
        workflow: WorkflowIntent;
        status: JobRecord['status'];
        errorMessage?: string;
      }
    | undefined {
    const row = this.db
      .prepare(`SELECT id, workflow, status, error_message FROM jobs WHERE id = ? LIMIT 1`)
      .get(jobId) as
      | {
          id?: string;
          workflow?: WorkflowIntent;
          status?: JobRecord['status'];
          error_message?: string | null;
        }
      | undefined;

    if (!row?.id || !row.workflow || !row.status) {
      return undefined;
    }

    return {
      id: row.id,
      workflow: row.workflow,
      status: row.status,
      errorMessage: row.error_message ?? undefined,
    };
  }

  getDevLearningSnapshot(): {
    signals24h: number;
    correctionsLearned: number;
    correctionsApplied24h: number;
    personalityProfiles: number;
    topErrorKind: string;
  } {
    const signals24h = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) as count FROM learning_signals WHERE created_at >= ?`)
          .get(isoSince(DAY_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const correctionsLearned = Number(
      (this.db.prepare(`SELECT COUNT(*) as count FROM intent_corrections`).get() as { count?: number } | undefined)
        ?.count ?? 0,
    );

    const correctionsApplied24h = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) as count
           FROM learning_signals
           WHERE correction_applied = 1
             AND created_at >= ?`,
          )
          .get(isoSince(DAY_MS)) as { count?: number } | undefined
      )?.count ?? 0,
    );

    const personalityProfiles = Number(
      (this.db.prepare(`SELECT COUNT(*) as count FROM personality_profiles`).get() as { count?: number } | undefined)
        ?.count ?? 0,
    );

    const topErrorKind =
      (
        this.db
          .prepare(
            `SELECT error_kind
             FROM learning_signals
             WHERE error_kind IS NOT NULL AND error_kind != ''
             GROUP BY error_kind
             ORDER BY COUNT(*) DESC, error_kind ASC
             LIMIT 1`,
          )
          .get() as { error_kind?: string } | undefined
      )?.error_kind ?? 'none';

    return {
      signals24h,
      correctionsLearned,
      correctionsApplied24h,
      personalityProfiles,
      topErrorKind,
    };
  }

  getDevChannelHeat(limit = 5): Array<{
    channelId: string;
    runs: number;
    failures: number;
  }> {
    const safeLimit = Math.min(Math.max(limit, 1), 20);
    const stmt = this.db.prepare(
      `SELECT channel_id,
              COUNT(*) as runs,
              SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failures
       FROM jobs
       WHERE created_at >= ?
       GROUP BY channel_id
       ORDER BY runs DESC, failures DESC, channel_id ASC
       LIMIT ?`,
    ) as unknown as {
      all: (
        sinceIso: string,
        limitArg: number,
      ) => Array<{
        channel_id: string;
        runs: number;
        failures: number;
      }>;
    };

    return stmt.all(isoSince(7 * DAY_MS), safeLimit).map(row => ({
      channelId: row.channel_id,
      runs: Number(row.runs),
      failures: Number(row.failures),
    }));
  }

  // --- Agent Pipeline Runs ---

  createPipelineRun(input: {
    id: string;
    jobId: string;
    pipelineConfigJson: string;
    status: string;
    stepsJson: string;
    retryLoops?: number;
    totalDurationMs?: number;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_pipeline_runs(
           id, job_id, pipeline_config_json, status, steps_json,
           retry_loops, total_duration_ms, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        input.pipelineConfigJson,
        input.status,
        input.stepsJson,
        input.retryLoops ?? 0,
        input.totalDurationMs ?? null,
        now,
        now,
      );
  }

  updatePipelineRun(
    id: string,
    updates: {
      status?: string;
      stepsJson?: string;
      retryLoops?: number;
      totalDurationMs?: number;
    },
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.stepsJson !== undefined) {
      sets.push('steps_json = ?');
      values.push(updates.stepsJson);
    }
    if (updates.retryLoops !== undefined) {
      sets.push('retry_loops = ?');
      values.push(updates.retryLoops);
    }
    if (updates.totalDurationMs !== undefined) {
      sets.push('total_duration_ms = ?');
      values.push(updates.totalDurationMs);
    }

    values.push(id);
    this.db.prepare(`UPDATE agent_pipeline_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getPipelineRunByJobId(jobId: string):
    | {
        id: string;
        jobId: string;
        pipelineConfigJson: string;
        status: string;
        stepsJson: string;
        retryLoops: number;
        totalDurationMs: number | null;
        createdAt: string;
        updatedAt: string;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT id, job_id, pipeline_config_json, status, steps_json,
                retry_loops, total_duration_ms, created_at, updated_at
         FROM agent_pipeline_runs
         WHERE job_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    return {
      id: String(row.id),
      jobId: String(row.job_id),
      pipelineConfigJson: String(row.pipeline_config_json),
      status: String(row.status),
      stepsJson: String(row.steps_json),
      retryLoops: Number(row.retry_loops),
      totalDurationMs: row.total_duration_ms != null ? Number(row.total_duration_ms) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
