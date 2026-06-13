import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { extractEntities, gatherRepoSignals } from './repoClassifier.js';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * Where a bug investigation should look:
 * - 'newton-web': a frontend/UI symptom — investigate the web repo only
 * - 'newton-api': a backend/data symptom — investigate the api repo only
 * - 'broad': can't localize from the report — sweep both repos + Metabase
 */
export type InvestigationScope = 'newton-web' | 'newton-api' | 'broad';

export interface InvestigationScopeResult {
  scope: InvestigationScope;
  confidence: number;
  reasoning: string;
  /** How the scope was decided — useful for RCA. */
  method: 'grep' | 'llm' | 'fallback';
}

const SCOPE_PROMPT = `You are a bug-triage classifier for a developer assistant. Given a bug report, decide WHERE the bug most likely originates so the right codebase(s) get investigated. You have NO repo access — classify purely from the report and thread context.

The two codebases:
- newton-web: the React/TypeScript FRONTEND. Owns rendering, layout, styling, client-side state, routing, form/interaction behaviour, what the user sees and clicks.
- newton-api: the Django/Python BACKEND. Owns API endpoints, business logic, server-side computation, and the data returned to the frontend.

Classify the bug into exactly one scope:
- "newton-web": a frontend symptom — something renders wrong, a button/modal/layout misbehaves, a client-side interaction is broken, a console error in the browser, wrong UI copy/state. The data arriving looks fine; the UI handling of it is suspect.
- "newton-api": a backend/data symptom — the data itself is wrong or missing, an API returns an error or bad payload, a computed value is incorrect, a server 500, something that smells like the database/query/business-logic layer.
- "broad": you cannot confidently localize it — the report is vague (just a screenshot/URL/"X is broken"), OR the symptom is a frontend display of data that could be wrong at any layer (frontend rendering vs API payload vs underlying data). When a frontend symptom could plausibly be caused by bad backend data, prefer "broad" so the full stack (newton-web + newton-api + the database) is inspected.

When genuinely unsure, prefer "broad" — a wider investigation is cheap; missing the real layer is expensive.

Return strict JSON:
{
  "scope": "newton-web" | "newton-api" | "broad",
  "confidence": number between 0 and 1,
  "reasoning": "one sentence explaining why"
}`;

const FALLBACK: InvestigationScopeResult = {
  scope: 'broad',
  confidence: 0,
  reasoning: 'Scope classifier unavailable — defaulting to a broad (full-stack) investigation.',
  method: 'fallback',
};

const SCOPES: InvestigationScope[] = ['newton-web', 'newton-api', 'broad'];

/**
 * Decide which repo(s) / sources a bug investigation should cover. A
 * deterministic entity-grep pre-check (reused from repoClassifier) short-
 * circuits when a distinctive identifier from the report lives in exactly one
 * repo; otherwise a lightweight LLM classifies the symptom locus. Failure
 * falls back to 'broad' so an investigation is never silently narrowed on a
 * classifier outage.
 */
export async function classifyInvestigationScope(params: {
  bugReport: string;
  threadMessages?: string[];
  webPath?: string;
  apiPath?: string;
  logStep?: WorkflowStepLogger;
}): Promise<InvestigationScopeResult> {
  const { bugReport, threadMessages = [], webPath, apiPath, logStep } = params;

  // 1. Deterministic grep short-circuit: if a distinctive identifier from the
  //    report matches exactly one repo, that's a strong locus signal — skip
  //    the LLM (mirrors repoClassifier's grep short-circuit).
  if (webPath || apiPath) {
    const entities = extractEntities(`${bugReport}\n${threadMessages.join('\n')}`);
    const signals = gatherRepoSignals({ entities, webPath, apiPath });
    const webOnly = signals.webHittingEntities.length > 0 && signals.apiHittingEntities.length === 0;
    const apiOnly = signals.apiHittingEntities.length > 0 && signals.webHittingEntities.length === 0;
    if ((webOnly || apiOnly) && signals.hasDistinctiveHit) {
      const scope: InvestigationScope = webOnly ? 'newton-web' : 'newton-api';
      const hits = webOnly ? signals.webHittingEntities : signals.apiHittingEntities;
      const result: InvestigationScopeResult = {
        scope,
        confidence: 0.9,
        reasoning: `Deterministic grep: ${hits.slice(0, 3).join(', ')}${hits.length > 3 ? '…' : ''} matched only in ${scope}.`,
        method: 'grep',
      };
      logStep?.({
        stage: 'investigation.scope.classified',
        message: `Investigation scope: ${scope} (grep, confidence ${result.confidence}).`,
        data: { ...result },
      });
      return result;
    }
  }

  // 2. LLM classification.
  try {
    const profile = lightweightProfile(getActiveBackendId());
    const threadBlock = threadMessages.length > 0 ? `\n\nThread context:\n${threadMessages.join('\n')}` : '';
    const result = await runCodex({
      cwd: os.tmpdir(),
      prompt: `${SCOPE_PROMPT}\n\nBug report:\n"${bugReport}"${threadBlock}\n\nClassify this bug.`,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 30_000,
    });

    if (!result.ok || !result.parsedJson) {
      logStep?.({
        stage: 'investigation.scope.fallback',
        message: 'Scope classifier call failed — defaulting to broad.',
        level: 'WARN',
        data: { ok: result.ok, exitCode: result.exitCode },
      });
      return FALLBACK;
    }

    const raw = result.parsedJson as { scope?: unknown; confidence?: unknown; reasoning?: unknown };
    const scope = SCOPES.includes(raw.scope as InvestigationScope) ? (raw.scope as InvestigationScope) : 'broad';
    const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';
    const classification: InvestigationScopeResult = { scope, confidence, reasoning, method: 'llm' };

    logStep?.({
      stage: 'investigation.scope.classified',
      message: `Investigation scope: ${scope} (llm, confidence ${confidence.toFixed(2)}).`,
      data: { ...classification },
    });
    return classification;
  } catch (error) {
    logStep?.({
      stage: 'investigation.scope.fallback',
      message: `Scope classifier threw — defaulting to broad: ${String(error)}`,
      level: 'WARN',
    });
    return FALLBACK;
  }
}
