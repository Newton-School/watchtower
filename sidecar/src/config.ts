import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  buildLegacyAccessControlConfig,
  createDefaultAccessControlSettings,
  deriveBundlesFromLegacy,
  toResolvedAccessControlConfig,
} from './access/control.js';
import type { AccessControlSettings, AgentBackendId, AppConfig } from './types/contracts.js';

export const METABASE_MCP_URL_DEFAULT = 'https://metabase-lierhfgoeiwhr.newtonschool.co/api/mcp';

const settingsSchema = z.object({
  slack_bot_token: z.string(),
  slack_app_token: z.string(),
  owner_slack_user_ids: z.string(),
  bot_user_id: z.string(),
  bugs_and_updates_channel_id: z.string().default('C01H25RNLJH'),
  newton_web_path: z.string(),
  newton_api_path: z.string(),
  newton_marketing_web_path: z.string().default(''),
  max_concurrent_jobs: z.number().int().positive().default(2),
  pr_review_timeout_ms: z.number().int().positive().default(1200000),
  bug_fix_timeout_ms: z.number().int().positive().default(2700000),
  repo_classifier_threshold: z.number().min(0).max(1).default(0.75),
  multi_agent_enabled: z.number().int().min(0).max(1).default(0),
  agent_backend: z.string().default('codex'),
  pm_slack_user_ids: z.string().default(''),
  pm_task_timeout_ms: z.number().int().positive().default(600000),
  core_dev_slack_user_ids: z.string().default(''),
  core_dev_slack_user_group: z.string().default(''),
  mini_og_repo_root: z.string().default('/Users/dipesh/code/mini-og'),
  watchtower_path: z.string().default(''),
  metabase_mcp_url: z.string().default(METABASE_MCP_URL_DEFAULT),
});

type SettingsRow = z.infer<typeof settingsSchema>;

function mustBeAbsoluteExistingDir(p: string, label: string): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`${label} must be an absolute path: ${p}`);
  }
  const real = fs.realpathSync(p);
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must point to an existing directory: ${real}`);
  }
  return real;
}

/**
 * Typed error thrown when repo paths are not under the mini-og root. Carries
 * the violating paths so the Slack-startup layer can surface them to admins.
 */
export class MiniOgRepoRootViolationError extends Error {
  constructor(
    public readonly miniOgRepoRoot: string,
    public readonly offending: Array<{ label: string; path: string }>,
  ) {
    const lines = offending.map(o => `  - ${o.label}: ${o.path}`).join('\n');
    super(
      `Configured repo paths must live under miniOgRepoRoot (${miniOgRepoRoot}). Offending paths:\n${lines}\n\nUpdate settings so every repo path is a subdirectory of ${miniOgRepoRoot}.`,
    );
    this.name = 'MiniOgRepoRootViolationError';
  }
}

/**
 * Returns true if `childPath` is `rootPath` or any subdirectory of it.
 * Uses path separators to prevent partial-prefix matches like /foo/bar-baz
 * being treated as inside /foo/bar.
 */
export function isPathUnder(rootPath: string, childPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedChild = path.resolve(childPath);
  if (normalizedChild === normalizedRoot) return true;
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedChild.startsWith(withSep);
}

function parseOwnerIds(raw: string): string[] {
  return raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function parseChannelIds(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of raw.split(',')) {
    const id = value.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }

  return result;
}

function loadAccessControlSettings(db: Database.Database): AccessControlSettings | undefined {
  const hasSettingsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_control_settings' LIMIT 1")
    .get() as { name?: string } | undefined;
  const hasGroupsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_control_groups' LIMIT 1")
    .get() as { name?: string } | undefined;

  if (!hasSettingsTable?.name || !hasGroupsTable?.name) {
    return undefined;
  }

  const defaults = createDefaultAccessControlSettings();
  const modeRow = db
    .prepare(`SELECT COALESCE(mode, 'audit') AS mode FROM access_control_settings WHERE id = 1 LIMIT 1`)
    .get() as { mode?: string } | undefined;

  const rows = db
    .prepare(
      `SELECT
      group_key,
      COALESCE(slack_user_group_handle, '') AS slack_user_group_handle,
      COALESCE(manual_user_ids, '') AS manual_user_ids,
      COALESCE(allowed_channel_ids, '') AS allowed_channel_ids,
      COALESCE(allow_im, 0) AS allow_im,
      COALESCE(allow_mpim, 0) AS allow_mpim
     FROM access_control_groups`,
    )
    .all() as Array<{
    group_key?: string;
    slack_user_group_handle?: string;
    manual_user_ids?: string;
    allowed_channel_ids?: string;
    allow_im?: number;
    allow_mpim?: number;
  }>;

  for (const row of rows) {
    const key = row.group_key;
    // The `owner` row is accepted so the schema stays uniform across groups, but it
    // is intentionally not editable from the Settings UI — owners are configured via
    // `ownerSlackUserIds`. Any `manual_user_ids` / `slack_user_group_handle` seeded on
    // this row by direct SQL will be loaded and granted rank-4 access; treat the row
    // as system-managed and don't populate it by hand.
    if (key !== 'viewer' && key !== 'reviewer' && key !== 'builder' && key !== 'admin' && key !== 'owner') {
      continue;
    }

    defaults.groups[key] = {
      slackUserGroupHandle: row.slack_user_group_handle ?? '',
      manualUserIds: row.manual_user_ids ?? '',
      allowedChannelIds: row.allowed_channel_ids ?? '',
      allowIm: Boolean(row.allow_im),
      allowMpim: Boolean(row.allow_mpim),
    };
  }

  defaults.mode = modeRow?.mode === 'enforce' ? 'enforce' : 'audit';
  return defaults;
}

export function loadConfigFromDb(dbPath: string): AppConfig {
  const db = new Database(dbPath);

  try {
    // Ensure the mini_og_repo_root column exists before SELECTing it. JobStore
    // normally runs schema migrations, but it boots AFTER loadConfigFromDb, so
    // on first launch of a version that adds the column we'd otherwise hit a
    // "no such column" error and crash-loop. Idempotent.
    try {
      db.exec(
        `ALTER TABLE app_settings ADD COLUMN mini_og_repo_root TEXT NOT NULL DEFAULT '/Users/dipesh/code/mini-og'`,
      );
    } catch {
      /* column already exists */
    }
    try {
      db.exec(`ALTER TABLE app_settings ADD COLUMN watchtower_path TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      db.exec(`ALTER TABLE app_settings ADD COLUMN newton_marketing_web_path TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
    try {
      db.exec(
        `ALTER TABLE app_settings ADD COLUMN metabase_mcp_url TEXT NOT NULL DEFAULT '${METABASE_MCP_URL_DEFAULT}'`,
      );
    } catch {
      /* column already exists */
    }

    const row = db
      .prepare(
        `SELECT
          slack_bot_token,
          slack_app_token,
          owner_slack_user_ids,
          bot_user_id,
          bugs_and_updates_channel_id,
          newton_web_path,
          newton_api_path,
          COALESCE(newton_marketing_web_path, '') AS newton_marketing_web_path,
          max_concurrent_jobs,
          pr_review_timeout_ms,
          bug_fix_timeout_ms,
          repo_classifier_threshold,
          COALESCE(multi_agent_enabled, 0) AS multi_agent_enabled,
          COALESCE(agent_backend, 'codex') AS agent_backend,
          COALESCE(pm_slack_user_ids, '') AS pm_slack_user_ids,
          COALESCE(pm_task_timeout_ms, 600000) AS pm_task_timeout_ms,
          COALESCE(core_dev_slack_user_ids, '') AS core_dev_slack_user_ids,
          COALESCE(core_dev_slack_user_group, '') AS core_dev_slack_user_group,
          COALESCE(mini_og_repo_root, '/Users/dipesh/code/mini-og') AS mini_og_repo_root,
          COALESCE(watchtower_path, '') AS watchtower_path,
          COALESCE(metabase_mcp_url, '${METABASE_MCP_URL_DEFAULT}') AS metabase_mcp_url
         FROM app_settings
         WHERE id = 1
         LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error('Settings row missing; open app settings page and save configuration.');
    }

    const parsed = settingsSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`Invalid settings row: ${parsed.error.message}`);
    }

    return mapSettingsToConfig(parsed.data, loadAccessControlSettings(db));
  } finally {
    db.close();
  }
}

/**
 * Minimal settings snapshot used for emergency admin alerts before (or
 * instead of) a full config load. Only reads fields we need to post a Slack
 * message; performs no path validation.
 */
export interface RawAlertSettings {
  slackBotToken: string;
  channelId: string;
  adminUserIds: string[];
}

export function readSettingsForAlert(dbPath: string): RawAlertSettings | undefined {
  try {
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT
            COALESCE(slack_bot_token, '') AS slack_bot_token,
            COALESCE(bugs_and_updates_channel_id, '') AS channel_id,
            COALESCE(owner_slack_user_ids, '') AS owner_slack_user_ids,
            COALESCE(core_dev_slack_user_ids, '') AS core_dev_slack_user_ids
           FROM app_settings WHERE id = 1 LIMIT 1`,
        )
        .get() as
        | {
            slack_bot_token?: string;
            channel_id?: string;
            owner_slack_user_ids?: string;
            core_dev_slack_user_ids?: string;
          }
        | undefined;
      if (!row) return undefined;
      const token = (row.slack_bot_token ?? '').trim();
      const channel = (row.channel_id ?? '').split(',')[0]?.trim() ?? '';
      if (!token || !channel) return undefined;
      const adminUserIds = [
        ...new Set([
          ...parseOwnerIds(row.owner_slack_user_ids ?? ''),
          ...parseOwnerIds(row.core_dev_slack_user_ids ?? ''),
        ]),
      ];
      return { slackBotToken: token, channelId: channel, adminUserIds };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function readAgentBackend(dbPath: string): AgentBackendId {
  const db = new Database(dbPath);
  try {
    const row = db
      .prepare(`SELECT COALESCE(agent_backend, 'codex') AS agent_backend FROM app_settings WHERE id = 1 LIMIT 1`)
      .get() as { agent_backend?: string } | undefined;
    return coerceAgentBackend(row?.agent_backend);
  } finally {
    db.close();
  }
}

function coerceAgentBackend(value: string | undefined | null): AgentBackendId {
  if (value === 'claude-code') return 'claude-code';
  return 'codex';
}

function mapSettingsToConfig(settings: SettingsRow, accessControlSettings?: AccessControlSettings): AppConfig {
  const ownerSlackUserIds = parseOwnerIds(settings.owner_slack_user_ids);
  const coreDevSlackUserIds = [...new Set([...parseOwnerIds(settings.core_dev_slack_user_ids), ...ownerSlackUserIds])];
  const bugFixChannelIds = parseChannelIds(settings.bugs_and_updates_channel_id);

  const missingFields: string[] = [];
  if (!settings.slack_bot_token.trim()) missingFields.push('slack_bot_token');
  if (!settings.slack_app_token.trim()) missingFields.push('slack_app_token');
  if (!settings.bot_user_id.trim()) missingFields.push('bot_user_id');
  if (ownerSlackUserIds.length === 0) missingFields.push('owner_slack_user_ids');
  if (!settings.newton_web_path.trim()) missingFields.push('newton_web_path');
  if (!settings.newton_api_path.trim()) missingFields.push('newton_api_path');

  if (missingFields.length > 0) {
    throw new Error(
      `Settings incomplete (${missingFields.join(', ')}). Update Watchtower settings in the desktop app.`,
    );
  }

  const newtonWeb = mustBeAbsoluteExistingDir(settings.newton_web_path, 'newton_web_path');
  const newtonApi = mustBeAbsoluteExistingDir(settings.newton_api_path, 'newton_api_path');
  // Optional third repo: blank means "not onboarded on this host" and every
  // marketing-aware feature must degrade gracefully rather than error.
  const newtonMarketingWeb = settings.newton_marketing_web_path.trim()
    ? mustBeAbsoluteExistingDir(settings.newton_marketing_web_path, 'newton_marketing_web_path')
    : undefined;
  const miniOgRepoRoot = mustBeAbsoluteExistingDir(settings.mini_og_repo_root, 'mini_og_repo_root');

  const offending: Array<{ label: string; path: string }> = [];
  if (!isPathUnder(miniOgRepoRoot, newtonWeb)) {
    offending.push({ label: 'newton_web_path', path: newtonWeb });
  }
  if (!isPathUnder(miniOgRepoRoot, newtonApi)) {
    offending.push({ label: 'newton_api_path', path: newtonApi });
  }
  if (newtonMarketingWeb && !isPathUnder(miniOgRepoRoot, newtonMarketingWeb)) {
    offending.push({ label: 'newton_marketing_web_path', path: newtonMarketingWeb });
  }
  if (offending.length > 0) {
    throw new MiniOgRepoRootViolationError(miniOgRepoRoot, offending);
  }

  const watchtowerPath = settings.watchtower_path.trim()
    ? mustBeAbsoluteExistingDir(settings.watchtower_path, 'watchtower_path')
    : undefined;
  const accessControl =
    accessControlSettings !== undefined
      ? toResolvedAccessControlConfig(accessControlSettings, ownerSlackUserIds)
      : buildLegacyAccessControlConfig({
          ownerSlackUserIds,
          coreDevSlackUserIds,
          coreDevSlackUserGroup: settings.core_dev_slack_user_group.trim(),
          allowedChannelsForBugFix: bugFixChannelIds,
        });

  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds,
    coreDevSlackUserIds,
    coreDevSlackUserGroup: settings.core_dev_slack_user_group.trim(),
    botUserId: settings.bot_user_id.trim(),
    slackBotToken: settings.slack_bot_token.trim(),
    slackAppToken: settings.slack_app_token.trim(),
    bugsAndUpdatesChannelId: bugFixChannelIds[0] ?? '',
    allowedChannelsForBugFix: bugFixChannelIds,
    repoPaths: {
      newtonWeb,
      newtonApi,
      newtonMarketingWeb,
      watchtower: watchtowerPath,
    },
    miniOgRepoRoot,
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: settings.max_concurrent_jobs,
    repoClassifierThreshold: settings.repo_classifier_threshold,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: Boolean(settings.multi_agent_enabled),
    agentBackend: coerceAgentBackend(settings.agent_backend),
    prReviewTimeoutMs: settings.pr_review_timeout_ms,
    bugFixTimeoutMs: settings.bug_fix_timeout_ms,
    pmTaskTimeoutMs: settings.pm_task_timeout_ms,
    metabaseMcpUrl: settings.metabase_mcp_url.trim(),
    accessControl,
    bundles: deriveBundlesFromLegacy(accessControl),
  };
}
