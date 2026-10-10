import { afterEach, describe, expect, it, vi } from 'vitest';

// The WATCHTOWER_* model overrides are read once at module load, so each case
// stubs the env, resets the module registry, and re-imports fresh.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('claude-code model env overrides', () => {
  it('lightweight and highReasoning follow their env vars; effort stays profile-defined', async () => {
    vi.stubEnv('WATCHTOWER_CLAUDE_LIGHTWEIGHT_MODEL', 'claude-sonnet-4-6');
    vi.stubEnv('WATCHTOWER_CLAUDE_HIGH_REASONING_MODEL', 'claude-opus-4-7');
    vi.resetModules();
    const m = await import('../src/codex/modelProfiles.js');

    expect(m.lightweightProfile('claude-code')).toEqual({ model: 'claude-sonnet-4-6', reasoningEffort: 'low' });
    expect(m.highReasoningProfile('claude-code')).toEqual({ model: 'claude-opus-4-7', reasoningEffort: 'xhigh' });
  });

  it('planner override follows the high-reasoning env var (no third hardcoded copy)', async () => {
    vi.stubEnv('WATCHTOWER_CLAUDE_HIGH_REASONING_MODEL', 'claude-opus-4-7');
    vi.resetModules();
    const m = await import('../src/codex/modelProfiles.js');

    expect(m.profileForAgentRole('planner', 'claude-code')).toEqual({
      model: 'claude-opus-4-7',
      reasoningEffort: 'xhigh',
    });
  });

  it('empty-string override is treated as unset', async () => {
    vi.stubEnv('WATCHTOWER_CLAUDE_HIGH_REASONING_MODEL', '  ');
    vi.resetModules();
    const m = await import('../src/codex/modelProfiles.js');

    expect(m.highReasoningProfile('claude-code').model).toBe('claude-opus-5');
  });
});
