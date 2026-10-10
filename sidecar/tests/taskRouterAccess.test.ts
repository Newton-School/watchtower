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
const classifyWorkflowIntent = vi.fn();
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

// The tool-router runs in shadow beside every routed mention (issue #456).
// Stub its model call so no test can spawn the real CLI; keep the rest real.
vi.mock('../src/router/toolRouter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/router/toolRouter.js')>()),
  decideTool,
}));

vi.mock('../src/router/classifyIntent.js', () => ({
  classifyWorkflowIntent,
}));

vi.mock('../src/workflows/matcher.js', () => ({
  matchWorkflowTemplate: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../src/workflows/registry.js', () => ({
  getWorkflowTemplates: vi.fn().mockReturnValue([]),
}));

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

function makeSlack() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.45' }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Shadow router: by default it "fails", which must never matter to a job.
  decideTool.mockResolvedValue({ ok: false, error: 'stubbed', durationMs: 0 });
  classifyWorkflowIntent.mockResolvedValue({
    intent: 'PR_REVIEW',
    confidence: 0.91,
    reasoning: 'review request',
  });
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
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'CONVERSATIONAL',
      confidence: 0.9,
      reasoning: 'casual chat',
    });

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
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('blocks builders from deploy and lets the owner bypass', async () => {
    const config = makeConfig('enforce');
    const slack = makeSlack();

    const blocked = await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> deploy prod',
        intent: 'DEPLOY',
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
        text: '<@UBOT1> deploy prod',
        intent: 'DEPLOY',
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

  it('routes "yes" with pending findings to IMPLEMENTATION for non-owner (bypasses classifier)', async () => {
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
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
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
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.investigation.resume_gate',
        data: expect.objectContaining({ resolvedIntent: 'OWNER_AUTOPILOT' }),
      }),
    );
  });

  it('falls through to the classifier when affirmation has no pending findings', async () => {
    // No investigation_findings row for this thread — gate must not fire.
    // Confidence ≥ 0.75 so the classifier confidence floor (D3) accepts the
    // override; this test exists to verify the resume-gate path specifically.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    const store = storeWithFindings(undefined);
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'CONVERSATIONAL',
      confidence: 0.85,
      reasoning: 'just a yes',
    });

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

    expect(classifyWorkflowIntent).toHaveBeenCalledOnce();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
    expect(runAgenticEntry).toHaveBeenCalledOnce();
    expect(result.status).toBe('SUCCESS');
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.investigation.resume_gate' }));
  });

  it('holds the original intent when a low-confidence classifier override drops the access tier', async () => {
    // Regression for RCA Slack thread p1779086230428739 (2026-05-18). A bare
    // "yes" tagged at miniOG used to get reclassified IMPLEMENTATION →
    // CONVERSATIONAL at confidence 0.60 — the conversational workflow then
    // hallucinated a "fix done" reply. The floor refuses the override when
    // confidence < 0.75 AND the proposed intent requires a strictly lower
    // access tier (CONVERSATIONAL → viewer, IMPLEMENTATION → builder).
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const logStep = vi.fn();
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'CONVERSATIONAL',
      confidence: 0.6,
      reasoning: 'short message',
    });

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

    expect(classifyWorkflowIntent).toHaveBeenCalledOnce();
    expect(runImplementationWorkflow).toHaveBeenCalledOnce(); // original intent honored
    expect(runAgenticEntry).not.toHaveBeenCalled();
    expect(result.status).toBe('SUCCESS');
    expect(logStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'router.classify.low_confidence_hold',
        level: 'WARN',
        data: expect.objectContaining({
          originalIntent: 'IMPLEMENTATION',
          classifiedIntent: 'CONVERSATIONAL',
          confidence: 0.6,
          originalRequiredLevel: 'builder',
          proposedRequiredLevel: 'viewer',
        }),
      }),
    );
  });

  it('accepts a high-confidence access-dropping override', async () => {
    // 0.80 ≥ 0.75 floor — classifier judgment is trusted.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'CONVERSATIONAL',
      confidence: 0.8,
      reasoning: 'clearly chat',
    });

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

  it('does not gate sideways/upward overrides regardless of confidence', async () => {
    // INFORMATIONAL (viewer) → IMPLEMENTATION (builder) raises the tier; the
    // floor only applies to access-dropping moves. A low-confidence upward
    // shift is still acceptable because access checks still gate it.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'IMPLEMENTATION',
      confidence: 0.5,
      reasoning: 'might be a fix request',
    });

    await routeTask({
      task: makeTask({
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        text: '<@UBOT1> please look into this',
        intent: 'INFORMATIONAL',
      }),
      config,
      slack: slack as never,
      store: {} as never,
      logStep: vi.fn(),
    });

    expect(runImplementationWorkflow).toHaveBeenCalledOnce();
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
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'INFORMATIONAL',
      confidence: 0.72,
      reasoning: 'this is a how-does-it-work question',
    });

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
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.classify.low_confidence_hold' }));
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
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'INVESTIGATION',
      confidence: 0.72,
      reasoning: 'reported odd behavior, no anchor — diagnose first',
    });

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
    expect(logStep).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.classify.low_confidence_hold' }));
  });

  it('falls through to the classifier when text is not an affirmation, even with pending findings', async () => {
    // Findings exist but the message is not a "yes, fix it" — classifier still
    // decides intent. This is the path for "actually wait" / "no, the bug is X".
    // Confidence ≥ 0.75 so the D3 floor accepts the override.
    const config = makeConfig('enforce');
    const slack = makeSlack();
    const store = storeWithFindings({ summary: 'prior RCA' });
    classifyWorkflowIntent.mockResolvedValueOnce({
      intent: 'CONVERSATIONAL',
      confidence: 0.85,
      reasoning: 'follow-up discussion',
    });

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

    expect(classifyWorkflowIntent).toHaveBeenCalledOnce();
    expect(runImplementationWorkflow).not.toHaveBeenCalled();
  });
});

describe('deterministic PR_REVIEW seed (issue #334 bug B)', () => {
  it('skips the AI classifier and dispatches the review at reviewer tier', async () => {
    const config = makeConfig('enforce');
    const logStep = vi.fn();

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
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
    expect(runAgenticPrReview).toHaveBeenCalledOnce();
    expect(logStep).toHaveBeenCalledWith(expect.objectContaining({ stage: 'router.pr_review.deterministic' }));
  });

  it('routes the review even when the classifier CLI is dead (the incident failure mode)', async () => {
    // 2026-06-11 incident: "Please review <newton-web URL>" hit a classifier
    // CLI exit-1, fell back to INFORMATIONAL@0.00, the access-drop guardrail
    // held IMPLEMENTATION, and the implementation workflow asked admins
    // "web or api?" about a message that named the repo in its URL. With the
    // deterministic seed the classifier is never consulted, so its health is
    // irrelevant.
    const config = makeConfig('enforce');
    classifyWorkflowIntent.mockRejectedValue(new Error('CLI exited 1'));

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
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
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

describe('routeTask runs the tool-router in shadow (issue #456)', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const shadowLog = (logStep: ReturnType<typeof vi.fn>) =>
    logStep.mock.calls.map(call => call[0]).find(entry => entry.stage === 'router.shadow');

  async function route(text: string, store: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const logStep = vi.fn();
    const result = await routeTask({
      task: makeTask({ userId: 'UOWNER1', channelId: 'C-VIEW', text, ...extra }),
      config: makeConfig('audit'),
      slack: makeSlack() as never,
      store: store as never,
      logStep,
    });
    await settle();
    return { result, logStep };
  }

  it('asks the router beside the classifier and logs whether they agree, without changing what runs', async () => {
    classifyWorkflowIntent.mockResolvedValue({ intent: 'INFORMATIONAL', confidence: 0.9, reasoning: 'a question' });
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool: 'answer', confidence: 0.93, reason: 'a question about the code' },
      durationMs: 812,
    });

    const { result, logStep } = await route('<@UBOT1> how does the login redirect work?');

    expect(result.workflow).toBe('INFORMATIONAL');
    expect(decideTool).toHaveBeenCalledTimes(1);
    expect(decideTool.mock.calls[0][0]).toMatchObject({
      role: 'router_shadow',
      facts: { message: 'how does the login redirect work?', addressing: 'direct', hints: [] },
    });
    // No onLog: the shadow call must not move the Slack status line.
    expect(decideTool.mock.calls[0][0].logStep).toBeUndefined();
    expect(shadowLog(logStep).data).toMatchObject({
      agree: true,
      legacyIntent: 'INFORMATIONAL',
      legacyDecidedBy: 'classifier',
      routerWouldRun: 'INFORMATIONAL',
      tool: 'answer',
      confidence: 0.93,
      durationMs: 812,
    });
  });

  it('records a disagreement and still runs what the legacy path chose', async () => {
    classifyWorkflowIntent.mockResolvedValue({ intent: 'INFORMATIONAL', confidence: 0.9, reasoning: 'q' });
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool: 'ask_user', confidence: 0.8, reason: 'nothing to act on', question: 'What should I look at?' },
      durationMs: 5,
    });

    const { result, logStep } = await route('<@UBOT1> check now');

    expect(result.workflow).toBe('INFORMATIONAL');
    expect(runAgenticEntry).toHaveBeenCalledTimes(1);
    expect(shadowLog(logStep).data).toMatchObject({
      agree: false,
      routerWouldRun: 'ASK_USER',
      routerAsClassifier: 'INFORMATIONAL',
      question: 'What should I look at?',
    });
  });

  it('shadows a message the keyword gate decided, and says a gate decided it', async () => {
    decideTool.mockResolvedValue({
      ok: true,
      decision: { tool: 'answer', confidence: 0.9, reason: 'a question about a merged PR' },
      durationMs: 5,
    });

    const { result, logStep } = await route('<@UBOT1> is this merged?', {}, { intent: 'PR_REVIEW' });

    expect(result.workflow).toBe('PR_REVIEW');
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
    expect(decideTool.mock.calls[0][0].facts.hints).toEqual(['review gate matched']);
    expect(shadowLog(logStep).data).toMatchObject({
      agree: false,
      legacyIntent: 'PR_REVIEW',
      legacyDecidedBy: 'gate',
      routerWouldRun: 'INFORMATIONAL',
    });
  });

  it('is unaffected when the router fails or throws', async () => {
    classifyWorkflowIntent.mockResolvedValue({ intent: 'INFORMATIONAL', confidence: 0.9, reasoning: 'q' });
    decideTool.mockRejectedValue(new Error('spawn failed'));

    const { result, logStep } = await route('<@UBOT1> how does the login redirect work?');

    expect(result.status).toBe('SUCCESS');
    expect(shadowLog(logStep).data).toMatchObject({ agree: false, routerWouldRun: 'FAILED' });
    // A shadow call decides nothing, so a failed one is not worth a second.
    expect(decideTool).toHaveBeenCalledTimes(1);
  });

  it('does not run in legacy mode', async () => {
    const store = { getState: (key: string) => (key === 'tool_router_mode' ? 'legacy' : undefined) };
    const { logStep } = await route('<@UBOT1> how does the login redirect work?', store);

    expect(decideTool).not.toHaveBeenCalled();
    expect(shadowLog(logStep)).toBeUndefined();
  });

  it('skips exact-syntax commands, which leave nothing to decide', async () => {
    await route('<@UBOT1> wt status', {}, { intent: 'DEV_ASSIST' });
    expect(decideTool).not.toHaveBeenCalled();
  });
});

describe('routeTask lets the tool-router decide when it is on (issue #456)', () => {
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
    return { getState: (key: string) => (key === 'tool_router_mode' ? 'on' : undefined), ...extra };
  }

  async function route(
    text: string,
    task: Record<string, unknown> = {},
    options: { store?: Record<string, unknown>; config?: AppConfig; log?: boolean; signal?: AbortSignal } = {},
  ) {
    const logStep = vi.fn();
    const slack = makeSlack();
    const {
      mentionType = 'bot',
      mentionReference,
      clarification,
      ...input
    } = task as {
      mentionType?: 'bot' | 'owner';
      mentionReference?: boolean;
      clarification?: NormalizedTask['clarification'];
    };
    const result = await routeTask({
      task: {
        ...makeTask({ userId: 'UOWNER1', channelId: 'C-VIEW', text, ...input }),
        mentionType,
        ...(mentionReference ? { mentionReference } : {}),
        ...(clarification ? { clarification } : {}),
      },
      config: options.config ?? makeConfig('audit'),
      slack: slack as never,
      store: (options.store ?? onStore()) as never,
      signal: options.signal,
      ...(options.log === false ? {} : { logStep }),
    });
    await settle();
    return { result, logStep, slack };
  }

  it('uses the router where the classifier was, with one call and no classifier call', async () => {
    routerSays('answer', 0.93);

    const { result, logStep } = await route('<@UBOT1> how does the login redirect work?');

    expect(result.workflow).toBe('INFORMATIONAL');
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
    expect(decideTool).toHaveBeenCalledTimes(1);
    // The deciding call is the job's own: costed as the router and logged like the classifier's was.
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

  it.each(['unsupported', 'deploy', 'qa_webapp'])(
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
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
    expect(thrown.slack.chat.postMessage).not.toHaveBeenCalled();

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
      expect(slack.chat.postMessage).not.toHaveBeenCalled();
    });

    it('never answers an owner mention with a question', async () => {
      routerSays('ask_user', 0.8, { question: 'Review what?' });

      const { result, slack } = await route('<@UOWNER1> can anyone review this', {
        mentionType: 'owner' as const,
        userId: 'UVIEWER',
      });

      expect(result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
      expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
      expect(slack.chat.postMessage).not.toHaveBeenCalled();
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
      expect(asked.slack.chat.postMessage).not.toHaveBeenCalled();

      decideTool.mockResolvedValue({ ok: false, error: 'router call failed (exit 1)', durationMs: 3 });
      const failed = await route('cc: <@UBOT1>', inPassing, { config: makeConfig('enforce') });
      expect(failed.result).toMatchObject({ workflow: 'NONE', status: 'SKIPPED' });
      expect(failed.slack.chat.postMessage).not.toHaveBeenCalled();
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

  it('leaves a gate-seeded deploy with the deploy gate', async () => {
    routerSays('answer');

    const { result } = await route('<@UBOT1> deploy newton-web to production', { intent: 'DEPLOY' });

    expect(result.workflow).toBe('DEPLOY');
    expect(runDeployWorkflow).toHaveBeenCalledOnce();
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
    expect(classifyWorkflowIntent).not.toHaveBeenCalled();
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
