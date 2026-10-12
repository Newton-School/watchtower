import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolchainEnv } from '../src/backends/codexBackend.js';

// Issue #444: the app is launched by the GUI, so the sidecar inherits a PATH
// without Homebrew or Node, and a direct `gh` spawn failed with ENOENT.
describe('toolchainEnv', () => {
  const realPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  });

  afterEach(() => {
    process.env.PATH = realPath;
  });

  it('adds Homebrew and the running Node directory to a GUI-minimal PATH', () => {
    const dirs = (toolchainEnv().PATH ?? '').split(path.delimiter);
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain(path.dirname(process.execPath));
  });

  it('keeps every directory that was already on the PATH', () => {
    process.env.PATH = '/usr/bin:/opt/custom/bin';
    const dirs = (toolchainEnv().PATH ?? '').split(path.delimiter);
    expect(dirs).toContain('/usr/bin');
    expect(dirs).toContain('/opt/custom/bin');
  });

  it('passes the rest of the environment through unchanged', () => {
    process.env.WT_TOOLCHAIN_PROBE = 'kept';
    try {
      expect(toolchainEnv().WT_TOOLCHAIN_PROBE).toBe('kept');
      expect(toolchainEnv().HOME).toBe(process.env.HOME);
    } finally {
      delete process.env.WT_TOOLCHAIN_PROBE;
    }
  });

  it('does not change the PATH of the sidecar process itself', () => {
    toolchainEnv();
    expect(process.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
