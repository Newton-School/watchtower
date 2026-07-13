import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { loadConfigFromDb, MiniOgRepoRootViolationError } from '../src/config.js';

interface Fixture {
  dbPath: string;
  miniOgRoot: string;
  newtonWeb: string;
  newtonApi: string;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-config-'));
  fs.mkdirSync(path.join(dir, 'mini-og', 'newton-web'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mini-og', 'newton-api'), { recursive: true });
  // Resolve symlinks (macOS /tmp → /private/tmp) so the values match what
  // `mustBeAbsoluteExistingDir` returns after realpathSync.
  const miniOgRoot = fs.realpathSync(path.join(dir, 'mini-og'));
  const newtonWeb = fs.realpathSync(path.join(dir, 'mini-og', 'newton-web'));
  const newtonApi = fs.realpathSync(path.join(dir, 'mini-og', 'newton-api'));

  const dbPath = path.join(dir, 'watchtower.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      slack_bot_token TEXT NOT NULL DEFAULT '',
      slack_app_token TEXT NOT NULL DEFAULT '',
      owner_slack_user_ids TEXT NOT NULL DEFAULT '',
      bot_user_id TEXT NOT NULL DEFAULT '',
      bugs_and_updates_channel_id TEXT NOT NULL DEFAULT 'C01H25RNLJH',
      newton_web_path TEXT NOT NULL DEFAULT '',
      newton_api_path TEXT NOT NULL DEFAULT '',
      max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
      pr_review_timeout_ms INTEGER NOT NULL DEFAULT 720000,
      bug_fix_timeout_ms INTEGER NOT NULL DEFAULT 2700000,
      repo_classifier_threshold REAL NOT NULL DEFAULT 0.75,
      multi_agent_enabled INTEGER NOT NULL DEFAULT 0,
      agent_backend TEXT NOT NULL DEFAULT 'codex',
      pm_slack_user_ids TEXT NOT NULL DEFAULT '',
      pm_task_timeout_ms INTEGER NOT NULL DEFAULT 600000,
      core_dev_slack_user_ids TEXT NOT NULL DEFAULT '',
      core_dev_slack_user_group TEXT NOT NULL DEFAULT '',
      mini_og_repo_root TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO app_settings(id) VALUES (1);
  `);

  db.prepare(`UPDATE app_settings SET mini_og_repo_root = ? WHERE id = 1`).run(miniOgRoot);

  db.close();
  return { dbPath, miniOgRoot, newtonWeb, newtonApi };
}

function makeDb(): string {
  return makeFixture().dbPath;
}

describe('loadConfigFromDb', () => {
  it('loads config from persisted settings', () => {
    const { dbPath, newtonWeb, newtonApi } = makeFixture();
    const db = new Database(dbPath);

    db.prepare(
      `
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          bugs_and_updates_channel_id = ?,
          newton_web_path = ?,
          newton_api_path = ?,
          max_concurrent_jobs = ?,
          pr_review_timeout_ms = ?,
          bug_fix_timeout_ms = ?,
          repo_classifier_threshold = ?
      WHERE id = 1
    `,
    ).run(
      'xoxb-valid',
      'xapp-valid',
      'U1,U2',
      'UBOT',
      'C01H25RNLJH, C02BUGS, C01H25RNLJH',
      newtonWeb,
      newtonApi,
      2,
      720000,
      2700000,
      0.75,
    );

    db.close();

    const config = loadConfigFromDb(dbPath);
    expect(config.botUserId).toBe('UBOT');
    expect(config.ownerSlackUserIds).toEqual(['U1', 'U2']);
    expect(config.allowedChannelsForBugFix).toEqual(['C01H25RNLJH', 'C02BUGS']);
    expect(config.bugsAndUpdatesChannelId).toBe('C01H25RNLJH');
    expect(config.repoPaths.newtonWeb).toBe(newtonWeb);
    // The fixture schema predates newton_marketing_web_path, so this also
    // proves the self-migration ran and a blank column disables the repo.
    expect(config.repoPaths.newtonMarketingWeb).toBeUndefined();
  });

  it('loads an optional newton-marketing-web path when configured under the root', () => {
    const { dbPath, miniOgRoot, newtonWeb, newtonApi } = makeFixture();
    const marketingWeb = path.join(miniOgRoot, 'newton-marketing-web');
    fs.mkdirSync(marketingWeb, { recursive: true });

    const db = new Database(dbPath);
    db.exec(`ALTER TABLE app_settings ADD COLUMN newton_marketing_web_path TEXT NOT NULL DEFAULT ''`);
    db.prepare(
      `
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          newton_web_path = ?,
          newton_api_path = ?,
          newton_marketing_web_path = ?
      WHERE id = 1
    `,
    ).run('xoxb-valid', 'xapp-valid', 'U1', 'UBOT', newtonWeb, newtonApi, marketingWeb);
    db.close();

    const config = loadConfigFromDb(dbPath);
    expect(config.repoPaths.newtonMarketingWeb).toBe(fs.realpathSync(marketingWeb));
  });

  it('refuses config when the marketing path is outside the mini-og root', () => {
    const { dbPath, newtonWeb, newtonApi } = makeFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-mkt-outside-'));
    const outsideMarketing = path.join(outside, 'newton-marketing-web');
    fs.mkdirSync(outsideMarketing, { recursive: true });

    const db = new Database(dbPath);
    db.exec(`ALTER TABLE app_settings ADD COLUMN newton_marketing_web_path TEXT NOT NULL DEFAULT ''`);
    db.prepare(
      `
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          newton_web_path = ?,
          newton_api_path = ?,
          newton_marketing_web_path = ?
      WHERE id = 1
    `,
    ).run('xoxb-valid', 'xapp-valid', 'U1', 'UBOT', newtonWeb, newtonApi, outsideMarketing);
    db.close();

    let thrown: unknown;
    try {
      loadConfigFromDb(dbPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MiniOgRepoRootViolationError);
    expect(String(thrown)).toContain('newton_marketing_web_path');
  });

  it('self-migrates the mini_og_repo_root column when the DB predates it', () => {
    // Pre-v0.5.9 schema: no mini_og_repo_root column at all. Before the fix,
    // loadConfigFromDb would crash with "no such column". The loader must now
    // ALTER TABLE ADD COLUMN on the fly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-oldschema-'));
    fs.mkdirSync(path.join(dir, 'mini-og', 'newton-web'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'mini-og', 'newton-api'), { recursive: true });
    const miniOgRoot = fs.realpathSync(path.join(dir, 'mini-og'));
    const newtonWeb = fs.realpathSync(path.join(dir, 'mini-og', 'newton-web'));
    const newtonApi = fs.realpathSync(path.join(dir, 'mini-og', 'newton-api'));

    const dbPath = path.join(dir, 'watchtower.db');
    const db = new Database(dbPath);
    // NOTE: no mini_og_repo_root column — this is the pre-v0.5.9 state. All
    // other columns referenced by the SELECT must exist, since the COALESCE
    // wrappers guard against NULL but not missing columns.
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        slack_bot_token TEXT NOT NULL DEFAULT '',
        slack_app_token TEXT NOT NULL DEFAULT '',
        owner_slack_user_ids TEXT NOT NULL DEFAULT '',
        bot_user_id TEXT NOT NULL DEFAULT '',
        bugs_and_updates_channel_id TEXT NOT NULL DEFAULT 'C01H25RNLJH',
        newton_web_path TEXT NOT NULL DEFAULT '',
        newton_api_path TEXT NOT NULL DEFAULT '',
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
        pr_review_timeout_ms INTEGER NOT NULL DEFAULT 720000,
        bug_fix_timeout_ms INTEGER NOT NULL DEFAULT 2700000,
        repo_classifier_threshold REAL NOT NULL DEFAULT 0.75,
        multi_agent_enabled INTEGER NOT NULL DEFAULT 0,
        agent_backend TEXT NOT NULL DEFAULT 'codex',
        pm_slack_user_ids TEXT NOT NULL DEFAULT '',
        pm_task_timeout_ms INTEGER NOT NULL DEFAULT 600000,
        core_dev_slack_user_ids TEXT NOT NULL DEFAULT '',
        core_dev_slack_user_group TEXT NOT NULL DEFAULT ''
      );
      INSERT OR IGNORE INTO app_settings(id) VALUES (1);
    `);
    db.prepare(
      `UPDATE app_settings SET slack_bot_token=?, slack_app_token=?, owner_slack_user_ids=?, bot_user_id=?, bugs_and_updates_channel_id=?, newton_web_path=?, newton_api_path=? WHERE id=1`,
    ).run('xoxb-valid', 'xapp-valid', 'U1', 'UBOT', 'C01H25RNLJH', newtonWeb, newtonApi);
    db.close();

    // Loader must self-migrate rather than throw "no such column". It may still
    // throw a downstream error (MiniOgRepoRootViolationError) because the
    // default root won't match these tmp paths — that's fine; we only care
    // that the self-migration ran and the column now exists.
    let thrown: unknown;
    try {
      loadConfigFromDb(dbPath);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown ?? '')).not.toMatch(/no such column/i);

    const db2 = new Database(dbPath);
    const cols = (db2.prepare(`PRAGMA table_info(app_settings)`).all() as Array<{ name: string }>).map(c => c.name);
    db2.close();
    expect(cols).toContain('mini_og_repo_root');

    void miniOgRoot;
  });

  it('refuses config when repo paths are not under the mini-og root', () => {
    const { dbPath } = makeFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-outside-'));
    const outsideWeb = path.join(outside, 'newton-web');
    const outsideApi = path.join(outside, 'newton-api');
    fs.mkdirSync(outsideWeb, { recursive: true });
    fs.mkdirSync(outsideApi, { recursive: true });

    const db = new Database(dbPath);
    db.prepare(
      `
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          bugs_and_updates_channel_id = ?,
          newton_web_path = ?,
          newton_api_path = ?
      WHERE id = 1
    `,
    ).run('xoxb-valid', 'xapp-valid', 'U1', 'UBOT', 'C01H25RNLJH', outsideWeb, outsideApi);
    db.close();

    expect(() => loadConfigFromDb(dbPath)).toThrow(MiniOgRepoRootViolationError);
  });

  it('throws when required settings are missing', () => {
    const dbPath = makeDb();
    expect(() => loadConfigFromDb(dbPath)).toThrow('Settings incomplete');
  });

  it('loads access-control settings from dedicated tables when present', () => {
    const { dbPath, newtonWeb, newtonApi } = makeFixture();
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS access_control_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'audit',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT OR IGNORE INTO access_control_settings(id, mode) VALUES (1, 'enforce');

      CREATE TABLE IF NOT EXISTS access_control_groups (
        group_key TEXT PRIMARY KEY,
        slack_user_group_handle TEXT NOT NULL DEFAULT '',
        manual_user_ids TEXT NOT NULL DEFAULT '',
        allowed_channel_ids TEXT NOT NULL DEFAULT '',
        allow_im INTEGER NOT NULL DEFAULT 0,
        allow_mpim INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.prepare(
      `
      UPDATE app_settings
      SET slack_bot_token = ?,
          slack_app_token = ?,
          owner_slack_user_ids = ?,
          bot_user_id = ?,
          bugs_and_updates_channel_id = ?,
          newton_web_path = ?,
          newton_api_path = ?,
          max_concurrent_jobs = ?,
          pr_review_timeout_ms = ?,
          bug_fix_timeout_ms = ?,
          repo_classifier_threshold = ?
      WHERE id = 1
    `,
    ).run('xoxb-valid', 'xapp-valid', 'U1,U2', 'UBOT', 'C01H25RNLJH', newtonWeb, newtonApi, 2, 720000, 2700000, 0.75);

    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('viewer', 'eng-viewers', 'U3', 'C-VIEW', 1, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('reviewer', '', 'U4', 'C-REVIEW', 0, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('builder', '', 'U5', 'C-BUILD', 0, 0);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('admin', 'platform-admins', 'U6', 'C-ADMIN', 1, 1);
    db.prepare(
      `
      INSERT INTO access_control_groups(
        group_key,
        slack_user_group_handle,
        manual_user_ids,
        allowed_channel_ids,
        allow_im,
        allow_mpim
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run('owner', '', '', '', 0, 0);

    db.close();

    const config = loadConfigFromDb(dbPath);
    expect(config.accessControl?.mode).toBe('enforce');
    expect(config.accessControl?.groups.viewer.slackUserGroupHandle).toBe('eng-viewers');
    expect(config.accessControl?.groups.viewer.resolvedUserIds).toEqual(['U3']);
    expect(config.accessControl?.groups.admin.resolvedUserIds).toEqual(['U1', 'U2', 'U6']);
    expect(config.accessControl?.groups.admin.allowIm).toBe(true);
    expect(config.accessControl?.groups.owner).toBeDefined();
    expect(config.accessControl?.groups.owner.resolvedUserIds).toEqual(['U1', 'U2']);
  });
});
