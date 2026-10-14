import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __infraRetry, connectionLostReply, killedFromOutsideReply } from '../src/codex/infraRetry.js';
import { runClaudeAgentic } from '../src/agentic/runClaude.js';
import { defaultPrReviewDeps } from '../src/agentic/prReviewAgent.js';
import type { CodexRunResult } from '../src/types/contracts.js';

vi.mock('../src/codex/runCodex.js', () => ({
  runCodex: vi.fn(),
  getActiveBackendId: () => 'claude-code',
}));

const answered = (text: string): CodexRunResult => ({
  ok: true,
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  lastMessage: text,
});

const dropped = (): CodexRunResult => ({
  ok: false,
  exitCode: 1,
  timedOut: false,
  stdout: '',
  stderr: '',
  lastMessage: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
  errorKind: 'API_ERROR',
  apiErrorDetail: 'ENOTFOUND',
});

const killed = (): CodexRunResult => ({
  ok: false,
  exitCode: 143,
  timedOut: false,
  stdout: '',
  stderr: '',
  lastMessage: '',
  errorKind: 'EXTERNAL_KILL',
  killSignal: 'SIGTERM',
});

const saved = { ...__infraRetry };
let run: ReturnType<typeof vi.fn>;

beforeEach(() => {
  run = vi.fn();
  __infraRetry.run = run;
  __infraRetry.sleep = vi.fn(async () => true);
  __infraRetry.delaysMs = [1, 1, 1];
  __infraRetry.killDelaysMs = [1];
});

afterEach(() => Object.assign(__infraRetry, saved));

// Issue #439, seen in the soak: a colleague's lookup lost its connection and
// miniOG posted "API Error: Can't reach the API server … (ENOTFOUND)" into the
// thread as its answer. The retry covered only the change pipeline.
describe('a lookup, a chat reply or a QA run that loses its connection', () => {
  const ask = (logStep = vi.fn()) =>
    runClaudeAgentic({ systemPrompt: 's', userMessage: 'how does X work?', cwd: '/repos', logStep });

  it('is retried, and answers once the connection is back', async () => {
    run.mockResolvedValueOnce(dropped()).mockResolvedValueOnce(answered('X works like this.'));
    const logStep = vi.fn();

    const result = await ask(logStep);

    expect(result).toMatchObject({ ok: true, reply: 'X works like this.' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agent.api_error.retry', level: 'WARN' }));
  });

  it('says it lost the connection, never posts the API error, when retrying does not help', async () => {
    run.mockResolvedValue(dropped());

    const result = await ask();

    expect(run).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: false, interrupted: 'API_ERROR' });
    expect(result.reply).toBe(connectionLostReply('answering this', { changesCode: false }));
    expect(result.reply).not.toContain('API Error');
    // An answer changes nothing, so there is nothing to say about merging.
    expect(result.reply).not.toContain('merged');
    expect(result.error).toContain('after 3 retries');
  });

  it('says what the run was doing', async () => {
    run.mockResolvedValue(dropped());

    const result = await runClaudeAgentic({
      systemPrompt: 's',
      userMessage: 'QA the login page',
      cwd: '/repos',
      doing: 'testing the page',
    });

    expect(result.reply).toContain('while testing the page');
  });

  it('says it was stopped from outside when it is killed twice', async () => {
    run.mockResolvedValue(killed());

    const result = await ask();

    expect(run).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, interrupted: 'EXTERNAL_KILL' });
    expect(result.reply).toBe(killedFromOutsideReply('My run', { changesCode: false }));
  });

  it('is not touched when the agent itself fails', async () => {
    run.mockResolvedValue({ ...answered('Agent hit a wall.'), ok: false });

    const result = await ask();

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, reply: 'Agent hit a wall.' });
    expect(result.interrupted).toBeUndefined();
  });
});

describe('a review agent that loses its connection', () => {
  it('is retried by the default runner the orchestrator, lenses and verifier use', async () => {
    run.mockResolvedValueOnce(dropped()).mockResolvedValueOnce(answered('{"findings":[]}'));
    const onLog = vi.fn();

    const result = await defaultPrReviewDeps.runAgent({ cwd: '/repos', prompt: 'review', onLog });

    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'agent.api_error.retry', message: expect.stringContaining('the review') }),
    );
  });
});

describe('the replies when the connection never comes back', () => {
  it('keep "nothing has been merged" for runs that change code, and drop it otherwise', () => {
    expect(connectionLostReply('planning this')).toContain('Nothing has been merged.');
    expect(connectionLostReply('answering this', { changesCode: false })).toBe(
      "I lost my connection to the model while answering this, and retrying didn't bring it back. Mention me again in a few minutes and I'll pick it up.",
    );
    expect(killedFromOutsideReply('The coder')).toContain('not a verdict on the change');
    expect(killedFromOutsideReply('My run', { changesCode: false })).not.toContain('verdict');
  });
});
