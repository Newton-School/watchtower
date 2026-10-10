import type { NormalizedTask, WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';
import { formatThreadContextForClassifier, isPresencePing } from '../workflows/shared/workflowUtils.js';
import type { IntentClassification } from './classifyIntent.js';
import { classifyDeployTarget, leadingDeployTarget } from './intentParser.js';
import {
  decideTool,
  mayDeploy,
  outcomeToLegacyIntent,
  readToolRouterMode,
  type RouterFacts,
  type RouterOutcome,
  type RouterTool,
} from './toolRouter.js';

/**
 * The tool-router's one call per routed mention (issue #456).
 *
 * In `shadow` mode it runs beside the legacy path and logs what it would have
 * done, without deciding anything: the log is the evidence for handing each
 * decision over. That call is detached. Nothing waits for it, its failure is
 * invisible to the job, and its result may land in the job's log after the
 * job has finished.
 *
 * In `on` mode the same call stands in for the intent classifier, and only
 * for it: a message a keyword gate already decided is still only shadowed.
 */

/** What settled the workflow that ran. */
export type LegacyDecidedBy = 'gate' | 'resume_gate' | 'classifier' | 'router';

/** Seeds reached by exact syntax; there is nothing for a router to decide. */
const EXACT_SYNTAX_SEEDS = new Set<WorkflowIntent>(['DEV_ASSIST', 'MINIOG_DOSSIER']);

const GATE_HINTS: Partial<Record<WorkflowIntent, string>> = {
  DEPLOY: 'deploy keywords matched',
  PR_REVIEW: 'review gate matched',
  WEBAPP_QA: 'QA gate matched',
};

/** How a message reached miniOG, in the router's terms. */
export function addressingOf(
  task: Pick<NormalizedTask, 'mentionType' | 'mentionReference'>,
): RouterFacts['addressing'] {
  if (task.mentionType === 'owner') return 'owner_mention';
  return task.mentionReference ? 'reference' : 'direct';
}

export function buildRouterFacts(task: NormalizedTask, userMessage: string): RouterFacts {
  const prs = task.prContexts ?? [];
  const inTrigger = prs.some(pr => pr.source === 'trigger');
  // With the router on the deploy keywords no longer seed DEPLOY, so the hint
  // is read from the message, as the gate read it. The target that can allow
  // a deploy is held to more: the message has to lead with the ask.
  const text = task.event.text ?? '';
  const deployTarget = leadingDeployTarget(text) ?? undefined;
  const hint = GATE_HINTS[task.intent] ?? (classifyDeployTarget(text) ? GATE_HINTS.DEPLOY : undefined);
  return {
    message: userMessage,
    addressing: addressingOf(task),
    threadContext: formatThreadContextForClassifier(task),
    prUrlInTrigger: inTrigger,
    prUrlInThread: prs.some(pr => pr.source === 'thread') || (!inTrigger && Boolean(task.prContext)),
    hints: hint ? [hint] : [],
    ...(task.clarification ? { answering: task.clarification } : {}),
    ...(deployTarget ? { deployTarget } : {}),
  };
}

/** What the router would run, in the legacy vocabulary where there is a word for it. */
export function routerWouldRun(outcome: RouterOutcome): string {
  if (!outcome.ok) return 'FAILED';
  switch (outcome.decision.tool) {
    case 'review_pr':
      return 'PR_REVIEW';
    case 'change_code':
      return 'IMPLEMENTATION';
    case 'investigate':
      return 'INVESTIGATION';
    case 'answer':
      return 'INFORMATIONAL';
    case 'chat':
      return 'CONVERSATIONAL';
    case 'stay_silent':
      return 'NONE';
    case 'deploy':
      return 'DEPLOY';
    case 'qa_webapp':
      return 'WEBAPP_QA';
    case 'ask_user':
      return 'ASK_USER';
    default:
      return 'UNSUPPORTED';
  }
}

const sameWorkflow = (legacy: WorkflowIntent, router: string): boolean =>
  (legacy === 'OWNER_AUTOPILOT' ? 'IMPLEMENTATION' : legacy) === router;

/** A router decision in the classifier's shape. */
export interface RouterClassification extends IntentClassification {
  /** The router could not decide, even on a second try. `intent` is then the low-risk fallback. */
  failed: boolean;
  /** What the router named, before it was mapped to an intent. Absent when it failed. */
  tool?: RouterTool;
  /** The question it wants put to the requester, for `ask_user`. */
  question?: string;
  /** For `deploy`: whether code agrees a deploy may start (`mayDeploy`). */
  deployAllowed?: boolean;
}

export interface RouterShadow {
  /** True in `on` mode: the router's decision is used where the classifier's was. */
  decides: boolean;
  /**
   * The router's decision in the shape the classifier returned, for the code
   * that consumed a classification. Waits for the call; never rejects.
   */
  asClassification(): Promise<RouterClassification>;
  /**
   * Call once a workflow is settled on. Logs what the router said; returns at once.
   * When what happened was not a workflow run, `did` says it in words and
   * `ran` names it in the router's vocabulary ("ASK_USER").
   */
  compare(legacy: { intent: WorkflowIntent; decidedBy: LegacyDecidedBy; did?: string; ran?: string }): void;
}

export function startRouterShadow(params: {
  task: NormalizedTask;
  userMessage: string;
  store: { getState?: (key: string) => string | undefined } | undefined;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  decide?: typeof decideTool;
}): RouterShadow | undefined {
  const { task, userMessage, store, logStep, signal } = params;
  const mode = readToolRouterMode(store);
  if (mode === 'legacy') return undefined;
  const decides = mode === 'on';
  // Shadowing with nowhere to log would be a call nobody reads.
  if (!decides && !logStep) return undefined;
  if (EXACT_SYNTAX_SEEDS.has(task.intent) || isPresencePing(userMessage)) return undefined;

  const facts = buildRouterFacts(task, userMessage);
  // A shadow call gets no logger: it must not move the Slack status line.
  const call = (): Promise<RouterOutcome> =>
    (params.decide ?? decideTool)({
      facts,
      signal,
      role: decides ? 'router' : 'router_shadow',
      ...(decides ? { logStep } : {}),
    }).catch((error): RouterOutcome => ({ ok: false, error: String(error), durationMs: 0 }));
  // A deciding call gets one more try: a failure here used to become a silent
  // lookup or silence (issue #440). A shadow call decides nothing, so it does not.
  const pending = decides
    ? call().then(first => {
        if (first.ok || signal?.aborted) return first;
        logStep?.({
          stage: 'router.decision.retry',
          message: 'Router call failed — trying once more.',
          level: 'WARN',
          data: { error: first.error, durationMs: first.durationMs },
        });
        return call();
      })
    : call();

  return {
    decides,
    async asClassification() {
      const outcome = await pending;
      const deployAllowed = mayDeploy(facts);
      const intent = outcomeToLegacyIntent(outcome, facts.addressing, { allowDeploy: deployAllowed });
      if (!outcome.ok) {
        logStep?.({
          stage: 'router.decision.fallback',
          message: `Router call failed twice — using ${intent} fallback.`,
          level: 'WARN',
          data: { error: outcome.error, durationMs: outcome.durationMs },
        });
        // The classifier's own fallbacks: a lookup for a direct ask, silence for an owner mention.
        return {
          intent,
          confidence: facts.addressing === 'owner_mention' ? 0.5 : 0,
          reasoning: `Router failed; using low-risk ${intent} fallback.`,
          failed: true,
        };
      }
      return {
        intent,
        confidence: outcome.decision.confidence,
        reasoning: outcome.decision.reason,
        failed: false,
        tool: outcome.decision.tool,
        question: outcome.decision.question,
        deployAllowed,
      };
    },
    compare(legacy) {
      if (!logStep) return;
      void pending
        .then(outcome => {
          const wouldRun = routerWouldRun(outcome);
          const agree = legacy.ran ? legacy.ran === wouldRun : sameWorkflow(legacy.intent, wouldRun);
          const routerDecided = legacy.decidedBy === 'router';
          logStep({
            stage: routerDecided ? 'router.decision' : 'router.shadow',
            message: routerDecided
              ? `Router chose ${outcome.ok ? outcome.decision.tool : 'nothing (the call failed)'}; ${legacy.did ?? `running ${legacy.intent}`}.`
              : `Router (shadow) would run ${wouldRun}; the legacy path ran ${legacy.intent} — ${agree ? 'agree' : 'differ'}.`,
            level: 'INFO',
            data: {
              mode,
              agree,
              legacySeed: task.intent,
              legacyIntent: legacy.intent,
              legacyDecidedBy: legacy.decidedBy,
              routerWouldRun: wouldRun,
              // What the router would be allowed to run in place of the classifier today.
              routerAsClassifier: outcomeToLegacyIntent(outcome, facts.addressing, { allowDeploy: mayDeploy(facts) }),
              ...(outcome.ok
                ? {
                    tool: outcome.decision.tool,
                    confidence: outcome.decision.confidence,
                    reason: outcome.decision.reason,
                    question: outcome.decision.question,
                  }
                : { error: outcome.error }),
              durationMs: outcome.durationMs,
              addressing: facts.addressing,
            },
          });
        })
        .catch(() => {});
    },
  };
}
