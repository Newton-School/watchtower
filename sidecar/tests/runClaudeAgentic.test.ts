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

  it('defaults to the high tier at its own effort (opus @ high)', async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', reasoningEffort: 'high' });
  });

  it('effort override keeps the tier model and dials only effort', async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', effort: 'medium' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-opus-5-5', reasoningEffort: 'medium' });
  });

  it("tier 'light' resolves the lightweight profile (sonnet @ low)", async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', tier: 'light' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5-5', reasoningEffort: 'low' });
  });

  it("tier 'light' composes with an effort override", async () => {
    await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp', tier: 'light', effort: 'medium' });
    expect(runCodex.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5-5', reasoningEffort: 'medium' });
  });
});

describe('runClaudeAgentic on the usage limit (issue #592)', () => {
  beforeEach(() => runCodex.mockReset());

  it('replies with the limit and the reset time instead of the CLI text, and does not retry', async () => {
    runCodex.mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      lastMessage: "You've hit your usage limit · resets 4:50pm (Asia/Calcutta)",
      errorKind: 'USAGE_LIMIT',
      limitResetsAtText: '4:50pm (Asia/Calcutta)',
    });

    const result = await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp' });

    expect(runCodex).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, reason: 'error', interrupted: 'USAGE_LIMIT' });
    expect(result.reply).toBe(
      "I've hit my Claude usage limit, so I can't answer this right now. It resets 4:50pm (Asia/Calcutta); ask me again after that.",
    );
  });

  it('still says when to come back without a reset time', async () => {
    runCodex.mockResolvedValue({
      ok: false,
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      stdout: '',
      stderr: '',
      lastMessage: 'usage limit reached',
      errorKind: 'USAGE_LIMIT',
    });
    const result = await runClaudeAgentic({ systemPrompt: 's', userMessage: 'u', cwd: '/tmp' });
    expect(result.reply).toBe(
      "I've hit my Claude usage limit, so I can't answer this right now. Ask me again in a few hours.",
    );
  });
});
