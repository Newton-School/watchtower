/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { extractUserFocus, FOCUS_PROMPT_MARKER } from '../src/agentic/reviewFocus.js';

const WEB_PR = 'https://github.com/Newton-School/newton-web/pull/8652';

function focusOk(focusAreas: string[]) {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    stdout: '{}',
    stderr: '',
    lastMessage: '',
    parsedJson: { focusAreas },
    durationMs: 5,
    backend: 'codex',
  };
}

describe('extractUserFocus', () => {
  it('deterministic floor: quotes the trigger verbatim, minus mention and PR URL', async () => {
    const { focusBlock } = await extractUserFocus({
      triggerText: `<@UBOT1> review ${WEB_PR} focus on the migration and the retry logic`,
      threadTexts: ['one message'],
    });

    expect(focusBlock).toContain('USER FOCUS');
    expect(focusBlock).toContain(`Requester's instruction: "review focus on the migration and the retry logic"`);
    expect(focusBlock).not.toContain('github.com');
    expect(focusBlock).not.toContain('<@UBOT1>');
  });

  it('strips Slack-formatted <url|label> links too', async () => {
    const { focusBlock } = await extractUserFocus({
      triggerText: `<@UBOT1> review <${WEB_PR}|this PR> and check the auth changes carefully`,
      threadTexts: [],
    });
    expect(focusBlock).toContain('check the auth changes carefully');
    expect(focusBlock).not.toContain('github.com');
  });

  it('returns an empty block for a bare review request (nothing to focus on)', async () => {
    const { focusBlock } = await extractUserFocus({
      triggerText: `<@UBOT1> review ${WEB_PR}`,
      threadTexts: ['x'],
    });
    expect(focusBlock).toBe('');
  });

  it('skips the model pass on short threads', async () => {
    const runAgent = vi.fn();
    await extractUserFocus({
      triggerText: '<@UBOT1> review this and focus on error handling',
      threadTexts: ['a', 'b'],
      runAgent: runAgent as any,
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs the model pass on longer threads and merges extracted areas', async () => {
    const runAgent = vi.fn().mockResolvedValue(focusOk(['check the DB migration rollback path']));
    const logStep = vi.fn();

    const { focusBlock } = await extractUserFocus({
      triggerText: '<@UBOT1> review this and prioritize correctness',
      threadTexts: ['a', 'b', 'c', 'd'],
      runAgent: runAgent as any,
      logStep,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].prompt).toContain(FOCUS_PROMPT_MARKER);
    expect(focusBlock).toContain(`Requester's instruction: "review this and prioritize correctness"`);
    expect(focusBlock).toContain('check the DB migration rollback path');
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.focus.extracted' }));
  });

  it('fails open to the deterministic floor when the model pass throws', async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const logStep = vi.fn();

    const { focusBlock } = await extractUserFocus({
      triggerText: '<@UBOT1> review this and prioritize correctness please',
      threadTexts: ['a', 'b', 'c'],
      runAgent: runAgent as any,
      logStep,
    });

    expect(focusBlock).toContain(`Requester's instruction: "review this and prioritize correctness please"`);
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'agentic.pr_review.focus.failed' }));
  });
});
