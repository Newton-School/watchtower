import type { WorkflowSideEffect } from '../access/control.js';
import type { AccessLevel, Capability, WorkflowIntent } from '../types/contracts.js';

/**
 * What miniOG can do, as tools (issue #456).
 *
 * Each tool is still carried out by one of the existing workflows, named by
 * its legacy intent: `jobs.workflow`, the access tiers, the logs and the
 * pause/resume code all speak intents, and none of that changes here. What
 * this adds is one place that says, for each tool, what it needs and what it
 * can do, instead of three `switch` statements and an `if` chain that had to
 * be kept in step by hand.
 */
export type ToolId =
  | 'review_pr'
  | 'change_code'
  | 'investigate'
  | 'answer'
  | 'chat'
  | 'qa_webapp'
  | 'deploy'
  | 'dev_assist'
  | 'dossier'
  | 'stay_silent';

export interface ToolSpec {
  id: ToolId;
  /** Legacy intents that run this tool. */
  intents: readonly WorkflowIntent[];
  /** Capability the requester must hold. */
  capability: Capability;
  /** Legacy access tier, until the tiers are retired in favour of capabilities. */
  requiredLevel: AccessLevel;
  /** Whether the tool can act on, or imply completion of, work. */
  sideEffect: WorkflowSideEffect;
  /** Cannot be taken back once started: needs an explicit ask and a confirmation. */
  irreversible: boolean;
  /**
   * Whether the router's model may pick it. Tools reached only by exact
   * syntax (`wt …`, dossier subcommands) or by a dedicated gate stay false.
   */
  routerSelectable: boolean;
  /** One line for the router: when this is the right tool. */
  description: string;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'review_pr',
    intents: ['PR_REVIEW'],
    capability: 'submit_pr_review',
    requiredLevel: 'reviewer',
    sideEffect: 'mutating',
    irreversible: false,
    routerSelectable: true,
    description: 'Review a GitHub pull request and post the findings on it.',
  },
  {
    id: 'change_code',
    intents: ['IMPLEMENTATION', 'OWNER_AUTOPILOT'],
    capability: 'start_implementation',
    requiredLevel: 'builder',
    sideEffect: 'mutating',
    irreversible: false,
    routerSelectable: true,
    description: 'Build, change or fix something in a repository, through a plan an admin approves.',
  },
  {
    id: 'investigate',
    intents: ['INVESTIGATION'],
    capability: 'investigate',
    requiredLevel: 'viewer',
    sideEffect: 'answer',
    irreversible: false,
    routerSelectable: true,
    description: 'Diagnose a reported problem and report the cause, without changing anything.',
  },
  {
    id: 'answer',
    intents: ['INFORMATIONAL'],
    capability: 'query_codebase',
    requiredLevel: 'viewer',
    sideEffect: 'answer',
    irreversible: false,
    routerSelectable: true,
    description: 'Answer a question by reading the code and the data. Read-only.',
  },
  {
    id: 'chat',
    intents: ['CONVERSATIONAL'],
    capability: 'chat',
    requiredLevel: 'viewer',
    sideEffect: 'chat',
    irreversible: false,
    routerSelectable: true,
    description: 'Reply to a greeting, thanks or small talk.',
  },
  {
    id: 'qa_webapp',
    intents: ['WEBAPP_QA'],
    capability: 'start_implementation',
    requiredLevel: 'builder',
    // QA reports findings against a running app; it cannot imply code shipped.
    sideEffect: 'answer',
    irreversible: false,
    routerSelectable: false,
    description: 'Test a running web app, or a pull request, in a browser and report what was found.',
  },
  {
    id: 'deploy',
    intents: ['DEPLOY'],
    capability: 'deploy_prod',
    requiredLevel: 'admin',
    sideEffect: 'mutating',
    irreversible: true,
    routerSelectable: false,
    description: 'Deploy an application to production.',
  },
  {
    id: 'dev_assist',
    intents: ['DEV_ASSIST'],
    capability: 'dev_assist',
    requiredLevel: 'admin',
    sideEffect: 'answer',
    irreversible: false,
    routerSelectable: false,
    description: 'Operator commands: status, queue, errors, settings.',
  },
  {
    id: 'dossier',
    intents: ['MINIOG_DOSSIER'],
    capability: 'miniog_dossier_self',
    requiredLevel: 'viewer',
    sideEffect: 'answer',
    irreversible: false,
    routerSelectable: false,
    description: 'What miniOG remembers about a person: show, add, forget.',
  },
  {
    id: 'stay_silent',
    intents: ['NONE'],
    capability: 'query_codebase',
    requiredLevel: 'viewer',
    sideEffect: 'none',
    irreversible: false,
    routerSelectable: true,
    description: 'Say nothing: the message is people talking to each other, not a request.',
  },
];

const TOOL_BY_INTENT = new Map<WorkflowIntent, ToolSpec>(
  TOOLS.flatMap(tool => tool.intents.map(intent => [intent, tool] as const)),
);

/** The tool an intent runs, or undefined for an intent that names no tool (`UNKNOWN`). */
export function toolForIntent(intent: WorkflowIntent): ToolSpec | undefined {
  return TOOL_BY_INTENT.get(intent);
}

/** Intents that have a workflow to run. `NONE` is a decision to do nothing. */
export const RUNNABLE_INTENTS: readonly WorkflowIntent[] = TOOLS.filter(tool => tool.id !== 'stay_silent').flatMap(
  tool => tool.intents,
);
