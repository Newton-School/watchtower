import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { withAgentCallContext } from '../state/runContext.js';
import type { WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';
import { TOOLS, type ToolId } from './toolRegistry.js';

/**
 * The tool-router's decision (issue #456): one call that reads a message
 * addressed to miniOG and names the tool that should handle it.
 *
 * It replaces the five-class intent classifier. The differences that matter:
 * it can say "ask the person" or "none of my tools do this" instead of
 * forcing every message into a workflow, and it reports deploy and QA asks
 * as what they are, so the keyword gates that decide those today can be
 * checked against it before they are retired.
 *
 * This module only decides. What may be done with a decision is policy, and
 * lives outside the prompt.
 */

/** Tools the model can name. The registry's tools, plus the two non-actions. */
export type RouterTool = ToolId | 'ask_user' | 'unsupported';

export interface RouterDecision {
  tool: RouterTool;
  confidence: number;
  reason: string;
  /** For `ask_user`: the one question to put to the requester. */
  question?: string;
}

export interface RouterFacts {
  /** The trigger message, mentions removed. */
  message: string;
  /** `direct`: @miniOG or a DM. `owner_mention`: the message tags the owner, not the bot. */
  addressing: 'direct' | 'owner_mention';
  threadContext?: string;
  prUrlInTrigger: boolean;
  prUrlInThread: boolean;
  /** Keyword matches from the legacy gates, as hints. Never decisions. */
  hints: string[];
  userDossierSummary?: string;
}

export type RouterOutcome =
  | { ok: true; decision: RouterDecision; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/** Tools named in the prompt: every registry tool except the exact-syntax ones. */
const PROMPT_TOOLS: ReadonlyArray<{ id: RouterTool; description: string }> = [
  ...TOOLS.filter(tool => tool.id !== 'dev_assist' && tool.id !== 'dossier').map(tool => ({
    id: tool.id as RouterTool,
    description: tool.description,
  })),
  {
    id: 'ask_user',
    description:
      'You cannot tell what is being asked, or the message has no task in it. Put one short question in "question".',
  },
  {
    id: 'unsupported',
    description: 'A clear request for something none of these tools do (file a ticket, schedule a meeting).',
  },
];

const VALID_TOOLS = new Set<string>(PROMPT_TOOLS.map(tool => tool.id));

const RULES = `Rules:
- Decide from what this message asks for. Thread context explains it; it is not the request.
- A link is not a request. A pull-request link with a question about it ("is this merged?", "what does this change?") is answer. review_pr needs the person to ask for a review, or to post the link with nothing else.
- change_code needs both an instruction to build, change, fix, add or remove something and something to act on: an error, a file, a function, a failing request, or a specific change.
- A problem report with no instruction and nothing to act on, or a vague "fix it", is investigate. Between change_code and investigate, prefer investigate.
- A question about how something works, where something is, or what happened is answer. A question about a dashboard or query (a Metabase link) is answer.
- A request to merge, close or create a pull request is change_code.
- deploy only when this message itself tells you to deploy to production now. Words like "deploy", "release" or "ship" in a description, a plan, a question or a link are not that.
- qa_webapp only when the person asks you to test or QA a running app or a pull request in a browser.
- A message with nothing to act on ("no", "check now", "cc", a bare "yes" with no pending question) is ask_user, not a guess.
- stay_silent is only for a message that tags the owner while people talk to each other. A message addressed to you directly is never stay_silent.`;

export function buildRouterPrompt(facts: RouterFacts): string {
  const tools = PROMPT_TOOLS.map(tool => `- ${tool.id}: ${tool.description}`).join('\n');
  const lines = [
    'You route one Slack message for miniOG, a developer assistant bot, to exactly one tool.',
    'You have no access to any codebase. Decide from the message and the context below only.',
    '',
    'Tools:',
    tools,
    '',
    RULES,
    '',
    'Return strict JSON and nothing else:',
    '{ "tool": one of the tool names above, "confidence": number between 0 and 1, "reason": "one sentence", "question": "only for ask_user" }',
  ];
  if (facts.userDossierSummary) {
    lines.push('', 'About the requester (from past activity; weigh this message above it):', facts.userDossierSummary);
  }
  lines.push(
    '',
    `Addressed: ${facts.addressing === 'direct' ? 'directly to miniOG' : 'to the owner, not to miniOG (people may be talking to each other)'}`,
    `Pull-request link in this message: ${facts.prUrlInTrigger ? 'yes' : 'no'}`,
    `Pull-request link earlier in the thread: ${facts.prUrlInThread ? 'yes' : 'no'}`,
  );
  if (facts.hints.length > 0) {
    lines.push(`Keyword hints (may be coincidence): ${facts.hints.join(', ')}`);
  }
  if (facts.threadContext) {
    lines.push('', 'Thread so far:', facts.threadContext);
  }
  lines.push('', `Message: "${facts.message}"`);
  return lines.join('\n');
}

/** Validates what the model returned. Anything that is not a known tool is no decision. */
export function parseRouterDecision(raw: unknown): RouterDecision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.tool !== 'string' || !VALID_TOOLS.has(record.tool)) return undefined;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0.5;
  const question = typeof record.question === 'string' && record.question.trim() ? record.question.trim() : undefined;
  return {
    tool: record.tool as RouterTool,
    confidence,
    reason: typeof record.reason === 'string' ? record.reason : '',
    ...(record.tool === 'ask_user' && question ? { question } : {}),
  };
}

export async function decideTool(params: {
  facts: RouterFacts;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
  /** Role recorded against the call's cost. */
  role?: string;
  runAgent?: typeof runCodex;
}): Promise<RouterOutcome> {
  const { facts, logStep, signal } = params;
  const runAgent = params.runAgent ?? runCodex;
  const startedAt = Date.now();
  try {
    const profile = lightweightProfile(getActiveBackendId());
    const result = await withAgentCallContext({ role: params.role ?? 'router' }, () =>
      runAgent({
        cwd: os.tmpdir(),
        noTools: true,
        prompt: buildRouterPrompt(facts),
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
        timeoutMs: 45_000,
        onLog: logStep,
        signal,
      }),
    );
    const durationMs = Date.now() - startedAt;
    if (!result.ok || !result.parsedJson) {
      return { ok: false, error: `router call failed (exit ${result.exitCode})`, durationMs };
    }
    const decision = parseRouterDecision(result.parsedJson);
    if (!decision) {
      return { ok: false, error: 'router returned no valid tool', durationMs };
    }
    return { ok: true, decision, durationMs };
  } catch (error) {
    return { ok: false, error: String(error), durationMs: Date.now() - startedAt };
  }
}

/**
 * The intent the legacy path would act on for a router outcome. This is the
 * parity mapping: it reproduces what the classifier could return and nothing
 * more, so the router can stand in for the classifier without changing what
 * runs. Decisions the classifier had no way to express (ask, unsupported,
 * deploy, QA) fall back exactly as an invalid classification did.
 */
export function outcomeToLegacyIntent(outcome: RouterOutcome, addressing: RouterFacts['addressing']): WorkflowIntent {
  const fallback: WorkflowIntent = addressing === 'owner_mention' ? 'NONE' : 'INFORMATIONAL';
  if (!outcome.ok) return fallback;
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
      // Only an owner mention may be met with silence.
      return addressing === 'owner_mention' ? 'NONE' : fallback;
    default:
      return fallback;
  }
}

export type ToolRouterMode = 'legacy' | 'shadow' | 'on';

/** `sidecar_state` key. Read per job, so it can be changed without a rebuild. */
export const TOOL_ROUTER_MODE_KEY = 'tool_router_mode';

/**
 * How the router takes part. `shadow` (the default) runs it beside the legacy
 * path and logs what it would have done; `legacy` turns it off. `on` is
 * reserved for the change that lets it decide, and behaves as `shadow` until then.
 */
export function readToolRouterMode(
  store: { getState?: (key: string) => string | undefined } | undefined,
): ToolRouterMode {
  let raw: string | undefined;
  try {
    raw = typeof store?.getState === 'function' ? store.getState(TOOL_ROUTER_MODE_KEY) : undefined;
  } catch {
    raw = undefined;
  }
  return raw === 'legacy' || raw === 'on' ? raw : 'shadow';
}
