import type { NormalizedTask, WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';
import { formatThreadContextForClassifier, isPresencePing } from '../workflows/shared/workflowUtils.js';
import { classifyDeployTarget, leadingDeployTarget } from './intentParser.js';
import {
  decideTool,
  mayDeploy,
  outcomeToLegacyIntent,
  type RouterFacts,
  type RouterOutcome,
  type RouterTool,
} from './toolRouter.js';

/**
 * The tool-router's one call per routed mention (issue #456).
 *
 * It decides what a message asks for wherever a keyword gate did not. The
 * gates that remain (an explicit review ask, a QA ask, the exact-syntax
 * commands) still settle their workflow from the wording alone; for a
 * gate-decided message the same call runs detached and only logs what the
 * router would have chosen beside what the gate chose (`router.shadow`).
 * Nothing waits for that call, and its result may land in the job's log
 * after the job has finished. That log is the evidence for handing a gate
 * over.
 *
 * The file and several names here date from when the router ran beside an
 * intent classifier (`shadow`) before replacing it (`on`). The classifier and
 * the mode switch are gone; the names and the log fields were kept so rows
 * written before and after read the same.
 */

/** What settled the workflow that ran. */
export type LegacyDecidedBy = 'gate' | 'resume_gate' | 'router';

/** Seeds reached by exact syntax; there is nothing for a router to decide. */
const EXACT_SYNTAX_SEEDS = new Set<WorkflowIntent>(['DEV_ASSIST', 'MINIOG_DOSSIER']);

const GATE_HINTS: Partial<Record<WorkflowIntent, string>> = {
  PR_REVIEW: 'review gate matched',
  WEBAPP_QA: 'QA gate matched',
};
const DEPLOY_KEYWORDS_HINT = 'deploy keywords matched';

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
  // The deploy keywords do not seed a workflow; they are a hint, read from the
  // message as the old gate read it. The target that can allow a deploy is
  // held to more: the message has to lead with the ask.
  const text = task.event.text ?? '';
  const deployTarget = leadingDeployTarget(text) ?? undefined;
  const hint = GATE_HINTS[task.intent] ?? (classifyDeployTarget(text) ? DEPLOY_KEYWORDS_HINT : undefined);
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

/** A router decision, mapped to the workflow intent it runs as. */
export interface RouterClassification {
  intent: WorkflowIntent;
  confidence: number;
  reasoning: string;
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
  /** The router's decision as a workflow intent. Waits for the call; never rejects. */
  asClassification(): Promise<RouterClassification>;
  /**
   * Call once a workflow is settled on. Logs what the router said; returns at once.
   * When what happened was not a workflow run, `did` says it in words and
   * `ran` names it in the router's vocabulary ("ASK_USER").
   */
  compare(legacy: { intent: WorkflowIntent; decidedBy: LegacyDecidedBy; did?: string; ran?: string }): void;
}

/** The decision used when the router cannot be asked or fails twice: never more than a lookup. */
export function failedClassification(addressing: RouterFacts['addressing']): RouterClassification {
  const intent = outcomeToLegacyIntent({ ok: false, error: 'router unavailable', durationMs: 0 }, addressing);
  return {
    intent,
    // A lookup for a direct ask, silence for anything else.
    confidence: addressing === 'owner_mention' ? 0.5 : 0,
    reasoning: `Router failed; using low-risk ${intent} fallback.`,
    failed: true,
  };
}

export function startRouterShadow(params: {
  task: NormalizedTask;
  userMessage: string;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  decide?: typeof decideTool;
}): RouterShadow | undefined {
  const { task, userMessage, logStep, signal } = params;
  // Exact syntax and presence pings need no model to read them.
  if (EXACT_SYNTAX_SEEDS.has(task.intent) || isPresencePing(userMessage)) return undefined;

  const facts = buildRouterFacts(task, userMessage);
  const call = (): Promise<RouterOutcome> =>
    (params.decide ?? decideTool)({ facts, signal, role: 'router', logStep }).catch(
      (error): RouterOutcome => ({ ok: false, error: String(error), durationMs: 0 }),
    );
  // One more try: a failure here used to become a silent lookup or silence (issue #440).
  const pending = call().then(first => {
    if (first.ok || signal?.aborted) return first;
    logStep?.({
      stage: 'router.decision.retry',
      message: 'Router call failed — trying once more.',
      level: 'WARN',
      data: { error: first.error, durationMs: first.durationMs },
    });
    return call();
  });

  return {
    async asClassification() {
      const outcome = await pending;
      const deployAllowed = mayDeploy(facts);
      if (!outcome.ok) {
        const fallback = failedClassification(facts.addressing);
        logStep?.({
          stage: 'router.decision.fallback',
          message: `Router call failed twice — using ${fallback.intent} fallback.`,
          level: 'WARN',
          data: { error: outcome.error, durationMs: outcome.durationMs },
        });
        return fallback;
      }
      return {
        intent: outcomeToLegacyIntent(outcome, facts.addressing, { allowDeploy: deployAllowed }),
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
              : `Router (shadow) would run ${wouldRun}; the ${legacy.decidedBy === 'gate' ? 'keyword gate' : 'resume gate'} ran ${legacy.intent} — ${agree ? 'agree' : 'differ'}.`,
            level: 'INFO',
            data: {
              // Constant since the mode switch was removed; kept so old and new rows filter alike.
              mode: 'on',
              agree,
              legacySeed: task.intent,
              legacyIntent: legacy.intent,
              legacyDecidedBy: legacy.decidedBy,
              routerWouldRun: wouldRun,
              // The intent the router's choice maps to (a deploy only where code allows one).
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
