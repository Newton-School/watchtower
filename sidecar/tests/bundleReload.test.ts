import { beforeEach, describe, expect, it } from 'vitest';
import { __setBundlesLoadedAtForTests, reloadBundlesIfChanged } from '../src/runtime/bundleReload.js';
import type { AppConfig, Bundle } from '../src/types/contracts.js';

// Access edited in the app reaches a long wait too (issue #703), not only the next job start.

const admin = (userIds: string[]): Bundle =>
  ({
    name: 'admin',
    manualUserIds: userIds.join(','),
    resolvedUserIds: userIds,
    capabilities: ['deploy_prod'],
    allowedChannelIds: ['C1'],
    allowIm: false,
    allowMpim: false,
  }) as unknown as Bundle;

const source = (signalAt: string | undefined, bundles: Bundle[]) => ({
  getAccessCacheSignalAt: () => signalAt,
  getBundles: () => bundles,
});

beforeEach(() => __setBundlesLoadedAtForTests('2026-10-25T10:00:00.000Z'));

describe('reloading the access bundles', () => {
  it('reloads them in place when they were edited since they were loaded', () => {
    const config = { ownerSlackUserIds: ['UOWNER1'], bundles: [admin(['UADMIN'])] } as unknown as AppConfig;

    expect(reloadBundlesIfChanged(config, source('2026-10-25T11:00:00.000Z', [admin(['UADMIN', 'UNEW'])]))).toBe(true);
    expect(config.bundles?.[0].resolvedUserIds).toContain('UNEW');
    // Once: the same edit isn't read again.
    expect(reloadBundlesIfChanged(config, source('2026-10-25T11:00:00.000Z', [admin(['UOTHER'])]))).toBe(false);
  });

  it.each([
    ['nothing was edited', undefined],
    ['the edit is older than the last load', '2026-10-25T09:00:00.000Z'],
  ])('leaves them alone when %s', (_case, signalAt) => {
    const config = { ownerSlackUserIds: ['UOWNER1'], bundles: [admin(['UADMIN'])] } as unknown as AppConfig;

    expect(reloadBundlesIfChanged(config, source(signalAt, [admin(['UNEW'])]))).toBe(false);
    expect(config.bundles?.[0].resolvedUserIds).toEqual(['UADMIN']);
  });

  it('keeps the bundles it has when the table is empty', () => {
    const config = { ownerSlackUserIds: ['UOWNER1'], bundles: [admin(['UADMIN'])] } as unknown as AppConfig;

    expect(reloadBundlesIfChanged(config, source('2026-10-25T11:00:00.000Z', []))).toBe(false);
    expect(config.bundles?.[0].resolvedUserIds).toEqual(['UADMIN']);
  });
});
