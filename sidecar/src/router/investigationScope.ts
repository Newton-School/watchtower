import os from 'node:os';
import { runCodex, getActiveBackendId } from '../codex/runCodex.js';
import { lightweightProfile } from '../codex/modelProfiles.js';
import { extractEntities, gatherRepoSignals } from './repoClassifier.js';
import { REPO_KEYS, type RepoKey } from '../repos/registry.js';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * Where a bug investigation should look:
 * - a repo key: the symptom localizes to that repo — investigate it only
 * - 'broad': can't localize from the report — sweep the PRODUCT stack
 *   (newton-web + newton-api + Metabase). newton-marketing-web is
 *   deliberately excluded from 'broad': the marketing site is a static
 *   export with no newton-api/Metabase coupling, so sweeping it on every
 *   vague product bug adds pure noise. Marketing scope is explicit-only.
 */
export type InvestigationScope = RepoKey | 'broad';

export interface InvestigationScopeResult {
  scope: InvestigationScope;
  confidence: number;
  reasoning: string;
  /** How the scope was decided — useful for RCA. */
  method: 'grep' | 'llm' | 'fallback';
}

const MARKETING_SCOPE_BLOCKS = {
  codebase: `- newton-marketing-web: the PUBLIC MARKETING site (Next.js static export behind a Cloudflare Worker). Owns newtonschool.co landing/marketing pages migrated from Webflow, their SEO/meta, and their images. It never reads from newton-api.`,
  scope: `- "newton-marketing-web": a symptom with an explicit PUBLIC-SITE signal — a bare/www newtonschool.co URL, or strong marketing vocabulary (Webflow/cutover, "-temp" page, wrangler/Cloudflare worker, image rehost/CloudFront, marketing site). The marketing site is a static export and never reads from newton-api — a marketing-page bug does NOT need the backend or "broad". CAUTION: "landing page", the homepage, and NSAT/NST pages exist in BOTH frontends (marketing owns the public admission landing pages; newton-web owns the logged-in NSAT timeline/test flows) — those nouns alone are NOT a public-site signal. Logged-in my.newtonschool.co symptoms are newton-web; when torn between the two frontends with no public-site signal, prefer "newton-web".`,
} as const;

function buildScopePrompt(marketingEnabled: boolean): string {
  return `You are a bug-triage classifier for a developer assistant. Given a bug report, decide WHERE the bug most likely originates so the right codebase(s) get investigated. You have NO repo access — classify purely from the report and thread context.

The codebases:
- newton-web: the React/JavaScript PRODUCT frontend (the logged-in app at my.newtonschool.co). Owns rendering, layout, styling, client-side state, routing, form/interaction behaviour, what the user sees and clicks in the product.
- newton-api: the Django/Python BACKEND. Owns API endpoints, business logic, server-side computation, and the data returned to the frontend.
${marketingEnabled ? MARKETING_SCOPE_BLOCKS.codebase : ''}

Classify the bug into exactly one scope:
- "newton-web": a product-frontend symptom — something renders wrong, a button/modal/layout misbehaves, a client-side interaction is broken, a console error in the browser, wrong UI copy/state. The data arriving looks fine; the UI handling of it is suspect.
- "newton-api": a backend/data symptom — the data itself is wrong or missing, an API returns an error or bad payload, a computed value is incorrect, a server 500, something that smells like the database/query/business-logic layer.
${marketingEnabled ? MARKETING_SCOPE_BLOCKS.scope : ''}
- "broad": you cannot confidently localize it — the report is vague (just a screenshot/URL/"X is broken"), OR the symptom is a frontend display of data that could be wrong at any layer (frontend rendering vs API payload vs underlying data). When a product-frontend symptom could plausibly be caused by bad backend data, prefer "broad" so the full product stack (newton-web + newton-api + the database) is inspected.${marketingEnabled ? ' "broad" covers the PRODUCT stack only — never pick it for a marketing-page symptom.' : ''}

When genuinely unsure, prefer "broad" — a wider investigation is cheap; missing the real layer is expensive.

Return strict JSON:
{
  "scope": ${marketingEnabled ? '"newton-web" | "newton-api" | "newton-marketing-web" | "broad"' : '"newton-web" | "newton-api" | "broad"'},
  "confidence": number between 0 and 1,
  "reasoning": "one sentence explaining why"
}`;
}

const FALLBACK: InvestigationScopeResult = {
  scope: 'broad',
  confidence: 0,
  reasoning: 'Scope classifier unavailable — defaulting to a broad (full-stack) investigation.',
  method: 'fallback',
};

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
  /** Configured repo checkouts to grep — from enabledRepoPaths(config). */
  repoGrepPaths?: Array<{ key: RepoKey; path: string }>;
  logStep?: WorkflowStepLogger;
}): Promise<InvestigationScopeResult> {
  const { bugReport, threadMessages = [], repoGrepPaths = [], logStep } = params;
  // Without grep paths (callers that only want the LLM verdict) assume the
  // two always-required repos — marketing stays opt-in.
  const enabledKeys: RepoKey[] =
    repoGrepPaths.length > 0 ? repoGrepPaths.map(p => p.key) : ['newton-web', 'newton-api'];
  const marketingEnabled = enabledKeys.includes('newton-marketing-web');

  // 1. Deterministic grep short-circuit: if a distinctive identifier from the
  //    report matches exactly one repo, that's a strong locus signal — skip
  //    the LLM (mirrors repoClassifier's grep short-circuit).
  if (repoGrepPaths.length > 0) {
    const entities = extractEntities(`${bugReport}\n${threadMessages.join('\n')}`);
    const signals = gatherRepoSignals({ entities, repoGrepPaths });
    const hittingRepos = REPO_KEYS.filter(key => signals.hitsByRepo[key].length > 0);
    if (hittingRepos.length === 1 && signals.hasDistinctiveHit) {
      const scope: InvestigationScope = hittingRepos[0];
      const hits = signals.hitsByRepo[scope as RepoKey];
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
      prompt: `${buildScopePrompt(marketingEnabled)}\n\nBug report:\n"${bugReport}"${threadBlock}\n\nClassify this bug.`,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      timeoutMs: 45_000,
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

    // Accept 'broad' plus any ENABLED repo — a scope naming a repo that isn't
    // configured on this host coerces to 'broad' rather than crashing the
    // workspace resolution downstream.
    const validScopes: InvestigationScope[] = ['broad', ...enabledKeys.filter(key => REPO_KEYS.includes(key))];
    const raw = result.parsedJson as { scope?: unknown; confidence?: unknown; reasoning?: unknown };
    const scope = validScopes.includes(raw.scope as InvestigationScope) ? (raw.scope as InvestigationScope) : 'broad';
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
