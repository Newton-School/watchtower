/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revisionPromptMarkdown, runApprovalLoop } from '../src/workflows/implementationWorkflow.js';
import { changesSinceLastPlan, formatPlanMessage, waitForApproval } from '../src/agents/pipeline.js';
import { normalizePlannerOutput } from '../src/agents/normalizePlannerOutput.js';
import { runCodex } from '../src/codex/runCodex.js';

vi.mock('../src/codex/runCodex.js', () => ({ runCodex: vi.fn(), getActiveBackendId: vi.fn(() => 'claude-code') }));
vi.mock('../src/agents/pipeline.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/agents/pipeline.js')>()),
  waitForApproval: vi.fn(),
}));
vi.mock('../src/workspaces/workspaceManager.js', () => ({ resolveWorkspace: vi.fn(async (p: string) => p) }));

// Issue #388: a revision asked for JSON steps, which normalized to an empty
// plan on claude-code, so "Here's the revised plan" re-posted the old one and
// the coder built the old one. A requester asked for the stored values to
// change; both revised summaries still said they stay as-is.
const plan = (behaviour: string, extra = '') =>
  [
    '# Shift the graduation-year options by a year',
    '',
    '## For the approver',
    '- What changes: The form offers 2013 - 2026, 2027 and After 2027.',
    '- Where: the request-a-callback form',
    `- Behaviour change: ${behaviour}`,
    '- Assumptions to confirm: none',
    '- Outside the repo: none',
    '- Risk: medium',
    extra,
    '## Files to change',
    '- `src/components/forms/rcb-form.tsx` — the options',
    '',
    'Scope: small',
    'Requires code changes: yes',
  ].join('\n');
const V1 = plan('none. What the form sends is unchanged: stored values stay `2013_2025`.');
const V2 = plan(
  'The form now sends `2013_2026` and `2027`; the backend allowlist must accept them first.',
  '\n## Changed since the last plan\n- The stored values change to `2013_2026` and `2027`, as asked.\n- Added a newton-api step to accept the new values.\n',
);

describe('a revised plan is the plan the feedback asked for', () => {
  const posted: string[] = [];
  const slack = {
    chat: {
      postMessage: vi.fn(async (args: any) => {
        posted.push(args.text);
        return { ok: true, ts: String(300 + posted.length) };
      }),
      update: vi.fn(),
    },
    filesUploadV2: vi.fn(async () => ({ ok: true })),
  } as any;
  const runInput = (): Parameters<typeof runApprovalLoop>[0] => ({
    slack,
    config: { botUserId: 'UBOT', ownerSlackUserIds: ['UADMIN'], coreDevSlackUserIds: ['UADMIN'] } as any,
    task: {
      event: { channelId: 'C1', threadTs: '1.1', userId: 'UADMIN', text: 'shift the years' },
      intent: 'IMPLEMENTATION',
    } as any,
    initial: {
      planMarkdown: V1,
      planAffectedFiles: ['src/components/forms/rcb-form.tsx'],
      planScope: 'small',
      plannerOutput: { summary: V1 },
    },
    pipelineCwd: '/ws/newton-marketing-web/1-1',
    iterationStart: 0,
    feedbackRoundsStart: 0,
    pauseCountStart: 0,
    plannerSchemaPath: '/schema.json',
    plannerProfile: { model: 'opus' } as any,
    plannerBackend: 'claude-code',
    workflowTimeoutMs: 2_700_000,
    workflowIntent: 'IMPLEMENTATION',
    logStep: vi.fn(),
  });
  const run = () => runApprovalLoop(runInput());

  beforeEach(() => {
    posted.length = 0;
    vi.mocked(runCodex).mockReset();
    vi.mocked(waitForApproval)
      .mockReset()
      .mockResolvedValueOnce({
        outcome: 'feedback',
        userReply: 'please update the stored values as well',
        approverId: 'UREQ',
        replyTs: '200',
      })
      .mockResolvedValueOnce({ outcome: 'approved', userReply: 'yes', approverId: 'UADMIN', replyTs: '400' });
  });

  it('asks for the whole plan again, read-only, and posts and hands on the new one', async () => {
    vi.mocked(runCodex).mockResolvedValue({ ok: true, exitCode: 0, parsedJson: { summary: V2 } } as any);

    const outcome = await run();

    const request = vi.mocked(runCodex).mock.calls[0][0];
    expect(request.readOnly).toBe(true);
    expect(request.prompt).toContain('please update the stored values as well');
    expect(request.prompt).toContain('## Changed since the last plan');
    expect(request.prompt).toContain(V1);
    expect(outcome).toMatchObject({ kind: 'approved', planMarkdown: V2 });
    const revisedMessage = posted.find(
      text => text.startsWith('*Plan*') && text.includes('Changed since the last plan'),
    );
    expect(revisedMessage).toContain('• The stored values change to `2013_2026` and `2027`, as asked.');
    expect(revisedMessage).toContain('the backend allowlist must accept them first');
    expect(revisedMessage).not.toContain('stored values stay');
  });

  // Waiting on an admin for every plan was friction: the requester, and anyone who could have asked, decide it.
  it('lets the requester and anyone who could have asked decide the plan, and no one else', async () => {
    vi.mocked(runCodex).mockResolvedValue({ ok: true, exitCode: 0, parsedJson: { summary: V2 } } as any);
    const enforced = {
      botUserId: 'UBOT',
      ownerSlackUserIds: ['UADMIN'],
      coreDevSlackUserIds: ['UADMIN'],
      accessControl: { mode: 'enforce' },
      bundles: [
        {
          name: 'builder',
          slackUserGroupHandle: '',
          manualUserIds: 'UBUILDER',
          resolvedUserIds: ['UBUILDER'],
          capabilities: ['start_implementation'],
          allowedChannelIds: ['C1'],
          allowIm: false,
          allowMpim: false,
        },
      ],
    } as any;

    await runApprovalLoop({
      ...runInput(),
      config: enforced,
      task: { event: { channelId: 'C1', threadTs: '1.1', userId: 'UREQ', text: 'shift the years' } } as any,
    });

    const calls = vi.mocked(waitForApproval).mock.calls.map(call => call[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const { canApprove } of calls) {
      expect(['UREQ', 'UBUILDER'].map(id => canApprove?.(id))).toEqual([true, true]);
      expect(['UVIEWER', 'UGUEST'].map(id => canApprove?.(id))).toEqual([false, false]);
    }
  });

  it('keeps access enforced in a group DM even when it is only audited elsewhere', async () => {
    const audited = {
      ...runInput().config,
      accessControl: { mode: 'audit' },
      bundles: [
        {
          name: 'builder',
          slackUserGroupHandle: '',
          manualUserIds: 'UBUILDER',
          resolvedUserIds: ['UBUILDER'],
          capabilities: ['start_implementation'],
          allowedChannelIds: ['C1'],
          allowIm: false,
          allowMpim: false,
        },
      ],
    } as any;
    const event = { threadTs: '1.1', userId: 'UREQ', text: 'shift the years' };
    vi.mocked(waitForApproval)
      .mockReset()
      .mockResolvedValue({ outcome: 'approved', userReply: 'yes', approverId: 'UREQ', replyTs: '400' });

    await runApprovalLoop({ ...runInput(), config: audited, task: { event: { ...event, channelId: 'C1' } } as any });
    await runApprovalLoop({
      ...runInput(),
      config: audited,
      task: { event: { ...event, channelId: 'G1', channelType: 'mpim' } } as any,
    });

    const [channel, groupDm] = vi.mocked(waitForApproval).mock.calls.map(call => call[0].canApprove);
    expect(channel?.('UANYONE')).toBe(true);
    expect([groupDm?.('UREQ'), groupDm?.('UANYONE')]).toEqual([true, false]);
  });

  it('asks what to change after a no, so a "yes" does not go ahead with the plan just turned down', async () => {
    vi.mocked(waitForApproval)
      .mockReset()
      .mockResolvedValueOnce({ outcome: 'rejected', userReply: 'no', approverId: 'UREQ', replyTs: '200' })
      .mockResolvedValueOnce({ outcome: 'cancelled', userReply: 'cancel', approverId: 'UREQ', replyTs: '400' });

    await run();

    expect(posted).toContain(
      'Got it. What should I change? Reply with what you\'d like different, "go" to use the plan as it is, or "cancel" to stop.',
    );
  });

  it('says the revision failed, and keeps the plan, when it brings back no plan', async () => {
    vi.mocked(runCodex).mockResolvedValue({ ok: true, exitCode: 0, parsedJson: { foo: 'bar' } } as any);

    const outcome = await run();

    expect(posted.some(text => text.includes('the planner did not return a revised plan'))).toBe(true);
    expect(posted.some(text => text.startsWith('*Plan*'))).toBe(false);
    expect(outcome).toMatchObject({ kind: 'approved', planMarkdown: V1 });
  });
});

describe('the pieces of a revision', () => {
  it('renders JSON steps instead of dropping them on claude-code', () => {
    const normalized = normalizePlannerOutput(
      { plan: ['Change the options', 'Update the allowlist'], affectedFiles: ['a.ts'] },
      'claude-code',
    );
    expect(normalized.planMarkdown).toContain('Change the options');
    expect(normalized.planMarkdown).not.toBe('');
  });

  it('lists what changed, and shows it under the header', () => {
    expect(changesSinceLastPlan(V2)).toEqual([
      'The stored values change to `2013_2026` and `2027`, as asked.',
      'Added a newton-api step to accept the new values.',
    ]);
    expect(changesSinceLastPlan(V1)).toEqual([]);
    const lines = formatPlanMessage(V2, [], 'small').split('\n');
    expect(lines[1]).toBe('*Changed since the last plan:*');
  });

  it('asks for every approver line to be rewritten, not copied', () => {
    const prompt = revisionPromptMarkdown(V1, 'change the stored values');
    expect(prompt).toContain('Do not copy the old block');
    expect(prompt).toContain('"Behaviour change" and "Outside the repo"');
  });
});
