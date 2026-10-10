import type { NormalizedTask, WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';
import { formatThreadContextForClassifier, isPresencePing } from '../workflows/shared/workflowUtils.js';
import {
  decideTool,
  outcomeToLegacyIntent,
  readToolRouterMode,
  type RouterFacts,
  type RouterOutcome,
} from './toolRouter.js';

/**
 * Shadow mode for the tool-router (issue #456): run it beside the legacy
 * path on real mentions and log what it would have done, without letting it
 * decide anything. The log is the evidence for handing each decision over.
 *
 * The call is detached. Nothing waits for it, its failure is invisible to the
 * job, and its result may land in the job's log after the job has finished.
 */

/** How the legacy path arrived at the workflow it ran. */
export type LegacyDecidedBy = 'gate' | 'resume_gate' | 'classifier';

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
  /** Call once the legacy path has settled on a workflow. Returns at once. */
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
  if (mode === 'legacy' || !logStep) return undefined;
  if (EXACT_SYNTAX_SEEDS.has(task.intent) || isPresencePing(userMessage)) return undefined;

  const facts = buildRouterFacts(task, userMessage);
  const pending = (params.decide ?? decideTool)({ facts, signal, role: 'router_shadow' }).catch(
    (error): RouterOutcome => ({ ok: false, error: String(error), durationMs: 0 }),
  );

  return {
    compare(legacy) {
      void pending
        .then(outcome => {
          const wouldRun = routerWouldRun(outcome);
          const agree = sameWorkflow(legacy.intent, wouldRun);
          logStep({
            stage: 'router.shadow',
            message: `Router (shadow) would run ${wouldRun}; the legacy path ran ${legacy.intent} — ${agree ? 'agree' : 'differ'}.`,
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
