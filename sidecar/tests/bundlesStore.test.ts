import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { hydrateBundleUserIds } from '../src/access/control.js';
import type { Bundle } from '../src/types/contracts.js';

function tempDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-bundles-')), 'watchtower.db');
}

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    name: 'reviewer',
    manualUserIds: 'U1,U2',
    resolvedUserIds: ['U1', 'U2'],
    capabilities: ['query_codebase', 'submit_pr_review', 'comment_pr', 'investigate'],
    allowedChannelIds: ['C-REVIEW'],
    allowIm: false,
    allowMpim: false,
    ...overrides,
  };
}

describe('JobStore bundles CRUD', () => {
  it('returns an empty array when the bundles table is freshly migrated', () => {
    const store = new JobStore(tempDbPath());
    expect(store.getBundles()).toEqual([]);
  });

  it('upserts a bundle and reads it back with the same shape', () => {
    const store = new JobStore(tempDbPath());
    const bundle = makeBundle();
    store.setBundle(bundle);

    const rows = store.getBundles();
    expect(rows).toHaveLength(1);
    const fetched = rows[0];
    expect(fetched.name).toBe('reviewer');
    expect(fetched.manualUserIds).toBe('U1,U2');
    expect(fetched.capabilities).toEqual(['query_codebase', 'submit_pr_review', 'comment_pr', 'investigate']);
    expect(fetched.allowedChannelIds).toEqual(['C-REVIEW']);
    expect(fetched.allowIm).toBe(false);
    expect(fetched.allowMpim).toBe(false);
    // resolvedUserIds is NOT persisted; the read returns an empty array, and
    // hydrateBundleUserIds fills it in at load time.
    expect(fetched.resolvedUserIds).toEqual([]);
  });

  it('upserts on conflict (idempotent setBundle by name)', () => {
    const store = new JobStore(tempDbPath());
    store.setBundle(makeBundle({ name: 'admin', capabilities: ['deploy_prod'] }));
    store.setBundle(
      makeBundle({
        name: 'admin',
        capabilities: ['deploy_prod', 'dev_assist', 'miniog_dossier_admin'],
        allowIm: true,
      }),
    );

    const rows = store.getBundles();
    expect(rows).toHaveLength(1);
    expect(rows[0].capabilities).toEqual(['deploy_prod', 'dev_assist', 'miniog_dossier_admin']);
    expect(rows[0].allowIm).toBe(true);
  });

  it('returns rows sorted by name', () => {
    const store = new JobStore(tempDbPath());
    store.setBundle(makeBundle({ name: 'reviewer' }));
    store.setBundle(makeBundle({ name: 'admin' }));
    store.setBundle(makeBundle({ name: 'viewer' }));

    expect(store.getBundles().map(b => b.name)).toEqual(['admin', 'reviewer', 'viewer']);
  });

  it('deleteBundle removes a row and returns true; returns false for unknown names', () => {
    const store = new JobStore(tempDbPath());
    store.setBundle(makeBundle({ name: 'admin' }));

    expect(store.deleteBundle('admin')).toBe(true);
    expect(store.getBundles()).toHaveLength(0);
    expect(store.deleteBundle('admin')).toBe(false);
    expect(store.deleteBundle('never-existed')).toBe(false);
  });

  it('survives malformed capabilities JSON without crashing (empty capability set)', () => {
    const store = new JobStore(tempDbPath());
    // Inject a row with bad JSON via direct SQL — simulates a corrupted bundle row.
    // @ts-expect-error — reaching into the private db for the test
    store.db
      .prepare(
        `INSERT INTO bundles(name, slack_user_group_handle, manual_user_ids, capabilities,
                             allowed_channel_ids, allow_im, allow_mpim, updated_at)
         VALUES('broken', '', '', 'not-json', '', 0, 0, ?)`,
      )
      .run(new Date().toISOString());

    const rows = store.getBundles();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('broken');
    expect(rows[0].capabilities).toEqual([]);
  });
});

describe('JobStore access cache signal', () => {
  it('returns undefined when no signal has been written', () => {
    const store = new JobStore(tempDbPath());
    expect(store.getAccessCacheSignalAt()).toBeUndefined();
  });

  it('bumpAccessCacheSignal writes a row and updates on subsequent bumps', async () => {
    const store = new JobStore(tempDbPath());
    store.bumpAccessCacheSignal();
    const first = store.getAccessCacheSignalAt();
    expect(first).toBeDefined();

    // Sleep enough to guarantee an ISO-string difference, then bump again.
    await new Promise(resolve => setTimeout(resolve, 5));
    store.bumpAccessCacheSignal();
    const second = store.getAccessCacheSignalAt();
    expect(second).toBeDefined();
    expect(second! > first!).toBe(true);
  });
});

describe('hydrateBundleUserIds', () => {
  it('parses manualUserIds into resolvedUserIds for non-admin/owner bundles', () => {
    const raw: Bundle[] = [
      {
        name: 'reviewer',
        manualUserIds: 'U1, U2 ,U3',
        resolvedUserIds: [],
        capabilities: ['submit_pr_review'],
        allowedChannelIds: ['C-REVIEW'],
        allowIm: false,
        allowMpim: false,
      },
    ];

    const hydrated = hydrateBundleUserIds(raw, ['UOWNER1']);
    expect(hydrated[0].resolvedUserIds).toEqual(['U1', 'U2', 'U3']);
  });

  it('auto-includes ownerSlackUserIds in admin and owner bundles', () => {
    const raw: Bundle[] = [
      {
        name: 'admin',
        manualUserIds: 'UCORE1',
        resolvedUserIds: [],
        capabilities: ['deploy_prod'],
        allowedChannelIds: ['C-ADMIN'],
        allowIm: true,
        allowMpim: false,
      },
      {
        name: 'owner',
        manualUserIds: '',
        resolvedUserIds: [],
        capabilities: ['manage_access'],
        allowedChannelIds: [],
        allowIm: false,
        allowMpim: false,
      },
      {
        name: 'viewer',
        manualUserIds: 'UV1',
        resolvedUserIds: [],
        capabilities: ['query_codebase'],
        allowedChannelIds: ['C-VIEW'],
        allowIm: true,
        allowMpim: false,
      },
    ];

    const hydrated = hydrateBundleUserIds(raw, ['UOWNER1']);

    const admin = hydrated.find(b => b.name === 'admin')!;
    expect(admin.resolvedUserIds).toContain('UOWNER1');
    expect(admin.resolvedUserIds).toContain('UCORE1');

    const owner = hydrated.find(b => b.name === 'owner')!;
    expect(owner.resolvedUserIds).toEqual(['UOWNER1']);

    // Non-admin/owner bundle does NOT auto-include owner IDs.
    const viewer = hydrated.find(b => b.name === 'viewer')!;
    expect(viewer.resolvedUserIds).toEqual(['UV1']);
  });

  it('dedupes when manualUserIds overlaps with ownerSlackUserIds in admin', () => {
    const raw: Bundle[] = [
      {
        name: 'admin',
        manualUserIds: 'UOWNER1,UCORE1',
        resolvedUserIds: [],
        capabilities: ['deploy_prod'],
        allowedChannelIds: ['C-ADMIN'],
        allowIm: true,
        allowMpim: false,
      },
    ];
    const hydrated = hydrateBundleUserIds(raw, ['UOWNER1']);
    expect(hydrated[0].resolvedUserIds).toEqual(['UOWNER1', 'UCORE1']);
  });
});
