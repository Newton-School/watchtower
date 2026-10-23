import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { copySlackGroupMembers } from '../src/access/slackGroupMembers.js';
import { JobStore } from '../src/state/jobStore.js';
import type { Bundle } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-slack-groups-')), 'watchtower.db');
}

function bundle(name: string, manualUserIds: string): Bundle {
  return {
    name,
    manualUserIds,
    resolvedUserIds: [],
    capabilities: ['query_codebase'],
    allowedChannelIds: [],
    allowIm: false,
    allowMpim: false,
  };
}

/** A store whose bundles name Slack user groups, as before bundles listed people directly. */
function storeWithGroups(groups: Record<string, { manual: string; handles: string }>): {
  store: JobStore;
  handleOf: (name: string) => string;
} {
  const dbPath = tempDbPath();
  const store = new JobStore(dbPath);
  const db = new Database(dbPath);
  for (const [name, { manual, handles }] of Object.entries(groups)) {
    store.setBundle(bundle(name, manual));
    db.prepare(`UPDATE bundles SET slack_user_group_handle = ? WHERE name = ?`).run(handles, name);
  }
  const handleOf = (name: string) =>
    (db.prepare(`SELECT slack_user_group_handle AS h FROM bundles WHERE name = ?`).get(name) as { h: string }).h;
  return { store, handleOf };
}

function fakeSlack(members: Record<string, string[]>, failing: string[] = []): Pick<WebClient, 'usergroups'> {
  const groups = Object.keys(members).map((handle, index) => ({ id: `S${index}`, handle }));
  return {
    usergroups: {
      list: async () => ({ ok: true, usergroups: groups }),
      users: {
        list: async ({ usergroup }: { usergroup: string }) => {
          const handle = groups.find(group => group.id === usergroup)?.handle ?? '';
          if (failing.includes(handle)) throw new Error('ratelimited');
          return { ok: true, users: members[handle] };
        },
      },
    },
  } as unknown as Pick<WebClient, 'usergroups'>;
}

describe('JobStore Slack group helpers', () => {
  it('lists the Slack user groups a bundle still names, and saving a bundle leaves them', () => {
    const { store, handleOf } = storeWithGroups({
      builder: { manual: 'U1', handles: 'core-product, core-design' },
      reviewer: { manual: '', handles: '' },
    });
    expect(store.listBundleSlackGroups()).toEqual([{ name: 'builder', handles: ['core-product', 'core-design'] }]);

    store.setBundle(bundle('builder', 'U1,U2'));
    expect(handleOf('builder')).toBe('core-product, core-design');
  });

  it('adds the members once and forgets the groups', () => {
    const { store, handleOf } = storeWithGroups({ builder: { manual: 'U1', handles: 'core-product' } });

    expect(store.addSlackGroupMembersToBundle('builder', ['U2', 'U1', 'U2'])).toEqual(['U2']);
    expect(store.getBundles()[0].manualUserIds).toBe('U1,U2');
    expect(handleOf('builder')).toBe('');
    expect(store.listBundleSlackGroups()).toEqual([]);
  });
});

describe('copySlackGroupMembers', () => {
  it("copies each bundle's Slack group members onto it, keeping the people already listed", async () => {
    const { store, handleOf } = storeWithGroups({
      builder: { manual: 'UMANUAL', handles: 'core-product,core-design' },
      admin: { manual: '', handles: '@core-dev' },
      viewer: { manual: 'UVIEW', handles: 'gone' },
    });
    const slack = fakeSlack({ 'core-product': ['UP1', 'UP2'], 'core-design': ['UP2', 'UD1'], 'core-dev': ['UDEV'] });

    const result = await copySlackGroupMembers({ store, slack });

    expect(result).toEqual({ copied: ['admin', 'builder', 'viewer'], pending: [] });
    const people = Object.fromEntries(store.getBundles().map(b => [b.name, b.manualUserIds]));
    expect(people).toEqual({ admin: 'UDEV', builder: 'UMANUAL,UP1,UP2,UD1', viewer: 'UVIEW' });
    expect([handleOf('builder'), handleOf('admin'), handleOf('viewer')]).toEqual(['', '', '']);
  });

  it('leaves a bundle whose groups could not all be read, to try again', async () => {
    const { store, handleOf } = storeWithGroups({
      builder: { manual: 'UMANUAL', handles: 'core-product,core-design' },
      admin: { manual: '', handles: 'core-dev' },
    });
    const slack = fakeSlack({ 'core-product': ['UP1'], 'core-design': ['UD1'], 'core-dev': ['UDEV'] }, ['core-design']);

    expect(await copySlackGroupMembers({ store, slack })).toEqual({ copied: ['admin'], pending: ['builder'] });
    expect(store.getBundles().find(b => b.name === 'builder')?.manualUserIds).toBe('UMANUAL');
    expect(handleOf('builder')).toBe('core-product,core-design');

    // Slack answers next time.
    const later = await copySlackGroupMembers({
      store,
      slack: fakeSlack({ 'core-product': ['UP1'], 'core-design': ['UD1'] }),
    });
    expect(later).toEqual({ copied: ['builder'], pending: [] });
    expect(store.getBundles().find(b => b.name === 'builder')?.manualUserIds).toBe('UMANUAL,UP1,UD1');
  });
});

describe('JobStore.carryLegacySlackGroups', () => {
  it('gives freshly seeded bundles the Slack groups of the legacy access groups', () => {
    const dbPath = tempDbPath();
    const store = new JobStore(dbPath);
    store.carryLegacySlackGroups(); // No legacy table yet: nothing to carry.

    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE access_control_groups (group_key TEXT PRIMARY KEY, slack_user_group_handle TEXT NOT NULL DEFAULT '')`,
    );
    db.prepare(`INSERT INTO access_control_groups VALUES (?, ?)`).run('admin', 'core-dev');
    db.prepare(`INSERT INTO access_control_groups VALUES (?, ?)`).run('viewer', '');
    store.setBundle(bundle('admin', 'UOLD'));
    store.setBundle(bundle('viewer', ''));
    store.setBundle(bundle('custom', ''));

    store.carryLegacySlackGroups();
    expect(store.listBundleSlackGroups()).toEqual([{ name: 'admin', handles: ['core-dev'] }]);
  });
});
