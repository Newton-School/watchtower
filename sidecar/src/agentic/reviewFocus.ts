import os from 'node:os';
import type { WorkflowStepLogger } from '../types/contracts.js';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { withAgentCallContext } from '../state/runContext.js';

/**
 * First-class user focus for PR review. Previously an instruction like
 * "focus on the migration" reached the reviewers only as ambient text inside
 * the flattened thread block, and the lens rubrics overrode it. This module
 * extracts it into a dedicated USER FOCUS prompt section that every review
 * prompt (orchestrator, lenses, one-shot) renders above the thread context.
 *
 * Two layers:
 * - a deterministic floor (always): the trigger text minus the bot mention and
 *   PR URLs, quoted verbatim — zero cost, zero failure modes;
 * - a conditional lightweight model pass (only for longer threads, where a
 *   directive can be buried mid-thread) that extracts focus areas. Fails open
 *   to the deterministic floor.
 */

const FOCUS_MODEL_THREAD_THRESHOLD = 2;
const FOCUS_TIMEOUT_MS = 60_000;
const MIN_INSTRUCTION_CHARS = 15;

export const FOCUS_PROMPT_MARKER = 'focus extractor';

/** Trigger text minus Slack mentions and PR URLs — the verbatim instruction. */
function deterministicInstruction(triggerText: string): string | undefined {
  const stripped = triggerText
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .replace(/<https?:\/\/[^>|\s]+(?:\|[^>]*)?>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > MIN_INSTRUCTION_CHARS ? stripped : undefined;
}

function renderFocusBlock(instruction: string | undefined, focusAreas: string[]): string {
  const bullets: string[] = [];
  if (instruction) bullets.push(`Requester's instruction: "${instruction}"`);
  for (const area of focusAreas) {
    if (!bullets.some(existing => existing.toLowerCase().includes(area.toLowerCase()))) bullets.push(area);
  }
  if (bullets.length === 0) return '';
  return [
    'USER FOCUS — the requester asked for specific attention:',
    ...bullets.map(bullet => `- ${bullet}`),
    'Address these explicitly; findings in these areas take priority.',
  ].join('\n');
}

/**
 * Extract the requester's focus for this review. Never throws; the model pass
 * fails open to the deterministic floor. Returns `focusBlock: ''` when there
 * is nothing meaningful — callers render nothing in that case.
 */
export async function extractUserFocus(params: {
  triggerText: string;
  threadTexts: string[];
  runAgent?: typeof runCodex;
  logStep?: WorkflowStepLogger;
  signal?: AbortSignal;
}): Promise<{ focusBlock: string }> {
  const { triggerText, threadTexts, logStep, signal } = params;
  const runAgent = params.runAgent ?? runCodex;
  const instruction = deterministicInstruction(triggerText);

  let focusAreas: string[] = [];
  if (threadTexts.length > FOCUS_MODEL_THREAD_THRESHOLD && !signal?.aborted) {
    try {
      const profile = lightweightProfile(getActiveBackendId());
      const result = await withAgentCallContext({ role: 'focus' }, () =>
        runAgent({
          cwd: os.tmpdir(),
          prompt: buildFocusPrompt(triggerText, threadTexts),
          model: profile.model,
          reasoningEffort: profile.reasoningEffort,
          timeoutMs: FOCUS_TIMEOUT_MS,
          onLog: logStep,
          signal,
        }),
      );
      if (result.ok && result.parsedJson && Array.isArray(result.parsedJson.focusAreas)) {
        focusAreas = result.parsedJson.focusAreas
          .filter((area): area is string => typeof area === 'string' && area.trim().length > 0)
          .map(area => area.trim())
          .slice(0, 5);
      }
    } catch (error) {
      logStep?.({
        stage: 'agentic.pr_review.focus.failed',
        level: 'WARN',
        message: `Focus extraction failed (${String(error)}) — using the trigger text alone.`,
        data: {},
      });
    }
  }

  const focusBlock = renderFocusBlock(instruction, focusAreas);
  if (focusBlock) {
    logStep?.({
      stage: 'agentic.pr_review.focus.extracted',
      message: 'Extracted user focus for the review.',
      data: { hasInstruction: Boolean(instruction), focusAreas },
    });
  }
  return { focusBlock };
}

function buildFocusPrompt(triggerText: string, threadTexts: string[]): string {
  return `You are a PR-review ${FOCUS_PROMPT_MARKER}. A user asked a bot to review a PR inside a Slack thread.
Extract any SPECIFIC review instructions the requester gave — areas, files, or concerns they want the
review to prioritize (e.g. "focus on the migration", "check the auth changes carefully").

Trigger message:
${triggerText}

Thread (oldest first):
${threadTexts.join('\n---\n')}

Only extract explicit requester instructions about what the review should focus on — not general
chatter, not the PR content itself. An empty list is the correct answer when there are none.

Reply with ONLY this JSON object (no prose, no code fences):
{ "focusAreas": ["<short instruction>", ...] }`;
}
