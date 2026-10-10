import type { NormalizedTask, WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';
import { formatThreadContextForClassifier, isPresencePing } from '../workflows/shared/workflowUtils.js';
import type { IntentClassification } from './classifyIntent.js';
import {
  decideTool,
  outcomeToLegacyIntent,
  readToolRouterMode,
  type RouterFacts,
  type RouterOutcome,
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

export function buildRouterFacts(task: NormalizedTask, userMessage: string): RouterFacts {
  const prs = task.prContexts ?? [];
  const inTrigger = prs.some(pr => pr.source === 'trigger');
  const hint = GATE_HINTS[task.intent];
  return {
    message: userMessage,
    addressing: task.mentionType === 'owner' ? 'owner_mention' : 'direct',
    threadContext: formatThreadContextForClassifier(task),
    prUrlInTrigger: inTrigger,
    prUrlInThread: prs.some(pr => pr.source === 'thread') || (!inTrigger && Boolean(task.prContext)),
    hints: hint ? [hint] : [],
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

export interface RouterShadow {
  /** True in `on` mode: the router's decision is used where the classifier's was. */
  decides: boolean;
  /**
   * The router's decision in the shape the classifier returned, for the code
   * that consumed a classification. Waits for the call; never rejects.
   */
  asClassification(): Promise<IntentClassification>;
  /** Call once a workflow is settled on. Logs what the router said; returns at once. */
  compare(legacy: { intent: WorkflowIntent; decidedBy: LegacyDecidedBy }): void;
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
  const pending = (params.decide ?? decideTool)({
    facts,
    signal,
    role: decides ? 'router' : 'router_shadow',
    ...(decides ? { logStep } : {}),
  }).catch((error): RouterOutcome => ({ ok: false, error: String(error), durationMs: 0 }));

  return {
    decides,
    async asClassification() {
      const outcome = await pending;
      const intent = outcomeToLegacyIntent(outcome, facts.addressing);
      if (!outcome.ok) {
        logStep?.({
          stage: 'router.decision.fallback',
          message: `Router call failed — using ${intent} fallback.`,
          level: 'WARN',
          data: { error: outcome.error, durationMs: outcome.durationMs },
        });
        // The classifier's own fallbacks: a lookup for a direct ask, silence for an owner mention.
        return {
          intent,
          confidence: facts.addressing === 'owner_mention' ? 0.5 : 0,
          reasoning: `Router failed; using low-risk ${intent} fallback.`,
        };
      }
      return { intent, confidence: outcome.decision.confidence, reasoning: outcome.decision.reason };
    },
    compare(legacy) {
      if (!logStep) return;
      void pending
        .then(outcome => {
          const wouldRun = routerWouldRun(outcome);
          const agree = sameWorkflow(legacy.intent, wouldRun);
          const routerDecided = legacy.decidedBy === 'router';
          logStep({
            stage: routerDecided ? 'router.decision' : 'router.shadow',
            message: routerDecided
              ? `Router chose ${outcome.ok ? outcome.decision.tool : 'nothing (the call failed)'}; running ${legacy.intent}.`
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
              routerAsClassifier: outcomeToLegacyIntent(outcome, facts.addressing),
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
