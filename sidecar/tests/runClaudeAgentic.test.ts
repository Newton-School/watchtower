import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';

// Pins the tier/effort contract of the agentic runner: the model always comes
// from the backend-resolved profile (callers never name a model id), effort
// optionally overrides the tier's default.

const runCodex = vi.fn();
vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
  getActiveBackendId: () => 'claude-code',
}));

function okResult() {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stdout: 'hi',
    stderr: '',
    lastMessage: 'hi',
    parsedJson: { status: 'success', summary: 'hi', actions: [], prUrl: '' },
  };
}

describe('runClaudeAgentic tier/effort resolution (live claude-code backend)', () => {
  beforeEach(() => {
    runCodex.mockReset();
    runCodex.mockResolvedValue(okResult());
  });

  it('defaults to the high tier at its own effort (opus @ xhigh)', async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'xhigh' });
  });

  it('effort override keeps the tier model and dials only effort', async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', effort: 'medium' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5', reasoningEffort: 'medium' });
  });

  it("tier 'light' resolves the lightweight profile (sonnet @ low)", async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', tier: 'light' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5', reasoningEffort: 'low' });
  });

  it("tier 'light' composes with an effort override", async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', tier: 'light', effort: 'medium' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5', reasoningEffort: 'medium' });
  });
});
