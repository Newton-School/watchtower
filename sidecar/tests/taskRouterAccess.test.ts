import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toResolvedAccessControlConfig } from '../src/access/control.js';
import type { AppConfig, NormalizedTask } from '../src/types/contracts.js';

const runPrReviewWorkflow = vi.fn();
const runImplementationWorkflow = vi.fn();
const runDevAssistWorkflow = vi.fn();
const runDeployWorkflow = vi.fn();
const runAgenticEntry = vi.fn();
const runUnknownTaskWorkflow = vi.fn();
const classifyWorkflowIntent = vi.fn();

vi.mock('../src/workflows/prReviewWorkflow.js', () => ({
  runPrReviewWorkflow,
}));

vi.mock('../src/workflows/implementationWorkflow.js', () => ({
  runImplementationWorkflow,
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
  classifyWorkflowIntent.mockResolvedValue({
    intent: 'PR_REVIEW',
    confidence: 0.91,
    reasoning: 'review request',
  });
  runPrReviewWorkflow.mockResolvedValue({
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
    expect(runPrReviewWorkflow).toHaveBeenCalledOnce();
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
    expect(runPrReviewWorkflow).not.toHaveBeenCalled();
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
    expect(runPrReviewWorkflow).not.toHaveBeenCalled();
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
    expect(runPrReviewWorkflow).toHaveBeenCalledOnce();
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
    expect(runPrReviewWorkflow).toHaveBeenCalledOnce();
  });
});
