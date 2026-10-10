import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
  CodexRunRequest,
  DossierRole,
  NormalizedTask,
  WorkflowIntent,
  WorkflowResult,
  WorkflowStepLogger,
} from '../types/contracts.js';
import {
  ACCESS_RANK,
  evaluateAccess,
  getConfiguredAccessControl,
  resolveRequiredAccessLevel,
  workflowSideEffect,
} from '../access/control.js';
import type { JobStore } from '../state/jobStore.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runMiniogDossierWorkflow } from '../workflows/miniogDossierWorkflow.js';
import { runDeployWorkflow } from '../workflows/deployWorkflow.js';
import { runImplementationWorkflow } from '../workflows/implementationWorkflow.js';
import { runInvestigationWorkflow } from '../workflows/investigationWorkflow.js';
import { runAgenticEntry } from '../agentic/agenticEntry.js';
import { runAgenticPrReview } from '../agentic/agenticPrReview.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';
import { getWorkflowTemplates } from '../workflows/registry.js';
import { matchWorkflowTemplate } from '../workflows/matcher.js';
import { renderPromptTemplate } from '../workflows/renderer.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { highReasoningProfile } from '../codex/modelProfiles.js';
import { resolveGithubTokenForCodex } from '../github/githubAuth.js';
import { classifyWorkflowIntent, type IntentClassification } from './classifyIntent.js';
import { startRouterShadow, type LegacyDecidedBy, type RouterClassification } from './routerShadow.js';
import { askRequester, decideClarify, giveUpOnClarify, type ClarifyAction } from './routeClarify.js';
import { cancelledResult } from '../workflows/shared/cancelState.js';
import { looksLikeFixAffirmation } from './resumeIntentParser.js';

// Confidence threshold below which the router refuses to honor a classifier
// override that drops the required access tier. RCA on Slack thread
// p1779086230428739 (2026-05-18) caught a 0.60-confidence
// IMPLEMENTATION → CONVERSATIONAL reclassification of a bare "yes"; the
// conversational workflow then hallucinated a "fix done" reply. Typical
// successful classifications run 0.85+, so 0.75 is a conservative floor.
export const CLASSIFIER_CONFIDENCE_FLOOR = 0.75;
import { formatThreadContextForClassifier, isPresencePing } from '../workflows/shared/workflowUtils.js';
import { formatDossierForPrompt } from '../state/dossierStore.js';

type WorkflowRunnerContext = {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
};

const investigationStoreOf = (store: JobStore) =>
  typeof store?.investigationStore === 'function' ? store.investigationStore() : undefined;

/**
 * The workflow that carries out each tool, by the intent it runs as. The
 * registry (router/toolRegistry.ts) says what each tool needs and can do;
 * this says how to start it. A test keeps the two in step.
 */
const WORKFLOW_RUNNERS: Partial<Record<WorkflowIntent, (ctx: WorkflowRunnerContext) => Promise<WorkflowResult>>> = {
  PR_REVIEW: ({ task, config, slack, store, jobId, logStep, signal }) =>
    runAgenticPrReview({ task, config, slack, store, jobId, logStep, signal }),
  IMPLEMENTATION: runImplementation,
  OWNER_AUTOPILOT: runImplementation,
  INVESTIGATION: ({ task, config, slack, store, jobId, logStep, signal }) =>
    runInvestigationWorkflow({
      task,
      config,
      slack,
      store,
      investigationStore: investigationStoreOf(store),
      jobId,
      logStep,
      signal,
    }),
  INFORMATIONAL: ctx => runAgenticEntry({ mode: 'informational', ...ctx }),
  CONVERSATIONAL: ctx => runAgenticEntry({ mode: 'conversational', ...ctx }),
  WEBAPP_QA: ctx => runAgenticEntry({ mode: 'qa', ...ctx }),
  DEV_ASSIST: ({ task, config, slack, store, logStep, signal }) =>
    runDevAssistWorkflow({ task, config, slack, store, logStep, signal }),
  MINIOG_DOSSIER: ({ task, slack, store, config, logStep, signal }) =>
    runMiniogDossierWorkflow({ task, slack, store, config, logStep, signal }),
  DEPLOY: ({ task, config, slack, store, logStep, signal }) =>
    runDeployWorkflow({ task, config, slack, store, logStep, signal }),
};

function runImplementation({ task, config, slack, store, jobId, logStep, signal }: WorkflowRunnerContext) {
  return runImplementationWorkflow({
    task,
    config,
    slack,
    store,
    investigationStore: investigationStoreOf(store),
    jobId,
    logStep,
    signal,
  });
}

/** Posted when the tool-router fails twice on a direct mention, in place of a guess (issue #440). */
export const ROUTER_FAILED_REPLY =
  "I couldn't work out what you're asking. That's a failure on my side, not your message — please send it again.";

/** Intents routeTask can start a workflow for. */
export const ROUTED_INTENTS = Object.keys(WORKFLOW_RUNNERS) as WorkflowIntent[];

/** The intent classifier's call, as it ran before the tool-router could stand in for it. */
async function classifyWithLegacyClassifier(params: {
  task: NormalizedTask;
  userMessage: string;
  store: JobStore;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<IntentClassification> {
  const { task, userMessage, store, logStep, signal } = params;
  // Pass mentionType so the classifier knows if this is a direct @miniOG mention
  // or an indirect @theOG mention (owner-mention triggers should be filtered for relevance).
  const hasPrUrl = Boolean(task.prContext);
  let userDossierSummary: string | undefined;
  try {
    const dossier = store.dossierStore().getDossier(task.event.userId);
    if (dossier.profile || dossier.affinity.length > 0) {
      userDossierSummary = formatDossierForPrompt(dossier);
    }
  } catch (err) {
    logStep?.({
      stage: 'router.classify.dossier_lookup_failed',
      level: 'WARN',
      message: 'Failed to assemble dossier summary for classifier; continuing without it.',
      data: { error: (err as Error).message },
    });
  }
  return classifyWorkflowIntent({
    userMessage,
    threadContext: formatThreadContextForClassifier(task),
    hasPrUrl,
    mentionType: task.mentionType,
    userDossierSummary,
    logStep,
    signal,
  });
}

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep, signal } = params;
  let resolvedIntent: WorkflowIntent = task.intent;
  let classificationReasoning: string | undefined;

  // Resolve dossier-derived tone once at the router so every downstream
  // workflow that builds a mention system prompt can honor it without
  // each one re-querying the DB.
  let toneMode: ReturnType<typeof store.getPersonalityMode> = 'normal';
  if (task.event.userId) {
    try {
      toneMode = store.getPersonalityMode({
        channelId: task.event.channelId,
        userId: task.event.userId,
      });
    } catch {
      // tone lookup is advisory; default 'normal' on any failure
    }
  }

  let dossierRole: DossierRole | undefined;
  if (task.event.userId) {
    try {
      const dossier = store.dossierStore().getDossier(task.event.userId);
      dossierRole = dossier.profile?.role ?? undefined;
    } catch {
      // role lookup is advisory; leave undefined on any failure
    }
  }

  // Presence pings: cheap regex check, skip the AI classifier entirely.
  const userMessage = (task.event.text ?? '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // The tool-router's one call for this message (issue #456). In shadow mode it
  // only logs what it would have done and nothing here waits for it. In `on`
  // mode its decision is used below where the classifier's was, and nowhere else.
  const routerShadow = startRouterShadow({ task, userMessage, store, logStep, signal });
  let legacyDecidedBy: LegacyDecidedBy = 'gate';
  let decider = 'AI classifier';
  let routerCouldNotDecide = false;
  let routerDecision: RouterClassification | undefined;
  let clarify: ClarifyAction = { kind: 'run' };

  // PR_REVIEW can only be seeded pre-classifier by the deterministic gate
  // (isPrReviewRequest in intentParser.ts) — nothing else produces it before
  // this point. Skip the AI classifier entirely so a "review <PR URL>"
  // message routes identically whether the classifier CLI is healthy or
  // down (issue #334, bug B).
  if (task.intent === 'PR_REVIEW') {
    logStep?.({
      stage: 'router.pr_review.deterministic',
      message: 'Deterministic PR-review gate fired — skipping the AI classifier.',
      data: { userMessage, prCount: task.prContexts?.length ?? (task.prContext ? 1 : 0) },
    });
  }

  if (
    task.intent !== 'DEV_ASSIST' &&
    task.intent !== 'DEPLOY' &&
    task.intent !== 'MINIOG_DOSSIER' &&
    task.intent !== 'PR_REVIEW' &&
    task.intent !== 'WEBAPP_QA'
  ) {
    if (isPresencePing(userMessage)) {
      resolvedIntent = 'CONVERSATIONAL';
    } else if (
      looksLikeFixAffirmation(userMessage) &&
      typeof store?.investigationStore === 'function' &&
      store.investigationStore().getForThread(task.event.threadTs)
    ) {
      // Resume gate: investigationWorkflow prompts the user to reply with
      // "yes, fix it" to continue from saved findings, but a bare affirmation
      // gets classified as CONVERSATIONAL by the AI classifier — see RCA on
      // Slack thread p1779086230428739 (2026-05-18). When the message is an
      // anchored affirmation AND investigation_findings exist for this thread,
      // force IMPLEMENTATION (or OWNER_AUTOPILOT for owners) and skip the
      // classifier. implementationWorkflow.ts already consumes those findings
      // via investigationStore.getForThread.
      resolvedIntent = task.isOwnerAuthor ? 'OWNER_AUTOPILOT' : 'IMPLEMENTATION';
      legacyDecidedBy = 'resume_gate';
      logStep?.({
        stage: 'router.investigation.resume_gate',
        message:
          'Affirmation reply in a thread with pending investigation findings — resuming as ' + resolvedIntent + '.',
        data: { userMessage, threadTs: task.event.threadTs, resolvedIntent },
      });
    } else {
      // For all other intents, use AI to decide: the tool-router when it is on,
      // the intent classifier otherwise. Both return the same shape, and
      // everything below this call treats them identically.
      let classification: IntentClassification;
      if (routerShadow?.decides) {
        legacyDecidedBy = 'router';
        decider = 'Router';
        const decided = await routerShadow.asClassification();
        // An owner mention the router could not read stays unanswered, as before.
        routerCouldNotDecide = decided.failed && decided.intent !== 'NONE';
        routerDecision = decided;
        classification = decided;
      } else {
        legacyDecidedBy = 'classifier';
        classification = await classifyWithLegacyClassifier({ task, userMessage, store, logStep, signal });
      }
      classificationReasoning = classification.reasoning;

      // Confidence floor on DANGEROUS classifier downgrades. RCA (Slack thread
      // p1779086230428739, 2026-05-18) showed a 0.60-confidence
      // IMPLEMENTATION → CONVERSATIONAL reclassification of a bare "yes" — the
      // conversational workflow then hallucinated a "fix done" reply and the
      // user thought the bug was fixed.
      //
      // The original guard held ANY access-tier drop below the floor, but
      // access tier is the wrong axis: INVESTIGATION, INFORMATIONAL, and
      // CONVERSATIONAL all resolve to the `viewer` tier, so a safe downgrade to
      // a read-only ANSWER workflow was vetoed identically to the dangerous
      // hallucinating CHAT downgrade (#348 RC1). The real risk is whether the
      // PROPOSED workflow can act on / imply completion of work it didn't do.
      //
      // Rule (a pure relaxation of the old one — it never holds anything the
      // old guard accepted): hold the override only when it drops the access
      // tier AND confidence < floor AND the proposed workflow can claim
      // completion ('mutating' opens PRs/deploys/posts a verdict, or 'chat' is
      // free-form and has hallucinated "fix done"). Downgrades to a read-only
      // 'answer' workflow (INFORMATIONAL, INVESTIGATION, …) are honored at any
      // confidence — they only read and report. Upgrades/sideways are
      // unaffected (accessDropping is false for them).
      const originalRequiredLevel = resolveRequiredAccessLevel(task.intent);
      const proposedRequiredLevel = resolveRequiredAccessLevel(classification.intent);
      const accessDropping = ACCESS_RANK[proposedRequiredLevel] < ACCESS_RANK[originalRequiredLevel];
      const proposedSideEffect = workflowSideEffect(classification.intent);
      const proposedCanClaimCompletion = proposedSideEffect === 'mutating' || proposedSideEffect === 'chat';
      const lowConfidence = classification.confidence < CLASSIFIER_CONFIDENCE_FLOOR;
      // (Floor constant declared at module scope above for easy override in tests.)
      const holdOverride =
        classification.intent !== task.intent && accessDropping && proposedCanClaimCompletion && lowConfidence;

      // Where the router decided, a decision that should not be acted on as
      // given becomes one question to the requester, instead of the keyword
      // seed (the floor hold below) or a guess (issue #431).
      if (routerDecision?.tool && !routerDecision.failed) {
        clarify = decideClarify({
          tool: routerDecision.tool,
          confidence: routerDecision.confidence,
          question: routerDecision.question,
          addressing: task.mentionType === 'owner' ? 'owner_mention' : 'direct',
          answering: Boolean(task.clarification),
          heldByFloor: holdOverride,
          confidenceFloor: CLASSIFIER_CONFIDENCE_FLOOR,
        });
      }

      if (clarify.kind !== 'run') {
        logStep?.({
          stage: 'router.clarify.decided',
          message:
            clarify.kind === 'ask'
              ? `Not acting on the router's ${routerDecision?.tool} (${clarify.reason}) — asking the requester instead.`
              : clarify.kind === 'give_up'
                ? `The reply to the question is still unclear (${clarify.reason}) — not asking twice.`
                : 'The reply to the question asks for nothing — staying silent.',
          data: {
            action: clarify.kind,
            tool: routerDecision?.tool,
            confidence: routerDecision?.confidence,
            seedIntent: task.intent,
            answering: Boolean(task.clarification),
            reasoning: routerDecision?.reasoning,
          },
        });
        // Nothing runs, so the access check below is made at the lowest tier.
        resolvedIntent = clarify.kind === 'silent' ? 'NONE' : 'INFORMATIONAL';
      } else if (holdOverride) {
        logStep?.({
          stage: 'router.classify.low_confidence_hold',
          level: 'WARN',
          message:
            `${decider} proposed ${task.intent} → ${classification.intent} at ` +
            `confidence=${classification.confidence.toFixed(2)} (below ${CLASSIFIER_CONFIDENCE_FLOOR.toFixed(2)}); ` +
            `proposed workflow is ${proposedSideEffect} (can act on / imply completion of work) and drops access ` +
            `from ${originalRequiredLevel} to ${proposedRequiredLevel}. Holding original intent.`,
          data: {
            originalIntent: task.intent,
            classifiedIntent: classification.intent,
            confidence: classification.confidence,
            originalRequiredLevel,
            proposedRequiredLevel,
            proposedSideEffect,
            reasoning: classification.reasoning,
          },
        });
        resolvedIntent = task.intent;
      } else {
        if (classification.intent !== task.intent) {
          logStep?.({
            stage: 'router.classify.override',
            message: `${decider} resolved intent: ${task.intent} → ${classification.intent} (confidence=${classification.confidence.toFixed(2)}).`,
            data: {
              originalIntent: task.intent,
              classifiedIntent: classification.intent,
              confidence: classification.confidence,
              proposedSideEffect,
              // True when a sub-floor access-dropping override was accepted
              // *because* the proposed workflow is read-only (#348 RC1 change).
              acceptedLowConfidenceSafeDowngrade: accessDropping && lowConfidence && !proposedCanClaimCompletion,
              reasoning: classification.reasoning,
            },
          });
        }
        resolvedIntent = classification.intent;
      }
    }
  }

  const routedTask: NormalizedTask =
    resolvedIntent !== task.intent || toneMode !== task.toneMode || dossierRole !== task.dossierRole
      ? { ...task, intent: resolvedIntent, toneMode, dossierRole }
      : task;

  routerShadow?.compare({
    intent: resolvedIntent,
    decidedBy: legacyDecidedBy,
    ...(clarify.kind === 'ask'
      ? { did: 'asking the requester', ran: 'ASK_USER' }
      : clarify.kind === 'give_up'
        ? { did: 'not asking a second time', ran: 'GAVE_UP' }
        : {}),
  });

  // NONE = classifier determined this is human-to-human conversation, miniOG should stay silent
  if (resolvedIntent === 'NONE') {
    logStep?.({
      stage: 'router.silent',
      message:
        clarify.kind === 'silent'
          ? 'The reply to the question asked for nothing — staying silent.'
          : `${decider} returned NONE — staying silent for this human-to-human conversation.`,
      data: { reasoning: classificationReasoning },
    });
    return {
      workflow: 'NONE',
      status: 'SKIPPED',
      message: 'Staying silent — message is human-to-human conversation.',
      notifyDesktop: false,
      slackPosted: false,
    };
  }

  const accessControl = getConfiguredAccessControl(config);
  const requiredLevel = resolveRequiredAccessLevel(resolvedIntent);
  const accessDecision = evaluateAccess({
    config,
    accessControl,
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    requiredLevel,
  });

  if (!accessDecision.allowed) {
    const isDirectMessage = task.event.channelType === 'im' || task.event.channelType === 'mpim';
    const shouldBlock = accessControl.mode === 'enforce' || isDirectMessage;
    const stage =
      isDirectMessage && accessControl.mode === 'audit'
        ? 'access.dm.denied'
        : accessControl.mode === 'enforce'
          ? 'access.enforce.denied'
          : 'access.audit.would_deny';
    const message =
      isDirectMessage && accessControl.mode === 'audit'
        ? 'DMs and MPIMs are always enforced; blocked despite audit mode.'
        : accessControl.mode === 'enforce'
          ? 'Access control denied this request.'
          : 'Access control would deny this request, but audit mode allowed it to continue.';

    logStep?.({
      stage,
      message,
      level: shouldBlock ? 'INFO' : 'WARN',
      data: {
        intent: resolvedIntent,
        requiredLevel,
        userGroups: accessDecision.userGroups,
        matchedGroups: accessDecision.matchedGroups,
        denyReason: accessDecision.denyReason,
        userId: task.event.userId,
        channelId: task.event.channelId,
        channelType: task.event.channelType,
      },
    });

    if (shouldBlock) {
      const denialText = accessDecision.reason ?? "Sorry, you're not on the access list. Please contact an admin.";

      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: denialText,
      });

      return {
        workflow: resolvedIntent,
        status: 'SKIPPED',
        message: denialText,
        notifyDesktop: false,
        slackPosted: true,
      };
    }
  } else {
    logStep?.({
      stage: accessDecision.ownerBypass ? 'access.owner_bypass' : 'access.allowed',
      message: accessDecision.ownerBypass
        ? 'Owner bypass granted unrestricted access.'
        : 'Access control allowed this request.',
      data: {
        intent: resolvedIntent,
        requiredLevel,
        userGroups: accessDecision.userGroups,
        matchedGroups: accessDecision.matchedGroups,
        userId: task.event.userId,
        channelId: task.event.channelId,
      },
    });
  }

  // The router failed twice on a message addressed to miniOG. Say so instead of
  // answering it as a lookup: the requester cannot tell a lookup that describes
  // their change from one that made it (issue #440). Placed after the access
  // check, so someone who would be denied gets the denial and nothing else.
  if (routerCouldNotDecide) {
    logStep?.({
      stage: 'router.decision.failed',
      message: signal?.aborted
        ? 'Router call failed and the job was cancelled — ran nothing.'
        : 'Router could not decide after two calls — told the requester and ran nothing.',
      level: 'ERROR',
      data: { seedIntent: task.intent, userMessage },
    });
    if (!signal?.aborted) {
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: ROUTER_FAILED_REPLY,
      });
    }
    return {
      workflow: 'UNKNOWN',
      status: 'FAILED',
      message: 'The router could not decide what this message asks for (two failed calls); nothing was run.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }

  // One question to the requester, or (if this message already was the answer
  // to one) a line saying so. After the access check, like the reply above.
  if (clarify.kind === 'ask' || clarify.kind === 'give_up') {
    if (signal?.aborted) return cancelledResult('UNKNOWN');
    return clarify.kind === 'ask'
      ? askRequester({ slack, store, task, userMessage, question: clarify.question, reason: clarify.reason, logStep })
      : giveUpOnClarify({ slack, task, reason: clarify.reason, logStep });
  }

  const runWorkflow = WORKFLOW_RUNNERS[resolvedIntent];
  if (runWorkflow) {
    return runWorkflow({ task: routedTask, config, slack, store, jobId, logStep, signal });
  }

  // Check file-based workflow templates before falling through to unknown
  const templates = getWorkflowTemplates();
  if (templates.length > 0) {
    const matched = matchWorkflowTemplate(task.event.text, templates);
    if (matched) {
      logStep?.({
        stage: 'router.template_matched',
        message: `Matched file-based workflow template: ${matched.name}`,
        data: { templateName: matched.name },
      });

      return runTemplateWorkflow({ task: routedTask, config, slack, template: matched, logStep, signal });
    }
  }

  return runUnknownTaskWorkflow({ task: routedTask, config, slack, logStep });
}

async function runTemplateWorkflow(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  template: ReturnType<typeof getWorkflowTemplates>[number];
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const { task, config, slack, template, logStep, signal } = params;

  const prompt = renderPromptTemplate(template.promptTemplate, task, config);
  // Keep the historical cwd: host-authored templates may assume they run
  // inside the newton-web clone (relative paths, bare npm/git commands).
  // Templates that target another repo reference it via the absolute
  // {{repo_api}} / {{repo_marketing}} vars, which don't depend on cwd.
  const cwd = config.repoPaths.newtonWeb;

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: `Running workflow: ${template.name}`,
    })
    .catch(() => {});

  const githubToken = await resolveGithubTokenForCodex();
  const request: CodexRunRequest = {
    cwd,
    prompt,
    outputSchemaPath: path.resolve(process.cwd(), 'schemas/owner-autopilot-result.schema.json'),
    githubToken,
    ...highReasoningProfile(getActiveBackendId()),
    onLog: logStep,
    signal,
  };

  const result = await runCodex(request);

  const summary = result.parsedJson?.summary
    ? String(result.parsedJson.summary)
    : result.lastMessage || 'Workflow completed.';

  await slack.chat
    .postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: summary,
    })
    .catch(() => {});

  return {
    workflow: 'IMPLEMENTATION',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    message: summary,
    notifyDesktop: false,
    slackPosted: true,
    result: result.parsedJson ?? {},
  };
}
