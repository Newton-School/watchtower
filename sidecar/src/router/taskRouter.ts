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
import { runStagingDeployWorkflow } from '../workflows/stagingDeployWorkflow.js';
import { runImplementationWorkflow } from '../workflows/implementationWorkflow.js';
import { readPrActionAsk } from './prActionAsk.js';
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
import {
  LOW_CONFIDENCE_STAGING_QUESTION,
  askRequester,
  decideClarify,
  giveUpOnClarify,
  type ClarifyAction,
} from './routeClarify.js';
import { cancelledResult } from '../workflows/shared/cancelState.js';
import { cleanResetText, usageLimitReply } from '../codex/infraRetry.js';
import { channelDenialHint } from '../access/denialHint.js';
import { buildHelpReply, isHelpRequest } from './helpReply.js';
import { unsupportedReply } from './unsupportedReply.js';
import { isMarketingStagingDeployAsk, namesStagingAsTarget } from './intentParser.js';
import { isMarketingStagingAsk } from './stagingTarget.js';
import { acknowledgementText, pickupDelayMs } from './acknowledgement.js';
import { RESTART_EVENT_PREFIX } from '../runtime/restartRecovery.js';
import { looksLikeFixAffirmation } from './resumeIntentParser.js';
import { askKindOf, askTextOf, duplicateAskReply, mayCheckForDuplicate, resolveDuplicateAsk } from './duplicateAsk.js';
import { currentWork, noteAsk } from '../state/workLedger.js';
import { requesterOf } from '../workflows/shared/requester.js';

import { buildSlackThreadLink, isPresencePing } from '../workflows/shared/workflowUtils.js';

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
  DEPLOY: ({ task, config, slack, store, jobId, logStep, signal }) =>
    runDeployWorkflow({ task, config, slack, store, jobId, logStep, signal }),
  STAGING_DEPLOY: ({ task, config, slack, store, jobId, logStep, signal }) =>
    runStagingDeployWorkflow({ task, config, slack, store, jobId, logStep, signal }),
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
  deps?: {
    resolveMembership?: (userId: string) => Promise<WorkspaceMembership>;
    prOpen?: (prUrl: string) => Promise<boolean>;
  };
}): Promise<WorkflowResult> {
  const { task, config, slack, store, jobId, logStep, signal, onEngage, deps } = params;
  let resolvedIntent: WorkflowIntent = task.intent;
  // How late this pickup is, so slow pickups are measurable and said out loud (issue #588).
  const pickupDelay = pickupDelayMs(task.event.eventTs);
  logStep?.({
    stage: 'job.pickup_delay',
    message:
      pickupDelay === undefined
        ? 'Pickup delay unknown: the message time could not be read.'
        : `Picked up ${Math.round(pickupDelay / 1000)}s after the message was sent.`,
    data: { pickupDelayMs: pickupDelay ?? null },
  });
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
  /**
   * Addressed to miniOG (not in passing) and not seeded by an exact-syntax or
   * keyword gate: the only messages a fixed reply below may answer.
   */
  const directAsk =
    task.mentionType === 'bot' &&
    !task.mentionReference &&
    !['DEV_ASSIST', 'MINIOG_DOSSIER', 'PR_REVIEW', 'WEBAPP_QA', 'STAGING_DEPLOY'].includes(task.intent);
  /**
   * A bare "help": answered at once, for this person in this channel, with no
   * model run. A mention in passing ("<@owner> cc <@miniOG> help") is not one.
   */
  const helpRequested = directAsk && isHelpRequest(userMessage);
  /**
   * A message that is only "deploy marketing to staging": the staging tool
   * runs at once, with no model run (issue #702). Left to the router, it once
   * became a change_code question ("change something, or only look into it?").
   */
  const stagingAsked = directAsk && !helpRequested && isMarketingStagingDeployAsk(userMessage);
  /**
   * A message that is only an operation on one pull request ("merge it",
   * "sync <PR link>"): the change workflow's fast path runs it with no router
   * and no planner (issue #605). Left to the router, "sync <PR link>" once read
   * as a review and got a question instead (issue #719). Owner tags still go
   * to the router, which reads a merge asked of the owner as a review. A reply
   * that resumed a paused job without naming miniOG (anyone's "go ahead" after
   * a usage-limit pause) is not addressed to it: only the message that names
   * miniOG, a DM, or the answer to miniOG's own question opens this.
   */
  const addressedToMiniog =
    Boolean(task.clarification) ||
    (!task.resumedPausedJob &&
      ((task.event.text ?? '').includes(`<@${config.botUserId}`) || task.event.channelType === 'im'));
  const prActionAsk =
    directAsk && !helpRequested && !stagingAsked && addressedToMiniog
      ? readPrActionAsk(task, { botUserId: config.botUserId, ownerUserIds: config.ownerSlackUserIds })
      : undefined;
  // STAGING_DEPLOY is seeded only by an answer to the staging tool's "which
  // PR or branch?" (pausedResume.ts): nothing for a model to read.
  const routerShadow =
    helpRequested || stagingAsked || task.intent === 'STAGING_DEPLOY'
      ? undefined
      : startRouterShadow({ task, userMessage, reviewedPrInThread, logStep, signal });
  let legacyDecidedBy: LegacyDecidedBy = 'gate';
  let routerCouldNotDecide = false;
  /** Set when the router failed on the Claude usage limit: the reply then says when to come back. */
  let routerUsageLimit: { resetsAtText?: string } | undefined;
  let clarify: ClarifyAction = { kind: 'run' };
  /** Set when miniOG was asked directly for an action none of its tools reach: the reply to post. */
  let unsupportedText: string | undefined;

  // PR_REVIEW can only be seeded before this point by the deterministic gate
  // (isPrReviewRequest in intentParser.ts). It does not wait for the router,
  // so a "review <PR URL>" message routes identically whether the model CLI
  // is healthy or down (issue #334, bug B).
  if (task.intent === 'STAGING_DEPLOY') {
    logStep?.({
      stage: 'router.staging.answer',
      message: 'An answer to "which PR or branch?" — back to the staging tool, no model run.',
      data: { userMessage },
    });
  }
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
    task.intent !== 'WEBAPP_QA' &&
    task.intent !== 'STAGING_DEPLOY'
  ) {
    if (isPresencePing(userMessage)) {
      resolvedIntent = 'CONVERSATIONAL';
    } else if (helpRequested) {
      resolvedIntent = 'CONVERSATIONAL';
      logStep?.({
        stage: 'router.help_gate',
        message: 'A bare help request — answering with what miniOG can do here, no model run.',
        data: { userMessage },
      });
    } else if (stagingAsked) {
      resolvedIntent = 'STAGING_DEPLOY';
      logStep?.({
        stage: 'router.staging_gate',
        message: 'A marketing staging deploy ask — putting it on staging, no model run.',
        data: { userMessage },
      });
    } else if (prActionAsk) {
      // What the router's change_code runs as, so the fast path sees the same task.
      resolvedIntent = 'IMPLEMENTATION';
      logStep?.({
        stage: 'router.pr_action_gate',
        message: `Only "${prActionAsk.action}" on one pull request — straight to the quick action, no model run.`,
        data: { userMessage, action: prActionAsk.action, prUrl: prActionAsk.pr.url },
      });
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
      routerUsageLimit = classification.usageLimit;
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
      // The marketing site's staging ask: a `deploy` pick on it is the staging tool's (issue #702).
      // So is a reply to the router's own staging question ("yes" read as `deploy`).
      const marketingStagingAsk =
        isMarketingStagingAsk(task, config.allowedPrOrg) ||
        task.clarification?.question === LOW_CONFIDENCE_STAGING_QUESTION;
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
          stagingAsk: namesStagingAsTarget(task.event.text ?? ''),
          marketingStagingAsk,
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
      } else if (
        classification.tool === 'unsupported' &&
        addressingOf(task) === 'direct' &&
        classification.confidence >= CLASSIFIER_CONFIDENCE_FLOOR
      ) {
        // An action none of the tools reach (grant access, set a reminder):
        // said at once, instead of a lookup that takes minutes to say the same
        // (issue #606). Nothing runs, so access is checked at the lowest tier.
        // An owner mention or a mention in passing keeps its silence. Below the
        // floor the router may have missed something it could do: the lookup
        // runs as before, and reads the message itself.
        unsupportedText = unsupportedReply({ cannot: classification.cannot, whoCan: classification.whoCan });
        logStep?.({
          stage: 'router.unsupported',
          message:
            "Router chose unsupported — will say miniOG can't do this, with no agent run, if the requester may be answered.",
          data: {
            cannot: classification.cannot ?? null,
            whoCan: classification.whoCan ?? null,
            confidence: classification.confidence,
            reasoning: classification.reasoning,
            reply: unsupportedText,
          },
        });
        resolvedIntent = 'INFORMATIONAL';
      } else if (
        classification.tool === 'deploy' &&
        !classification.deployAllowed &&
        addressingOf(task) === 'direct' &&
        marketingStagingAsk
      ) {
        // The router read a marketing staging ask as a production deploy. Code
        // found no production target in it, and a lookup would only say "ask
        // me for a testing link": it is the staging tool's (issue #702).
        logStep?.({
          stage: 'router.deploy_to_staging',
          message: 'Router picked deploy for a marketing staging ask — running the staging tool instead.',
          data: { confidence: classification.confidence, reasoning: classification.reasoning },
        });
        resolvedIntent = 'STAGING_DEPLOY';
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
  // Only the gate's own decision lets the change workflow skip the planner and,
  // for the owner, the confirmation (issue #719).
  if (prActionAsk && resolvedIntent === 'IMPLEMENTATION') {
    routedTask = {
      ...routedTask,
      prActionGate: {
        action: prActionAsk.action,
        pr: prActionAsk.pr,
        ...(prActionAsk.intoBase ? { intoBase: prActionAsk.intoBase } : {}),
      },
    };
  } else if (routedTask.prActionGate) {
    routedTask = { ...routedTask, prActionGate: undefined };
  }

  routerShadow?.compare({
    intent: resolvedIntent,
    decidedBy: legacyDecidedBy,
    ...(clarify.kind === 'ask'
      ? { did: 'asking the requester', ran: 'ASK_USER' }
      : clarify.kind === 'give_up'
        ? { did: 'not asking a second time', ran: 'GAVE_UP' }
        : unsupportedText
          ? { did: "will say it can't do this, if allowed", ran: 'UNSUPPORTED' }
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
    userId: task.event.userId,
    channelId: task.event.channelId,
    channelType: task.event.channelType,
    requiredLevel,
    // An indirect owner-mention (the message tags @theOG, not @miniOG) may run
    // read-only (viewer-tier) workflows even from a non-allowlisted author.
    ownerMentioned: task.mentionType === 'owner',
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
      const baseDenial = accessDecision.reason ?? "Sorry, you're not on the access list. Please contact an admin.";
      // A channel that is not enabled for them: say where they can ask (issue #618).
      const hint =
        accessDecision.denyReason === 'CHANNEL_NOT_ENABLED'
          ? channelDenialHint({
              config,
              userId: task.event.userId,
              channelId: task.event.channelId,
              channelType: task.event.channelType,
              requiredLevel,
            })
          : undefined;
      const denialText = hint ? `${baseDenial}\n${hint.text}` : baseDenial;
      if (hint) {
        logStep?.({
          stage: 'access.denied.hint',
          message: `Told the requester where they can ask instead: ${hint.text}`,
          data: { channels: hint.channels, dm: hint.dm },
        });
      }
      await engage();

      // Indirect owner-mentions weren't sent to miniOG — they tagged @theOG in a
      // (likely human-to-human) thread. Don't barge in with an "access denied"
      // reply; stay silent like the NONE branch. Read-only intents are already
      // allowed above via the owner-mention grant, so this only covers
      // owner-mentioned write/elevated asks the author can't run. Direct
      // @miniOG mentions still get the deny reply.
      const silentForOwnerMention = task.mentionType === 'owner';
      if (!silentForOwnerMention) {
        await slack.chat.postMessage({
          channel: task.event.channelId,
          thread_ts: task.event.threadTs,
          text: denialText,
        });
      }

      return {
        workflow: resolvedIntent,
        status: 'SKIPPED',
        message: denialText,
        notifyDesktop: false,
        slackPosted: !silentForOwnerMention,
      };
    }
  } else if (accessDecision.allowed) {
    logStep?.({
      stage: accessDecision.ownerBypass
        ? 'access.owner_bypass'
        : accessDecision.ownerMentionGrant
          ? 'access.owner_mention_grant'
          : 'access.allowed',
      message: accessDecision.ownerBypass
        ? 'Owner bypass granted unrestricted access.'
        : accessDecision.ownerMentionGrant
          ? 'Owner was mentioned — granting read-only access for this request.'
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
    // "Send it again" is wrong when the account hit its usage limit: a retry
    // fails the same way until the reset. One requester sent the same lookup
    // three times on 19 Oct (issue #592).
    const replyText = routerUsageLimit
      ? usageLimitReply("work out what you're asking", routerUsageLimit.resetsAtText)
      : ROUTER_FAILED_REPLY;
    logStep?.({
      stage: routerUsageLimit ? 'router.decision.usage_limit' : 'router.decision.failed',
      message: signal?.aborted
        ? 'Router call failed and the job was cancelled — ran nothing.'
        : routerUsageLimit
          ? 'Router hit the Claude usage limit — told the requester when to come back and ran nothing.'
          : 'Router could not decide after two calls — told the requester and ran nothing.',
      level: 'ERROR',
      data: { seedIntent: task.intent, userMessage, usageLimit: routerUsageLimit ?? null },
    });
    if (!signal?.aborted) {
      await engage();
      await slack.chat.postMessage({
        channel: task.event.channelId,
        thread_ts: task.event.threadTs,
        text: replyText,
      });
    }
    return {
      workflow: 'UNKNOWN',
      status: 'FAILED',
      message: routerUsageLimit
        ? `The usage limit was hit while routing${routerUsageLimit.resetsAtText ? `; it resets at ${cleanResetText(routerUsageLimit.resetsAtText)}` : ''}. Nothing was run.`
        : 'The router could not decide what this message asks for (two failed calls); nothing was run.',
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
  if (helpRequested) {
    if (signal?.aborted) return cancelledResult('CONVERSATIONAL');
    const text = buildHelpReply({
      config,
      userId: task.event.userId,
      channelId: task.event.channelId,
      channelType: task.event.channelType,
      role: dossierRole,
    });
    await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text });
    return {
      workflow: 'CONVERSATIONAL',
      status: 'SUCCESS',
      message: 'Answered a help request with what miniOG can do here.',
      notifyDesktop: false,
      slackPosted: true,
    };
  }
  if (unsupportedText) {
    if (signal?.aborted) return cancelledResult('UNKNOWN');
    await slack.chat.postMessage({
      channel: task.event.channelId,
      thread_ts: task.event.threadTs,
      text: unsupportedText,
    });
    logStep?.({ stage: 'router.unsupported.replied', message: unsupportedText });
    return {
      workflow: 'UNKNOWN',
      status: 'SKIPPED',
      message: `Asked for something none of the tools do; said so and ran nothing: ${unsupportedText}`,
      notifyDesktop: false,
      slackPosted: true,
    };
  }
  const runWorkflow = WORKFLOW_RUNNERS[resolvedIntent];
  if (runWorkflow) {
    // The same ask sent again from another thread is pointed at the first one
    // instead of becoming a second plan and PR (issue #602).
    const askKind = askKindOf(resolvedIntent);
    if (askKind && !signal?.aborted && mayCheckForDuplicate(routedTask)) {
      const first = await resolveDuplicateAsk({
        task: routedTask,
        kind: askKind,
        jobId,
        work: currentWork(),
        prOpen: deps?.prOpen,
      });
      if (first && !signal?.aborted) {
        const text = duplicateAskReply(first, buildSlackThreadLink(first.channelId, first.threadTs));
        logStep?.({
          stage: 'router.duplicate_ask',
          message: `The same ${askKind === 'change' ? 'change' : 'question'} is already in hand in another thread — pointed there and ran nothing.`,
          data: {
            intent: resolvedIntent,
            firstJobId: first.jobId,
            firstChannelId: first.channelId,
            firstThreadTs: first.threadTs,
            firstPrUrl: first.prUrl ?? null,
          },
        });
        await slack.chat.postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text });
        return {
          workflow: resolvedIntent,
          status: 'SKIPPED',
          message: `Same request as job ${first.jobId}, already in hand in another thread.`,
          notifyDesktop: false,
          slackPosted: true,
        };
      }
    }
    if (askKind && jobId) {
      noteAsk({
        jobId,
        requesterId: requesterOf(routedTask),
        channelId: task.event.channelId,
        channelType: task.event.channelType,
        threadTs: task.event.threadTs,
        kind: askKind,
        text: askTextOf(routedTask),
        startedAtMs: Date.now(),
      });
    }
    // The first line the requester reads: what to expect, and an apology when
    // the pickup was late (issue #588). Never fatal, never for a cancelled job.
    const ack = acknowledgementText({
      intent: resolvedIntent,
      pickupDelayMs: pickupDelay,
      // Only a PR named in the message itself: one from earlier in the thread
      // does not make a new request a quick action, unless the message is
      // only an operation on it ("merge it", issue #605).
      aboutExistingPr:
        (routedTask.prContexts
          ? routedTask.prContexts.some(pr => pr.source === 'trigger')
          : Boolean(routedTask.prContext)) ||
        Boolean(readPrActionAsk(routedTask, { botUserId: config.botUserId, ownerUserIds: config.ownerSlackUserIds })),
      replayed: task.event.ingestSource === 'launchpad' || task.event.eventId.startsWith(RESTART_EVENT_PREFIX),
    });
    if (ack && !signal?.aborted) {
      // Not awaited: the run must not wait on a Slack round trip, and the
      // workflow's own first post is seconds away.
      void slack.chat
        .postMessage({ channel: task.event.channelId, thread_ts: task.event.threadTs, text: ack })
        .then(() => logStep?.({ stage: 'job.acknowledged', message: ack, data: { intent: resolvedIntent } }))
        .catch(error =>
          logStep?.({
            stage: 'job.acknowledge_failed',
            level: 'WARN',
            message: 'Could not post the opening line.',
            data: { error: String(error) },
          }),
        );
    }
    return runWorkflow({ task: routedTask, config, slack, store, jobId, logStep, signal });
  }

  return runUnknownTaskWorkflow({ task: routedTask, config, slack, logStep });
}
