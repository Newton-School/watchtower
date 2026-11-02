import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAccountBlock, runAgent } from '../src/codex/runCodex.js';
import { createStreamDecoder } from '../src/codex/streamEvents.js';
import { accountBlockedReply, accountProblemReply, isAccountProblem, isInterruption } from '../src/codex/infraRetry.js';
import { diagnoseFailure } from '../src/learning/failureDoctor.js';
import {
  onAccountEvents,
  recordRefusal,
  recordWorking,
  recoveredAlertText,
  refusalAlertText,
} from '../src/runtime/accountAlerts.js';
import type { AgentBackend } from '../src/backends/types.js';

/** The words the CLI gave on 30 Oct 2026, when every run was refused for about 16 minutes. */
const BILLING =
  "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead";

/** Claude Code 2.1.316 with a bad API key: its error line and result envelope, captured as printed. */
const BAD_KEY_ERROR_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: '26bfd6fb',
    model: '<synthetic>',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'Invalid API key · Fix external API key' }],
  },
  session_id: 'ea99706c',
  error: 'authentication_failed',
  is_api_error_message: true,
  api_error_status: 401,
  api_error_origin: 'first_party',
});
const BAD_KEY_RESULT = JSON.stringify({
  terminal_reason: 'api_error',
  is_error: true,
  num_turns: 1,
  subtype: 'success',
  api_error_status: 401,
  result: 'Invalid API key · Fix external API key',
  type: 'result',
});

/** Codex 0.144.5 with a bad API key: the turn's own failure, after five "Reconnecting…" retries. */
const CODEX_401 =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
const CODEX_BAD_KEY_STREAM = [
  { type: 'thread.started', thread_id: '01a19e1d' },
  { type: 'turn.started' },
  { type: 'error', message: `Reconnecting... 5/5 (${CODEX_401})` },
  { type: 'turn.failed', error: { message: CODEX_401 } },
]
  .map(event => JSON.stringify(event))
  .join('\n');

describe('the stream decoder keeps the CLI API error line', () => {
  it('reads the code and the words off Claude Code’s error line', () => {
    const decoder = createStreamDecoder('claude-code');
    decoder.push(`${BAD_KEY_ERROR_LINE}\n${BAD_KEY_RESULT}\n`);
    expect(decoder.apiError()).toEqual({
      code: 'authentication_failed',
      text: 'Invalid API key · Fix external API key',
    });
  });

  it('leaves an ordinary assistant message alone', () => {
    const decoder = createStreamDecoder('claude-code');
    decoder.push(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Invalid API key handling lives in auth.ts' }] } })}\n`,
    );
    expect(decoder.apiError()).toBeUndefined();
  });

  it('reads Codex’s failed turn, not its reconnect notices', () => {
    const decoder = createStreamDecoder('codex');
    decoder.push(`${CODEX_BAD_KEY_STREAM}\n`);
    expect(decoder.apiError()).toEqual({ text: CODEX_401 });
  });
});

describe('detectAccountBlock', () => {
  it('classifies the 30 Oct billing block and keeps its words', () => {
    expect(
      detectAccountBlock({
        streamError: { code: 'oauth_org_not_allowed', text: BILLING },
        lastMessage: JSON.stringify({ terminal_reason: 'api_error', is_error: true, result: BILLING }),
        failedRun: true,
      }),
    ).toEqual({ message: BILLING, code: 'oauth_org_not_allowed' });
  });

  it('classifies the billing words on a failed run with no error code', () => {
    const envelope = JSON.stringify({ terminal_reason: 'api_error', is_error: true, result: BILLING });
    expect(detectAccountBlock({ lastMessage: envelope, failedRun: true })).toEqual({ message: BILLING });
  });

  it('classifies a refused key from the real CLI output', () => {
    expect(
      detectAccountBlock({
        streamError: { code: 'authentication_failed', text: 'Invalid API key · Fix external API key' },
        lastMessage: BAD_KEY_RESULT,
        failedRun: true,
      }),
    ).toEqual({ message: 'Invalid API key · Fix external API key', code: 'authentication_failed' });
  });

  it.each(['billing_error', 'account_on_hold', 'verification_required', 'cloud_credential_error'])(
    'classifies the %s code',
    code => {
      expect(
        detectAccountBlock({ streamError: { code, text: 'refused' }, lastMessage: '', failedRun: true }),
      ).toMatchObject({ code, message: 'refused' });
    },
  );

  it('classifies Codex’s 401 from its failed turn', () => {
    expect(detectAccountBlock({ streamError: { text: CODEX_401 }, lastMessage: 'Hello', failedRun: true })).toEqual({
      message: CODEX_401,
    });
  });

  it('leaves the passing API errors to the connection retry', () => {
    for (const code of ['rate_limit', 'overloaded', 'server_error', 'unknown']) {
      expect(
        detectAccountBlock({
          // Even when the words would match: the code is the CLI's verdict.
          streamError: { code, text: 'API Error: 529 Overloaded. Please run /login if this persists' },
          lastMessage: '',
          failedRun: true,
        }),
      ).toBeUndefined();
    }
  });

  it('does not take an agent’s answer for a refusal', () => {
    // A clean run, whatever it says.
    expect(detectAccountBlock({ lastMessage: 'Fixed the invalid API key path.', failedRun: false })).toBeUndefined();
    // A failed run whose last words are a long answer that mentions a login.
    const prose = 'The login page shows "Invalid API key" when the token is stale. '.repeat(12);
    expect(detectAccountBlock({ lastMessage: prose, failedRun: true })).toBeUndefined();
    // A 401 the agent quoted from some other service.
    expect(
      detectAccountBlock({ lastMessage: 'gh api returned 401 Unauthorized for the repo.', failedRun: true }),
    ).toBeUndefined();
  });

  it('cuts a very long reason', () => {
    const long = `Invalid API key ${'x'.repeat(1000)}`;
    const block = detectAccountBlock({
      streamError: { code: 'authentication_failed', text: long },
      lastMessage: '',
      failedRun: true,
    });
    expect(block?.message.length).toBe(400);
    expect(block?.message.endsWith('…')).toBe(true);
  });
});

describe('the reply for a refused account', () => {
  it('quotes the CLI’s words and says it is not the requester’s message', () => {
    expect(accountBlockedReply('look at this', BILLING)).toBe(
      [
        "I can't look at this right now: my model account refused the request. The problem is on my side, not with your message.",
        'The error:',
        `> ${BILLING}`,
        "Ask me again once it's fixed.",
      ].join('\n'),
    );
  });

  it('escapes Slack markup in the quoted words', () => {
    expect(accountBlockedReply('do this', 'a <b> & c')).toContain('> a &lt;b&gt; &amp; c');
  });

  it('still says what happened with no words to quote, and takes a closing line', () => {
    expect(accountBlockedReply('do this', undefined, { next: 'Reply "resume" once it is fixed.' })).toBe(
      'I can\'t do this right now: my model account refused the request. The problem is on my side, not with your message.\nReply "resume" once it is fixed.',
    );
  });

  it('picks the limit reply or the refusal reply from the run', () => {
    expect(
      accountProblemReply('do this', { errorKind: 'ACCOUNT_BLOCKED', accountBlockMessage: 'Invalid API key' }),
    ).toContain('> Invalid API key');
    expect(accountProblemReply('do this', { errorKind: 'USAGE_LIMIT', limitResetsAtText: '4pm' })).toBe(
      "I've hit my usage limit, so I can't do this right now. It resets 4pm; ask me again after that.",
    );
  });

  it('is an account problem, and not an interruption to wait out and retry', () => {
    expect(isAccountProblem('ACCOUNT_BLOCKED')).toBe(true);
    expect(isAccountProblem('USAGE_LIMIT')).toBe(true);
    expect(isAccountProblem('API_ERROR')).toBe(false);
    expect(isInterruption('ACCOUNT_BLOCKED')).toBe(false);
  });
});

describe('failure doctor on a refused account', () => {
  it('names the refusal, even when a pipeline paused under the usage-limit stage', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'Paused: the model account refused the request.',
      logs: [
        {
          stage: 'agent.account_blocked',
          message: `Claude Code (Anthropic) was refused by the model account: ${BILLING}`,
          level: 'ERROR',
        },
        { stage: 'pipeline.usage_limit', message: 'The model account refused the coder', level: 'ERROR' },
      ],
    });
    expect(diagnosis?.errorKind).toBe('ACCOUNT_BLOCKED');
    expect(diagnosis?.summary).toBe(`The model account refused the run: ${BILLING}`);
  });
});

describe('owner alerts for a refused account', () => {
  const memoryStore = () => {
    const state = new Map<string, string>();
    return {
      getState: (key: string) => state.get(key),
      setState: (key: string, value: string) => void state.set(key, value),
    };
  };
  const refusal = (jobId?: string) => ({
    backend: 'claude-code',
    backendName: 'Claude Code (Anthropic)',
    message: BILLING,
    code: 'oauth_org_not_allowed',
    jobId,
  });

  it('tells the owner once per outage, and lists every refused job when it ends', () => {
    const store = memoryStore();
    const start = new Date('2026-10-30T11:10:22Z');

    expect(recordRefusal(refusal('54342758-aaaa'), store, start).first).toBe(true);
    expect(recordRefusal(refusal('ae6eefc1-bbbb'), store).first).toBe(false);
    expect(recordRefusal(refusal('54342758-aaaa'), store).first).toBe(false);
    // Another backend is another account.
    expect(recordRefusal({ ...refusal('x'), backend: 'codex' }, store).first).toBe(true);

    const ended = recordWorking('claude-code', store);
    expect(ended).toMatchObject({ since: start.toISOString(), jobIds: ['54342758-aaaa', 'ae6eefc1-bbbb'] });
    expect(recordWorking('claude-code', store)).toBeUndefined();
    // The next refusal starts a new outage, told again.
    expect(recordRefusal(refusal('e8353616-cccc'), store).first).toBe(true);
  });

  it('quotes the CLI and links the thread in the first alert', () => {
    expect(refusalAlertText(refusal('54342758-aaaa'), 'https://x.slack.com/archives/C1/p1')).toBe(
      [
        ":warning: The model account (Claude Code (Anthropic)) is refusing runs, so requests fail until it's fixed. The CLI says:",
        `> ${BILLING}`,
        'First refused: <https://x.slack.com/archives/C1/p1|this thread> (job `54342758`).',
        "Each requester is told this reason in their thread. I'll tell you when a run works again.",
      ].join('\n'),
    );
  });

  it('says how long it was down and where to follow up, one link per thread', () => {
    const outage = {
      since: '2026-10-30T11:10:22Z',
      backendName: 'Claude Code (Anthropic)',
      message: BILLING,
      jobIds: ['54342758-aaaa', 'e8353616-bbbb', 'ae6eefc1-cccc'],
    };
    const text = recoveredAlertText(
      outage,
      ['https://x/p1', 'https://x/p1', undefined],
      new Date('2026-10-30T11:26:05Z'),
    );
    expect(text).toBe(
      [
        ':white_check_mark: The model account (Claude Code (Anthropic)) works again, after about 16 min.',
        '3 requests were refused while it was down: <https://x/p1|1>, `ae6eefc1`.',
        'Nothing re-runs by itself: mention miniOG in those threads to run them again.',
      ].join('\n'),
    );
    expect(recoveredAlertText({ ...outage, jobIds: [] }, [], new Date('2026-10-30T13:15:22Z'))).toBe(
      ':white_check_mark: The model account (Claude Code (Anthropic)) works again, after about 2 h 5 min.',
    );
  });

  describe('runAgent reports to the owner alert', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-blocked-'));
    const refusedStream = path.join(dir, 'refused.jsonl');
    fs.writeFileSync(refusedStream, `${BAD_KEY_ERROR_LINE}\n${BAD_KEY_RESULT}\n`);
    const shell = (script: string): AgentBackend => ({
      id: 'claude-code',
      displayName: 'Claude Code (Anthropic)',
      resolveBinary: () => '/bin/sh',
      isAvailable: () => true,
      supportsImages: () => false,
      buildArgs: () => ['-c', script],
      buildEnv: () => ({}),
      parseOutput: () => ({}),
      availableModels: () => ['test'],
      defaultModel: () => 'test',
    });
    const refused = vi.fn();
    const working = vi.fn();
    beforeEach(() => {
      refused.mockReset();
      working.mockReset();
      onAccountEvents({ refused, working });
    });
    afterEach(() => onAccountEvents(undefined));

    it('reports a refused run with the CLI words, and not as working', async () => {
      const result = await runAgent({ cwd: dir, prompt: 'unused' }, shell(`cat '${refusedStream}'; exit 1`));

      expect(result).toMatchObject({
        ok: false,
        errorKind: 'ACCOUNT_BLOCKED',
        accountBlockMessage: 'Invalid API key · Fix external API key',
      });
      expect(refused).toHaveBeenCalledExactlyOnceWith({
        backend: 'claude-code',
        backendName: 'Claude Code (Anthropic)',
        message: 'Invalid API key · Fix external API key',
        code: 'authentication_failed',
        jobId: undefined,
      });
      expect(working).not.toHaveBeenCalled();
    });

    it('reports a run that worked, and nothing for an ordinary failure', async () => {
      await runAgent({ cwd: dir, prompt: 'unused' }, shell('exit 0'));
      expect(working).toHaveBeenCalledExactlyOnceWith('claude-code');

      working.mockReset();
      await runAgent({ cwd: dir, prompt: 'unused' }, shell('exit 1'));
      expect(working).not.toHaveBeenCalled();
      expect(refused).not.toHaveBeenCalled();
    });
  });
});
