import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { JobStore } from '../src/state/jobStore.js';

// The vault default moved off ~/Documents (a macOS TCC-protected folder) to
// ~/.watchtower/vault so the app never triggers the per-install permission
// prompt. These exercise the first-launch default + the migration of an
// existing Documents vault, driven by JobStore.migrate() at construction.

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-vault-home-'));
  return { home, dbPath: path.join(home, 'wt.db') };
}

function seedAppSettings(dbPath: string, vaultPath: string, vaultEnabled: number) {
  const db = new Database(dbPath);
  db.exec(
    `CREATE TABLE app_settings (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       vault_path TEXT NOT NULL DEFAULT '',
       vault_enabled INTEGER NOT NULL DEFAULT 0
     )`,
  );
  db.prepare(`INSERT INTO app_settings (id, vault_path, vault_enabled) VALUES (1, ?, ?)`).run(vaultPath, vaultEnabled);
  db.close();
}

function readVault(dbPath: string): { vp: string; ve: number } {
  const db = new Database(dbPath);
  const row = db.prepare(`SELECT vault_path AS vp, vault_enabled AS ve FROM app_settings WHERE id = 1`).get() as {
    vp: string;
    ve: number;
  };
  db.close();
  return row;
}

describe('vault relocation off ~/Documents (TCC)', () => {
  const ORIGINAL_HOME = process.env.HOME;
  let home = '';

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('fresh install seeds the non-protected default and enables the vault', () => {
    ({ home } = (() => setup())());
    const dbPath = path.join(home, 'wt.db');
    process.env.HOME = home;
    seedAppSettings(dbPath, '', 0);

    new JobStore(dbPath).close();

    const { vp, ve } = readVault(dbPath);
    expect(vp).toBe(path.join(home, '.watchtower', 'vault'));
    expect(ve).toBe(1);
    // Never touched Documents.
    expect(fs.existsSync(path.join(home, 'Documents'))).toBe(false);
  });

  it('relocates an existing Documents vault and moves its contents', () => {
    const s = setup();
    home = s.home;
    process.env.HOME = home;
    const oldDir = path.join(home, 'Documents', 'miniog-memory');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'note.md'), '# memory\n');
    seedAppSettings(s.dbPath, oldDir, 1);

    new JobStore(s.dbPath).close();

    const newDir = path.join(home, '.watchtower', 'vault');
    expect(readVault(s.dbPath).vp).toBe(newDir);
    expect(fs.readFileSync(path.join(newDir, 'note.md'), 'utf8')).toBe('# memory\n');
    expect(fs.existsSync(oldDir)).toBe(false);
  });

  it('leaves a user-customized vault path untouched', () => {
    const s = setup();
    home = s.home;
    process.env.HOME = home;
    const custom = path.join(home, 'my-obsidian-vault');
    seedAppSettings(s.dbPath, custom, 1);

    new JobStore(s.dbPath).close();

    expect(readVault(s.dbPath).vp).toBe(custom);
  });

  it('when BOTH vaults exist, repoints nothing and orphans no data (manual-merge case)', () => {
    const s = setup();
    home = s.home;
    process.env.HOME = home;
    const oldDir = path.join(home, 'Documents', 'miniog-memory');
    const newDir = path.join(home, '.watchtower', 'vault');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'old.md'), 'old\n');
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(newDir, 'keep.md'), 'keep\n');
    seedAppSettings(s.dbPath, oldDir, 1);

    new JobStore(s.dbPath).close();

    // Ambiguous: don't silently switch to the other vault. vault_path stays on
    // the existing (old) one and BOTH directories' contents are preserved.
    expect(readVault(s.dbPath).vp).toBe(oldDir);
    expect(fs.readFileSync(path.join(oldDir, 'old.md'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(path.join(newDir, 'keep.md'), 'utf8')).toBe('keep\n');
  });

  it('repoints to the new default when vault_path is the old default but the dir is already gone (crash self-heal)', () => {
    const s = setup();
    home = s.home;
    process.env.HOME = home;
    // vault_path still points at the old default, but the directory no longer
    // exists (e.g. a prior migration moved it, then crashed before the DB
    // update). Next boot should repoint forward, not get stuck.
    seedAppSettings(s.dbPath, path.join(home, 'Documents', 'miniog-memory'), 1);

    new JobStore(s.dbPath).close();

    expect(readVault(s.dbPath).vp).toBe(path.join(home, '.watchtower', 'vault'));
  });
});
