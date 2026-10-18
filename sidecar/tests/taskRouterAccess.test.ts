import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

const runAgenticPrReview = vi.fn();
const runImplementationWorkflow = vi.fn();
const runInvestigationWorkflow = vi.fn();
const runDevAssistWorkflow = vi.fn();
const runDeployWorkflow = vi.fn();
const runAgenticEntry = vi.fn();
const runUnknownTaskWorkflow = vi.fn();
const decideTool = vi.fn();

vi.mock('../src/agentic/agenticPrReview.js', () => ({
  runAgenticPrReview: runAgenticPrReview,
}));

vi.mock('../src/workflows/implementationWorkflow.js', () => ({
  runImplementationWorkflow,
}));

vi.mock('../src/workflows/investigationWorkflow.js', () => ({
  runInvestigationWorkflow,
}));

vi.mock('../src/workflows/devAssistWorkflow.js', () => ({
  runDevAssistWorkflow,
}));

vi.mock('../src/workflows/deployWorkflow.js', () => ({
  runDeployWorkflow,
}));

vi.mock('../src/agentic/agenticEntry.js', () => ({
  runAgenticEntry,
}));

vi.mock('../src/workflows/unknownTaskWorkflow.js', () => ({
  runUnknownTaskWorkflow,
}));

// The tool-router decides every routed mention a keyword gate has not (issue
// #456). Stub its model call so no test can spawn the real CLI; keep the rest real.
vi.mock('../src/router/toolRouter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/router/toolRouter.js')>()),
  decideTool,
}));

/** The tool the router names for each workflow a test wants run. */
const TOOL_FOR_INTENT = {
  PR_REVIEW: 'review_pr',
  IMPLEMENTATION: 'change_code',
  INVESTIGATION: 'investigate',
  INFORMATIONAL: 'answer',
  CONVERSATIONAL: 'chat',
} as const;

/** Make the router read the message as a request for `intent`. */
function routerPicks(intent: keyof typeof TOOL_FOR_INTENT, confidence = 0.91, reason = 'stubbed decision'): void {
  decideTool.mockResolvedValue({
    ok: true,
    decision: { tool: TOOL_FOR_INTENT[intent], confidence, reason },
    durationMs: 1,
  });
}

vi.mock('../src/workflows/shared/workflowUtils.js', async () => {
  const actual = await vi.importActual('../src/workflows/shared/workflowUtils.js');
  return {
    ...actual,
    isPresencePing: vi.fn().mockReturnValue(false),
  };
});

const { routeTask } = await import('../src/router/taskRouter.js');

function makeConfig(mode: 'audit' | 'enforce'): AppConfig {
  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds: ['UOWNER1'],
    coreDevSlackUserIds: ['UOWNER1'],
    coreDevSlackUserGroup: '',
    botUserId: 'UBOT1',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    bugsAndUpdatesChannelId: 'C-BUILD',
    allowedChannelsForBugFix: ['C-BUILD'],
    repoPaths: {
      newtonWeb: '/Users/dipesh/code/newton-web',
      newtonApi: '/Users/dipesh/code/newton-api',
    },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: 2,
    repoClassifierThreshold: 0.75,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: false,
    agentBackend: 'codex',
    prReviewTimeoutMs: 120_000,
    bugFixTimeoutMs: 120_000,
    pmTaskTimeoutMs: 120_000,
    accessControl: toResolvedAccessControlConfig(
      {
        mode,
        groups: {
          viewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UVIEWER',
            allowedChannelIds: 'C-VIEW',
            allowIm: true,
            allowMpim: false,
          },
          reviewer: {
            slackUserGroupHandle: '',
            manualUserIds: 'UREVIEW',
            allowedChannelIds: 'C-REVIEW',
            allowIm: false,
            allowMpim: false,
          },
          builder: {
            slackUserGroupHandle: '',
            manualUserIds: 'UBUILDER',
            allowedChannelIds: 'C-BUILD',
            allowIm: false,
            allowMpim: false,
          },
          admin: {
            slackUserGroupHandle: '',
            manualUserIds: 'UADMIN',
            allowedChannelIds: 'C-ADMIN',
            allowIm: true,
            allowMpim: true,
          },
          owner: {
            slackUserGroupHandle: '',
            manualUserIds: '',
            allowedChannelIds: '',
            allowIm: false,
            allowMpim: false,
          },
        },
      },
      ['UOWNER1'],
    ),
  };
}

function makeTask(
  input: Partial<NormalizedTask> & { userId: string; channelId: string; text: string },
): NormalizedTask {
  return {
    event: {
      eventId: 'Ev1',
      channelId: input.channelId,
      channelType: input.channelId.startsWith('D') ? 'im' : 'channel',
      threadTs: '111.22',
      eventTs: '111.22',
      userId: input.userId,
      text: input.text,
      rawEvent: {},
    },
    mentionDetected: true,
    mentionType: 'bot',
    isOwnerAuthor: input.userId === 'UOWNER1',
    isCoreDevAuthor: input.userId === 'UOWNER1',
    intent: input.intent ?? 'OWNER_AUTOPILOT',
    prContext: input.prContext,
  };
}

/** What was posted, minus the opening "what to expect" line a run starts with (issue #588). */
function repliesOf(slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }): string[] {
  return slack.chat.postMessage.mock.calls
    .map(call => (call[0] as { text: string }).text)
    .filter(text => !/^(On it\.|Sorry for the wait)/.test(text));
}
function expectNoReply(slack: { chat: { postMessage: { mock: { calls: unknown[][] } } } }): void {
  expect(repliesOf(slack)).toEqual([]);
}

function makeSlack() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Unless a test says otherwise, the router reads the message as a review request.
  routerPicks('PR_REVIEW', 0.91, 'review request');
  runAgenticPrReview.mockResolvedValue({
    workflow: 'PR_REVIEW',
    status: 'SUCCESS',
    message: 'review ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runImplementationWorkflow.mockResolvedValue({
    workflow: 'IMPLEMENTATION',
    status: 'SUCCESS',
    message: 'impl ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runInvestigationWorkflow.mockResolvedValue({
    workflow: 'INVESTIGATION',
    status: 'SUCCESS',
    message: 'investigation ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runDevAssistWorkflow.mockResolvedValue({
    workflow: 'DEV_ASSIST',
    status: 'SUCCESS',
    message: 'dev assist ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  runDeployWorkflow.mockResolvedValue({
    workflow: 'DEPLOY',
    status: 'SUCCESS',
    message: 'deploy ok',
    notifyDesktop: false,
    slackPosted: true,
  });
  // Both INFORMATIONAL and CONVERSATIONAL now flow through runAgenticEntry,
  // which is dispatched with the `mode` arg distinguishing them.
  runAgenticEntry.mockImplementation(async ({ mode }: { mode: 'informational' | 'conversational' }) => ({
    workflow: mode === 'informational' ? 'INFORMATIONAL' : 'CONVERSATIONAL',
    status: 'SUCCESS',
    message: mode === 'informational' ? 'info ok' : 'chat ok',
    notifyDesktop: false,
    slackPosted: true,
  }));
  runUnknownTaskWorkflow.mockResolvedValue({
    workflow: 'UNKNOWN',
    status: 'SKIPPED',
    message: 'unknown ok',
    notifyDesktop: false,
    slackPosted: true,
  });
});

describe('routeTask access control', () => {
  it('logs would-deny in audit mode but still runs the workflow', async () => {
    const config = makeConfig('audit');
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await routeTask({
      task: makeTask({
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        text: '<@UBOT1> please review this PR',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runAgenticPrReview).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'access.audit.would_deny',
      }),
    );
  });

  it('blocks the workflow in enforce mode when access is missing', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();

    const result = await routeTask({
      task: makeTask({
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        text: '<@UBOT1> please review this PR',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SKIPPED');
    expect(runAgenticPrReview).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Sorry, this kind of request needs a higher access level than your role allows. Please contact an admin.',
      }),
    );
  });

  it('allows admins to use wt commands', async () => {
    const config = makeConfig('enforce');

    const result = await routeTask({
      task: makeTask({
        userId: 'UADMIN',
        channelId: 'D-ADMIN',
        text: '<@UBOT1> wt status',
        intent: 'DEV_ASSIST',
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SUCCESS');
    expect(runDevAssistWorkflow).toHaveBeenCalledOnce();
  });

  it('hard-blocks DMs from non-allowlisted users even in audit mode', async () => {
    const config = makeConfig('audit');
    const slack = makeSlack();
    const logStep = vi.fn();

    const result = await routeTask({
      task: makeTask({
        userId: 'UREVIEW', // reviewer has allowIm:false
        channelId: 'D-REVIEW',
        text: 'hey miniOG',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(result.status).toBe('SKIPPED');
    expect(runAgenticPrReview).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D-REVIEW',
        text: "Sorry, DMs aren't enabled for your role. Please contact an admin.",
      }),
    );
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'access.dm.denied',
      }),
    );
  });

  it('allows DMs from users in a group with allowIm enabled', async () => {
    const config = makeConfig('audit');
    const slack = makeSlack();
    routerPicks('CONVERSATIONAL', 0.9, 'casual chat');

    const result = await routeTask({
      task: makeTask({
        userId: 'UVIEWER', // viewer has allowIm:true
        channelId: 'D-VIEWER',
        text: '<@UBOT1> hey',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SUCCESS');
    expect(runAgenticEntry).toHaveBeenCalledOnce();
    expectNoReply(slack);
  });

  it('lets the owner DM miniOG regardless of group config', async () => {
    const config = makeConfig('audit');
    const slack = makeSlack();

    const result = await routeTask({
      task: makeTask({
        userId: 'UOWNER1',
        channelId: 'D-OWNER',
        text: '<@UBOT1> status check',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SUCCESS');
    expectNoReply(slack);
  });

  it('blocks builders from deploy and lets the owner bypass', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();
    // A deploy starts only when the router reads one and code finds the target at the head of the message.
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool: 'deploy', confidence: 0.95, reason: 'asks for a production deploy' },
      durationMs: 1,
    });

    const blocked = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> deploy newton-web to production',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(blocked.status).toBe('SKIPPED');
    expect(runDeployWorkflow).not.toHaveBeenCalled();

    const ownerResult = await routeTask({
      task: makeTask({
        userId: 'UOWNER1',
        channelId: 'C-UNLISTED',
        text: '<@UBOT1> deploy newton-web to production',
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(ownerResult.status).toBe('SUCCESS');
    expect(runDeployWorkflow).toHaveBeenCalledOnce();
  });
});

describe('routeTask investigation resume gate', () => {
  function storeWithFindings(findings: Record<string, unknown> | undefined) {
    const getForThread = vi.fn().mockReturnValue(findings);
    const investigationStore = vi.fn().mockReturnValue({ getForThread });
    const dossierStore = vi.fn().mockReturnValue({
      getDossier: () => ({ profile: undefined, affinity: [], productAffinity: [], metrics: {}, tone: 'normal' }),
    });
    return { investigationStore, dossierStore, getForThread, getPersonalityMode: vi.fn().mockReturnValue('normal') };
  }

  it('routes "yes" with pending findings to IMPLEMENTATION for non-owner (the gate decides, not the router)', async () => {
    // The router would read a bare "yes" as chat; the gate does not wait for it.
    routerPicks('CONVERSATIONAL', 0.95, 'just a yes');
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    const store = storeWithFindings({ summary: 'prior RCA', repoName: 'newton-web' });

    const result = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> yes',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: store as never,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(store.getForThread).toHaveBeenCalledWith('111.22');
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.investigation.resume_gate',
        data: expect.objectContaining({ resolvedIntent: 'IMPLEMENTATION' }),
      }),
    );
  });

  it('routes "yes, fix it" with pending findings to OWNER_AUTOPILOT for the owner', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    const store = storeWithFindings({ summary: 'prior RCA' });

    const result = await routeTask({
      task: makeTask({
        userId: 'UOWNER1',
        channelId: 'C-UNLISTED',
        text: '<@UBOT1> yes, fix it',
        intent: 'OWNER_AUTOPILOT',
      }),
      config,
      slack: slack as never,
      store: store as never,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.investigation.resume_gate',
        data: expect.objectContaining({ resolvedIntent: 'OWNER_AUTOPILOT' }),
      }),
    );
  });

  it('falls through to the router when affirmation has no pending findings', async () => {
    // No investigation_findings row for this thread — gate must not fire.
    // Confidence ≥ 0.75 so the confidence floor accepts the decision; this
    // test exists to verify the resume-gate path specifically.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    const store = storeWithFindings(undefined);
    routerPicks('CONVERSATIONAL', 0.85, 'just a yes');

    const result = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> yes',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: store as never,
      logStep,
    });

    expect(decideTool).toHaveBeenCalledOnce();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(runAgenticEntry).toHaveBeenCalledOnce();
    expect(result.status).toBe('SUCCESS');
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.investigation.resume_gate' }));
  });

  it('neither chats nor keeps the keyword seed when a low-confidence decision would drop the access tier', async () => {
    // Regression for RCA Slack thread p1779086230428739 (2026-05-18). A bare
    // "yes" tagged at miniOG was read as chat at confidence 0.60 — the
    // conversational workflow then hallucinated a "fix done" reply. The floor
    // refuses a decision below 0.75 that drops the access tier and could claim
    // completion. It used to run the keyword seed (the change pipeline)
    // instead; now the requester is asked one question (issue #431).
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    routerPicks('CONVERSATIONAL', 0.6, 'short message');

    const result = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> yes',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(result.status).toBe('PAUSED');
    expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('<@UBUILDER> ');
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.clarify.decided',
        data: expect.objectContaining({ action: 'ask', tool: 'chat', confidence: 0.6, seedIntent: 'IMPLEMENTATION' }),
      }),
    );
  });

  it('accepts a high-confidence access-dropping override', async () => {
    // 0.80 ≥ 0.75 floor — the decision is trusted.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    routerPicks('CONVERSATIONAL', 0.8, 'clearly chat');

    await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> thanks!',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(runAgenticEntry).toHaveBeenCalledOnce();
  });

  it('does not hold an upward decision, whatever its confidence', async () => {
    // INFORMATIONAL (viewer) → PR_REVIEW (reviewer) raises the tier; the floor
    // only applies to access-dropping moves, because the access check still
    // gates an upward one. (A low-confidence change_code is asked about
    // instead: see "asking instead of guessing".)
    const config = makeConfig('enforce');
    const slack = makeSlack();
    routerPicks('PR_REVIEW', 0.5, 'might be a review request');

    await routeTask({
      task: makeTask({
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        text: '<@UBOT1> please look at this one',
        intent: 'INFORMATIONAL',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(runAgenticPrReview).toHaveBeenCalledOnce();
    expect(runAgenticEntry).not.toHaveBeenCalled();
  });

  it('accepts a low-confidence IMPLEMENTATION → INFORMATIONAL downgrade (#348 RC1)', async () => {
    // INFORMATIONAL is a read-only ANSWER workflow — it only reads and reports,
    // so it can't imply work was shipped. A sub-floor downgrade is safe to
    // honor. The old tier-rank guard wrongly held this (the two differ only by
    // tier), forcing a plain question into the implementation pipeline (#348).
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    routerPicks('INFORMATIONAL', 0.72, 'this is a how-does-it-work question');

    await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> check PR #8666 and tell me what changed and the rules',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(runAgenticEntry).toHaveBeenCalledOnce();
    expect(runAgenticEntry).toHaveBeenCalledWith(expect.objectContaining({ mode: 'informational' }));
    expectNoReply(slack);
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.classify.override',
        data: expect.objectContaining({
          classifiedIntent: 'INFORMATIONAL',
          proposedSideEffect: 'answer',
          acceptedLowConfidenceSafeDowngrade: true,
        }),
      }),
    );
  });

  it('accepts a low-confidence IMPLEMENTATION → INVESTIGATION downgrade (#348 RC1)', async () => {
    // INVESTIGATION is also a read-only ANSWER workflow (diagnose, then ask
    // before fixing) — safe to honor below the floor.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    routerPicks('INVESTIGATION', 0.72, 'reported odd behavior, no anchor — diagnose first');

    await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: "<@UBOT1> something's off with the checkout page",
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(runInvestigationWorkflow).toHaveBeenCalledOnce();
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.clarify.decided' }));
  });

  it('falls through to the router when text is not an affirmation, even with pending findings', async () => {
    // Findings exist but the message is not a "yes, fix it" — the router still
    // decides. This is the path for "actually wait" / "no, the bug is X".
    // Confidence ≥ 0.75 so the floor accepts the decision.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const store = storeWithFindings({ summary: 'prior RCA' });
    routerPicks('CONVERSATIONAL', 0.85, 'follow-up discussion');

    await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> actually wait, let me check first',
        intent: 'IMPLEMENTATION',
      }),
      config,
      slack: slack as never,
      store: store as never,
      logStep: vi.fn(),
    });

    expect(decideTool).toHaveBeenCalledOnce();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
  });
});

describe('deterministic PR_REVIEW seed (issue #334 bug B)', () => {
  it('does not wait for the router and dispatches the review at reviewer tier', async () => {
    const config = makeConfig('enforce');
    const logStep = vi.fn();
    // A model call that never comes back: the review must not depend on it.
    decideTool.mockReturnValue(new Promise(() => {}));

    const result = await routeTask({
      task: makeTask({
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        text: '<@UBOT1> review https://github.com/Newton-School/newton-web/pull/8652',
        intent: 'PR_REVIEW',
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/8652',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 8652,
        },
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep,
    });

    expect(result.status).toBe('SUCCESS');
    expect(runAgenticPrReview).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.pr_review.deterministic' }));
  });

  it('routes the review even when the model CLI is dead (the incident failure mode)', async () => {
    // 2026-06-11 incident: "Please review <newton-web URL>" hit a classifier
    // CLI exit-1, fell back to INFORMATIONAL@0.00, the access-drop guardrail
    // held IMPLEMENTATION, and the implementation workflow asked admins
    // "web or api?" about a message that named the repo in its URL. With the
    // deterministic seed no model call decides this, so its health is
    // irrelevant.
    const config = makeConfig('enforce');
    decideTool.mockRejectedValue(new Error('CLI exited 1'));

    const result = await routeTask({
      task: makeTask({
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        text: '<@UBOT1> Please review https://github.com/Newton-School/newton-web/pull/8652',
        intent: 'PR_REVIEW',
        prContext: {
          url: 'https://github.com/Newton-School/newton-web/pull/8652',
          owner: 'Newton-School',
          repo: 'newton-web',
          number: 8652,
        },
      }),
      config,
      slack: makeSlack() as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(result.status).toBe('SUCCESS');
    expect(runAgenticPrReview).toHaveBeenCalledOnce();
  });
});

describe('routeTask and the tool registry (issue #456)', () => {
  it('can start a workflow for exactly the intents the registry says are runnable', async () => {
    const { ROUTED_INTENTS } = await import('../src/router/taskRouter.js');
    const { RUNNABLE_INTENTS } = await import('../src/router/toolRegistry.js');
    expect([...ROUTED_INTENTS].sort()).toEqual([...RUNNABLE_INTENTS].sort());
  });
});

describe('routeTask and a message a keyword gate decided (issue #456)', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const shadowLog = (logStep: ReturnType<typeof vi.fn>) =>
    logStep.mock.calls.map(call => call[0]).find(entry => entry.stage === 'router.shadow');

  async function route(text: string, extra: Record<string, unknown> = {}) {
    const logStep = vi.fn();
    const result = await routeTask({
      task: makeTask({ userId: 'UOWNER1', channelId: 'C-VIEW', text, ...extra }),
      config: makeConfig('audit'),
      slack: makeSlack() as never,
      store: {} as never,
      logStep,
    });
    await settle();
    return { result, logStep };
  }

  it('runs what the gate chose and logs what the router would have run beside it', async () => {
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool: 'answer', confidence: 0.9, reason: 'a question about a merged PR' },
      durationMs: 5,
    });

    const { result, logStep } = await route('<@UBOT1> is this merged?', { intent: 'PR_REVIEW' });

    expect(result.workflow).toBe('PR_REVIEW');
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(decideTool.mock.calls[0][0].facts.hints).toEqual(['review gate matched']);
    expect(shadowLog(logStep)).toMatchObject({
      message: 'Router (shadow) would run INFORMATIONAL; the keyword gate ran PR_REVIEW — differ.',
      data: { agree: false, legacyIntent: 'PR_REVIEW', legacyDecidedBy: 'gate', routerWouldRun: 'INFORMATIONAL' },
    });
  });

  it('is unaffected when the router fails or throws', async () => {
    decideTool.mockRejectedValue(new Error('spawn failed'));

    const { result, logStep } = await route('<@UBOT1> review this', { intent: 'PR_REVIEW' });

    expect(result).toMatchObject({ workflow: 'PR_REVIEW', status: 'SUCCESS' });
    expect(shadowLog(logStep).data).toMatchObject({ agree: false, routerWouldRun: 'FAILED' });
  });

  it('skips exact-syntax commands, which leave nothing to decide', async () => {
    await route('<@UBOT1> wt status', { intent: 'DEV_ASSIST' });
    expect(decideTool).not.toHaveBeenCalled();
  });
});

describe('routeTask lets the tool-router decide (issue #456)', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const stageLog = (logStep: ReturnType<typeof vi.fn>, stage: string) =>
    logStep.mock.calls.map(call => call[0]).find(entry => entry.stage === stage);
  const routerSays = (tool: string, confidence = 0.9, extra: Record<string, unknown> = {}) =>
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool, confidence, reason: `router picked ${tool}`, ...extra },
      durationMs: 7,
    });

  function onStore(extra: Record<string, unknown> = {}) {
    return { ...extra };
  }

  async function route(
    text: string,
    task: Record<string, unknown> = {},
    options: {
      store?: Record<string, unknown>;
      config?: AppConfig;
      log?: boolean;
      signal?: AbortSignal;
      onEngage?: () => void;
      deps?: Parameters<typeof routeTask>[0]['deps'];
    } = {},
  ) {
    const logStep = vi.fn();
    const slack = makeSlack();
    const {
      mentionType = 'bot',
      mentionReference,
      clarification,
      threadMessages,
      inheritedDelegationOwnerId,
      ...input
    } = task as {
      mentionType?: 'bot' | 'owner';
      mentionReference?: boolean;
      clarification?: NormalizedTask['clarification'];
      threadMessages?: NormalizedTask['threadMessages'];
      inheritedDelegationOwnerId?: string;
    };
    const result = await routeTask({
      task: {
        ...makeTask({ userId: 'UOWNER1', channelId: 'C-VIEW', text, ...input }),
        mentionType,
        ...(mentionReference ? { mentionReference } : {}),
        ...(clarification ? { clarification } : {}),
        ...(threadMessages ? { threadMessages } : {}),
        ...(inheritedDelegationOwnerId ? { inheritedDelegationOwnerId } : {}),
      },
      config: options.config ?? makeConfig('audit'),
      slack: slack as never,
      store: (options.store ?? onStore()) as never,
      signal: options.signal,
      onEngage: options.onEngage,
      deps: options.deps,
      ...(options.log === false ? {} : { logStep }),
    });
    await settle();
    return { result, logStep, slack };
  }

  it('decides with one router call', async () => {
    routerSays('answer', 0.93);

    const { result, logStep } = await route('<@UBOT1> how does the login redirect work?');

    expect(result.workflow).toBe('INFORMATIONAL');
    expect(decideTool).toHaveBeenCalledTimes(1);
    // The deciding call is the job's own: costed as the router and logged in the job.
    expect(decideTool.mock.calls[0][0]).toMatchObject({ role: 'router', logStep });
    expect(stageLog(logStep, 'router.shadow')).toBeUndefined();
    expect(stageLog(logStep, 'router.decision')).toMatchObject({
      message: 'Router chose answer; running INFORMATIONAL.',
      data: { mode: 'on', legacyDecidedBy: 'router', tool: 'answer', confidence: 0.93, agree: true },
    });
  });

  it.each([
    ['review_pr', 'PR_REVIEW', runAgenticPrReview],
    ['change_code', 'IMPLEMENTATION', runImplementationWorkflow],
    ['investigate', 'INVESTIGATION', runInvestigationWorkflow],
    ['chat', 'CONVERSATIONAL', runAgenticEntry],
  ] as const)('runs what the classifier could have returned for %s', async (tool, workflow, runner) => {
    routerSays(tool);

    const { result } = await route('<@UBOT1> the export job fails with a 500 on /api/export, fix it');

    expect(result.workflow).toBe(workflow);
    expect(runner).toHaveBeenCalledOnce();
  });

  it.each(['unsupported', 'qa_webapp'])(
    'cannot start anything new: %s on a direct mention is a lookup, as an invalid classification was',
    async tool => {
      routerSays(tool, 0.95);

      const { result, logStep } = await route('<@UBOT1> ship it to production now');

      expect(result.workflow).toBe('INFORMATIONAL');
      expect(runDeployWorkflow).not.toHaveBeenCalled();
      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      // The row says what the router wanted, so the difference stays visible.
      expect(stageLog(logStep, 'router.decision').data).toMatchObject({ tool, agree: false });
    },
  );

  const routerFails = { ok: false, error: 'router call failed (exit 1)', durationMs: 3 };

  it('tries once more when the router call fails, and acts on the second answer (issue #440)', async () => {
    routerSays('change_code');
    decideTool.mockResolvedValueOnce(routerFails);

    const { result, logStep, slack } = await route('<@UBOT1> replace "See how" with "Apply Now" on the DS page', {
      intent: 'IMPLEMENTATION',
    });

    expect(decideTool).toHaveBeenCalledTimes(2);
    expect(result.workflow).toBe('IMPLEMENTATION');
    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
    expect(stageLog(logStep, 'router.decision.retry')).toMatchObject({
      level: 'WARN',
      data: { error: 'router call failed (exit 1)' },
    });
    expectNoReply(slack);
  });

  it('says it could not read the message when the router fails twice, and runs nothing (issue #440)', async () => {
    const { ROUTER_FAILED_REPLY } = await import('../src/router/taskRouter.js');
    decideTool.mockResolvedValue(routerFails);

    const { result, logStep, slack } = await route('<@UBOT1> replace "See how" with "Apply Now" on the DS page', {
      intent: 'IMPLEMENTATION',
    });

    expect(decideTool).toHaveBeenCalledTimes(2);
    // Not a lookup that describes the change without making it, and not the keyword seed either.
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'C-VIEW',
      thread_ts: '111.22',
      text: ROUTER_FAILED_REPLY,
    });
    expect(result).toMatchObject({ workflow: 'UNKNOWN', status: 'FAILED', slackPosted: true });
    expect(stageLog(logStep, 'router.decision.failed')).toMatchObject({ level: 'ERROR' });
    expect(stageLog(logStep, 'router.decision').message).toBe(
      'Router chose nothing (the call failed); running INFORMATIONAL.',
    );
  });

  it('gives a requester who would be denied the denial, not the could-not-read reply', async () => {
    decideTool.mockResolvedValue(routerFails);

    const { result, slack } = await route(
      '<@UBOT1> how does login work?',
      { userId: 'USTRANGER', channelId: 'C-VIEW' },
      { config: makeConfig('enforce') },
    );

    expect(result.status).toBe('SKIPPED');
    expect(slack.chat.postMessage).toHaveBeenCalledOnce();
    expect(slack.chat.postMessage.mock.calls[0][0].text).not.toContain("couldn't work out");
  });

  it('neither retries nor replies once the job is cancelled', async () => {
    decideTool.mockResolvedValue(routerFails);
    const controller = new AbortController();
    controller.abort();

    const { result, slack } = await route('<@UBOT1> fix the login redirect', {}, { signal: controller.signal });

    expect(decideTool).toHaveBeenCalledTimes(1);
    expectNoReply(slack);
    expect(result.status).toBe('FAILED');
  });

  it('stays silent on an owner mention when the router fails, throws, or says stay_silent', async () => {
    const ownerMention = { mentionType: 'owner' as const, userId: 'UVIEWER' };

    decideTool.mockRejectedValue(new Error('spawn failed'));
    const thrown = await route('<@UOWNER1> fyi the release went out', ownerMention);
    expect(thrown.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
    expect(stageLog(thrown.logStep, 'router.silent').message).toContain('Router returned NONE');
    // Two tries, then silence: a failure never makes miniOG speak into people's conversation.
    expect(decideTool).toHaveBeenCalledTimes(2);
    expectNoReply(thrown.slack);

    routerSays('stay_silent');
    const silent = await route('<@UOWNER1> fyi the release went out', ownerMention);
    expect(silent.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });

    // Nothing the classifier could not say reaches a workflow on an owner mention either.
    routerSays('deploy');
    const deploy = await route('<@UOWNER1> deploy went fine', ownerMention);
    expect(deploy.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(runDeployWorkflow).not.toHaveBeenCalled();
  });

  describe('asking instead of guessing (issue #431)', () => {
    const builder = { userId: 'UBUILDER', channelId: 'C-BUILD', intent: 'IMPLEMENTATION' as const };
    const enforce = () => ({ config: makeConfig('enforce') });
    const nothingRan = () => {
      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      expect(runAgenticEntry).not.toHaveBeenCalled();
      expect(runAgenticPrReview).not.toHaveBeenCalled();
      expect(runInvestigationWorkflow).not.toHaveBeenCalled();
    };

    it("asks the router's question and parks the job when the message has nothing to act on", async () => {
      routerSays('ask_user', 0.85, { question: 'What should I check?' });

      const { result, logStep, slack } = await route('<@UBOT1> check now', builder, enforce());

      nothingRan();
      expect(slack.chat.postMessage).toHaveBeenCalledExactlyOnceWith({
        channel: 'C-BUILD',
        thread_ts: '111.22',
        text: '<@UBUILDER> What should I check?',
      });
      expect(result).toMatchObject({ status: 'PAUSED', workflow: 'UNKNOWN', slackPosted: true });
      expect(stageLog(logStep, 'router.clarify.asked').data).toMatchObject({
        question: 'What should I check?',
        requesterId: 'UBUILDER',
        askedText: 'check now',
        reason: 'router_asked',
      });
      expect(stageLog(logStep, 'router.decision')).toMatchObject({
        message: 'Router chose ask_user; asking the requester.',
        data: { tool: 'ask_user', agree: true },
      });
    });

    it('asks instead of keeping the keyword seed when the confidence floor would have held it', async () => {
      // "cc:" used to stay IMPLEMENTATION here and page the admins with "which repo?".
      routerSays('chat', 0.6);

      const { result, logStep, slack } = await route('<@UBOT1> cc:', builder, enforce());

      nothingRan();
      expect(result.status).toBe('PAUSED');
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('<@UBUILDER> ');
      expect(stageLog(logStep, 'router.clarify.decided').data).toMatchObject({ action: 'ask', tool: 'chat' });
      // The router wanted to chat; asking is policy's doing, and the row says they differ.
      expect(stageLog(logStep, 'router.decision').data).toMatchObject({ tool: 'chat', agree: false });
      expect(stageLog(logStep, 'router.classify.low_confidence_hold')).toBeUndefined();
    });

    it('asks before starting the change pipeline on a low-confidence change_code', async () => {
      routerSays('change_code', 0.62);

      const { result } = await route('<@UBOT1> change the highlighted text', builder, enforce());

      nothingRan();
      expect(result.status).toBe('PAUSED');
    });

    it('asks rather than obeying a model that wants to ignore a direct mention', async () => {
      routerSays('stay_silent', 0.9);

      const { result, slack } = await route('<@UBOT1> no deployment', builder, enforce());

      nothingRan();
      expect(result.status).toBe('PAUSED');
      expect(slack.chat.postMessage).toHaveBeenCalledOnce();
    });

    it('routes a clear reply to the question as a normal request, with the question in the facts', async () => {
      routerSays('change_code', 0.9);
      const clarification = { question: 'What should I check?', askedText: 'check now' };

      const { result } = await route('the login redirect is broken, fix it', { ...builder, clarification }, enforce());

      expect(result.workflow).toBe('IMPLEMENTATION');
      expect(decideTool.mock.calls[0][0].facts.answering).toEqual(clarification);
    });

    it('does not ask twice: an unclear reply to the question gets one closing line', async () => {
      routerSays('ask_user', 0.8, { question: 'Which redirect?' });
      const clarification = { question: 'What should I check?', askedText: 'check now' };

      const { result, slack, logStep } = await route('that one', { ...builder, clarification }, enforce());

      nothingRan();
      expect(result.status).toBe('SKIPPED');
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain("I still can't tell what you need");
      expect(stageLog(logStep, 'router.clarify.asked')).toBeUndefined();
    });

    it('stays silent when the reply to the question drops it', async () => {
      routerSays('stay_silent', 0.9);
      const clarification = { question: 'What should I check?', askedText: 'check now' };

      const { result, slack } = await route('never mind', { ...builder, clarification }, enforce());

      nothingRan();
      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
    });

    it('never answers an owner mention with a question', async () => {
      routerSays('ask_user', 0.8, { question: 'Review what?' });

      const { result, slack } = await route('<@UOWNER1> can anyone review this', {
        mentionType: 'owner' as const,
        userId: 'UVIEWER',
      });

      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
    });

    it('gives a requester who would be denied the denial, not a question', async () => {
      routerSays('ask_user', 0.8, { question: 'What do you need?' });

      const { result, slack } = await route(
        '<@UBOT1> check now',
        { userId: 'USTRANGER', channelId: 'C-VIEW' },
        enforce(),
      );

      expect(result.status).toBe('SKIPPED');
      expect(slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(slack.chat.postMessage.mock.calls[0][0].text).not.toContain('What do you need?');
    });

    it('asks nothing once the job is cancelled', async () => {
      routerSays('ask_user', 0.8, { question: 'What do you need?' });
      const controller = new AbortController();
      controller.abort();

      const { result, slack } = await route('<@UBOT1> check now', builder, { ...enforce(), signal: controller.signal });

      expect(result.status).toBe('CANCELLED');
      expectNoReply(slack);
    });

    it('leaves a question unparked when another job is already parked in the thread', async () => {
      routerSays('ask_user', 0.8, { question: 'What do you need?' });
      const store = onStore({ pausedJobForThread: () => ({ id: 'job-plan', workflow: 'IMPLEMENTATION' }) });

      const { result } = await route('<@UBOT1> no', builder, { ...enforce(), store });

      expect(result.status).toBe('SKIPPED');
    });
  });

  describe('a mention made in passing (issue #448)', () => {
    const inPassing = {
      mentionReference: true,
      userId: 'UBUILDER',
      channelId: 'C-BUILD',
      intent: 'IMPLEMENTATION' as const,
    };
    const text = "<@UOWNER1> - I've resolved <@UBOT1>'s comments can u pls take a look on priority?";

    it('may be met with silence: nothing runs and nothing is posted', async () => {
      routerSays('stay_silent', 0.9);

      const { result, slack } = await route(text, inPassing, { config: makeConfig('enforce') });

      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
      expect(runAgenticPrReview).not.toHaveBeenCalled();
      expect(decideTool.mock.calls[0][0].facts.addressing).toBe('reference');
    });

    it('still gets what it asks for when it does ask miniOG for something', async () => {
      routerSays('answer', 0.9);

      const { result } = await route('<@U999> not sure — <@UBOT1> which service sends this email?', inPassing, {
        config: makeConfig('enforce'),
      });

      expect(result.workflow).toBe('INFORMATIONAL');
    });

    it('is not asked a question, and not told the router failed', async () => {
      routerSays('ask_user', 0.8, { question: 'What do you need?' });
      const asked = await route('cc: <@UBOT1>', inPassing, { config: makeConfig('enforce') });
      expect(asked.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(asked.slack);

      decideTool.mockResolvedValue({ ok: false, error: 'router call failed (exit 1)', durationMs: 3 });
      const failed = await route('cc: <@UBOT1>', inPassing, { config: makeConfig('enforce') });
      expect(failed.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(failed.slack);
    });

    // A message that mentions miniOG in passing is seeded as a change request
    // like any other mention. When the router's read of it was unsure, the
    // confidence floor kept that seed, and the change pipeline started on a
    // message written to someone else.
    it.each([
      ['chat', 0.6],
      ['review_pr', 0.6],
    ])('never falls back to the change pipeline when the router is unsure (%s at %s)', async (tool, confidence) => {
      routerSays(tool, confidence);

      const { result, slack, logStep } = await route(text, inPassing, { config: makeConfig('enforce') });

      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      expect(runAgenticPrReview).not.toHaveBeenCalled();
      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
      expect(stageLog(logStep, 'router.classify.low_confidence_hold')).toBeUndefined();
      expect(stageLog(logStep, 'router.unsure_in_passing').data).toMatchObject({ tool, confidence });
    });

    it('still acts on a confident decision', async () => {
      routerSays('review_pr', 0.9);

      const { result } = await route(text, inPassing, { config: makeConfig('enforce') });

      expect(result.workflow).toBe('PR_REVIEW');
    });
  });

  it('leaves the keyword gates deciding: a gate-seeded review runs and the router is only shadowed', async () => {
    routerSays('answer');

    const { result, logStep } = await route('<@UBOT1> is this merged?', { intent: 'PR_REVIEW' });

    expect(result.workflow).toBe('PR_REVIEW');
    expect(runAgenticPrReview).toHaveBeenCalledOnce();
    expect(stageLog(logStep, 'router.decision')).toBeUndefined();
    expect(stageLog(logStep, 'router.shadow').data).toMatchObject({
      mode: 'on',
      legacyDecidedBy: 'gate',
      routerWouldRun: 'INFORMATIONAL',
      agree: false,
    });
  });

  // Issue #398. A builder asked, in a channel the builder group is not enabled
  // in, "<@theOG> what is the name of this page?" and miniOG answered the
  // message — written to the owner — with "I'm not enabled for this kind of
  // request in this channel".
  // Issue #451, seen in the soak: "Fixed all reviews @miniOG" in a thread
  // where miniOG had reviewed the PR forty minutes earlier.
  it('tells the router when miniOG already reviewed a pull request in the thread', async () => {
    routerSays('review_pr', 0.9);
    const hasReviewedPrInThread = vi.fn(() => true);

    await route('Fixed all reviews <@UBOT1>', {}, { store: onStore({ hasReviewedPrInThread }) });

    expect(hasReviewedPrInThread).toHaveBeenCalledWith('C-VIEW', '111.22');
    expect(decideTool.mock.calls[0][0].facts.reviewedPrInThread).toBe(true);
  });

  it('decides without that fact when the store cannot say', async () => {
    routerSays('answer', 0.9);
    const hasReviewedPrInThread = vi.fn(() => {
      throw new Error('db closed');
    });

    const { result } = await route('what changed?', {}, { store: onStore({ hasReviewedPrInThread }) });

    expect(result.workflow).toBe('INFORMATIONAL');
    expect(decideTool.mock.calls[0][0].facts).not.toHaveProperty('reviewedPrInThread');
  });

  describe('an owner tag from someone without access of their own (issue #398)', () => {
    const tagger = {
      mentionType: 'owner' as const,
      userId: 'UBUILDER',
      channelId: 'C-ADMIN',
      intent: 'UNKNOWN' as const,
    };
    const text = '<@UOWNER1>, what is the name of this page?';
    const member = { resolveMembership: vi.fn(async () => ({ eligible: true as const, reason: 'member' as const })) };
    const guest = { resolveMembership: vi.fn(async () => ({ eligible: false as const, reason: 'guest' as const })) };
    const enforce = makeConfig('enforce');

    it("runs on the owner's authority for a full member, and never posts an access error", async () => {
      routerSays('answer', 0.9);
      const onEngage = vi.fn();

      const { result, logStep, slack } = await route(text, tagger, { config: enforce, deps: member, onEngage });

      expect(result.workflow).toBe('INFORMATIONAL');
      expect(runAgenticEntry).toHaveBeenCalledOnce();
      // The work is still the tagger's: only the permission check is the owner's.
      expect(runAgenticEntry.mock.calls[0][0].task).toMatchObject({
        delegatedByOwnerId: 'UOWNER1',
        isOwnerAuthor: false,
        event: { userId: 'UBUILDER' },
      });
      expect(stageLog(logStep, 'access.owner_delegated').data).toMatchObject({
        ownerId: 'UOWNER1',
        requesterUserId: 'UBUILDER',
        requesterDenyReason: 'CHANNEL_NOT_ENABLED',
        inherited: false,
      });
      expectNoReply(slack);
      expect(onEngage).toHaveBeenCalledOnce();
    });

    it('stays silent for someone the authority cannot be lent to, and leaves no trace', async () => {
      routerSays('answer', 0.9);
      const onEngage = vi.fn();

      const { result, logStep, slack } = await route(text, tagger, { config: enforce, deps: guest, onEngage });

      expect(result).toMatchObject({ status: 'SKIPPED', slackPosted: false });
      expect(runAgenticEntry).not.toHaveBeenCalled();
      expectNoReply(slack);
      expect(onEngage).not.toHaveBeenCalled();
      expect(stageLog(logStep, 'access.owner_tag.silent_deny').data).toMatchObject({ reason: 'guest' });
    });

    it('stands down without asking the router when the owner already posted in the thread', async () => {
      const onEngage = vi.fn();
      const threadMessages = [
        { text: 'is this back button intended?', user: 'UBUILDER', ts: '111.10' },
        { text: 'yes, by design', user: 'UOWNER1', ts: '111.15' },
        { text, user: 'UBUILDER', ts: '111.22' },
      ];

      const { result, logStep, slack } = await route(
        text,
        { ...tagger, threadMessages },
        { config: enforce, deps: member, onEngage },
      );

      expect(result).toMatchObject({ status: 'SKIPPED', slackPosted: false });
      expect(decideTool).not.toHaveBeenCalled();
      expectNoReply(slack);
      expect(onEngage).not.toHaveBeenCalled();
      expect(stageLog(logStep, 'router.owner_tag.stand_down').data).toMatchObject({ ownerId: 'UOWNER1' });
    });

    it('leaves no trace when the router reads it as a conversation between people', async () => {
      routerSays('stay_silent', 0.9);
      const onEngage = vi.fn();

      const { result, slack } = await route(text, tagger, { config: enforce, deps: member, onEngage });

      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
      expect(onEngage).not.toHaveBeenCalled();
    });

    it('asks before a change on the owner’s authority, and the answer keeps it', async () => {
      routerSays('change_code', 0.9);
      const asked = await route('<@UOWNER1> please remove this section from the page', tagger, {
        config: enforce,
        deps: member,
      });

      expect(asked.result.status).toBe('PAUSED');
      expect(asked.slack.chat.postMessage.mock.calls[0][0].text).toContain('<@UBUILDER> ');
      expect(stageLog(asked.logStep, 'router.clarify.asked').data).toMatchObject({
        requesterId: 'UBUILDER',
        delegatedByOwnerId: 'UOWNER1',
      });

      // The tagger answers "yes" in the thread: a reply to miniOG, checked on the same owner's authority.
      vi.clearAllMocks();
      routerSays('change_code', 0.9);
      const answered = await route(
        'yes',
        {
          userId: 'UBUILDER',
          channelId: 'C-ADMIN',
          intent: 'IMPLEMENTATION',
          clarification: { question: 'Want me to pick this up?', askedText: 'please remove this section' },
          inheritedDelegationOwnerId: 'UOWNER1',
        },
        { config: enforce, deps: member },
      );

      expect(runImplementationWorkflow).toHaveBeenCalledOnce();
      expect(stageLog(answered.logStep, 'access.owner_delegated').data).toMatchObject({ inherited: true });
      expectNoReply(answered.slack);
    });

    it('does not change a direct mention: the same person gets the access error', async () => {
      routerSays('answer', 0.9);
      const onEngage = vi.fn();

      const { result, slack } = await route(
        '<@UBOT1> what is the name of this page?',
        { ...tagger, mentionType: 'bot' },
        {
          config: enforce,
          deps: member,
          onEngage,
        },
      );

      expect(result.status).toBe('SKIPPED');
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('not enabled for this kind of request');
      expect(onEngage).toHaveBeenCalledOnce();
    });

    it('goes back to the access error with the switch off', async () => {
      routerSays('answer', 0.9);
      vi.stubEnv('WATCHTOWER_OWNER_TAG_DELEGATION', '0');
      try {
        const { slack } = await route(text, tagger, { config: enforce, deps: member });
        expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('not enabled for this kind of request');
        expect(member.resolveMembership).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('a message that tags the owner (issue #430)', () => {
    const tagger = {
      mentionType: 'owner' as const,
      userId: 'UBUILDER',
      channelId: 'C-BUILD',
      intent: 'UNKNOWN' as const,
    };
    const CHANGE = '<@UOWNER1> we need to remove the disclaimer from the S-VYASA landing page, on priority';

    it('asks the tagger before starting a change, and parks on the answer', async () => {
      routerSays('change_code', 0.92);

      const { result, slack } = await route(CHANGE, tagger, { config: makeConfig('enforce') });

      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      expect(slack.chat.postMessage).toHaveBeenCalledOnce();
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('<@UBUILDER> Want me to pick this up');
      expect(result.status).toBe('PAUSED');
    });

    it('starts the change once the tagger says yes', async () => {
      routerSays('change_code', 0.9);
      const clarification = { question: 'Want me to pick this up and make the change?', askedText: CHANGE };

      // The reply resumes as a message to miniOG, checked against the tagger's own access.
      const { result } = await route(
        'yes',
        { userId: 'UBUILDER', channelId: 'C-BUILD', intent: 'IMPLEMENTATION', clarification },
        { config: makeConfig('enforce') },
      );

      expect(result.workflow).toBe('IMPLEMENTATION');
      expect(runImplementationWorkflow).toHaveBeenCalledOnce();
    });

    // The access check comes first, at the change tier. Someone who could not
    // say yes on their own can on the owner's authority (issue #398); someone
    // it cannot be lent to is not asked, and gets nothing.
    it('asks a full member who lacks the change tier, on the owner’s authority', async () => {
      routerSays('change_code', 0.92);
      const member = vi.fn(async () => ({ eligible: true as const, reason: 'member' as const }));

      const { result, slack } = await route(
        CHANGE,
        { ...tagger, userId: 'UVIEWER', channelId: 'C-VIEW' },
        { config: makeConfig('enforce'), deps: { resolveMembership: member } },
      );

      expect(result.status).toBe('PAUSED');
      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('Want me to pick');
    });

    it('does not ask, or answer, someone the owner’s authority cannot be lent to', async () => {
      routerSays('change_code', 0.92);

      // No membership information at all (the lookup fails): fail closed.
      const { result, slack } = await route(
        CHANGE,
        { ...tagger, userId: 'UVIEWER', channelId: 'C-VIEW' },
        { config: makeConfig('enforce') },
      );

      expect(result.status).toBe('SKIPPED');
      expect(runImplementationWorkflow).not.toHaveBeenCalled();
      expectNoReply(slack);
    });

    it('runs a review the gate seeded without waiting on the router', async () => {
      decideTool.mockResolvedValue({ ok: false, error: 'router call failed (exit 1)', durationMs: 3 });

      const { result } = await route(
        '<@UOWNER1> please review https://github.com/Newton-School/newton-web/pull/9210',
        { mentionType: 'owner' as const, userId: 'UREVIEW', channelId: 'C-REVIEW', intent: 'PR_REVIEW' },
        { config: makeConfig('enforce') },
      );

      // The model was down for this one, which is the case #430 lost twice.
      expect(result.workflow).toBe('PR_REVIEW');
      expect(runAgenticPrReview).toHaveBeenCalledOnce();
    });

    it('still reviews a PR posted with only its title, by the router', async () => {
      routerSays('review_pr', 0.8);

      const { result } = await route(
        '<@UOWNER1> NS-14362: Map playlists to company https://github.com/Newton-School/newton-web/pull/9318',
        { ...tagger, userId: 'UREVIEW', channelId: 'C-REVIEW' },
        { config: makeConfig('enforce') },
      );

      expect(result.workflow).toBe('PR_REVIEW');
      expect(runImplementationWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('a production deploy (issue #428)', () => {
    const DEPLOY_ASK = '<@UBOT1> deploy newton-web to production';
    const NEAR_MISS =
      '<@UBOT1> could you review these two please? • newton-web <https://github.com/Newton-School/newton-web/pull/9276|#9276> *Deploy order:* #9276 → web';

    it('starts when the router says deploy, the message is addressed to miniOG and code finds the target', async () => {
      routerSays('deploy', 0.95);

      const { result } = await route(DEPLOY_ASK);

      expect(result.workflow).toBe('DEPLOY');
      expect(runDeployWorkflow).toHaveBeenCalledOnce();
      expect(decideTool.mock.calls[0][0].facts).toMatchObject({ deployTarget: 'newton-web' });
    });

    it('is not started by keywords: the message that nearly deployed is reviewed', async () => {
      routerSays('review_pr', 0.95);

      const { result } = await route(NEAR_MISS);

      expect(result.workflow).toBe('PR_REVIEW');
      expect(runDeployWorkflow).not.toHaveBeenCalled();
    });

    it('is not started on the model alone: the message that nearly deployed gets a reply on how to ask', async () => {
      // Even if the model misread it as a deploy, code finds no deploy ask leading the message.
      routerSays('deploy', 0.95);

      const { result, slack } = await route(NEAR_MISS);

      expect(runDeployWorkflow).not.toHaveBeenCalled();
      expect(result.status).toBe('SKIPPED');
      expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('say which app in one message');
    });

    it.each([
      ['an owner mention', { mentionType: 'owner' as const, userId: 'UADMIN', channelId: 'C-ADMIN' }],
      ['a mention in passing', { mentionReference: true, userId: 'UADMIN', channelId: 'C-ADMIN' }],
    ])('is never started for %s, whatever the model says', async (_name, task) => {
      routerSays('deploy', 0.99);

      const { result, slack } = await route('<@UOWNER1> deploy newton-web to production cc <@UBOT1>', task);

      expect(runDeployWorkflow).not.toHaveBeenCalled();
      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expectNoReply(slack);
    });

    it('is never started from a reply to a question miniOG asked', async () => {
      routerSays('deploy', 0.99);
      const clarification = { question: 'What do you need?', askedText: 'ship it' };

      const { result } = await route('deploy newton-web to production', { clarification });

      expect(runDeployWorkflow).not.toHaveBeenCalled();
      expect(result.status).toBe('SKIPPED');
    });

    it('still needs the admin tier', async () => {
      routerSays('deploy', 0.95);

      const { result } = await route(
        DEPLOY_ASK,
        { userId: 'UBUILDER', channelId: 'C-BUILD', intent: 'IMPLEMENTATION' },
        { config: makeConfig('enforce') },
      );

      expect(runDeployWorkflow).not.toHaveBeenCalled();
      expect(result.status).toBe('SKIPPED');
    });
  });

  it('leaves the "yes, fix it" resume gate ahead of the router', async () => {
    routerSays('chat', 0.99);
    const store = onStore({
      investigationStore: () => ({ getForThread: () => ({ summary: 'prior RCA', repoName: 'newton-web' }) }),
    });

    const { result, logStep } = await route(
      '<@UBOT1> yes, fix it',
      { userId: 'UBUILDER', channelId: 'C-BUILD', intent: 'IMPLEMENTATION' },
      { store, config: makeConfig('enforce') },
    );

    expect(result.workflow).toBe('IMPLEMENTATION');
    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
    expect(stageLog(logStep, 'router.shadow').data).toMatchObject({ legacyDecidedBy: 'resume_gate' });
  });

  it('decides without a logger', async () => {
    routerSays('investigate');

    const { result } = await route('<@UBOT1> the dashboard looks off since morning', {}, { log: false });

    expect(result.workflow).toBe('INVESTIGATION');
  });

  it('applies the access tiers to what the router chose', async () => {
    routerSays('change_code');

    const { result } = await route(
      '<@UBOT1> fix the login redirect in auth.ts',
      { userId: 'UVIEWER', channelId: 'C-VIEW', intent: 'INFORMATIONAL' },
      { config: makeConfig('enforce') },
    );

    expect(result.status).toBe('SKIPPED');
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
  });
});

describe('the opening line (issue #588)', () => {
  const recent = () => String((Date.now() - 20_000) / 1000);
  const late = () => String((Date.now() - 25 * 60_000) / 1000);
  const pr = (source: 'trigger' | 'thread') =>
    ({
      owner: 'Newton-School',
      repo: 'newton-web',
      number: 1,
      url: 'https://github.com/Newton-School/newton-web/pull/1',
      source,
    }) as never;
  const lookup = (eventTs: string) => {
    const task = makeTask({ userId: 'UOWNER1', channelId: 'C-BUILD', text: '<@UBOT1> how does XP work?' });
    task.event.eventTs = eventTs;
    return task;
  };

  it('says what to expect before a lookup runs', async () => {
    const slack = makeSlack();
    const logStep = vi.fn();
    routerPicks('INFORMATIONAL');

    await routeTask({
      task: lookup(recent()),
      config: makeConfig('enforce'),
      slack: slack as never,
      store: {} as never,
      logStep,
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(
      'On it. A lookup like this usually takes a couple of minutes.',
    );
    expect(runAgenticEntry).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'job.pickup_delay',
        data: expect.objectContaining({ pickupDelayMs: expect.any(Number) }),
      }),
    );
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'job.acknowledged' }));
  });

  it('says it is late when the pickup was', async () => {
    const slack = makeSlack();
    routerPicks('INFORMATIONAL');

    await routeTask({ task: lookup(late()), config: makeConfig('enforce'), slack: slack as never, store: {} as never });

    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(
      "Sorry for the wait: I'm only picking this up 25 min after you sent it. On it. A lookup like this usually takes a couple of minutes.",
    );
  });

  it('does not apologise for a desktop retrigger or a restart re-run, whose event time is old by design', async () => {
    routerPicks('INFORMATIONAL');
    for (const shape of [{ ingestSource: 'launchpad' as const }, { eventId: 'restart:job-1' }]) {
      const slack = makeSlack();
      const task = lookup(late());
      task.event = { ...task.event, ...shape };
      await routeTask({ task, config: makeConfig('enforce'), slack: slack as never, store: {} as never });
      expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(
        'On it. A lookup like this usually takes a couple of minutes.',
      );
    }
  });

  it('posts no opening line once the job is cancelled', async () => {
    const slack = makeSlack();
    routerPicks('INFORMATIONAL');
    const controller = new AbortController();
    controller.abort();
    await routeTask({
      task: lookup(recent()),
      config: makeConfig('enforce'),
      slack: slack as never,
      store: {} as never,
      signal: controller.signal,
    });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('posts only the apology before a review, which opens with its own line', async () => {
    const slack = makeSlack();
    routerPicks('PR_REVIEW');
    const task = makeTask({
      userId: 'UOWNER1',
      channelId: 'C-BUILD',
      text: '<@UBOT1> review <https://github.com/Newton-School/newton-web/pull/1>',
      intent: 'PR_REVIEW',
      prContext: pr('trigger'),
    });
    task.event.eventTs = late();

    await routeTask({ task, config: makeConfig('enforce'), slack: slack as never, store: {} as never });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage.mock.calls[0][0].text).toBe(
      "Sorry for the wait: I'm only picking this up 25 min after you sent it.",
    );
  });

  it('posts nothing before a chat or a prompt review', async () => {
    const slack = makeSlack();
    routerPicks('CONVERSATIONAL');
    const chat = makeTask({ userId: 'UOWNER1', channelId: 'C-BUILD', text: '<@UBOT1> thanks!' });
    chat.event.eventTs = recent();
    await routeTask({ task: chat, config: makeConfig('enforce'), slack: slack as never, store: {} as never });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();

    routerPicks('PR_REVIEW');
    const review = makeTask({
      userId: 'UOWNER1',
      channelId: 'C-BUILD',
      text: '<@UBOT1> review <https://github.com/Newton-School/newton-web/pull/1>',
      intent: 'PR_REVIEW',
      prContext: pr('trigger'),
    });
    review.event.eventTs = recent();
    await routeTask({ task: review, config: makeConfig('enforce'), slack: slack as never, store: {} as never });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not promise a plan for a change request about a PR named in the message', async () => {
    const slack = makeSlack();
    routerPicks('IMPLEMENTATION');
    const task = makeTask({
      userId: 'UOWNER1',
      channelId: 'C-BUILD',
      text: '<@UBOT1> merge <https://github.com/Newton-School/newton-web/pull/1>',
      intent: 'IMPLEMENTATION',
      prContext: pr('trigger'),
    });
    task.event.eventTs = recent();

    await routeTask({ task, config: makeConfig('enforce'), slack: slack as never, store: {} as never });

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
  });

  it('still promises a plan when the only PR link is earlier in the thread', async () => {
    const slack = makeSlack();
    routerPicks('IMPLEMENTATION');
    const task = makeTask({
      userId: 'UOWNER1',
      channelId: 'C-BUILD',
      text: '<@UBOT1> also fix the empty-state copy',
      intent: 'IMPLEMENTATION',
    });
    task.prContexts = [pr('thread')];
    task.event.eventTs = recent();

    await routeTask({ task, config: makeConfig('enforce'), slack: slack as never, store: {} as never });

    expect(slack.chat.postMessage.mock.calls[0][0].text).toContain('post a plan for approval');
  });
});
