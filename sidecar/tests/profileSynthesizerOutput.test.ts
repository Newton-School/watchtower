import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import {
  MIN_MEMORIES_FOR_SYNTHESIS,
  readInferredProfile,
  synthesizeUserProfile,
} from '../src/learning/profileSynthesizer.js';

// Regression: on the claude-code backend, result.lastMessage is the raw
// {"type":"result",...} JSONL envelope (retained so parseOutput can unwrap it).
// The synthesizer used to persist that verbatim, injecting truncated JSON into
// every dossier-carrying prompt's "About:" line. It must persist the unwrapped
// prose (parsedJson.summary) instead.

const runCodex = vi.fn();
vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: (...args: unknown[]) => runCodex(...args),
  getActiveBackendId: () => 'claude-code',
}));

const PROSE = 'Dipesh is the owner; ships fast, prefers terse Slack replies.';
const RAW_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  result: PROSE,
  session_id: 'abc',
});

function claudeCodeResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stdout: RAW_ENVELOPE,
    stderr: '',
    lastMessage: RAW_ENVELOPE,
    parsedJson: { status: 'success', summary: PROSE, actions: [], prUrl: '' },
    ...overrides,
  };
}

function seedMemories(store: JobStore, userId: string): void {
  for (let i = 0; i < MIN_MEMORIES_FOR_SYNTHESIS; i++) {
    store.dossierStore().recordMemory({
      userId,
      jobId: `j-${i}`,
      workflow: 'IMPLEMENTATION',
      status: 'SUCCESS',
      repo: 'newton-web',
      summary: `Did thing ${i}`,
    });
  }
}

describe('synthesizeUserProfile — claude-code output handling', () => {
  beforeEach(() => {
    runCodex.mockReset();
  });

  it('persists the unwrapped prose, not the raw JSONL envelope', async () => {
    const store = new JobStore(':memory:');
    seedMemories(store, 'U1');
    runCodex.mockResolvedValue(claudeCodeResult());

    const out = await synthesizeUserProfile({ userId: 'U1', store });
    expect(out.ok).toBe(true);

    const inferred = readInferredProfile({ store, userId: 'U1' });
    expect(inferred?.text).toBe(PROSE);
    expect(inferred?.text).not.toContain('"type":"result"');
    store.close();
  });

  it('does not persist when the envelope reports an error', async () => {
    const store = new JobStore(':memory:');
    seedMemories(store, 'U1');
    runCodex.mockResolvedValue(
      claudeCodeResult({ parsedJson: { status: 'error', summary: 'usage limit reached', actions: [], prUrl: '' } }),
    );

    const out = await synthesizeUserProfile({ userId: 'U1', store });
    expect(out).toEqual({ ok: false, reason: 'llm-failed' });
    expect(readInferredProfile({ store, userId: 'U1' })).toBeNull();
    store.close();
  });
});
