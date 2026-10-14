import type { WebClient } from '@slack/web-api';
import type {
  AppConfig,
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
import {
  decideOwnerDelegation,
  isOwnerTagDelegationEnabled,
  isPureOwnerTag,
  ownerInThread,
  type OwnerDelegationDecision,
} from '../access/ownerDelegation.js';
import { resolveWorkspaceMembership, type WorkspaceMembership } from '../slack/workspaceMembership.js';
import { fetchThreadRepliesSince } from '../slack/threadContext.js';
import { runDevAssistWorkflow } from '../workflows/devAssistWorkflow.js';
import { runMiniogDossierWorkflow } from '../workflows/miniogDossierWorkflow.js';
import { runDeployWorkflow } from '../workflows/deployWorkflow.js';
import { runImplementationWorkflow } from '../workflows/implementationWorkflow.js';
import { runInvestigationWorkflow } from '../workflows/investigationWorkflow.js';
import { runAgenticEntry } from '../agentic/agenticEntry.js';
import { runAgenticPrReview } from '../agentic/agenticPrReview.js';
import { runUnknownTaskWorkflow } from '../workflows/unknownTaskWorkflow.js';
import {
  addressingOf,
  failedClassification,
  startRouterShadow,
  type LegacyDecidedBy,
  type RouterClassification,
} from './routerShadow.js';
import { askRequester, decideClarify, giveUpOnClarify, type ClarifyAction } from './routeClarify.js';
import { cancelledResult } from '../workflows/shared/cancelState.js';
import { looksLikeFixAffirmation } from './resumeIntentParser.js';

import { isPresencePing } from '../workflows/shared/workflowUtils.js';

// Confidence below which a decision is not acted on as given when it would
// drop the access tier of the default seed and could claim work was done. RCA
// on Slack thread p1779086230428739 (2026-05-18) caught a 0.60-confidence
// read of a bare "yes" as chat; the conversational workflow then hallucinated
// a "fix done" reply. Typical decisions run 0.85+, so 0.75 is a conservative
// floor. (The name is from the intent classifier this floor first guarded.)
export const CLASSIFIER_CONFIDENCE_FLOOR = 0.75;

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

/**
 * A run where miniOG stays out of a conversation between people: nothing is
 * posted, and intake leaves no reaction or status line (issue #398).
 */
function silentSkip(workflow: WorkflowIntent, message: string): WorkflowResult {
  return { workflow, status: 'SKIPPED', message, notifyDesktop: false, slackPosted: false };
}

// conversations.replies returns at most 200 messages per page, oldest first:
// a full intake page may be missing the newest replies, the owner's included.
const THREAD_PAGE_LIMIT = 200;

/** Posted when the tool-router fails twice on a direct mention, in place of a guess (issue #440). */
export const ROUTER_FAILED_REPLY =
  "I couldn't work out what you're asking. That's a failure on my side, not your message — please send it again.";

/** Intents routeTask can start a workflow for. */
export const ROUTED_INTENTS = Object.keys(WORKFLOW_RUNNERS) as WorkflowIntent[];

export async function routeTask(params: {
  task: NormalizedTask;
  config: AppConfig;
  slack: WebClient;
  store: JobStore;
  jobId?: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /**
   * Called once, right before miniOG says or runs anything. Intake holds back
   * its reaction and status line for a message that only tags an owner until
   * then, so a run that stays out of a conversation between people leaves no
   * trace in it (issue #398).
   */
  onEngage?: () => Promise<void> | void;
  /** Test seam. */
  deps?: { resolveMembership?: (userId: string) => Promise<WorkspaceMembership> };
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep, signal, onEngage, deps } = params;
  let resolvedIntent: WorkflowIntent = task.intent;
  let classificationReasoning: string | undefined;
  let engaged = false;
  const engage = async (): Promise<void> => {
    if (engaged) return;
    engaged = true;
    await onEngage?.();
  };
  // A message that tags an owner and not miniOG is written to a person.
  // miniOG handles it as the owner's assistant (issue #398).
  const pureOwnerTag = isPureOwnerTag(task) && isOwnerTagDelegationEnabled();

  // The owner is already in this thread, or answered before miniOG picked the
  // tag up: the owner has it. Checked before the router so standing down
  // costs no model call.
  if (pureOwnerTag && !task.isOwnerAuthor) {
    let thread = task.threadMessages ?? [];
    let presence = ownerInThread(thread, task.event.eventTs, config.ownerSlackUserIds);
    if (!presence.present && thread.length >= THREAD_PAGE_LIMIT) {
      try {
        thread = await fetchThreadRepliesSince(slack, task.event.channelId, task.event.threadTs, '0');
        presence = ownerInThread(thread, task.event.eventTs, config.ownerSlackUserIds);
      } catch {
        // The page we have is the best evidence left.
      }
    }
    if (presence.present) {
      logStep?.({
        stage: 'router.owner_tag.stand_down',
        message: 'An owner has already posted in this thread — staying out of the owner tag.',
        data: { ownerId: presence.ownerId, ownerMessageTs: presence.ts, tagTs: task.event.eventTs },
      });
      return silentSkip(task.intent, 'An owner is already in the thread — stood down.');
    }
  }

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

  // Mentions stripped: what the presence-ping check and the router read.
  const userMessage = (task.event.text ?? '')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // The tool-router's one call for this message (issue #456). Its decision is
  // used below wherever a keyword gate has not already settled the workflow;
  // for a gate-decided message nothing waits for it and it is only logged.
  // "Fixed all reviews" means "look again" only where miniOG already reviewed
  // a PR, and the thread text may not say so (issue #451).
  let reviewedPrInThread = false;
  try {
    reviewedPrInThread = Boolean(store.hasReviewedPrInThread?.(task.event.channelId, task.event.threadTs));
  } catch {
    // advisory: the router decides without it
  }
  const routerShadow = startRouterShadow({ task, userMessage, reviewedPrInThread, logStep, signal });
  let legacyDecidedBy: LegacyDecidedBy = 'gate';
  let routerCouldNotDecide = false;
  let clarify: ClarifyAction = { kind: 'run' };

  // PR_REVIEW can only be seeded before this point by the deterministic gate
  // (isPrReviewRequest in intentParser.ts). It does not wait for the router,
  // so a "review <PR URL>" message routes identically whether the model CLI
  // is healthy or down (issue #334, bug B).
  if (task.intent === 'PR_REVIEW') {
    logStep?.({
      stage: 'router.pr_review.deterministic',
      message: 'Deterministic PR-review gate fired — skipping the AI classifier.',
      data: { userMessage, prCount: task.prContexts?.length ?? (task.prContext ? 1 : 0) },
    });
  }

  // The seeds a keyword gate or exact syntax settles by itself. (A deploy is
  // no longer one of them: only the router, with code's agreement, starts one.)
  if (
    task.intent !== 'DEV_ASSIST' &&
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
      // reads as chat to a model — see RCA on Slack thread p1779086230428739
      // (2026-05-18). When the message is an anchored affirmation AND
      // investigation_findings exist for this thread, force IMPLEMENTATION
      // (or OWNER_AUTOPILOT for owners) without asking the router.
      // implementationWorkflow.ts already consumes those findings via
      // investigationStore.getForThread.
      resolvedIntent = task.isOwnerAuthor ? 'OWNER_AUTOPILOT' : 'IMPLEMENTATION';
      legacyDecidedBy = 'resume_gate';
      logStep?.({
        stage: 'router.investigation.resume_gate',
        message:
          'Affirmation reply in a thread with pending investigation findings — resuming as ' + resolvedIntent + '.',
        data: { userMessage, threadTs: task.event.threadTs, resolvedIntent },
      });
    } else {
      // Everything else is the tool-router's to decide. (It is always started
      // for a message that reaches here; the fallback keeps the types honest.)
      legacyDecidedBy = 'router';
      const classification: RouterClassification = routerShadow
        ? await routerShadow.asClassification()
        : failedClassification(addressingOf(task));
      // An owner mention the router could not read stays unanswered.
      routerCouldNotDecide = classification.failed && classification.intent !== 'NONE';
      classificationReasoning = classification.reasoning;

      // Confidence floor on DANGEROUS downgrades. RCA (Slack thread
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

      // A decision that should not be acted on as given becomes one question
      // to the requester, instead of the keyword seed or a guess (issue #431).
      if (classification.tool && !classification.failed) {
        clarify = decideClarify({
          tool: classification.tool,
          confidence: classification.confidence,
          question: classification.question,
          addressing: addressingOf(task),
          answering: Boolean(task.clarification),
          heldByFloor: holdOverride,
          confidenceFloor: CLASSIFIER_CONFIDENCE_FLOOR,
          deployAllowed: classification.deployAllowed,
        });
      }

      if (clarify.kind !== 'run') {
        logStep?.({
          stage: 'router.clarify.decided',
          message:
            clarify.kind === 'ask'
              ? `Not acting on the router's ${classification.tool} (${clarify.reason}) — asking the requester instead.`
              : clarify.kind === 'give_up'
                ? `The reply to the question is still unclear (${clarify.reason}) — not asking twice.`
                : 'The reply to the question asks for nothing — staying silent.',
          data: {
            action: clarify.kind,
            tool: classification.tool,
            confidence: classification.confidence,
            seedIntent: task.intent,
            answering: Boolean(task.clarification),
            reasoning: classification.reasoning,
          },
        });
        // Nothing runs, so the access check below is made at the lowest tier.
        // The exception offers to start the change pipeline, so it is checked
        // at that tier: no point asking someone who could not say yes.
        resolvedIntent =
          clarify.kind === 'silent'
            ? 'NONE'
            : clarify.kind === 'ask' && clarify.reason === 'owner_mention_change'
              ? classification.intent
              : 'INFORMATIONAL';
      } else if (holdOverride) {
        // The router was unsure and the message was not addressed to miniOG (a
        // direct address became a question above). The floor used to keep the
        // keyword seed here, and every mention is seeded as a change request:
        // a message that names miniOG in passing started the change pipeline.
        // Nobody asked miniOG for anything it is sure of, so nothing runs
        // (issue #448). A failed call never lands here: its fallback is a
        // lookup or silence, neither of which the floor holds.
        logStep?.({
          stage: 'router.unsure_in_passing',
          message:
            `Router proposed ${classification.tool ?? classification.intent} at ` +
            `confidence=${classification.confidence.toFixed(2)} (below ${CLASSIFIER_CONFIDENCE_FLOOR.toFixed(2)}) ` +
            'for a message not addressed to miniOG — staying silent.',
          data: {
            tool: classification.tool,
            confidence: classification.confidence,
            seedIntent: task.intent,
            addressing: addressingOf(task),
            reasoning: classification.reasoning,
          },
        });
        resolvedIntent = 'NONE';
      } else {
        if (classification.intent !== task.intent) {
          logStep?.({
            stage: 'router.classify.override',
            message: `Router resolved intent: ${task.intent} → ${classification.intent} (confidence=${classification.confidence.toFixed(2)}).`,
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

  let routedTask: NormalizedTask =
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
          : 'Router returned NONE — staying silent for this human-to-human conversation.',
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

  // Owner-tag delegation (issue #398). The requester fails their own check
  // but tagged an owner, or is answering a question miniOG asked on an
  // owner's authority. A full member of the workspace gets the owner's
  // authority; anyone else who only tagged a person gets silence, never an
  // access error. A direct mention keeps its three deny reasons and copy.
  let delegation: OwnerDelegationDecision = { kind: 'n/a' };
  if (!accessDecision.allowed && (pureOwnerTag || task.inheritedDelegationOwnerId)) {
    delegation = await decideOwnerDelegation({
      task,
      ownerIds: config.ownerSlackUserIds,
      resolveMembership: deps?.resolveMembership ?? (userId => resolveWorkspaceMembership({ slack, userId })),
    });
  }
  if (delegation.kind === 'delegate') {
    routedTask = { ...routedTask, delegatedByOwnerId: delegation.ownerId };
    logStep?.({
      stage: 'access.owner_delegated',
      message: `The requester lacks access on their own; handling it on <@${delegation.ownerId}>'s authority.`,
      data: {
        intent: resolvedIntent,
        requiredLevel,
        requesterUserId: task.event.userId,
        ownerId: delegation.ownerId,
        inherited: delegation.inherited,
        requesterDenyReason: accessDecision.denyReason,
        requesterGroups: accessDecision.userGroups,
        channelId: task.event.channelId,
      },
    });
  } else if (pureOwnerTag && !accessDecision.allowed) {
    logStep?.({
      stage: 'access.owner_tag.silent_deny',
      message: 'Owner tag from someone the owner’s authority cannot be lent to — staying silent.',
      data: {
        intent: resolvedIntent,
        requiredLevel,
        requesterUserId: task.event.userId,
        reason: delegation.kind === 'silent' ? delegation.reason : 'not_delegated',
        requesterDenyReason: accessDecision.denyReason,
        channelId: task.event.channelId,
        channelType: task.event.channelType,
      },
    });
    if (accessControl.mode === 'enforce') {
      return silentSkip(resolvedIntent, 'Owner tag not delegated — stayed silent.');
    }
  }

  if (!accessDecision.allowed && delegation.kind !== 'delegate') {
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
      await engage();

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
  } else if (accessDecision.allowed) {
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
      await engage();
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
    await engage();
    return clarify.kind === 'ask'
      ? askRequester({
          slack,
          store,
          task: routedTask,
          userMessage,
          question: clarify.question,
          reason: clarify.reason,
          park: clarify.park,
          logStep,
        })
      : giveUpOnClarify({ slack, task, reason: clarify.reason, logStep });
  }

  await engage();
  const runWorkflow = WORKFLOW_RUNNERS[resolvedIntent];
  if (runWorkflow) {
    return runWorkflow({ task: routedTask, config, slack, store, jobId, logStep, signal });
  }

  return runUnknownTaskWorkflow({ task: routedTask, config, slack, logStep });
}
