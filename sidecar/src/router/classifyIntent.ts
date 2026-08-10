import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import type { WorkflowIntent, WorkflowStepLogger } from '../types/contracts.js';

export interface IntentClassification {
  intent: WorkflowIntent;
  confidence: number;
  reasoning: string;
}

const CLASSIFY_PROMPT_BASE = `You are a workflow intent classifier for a developer productivity bot called miniOG. Your ONLY job is to classify what workflow should handle the user's message.

You have NO access to any codebase. Classify based purely on the user's message and thread context.

Available workflows:
- PR_REVIEW: The user wants a code review of a GitHub pull request. Signals: they link a PR URL, ask to "review" code changes, request feedback on a pull request, or paste a GitHub PR link with an implicit request to look at it.
- IMPLEMENTATION: The user wants something built, changed, fixed, added, removed, or modified, and has given enough signal to act: they used a concrete code-change verb ("fix", "add", "implement", "change", "update", "remove", "build", "make", "write", "refactor", "migrate", "set up", "configure", "enable", "disable") AND the message contains at least one anchor — a specific error message, stack trace, failing endpoint/payload, file path, function name, or a clear reproduction step.
- INVESTIGATION: The user wants miniOG to diagnose or look into a problem without committing to a fix yet. Signals: verbs like "check", "look into", "investigate", "debug", "why is X broken", "what's wrong with Y", "something's off with Z"; or a bug report whose only evidence is a screenshot/screen recording/URL with no console error, no reproduction steps, and no imperative code-change verb. Vague "fix it" requests without any technical anchor (no error text, no file scope, no failing request) are INVESTIGATION, not IMPLEMENTATION — miniOG should first look, report findings, then ask whether to fix.
- INFORMATIONAL: The user is asking a question, wants an explanation, or wants to understand something. Keywords like "how does", "what is", "explain", "describe", "list", "show me", "where is", "why does", "check status", "tell me about", "can you explain".
- CONVERSATIONAL: Greetings, banter, presence checks, casual chat, thanks. Keywords like "hi", "hello", "thanks", "how are you", "you there", "good morning", "what's up".

Classification rules:
- If the message contains a GitHub PR URL (github.com/.../pull/...) AND the user's intent is to get that PR reviewed → PR_REVIEW
- If the message contains a GitHub PR URL but the user is asking to CREATE, FIX, or MERGE a PR → IMPLEMENTATION
- If the user asks a question or wants to understand something → INFORMATIONAL
- If the user is just chatting, greeting, or thanking → CONVERSATIONAL
- If the user wants something fixed/built/changed AND supplies a concrete anchor (error text, stack trace, file path, function name, failing request, reproduction step) → IMPLEMENTATION.
- If the user wants something "checked", "investigated", "debugged", or reports a bug with only a screenshot/URL/video and no technical anchor → INVESTIGATION.
- If the message contains a Metabase URL (e.g. \`metabase.com\`, or self-hosted instances whose hostname starts with \`metabase\` — paths like \`/question\`, \`/dashboard\`, \`/model\`) and asks to explain, describe, or understand a table/query/dashboard/column → INFORMATIONAL with HIGH confidence (≥ 0.85). miniOG cannot edit Metabase content, so these are almost never IMPLEMENTATION. Only classify as IMPLEMENTATION if the user explicitly asks to write or change *code* that uses this query/table.
- When in doubt between IMPLEMENTATION and INVESTIGATION, prefer INVESTIGATION — confirming a diagnosis is cheap, shipping a bad fix is expensive.
- When in doubt between INVESTIGATION and INFORMATIONAL, prefer INVESTIGATION if the user is reporting a problem with observed behaviour; prefer INFORMATIONAL if the user is just asking how something works.`;

const OWNER_MENTION_ADDENDUM = `
IMPORTANT — INDIRECT MENTION CONTEXT:
This message was NOT sent directly to miniOG. It was detected because the team owner (@theOG) was mentioned. The message might be a human-to-human conversation where the owner was tagged — NOT a request for AI assistance.

Additional option:
- NONE: The message is a human-to-human conversation that does not need AI involvement. The owner was mentioned as part of normal team communication (status updates, FYIs, discussions, tagging for awareness, meeting coordination, etc.). miniOG should stay silent.

Rules for NONE:
- If people are discussing among themselves and just tagged the owner for visibility/awareness → NONE
- If the message is an FYI, status update, or team coordination that doesn't ask the AI to do anything → NONE
- If the message mentions the owner alongside other humans and is clearly a group conversation → NONE
- Only classify as a workflow (IMPLEMENTATION, INFORMATIONAL, etc.) if the message is clearly asking for AI assistance — e.g., explicitly asking miniOG to do something, or asking a technical question that an AI should answer.
- When in doubt for indirect mentions, prefer NONE (better to stay silent than interrupt a human conversation).`;

function buildClassifyUserPrompt(params: {
  userMessage: string;
  threadContext?: string;
  hasPrUrl: boolean;
  mentionType: 'bot' | 'owner' | 'none';
}): string {
  const lines = [`User message: "${params.userMessage}"`];
  lines.push(`Contains GitHub PR URL: ${params.hasPrUrl}`);
  lines.push(
    `Mention type: ${params.mentionType === 'bot' ? 'direct bot mention (@miniOG)' : 'indirect owner mention (@theOG)'}`,
  );
  if (params.threadContext) {
    lines.push(`\nThread context:\n${params.threadContext}`);
  }
  lines.push('\nClassify this message.');
  return lines.join('\n');
}

// Fall back to INFORMATIONAL (viewer-level read-only access) instead of IMPLEMENTATION
// (builder-level write access) when classification fails. Previously a transient classifier
// outage could deny a viewer's read-only question in a DM, or escalate it into the
// implementation workflow in a channel where they had only viewer/reviewer access.
// INFORMATIONAL keeps the request answerable in the same surfaces without granting
// privileges the user did not intend to invoke.
const SAFE_FALLBACK: IntentClassification = {
  intent: 'INFORMATIONAL',
  confidence: 0,
  reasoning: 'Classifier failed; using low-risk INFORMATIONAL fallback.',
};

const SILENT_FALLBACK: IntentClassification = {
  intent: 'NONE',
  confidence: 0.5,
  reasoning: 'Classification failed for indirect mention — defaulting to NONE to avoid interrupting.',
};

export async function classifyWorkflowIntent(params: {
  userMessage: string;
  threadContext?: string;
  hasPrUrl: boolean;
  mentionType?: 'bot' | 'owner' | 'none';
  /**
   * Optional per-user dossier summary (from formatDossierForPrompt). Injected
   * as advisory context — the classifier is told to weight the current message
   * above this when deciding intent.
   */
  userDossierSummary?: string;
  logStep?: WorkflowStepLogger;
}): Promise<IntentClassification> {
  const { userMessage, threadContext, hasPrUrl, mentionType = 'bot', userDossierSummary, logStep } = params;
  const isIndirectMention = mentionType === 'owner';

  logStep?.({
    stage: 'router.classify.start',
    message: 'Running AI-based workflow intent classification.',
    data: { userMessage, hasPrUrl, mentionType },
  });

  try {
    const prompt = isIndirectMention ? `${CLASSIFY_PROMPT_BASE}\n${OWNER_MENTION_ADDENDUM}` : CLASSIFY_PROMPT_BASE;

    const returnFormat = isIndirectMention
      ? `\nReturn strict JSON:\n{\n  "intent": "PR_REVIEW" | "IMPLEMENTATION" | "INVESTIGATION" | "INFORMATIONAL" | "CONVERSATIONAL" | "NONE",\n  "confidence": number between 0 and 1,\n  "reasoning": "one sentence explaining why"\n}`
      : `\nReturn strict JSON:\n{\n  "intent": "PR_REVIEW" | "IMPLEMENTATION" | "INVESTIGATION" | "INFORMATIONAL" | "CONVERSATIONAL",\n  "confidence": number between 0 and 1,\n  "reasoning": "one sentence explaining why"\n}`;

    const dossierBlock = userDossierSummary
      ? `\n\nUser context (from past activity, advisory only — weight the current message above this):\n${userDossierSummary}\n`
      : '';

    const fullPrompt = `${prompt}${returnFormat}${dossierBlock}\n\n${buildClassifyUserPrompt({ userMessage, threadContext, hasPrUrl, mentionType })}`;
    const profile = lightweightProfile(getActiveBackendId());

    const result = await runCodex({
      cwd: os.tmpdir(),
      prompt: fullPrompt,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 45_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep?.({
        stage: 'router.classify.fallback',
        message: `Classification AI call failed — using ${isIndirectMention ? 'NONE' : 'INFORMATIONAL'} fallback.`,
        level: 'WARN',
        data: {
          ok: result.ok,
          exitCode: result.exitCode,
          parsedJson: Boolean(result.parsedJson),
        },
      });
      return isIndirectMention ? SILENT_FALLBACK : SAFE_FALLBACK;
    }

    const raw = result.parsedJson;
    const validIntents: WorkflowIntent[] = isIndirectMention
      ? ['PR_REVIEW', 'IMPLEMENTATION', 'INVESTIGATION', 'INFORMATIONAL', 'CONVERSATIONAL', 'NONE']
      : ['PR_REVIEW', 'IMPLEMENTATION', 'INVESTIGATION', 'INFORMATIONAL', 'CONVERSATIONAL'];

    const fallbackIntent = isIndirectMention ? 'NONE' : 'INFORMATIONAL';
    const intent = validIntents.includes(raw.intent as WorkflowIntent)
      ? (raw.intent as WorkflowIntent)
      : fallbackIntent;

    const confidence = typeof raw.confidence === 'number' ? raw.confidence : 0.5;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

    const classification: IntentClassification = { intent, confidence, reasoning };

    logStep?.({
      stage: 'router.classify.done',
      message: `Classified workflow intent as ${intent} (confidence=${confidence.toFixed(2)}).`,
      data: { ...classification },
    });

    return classification;
  } catch (error) {
    logStep?.({
      stage: 'router.classify.error',
      message: `Classification threw unexpectedly — using ${isIndirectMention ? 'NONE' : 'INFORMATIONAL'} fallback: ${String(error)}`,
      level: 'WARN',
    });
    return isIndirectMention ? SILENT_FALLBACK : SAFE_FALLBACK;
  }
}
