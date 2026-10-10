import { describe, expect, it } from 'vitest';
import { isOlderVersion, readSidecarBuild } from '../src/runtime/buildInfo.js';

describe('readSidecarBuild', () => {
  it('reads the version and commit the app passes in', () => {
    const build = readSidecarBuild({
      pid: 771,
      argv: ['/usr/bin/node', '/Applications/watchtower.app/Contents/Resources/_up_/sidecar/dist/index.js'],
      env: { WATCHTOWER_APP_VERSION: '0.6.83', WATCHTOWER_GIT_SHA: 'abc1234' },
    });
    expect(build).toEqual({
      sidecarPid: 771,
      sidecarEntry: '/Applications/watchtower.app/Contents/Resources/_up_/sidecar/dist/index.js',
      appVersion: '0.6.83',
      gitSha: 'abc1234',
    });
  });

  it("reports 'dev' and 'unknown' for a sidecar started by hand", () => {
    const build = readSidecarBuild({ pid: 1, argv: ['node'], env: { WATCHTOWER_GIT_SHA: '' } });
    expect(build).toEqual({ sidecarPid: 1, sidecarEntry: '', appVersion: 'dev', gitSha: 'unknown' });
  });
});

describe('isOlderVersion', () => {
  it('compares each part as a number', () => {
    expect(isOlderVersion('0.6.77', '0.6.83')).toBe(true);
    expect(isOlderVersion('0.6.9', '0.6.10')).toBe(true);
    expect(isOlderVersion('0.6.83', '0.7.0')).toBe(true);
    expect(isOlderVersion('0.9.9', '1.0.0')).toBe(true);
  });

  it('is false for the same or a newer version', () => {
    expect(isOlderVersion('0.6.83', '0.6.83')).toBe(false);
    expect(isOlderVersion('0.6.84', '0.6.83')).toBe(false);
    expect(isOlderVersion('1.0.0', '0.9.9')).toBe(false);
  });

  it('never flags a version it cannot parse', () => {
    expect(isOlderVersion('dev', '0.6.83')).toBe(false);
    expect(isOlderVersion('0.6.83', 'dev')).toBe(false);
    expect(isOlderVersion('', '')).toBe(false);
  });
});
