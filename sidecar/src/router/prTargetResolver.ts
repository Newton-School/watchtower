import type { PrTarget } from '../types/contracts.js';

const GITHUB_PR_REGEX = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Cap for "review both/all" so a thread that accumulated a dozen PR links
 * can't fan a single mention into a dozen reviews. Truncation is surfaced
 * to the user, never silent.
 */
export const MAX_REVIEW_TARGETS = 3;

export interface PrReviewTargetResolution {
  /**
   * How the targets were chosen:
   * - trigger_urls: the trigger message contained PR URL(s) — they win outright
   * - selector:     a qualifier in the trigger ("frontend", "both", "#123")
   *                 picked among thread PRs
   * - thread_single: exactly one distinct PR in the thread — today's happy path
   * - ambiguous:    several thread PRs, no selector — never guess (issue #334)
   * - none:         no PR anywhere — caller keeps the ask-for-URL pause flow
   */
  mode: 'trigger_urls' | 'selector' | 'thread_single' | 'ambiguous' | 'none';
  targets: PrTarget[];
  /** Populated when mode === 'ambiguous' so the caller can list the choices. */
  candidates?: PrTarget[];
  /** The qualifier that drove a selector resolution (for telemetry). */
  selector?: string;
  /** Targets dropped by MAX_REVIEW_TARGETS — surface to the user when non-empty. */
  truncated?: PrTarget[];
}

/**
 * Extract every distinct GitHub PR URL across the given texts, preserving
 * first-seen order and tagging each with its source. Pass the trigger
 * message via `triggerText` so its URLs rank ahead of thread URLs.
 */
export function extractAllPrContexts(params: { triggerText?: string; threadTexts: string[] }): PrTarget[] {
  const seen = new Set<string>();
  const targets: PrTarget[] = [];

  const collect = (text: string | undefined, source: PrTarget['source']) => {
    if (!text) return;
    for (const match of text.matchAll(GITHUB_PR_REGEX)) {
      const url = match[0];
      if (seen.has(url)) continue;
      seen.add(url);
      targets.push({
        url,
        owner: match[1],
        repo: match[2],
        number: Number(match[3]),
        source,
      });
    }
  };

  collect(params.triggerText, 'trigger');
  for (const text of params.threadTexts) {
    collect(text, 'thread');
  }
  return targets;
}

const SELECTOR_ALL_RE = /\b(both|all|these|every)\b/;
// Marketing phrases are CONSUMED from the text before the web/api selectors
// run: \bweb\b matches inside "marketing web" and inside the repo slug
// "newton-marketing-web" (hyphens are word boundaries), so testing order and
// removal are load-bearing here.
const SELECTOR_MARKETING_RE =
  /\b(marketing(?:[- ]?(?:web|site|pages?))?|mweb|nmw|mkt|landing(?:[- ]?pages?)?|newton-marketing-web)\b/;
// Exact repo name → that repo only; generic frontend words → the frontend
// family (newton-web + newton-marketing-web), disambiguated by which repos
// actually have PRs in the thread.
const SELECTOR_WEB_EXACT_RE = /\bnewton-web\b/;
const SELECTOR_FRONTEND_RE = /\b(frontend|front-end|web)\b/;
const SELECTOR_API_RE = /\b(backend|back-end|api|newton-api)\b/;
const SELECTOR_NUMBER_RE = /#(\d{2,})\b/g;

function normalizeTriggerText(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Decide which PR(s) a review request is about. Fully deterministic — the
 * exact failure this replaces was "first URL in the thread wins" picking the
 * backend PR when the user said "review the frontend PR" (issue #334, bug A).
 */
export function resolvePrReviewTargets(params: {
  triggerText: string;
  threadTexts: string[];
}): PrReviewTargetResolution {
  const all = extractAllPrContexts(params);
  if (all.length === 0) {
    return { mode: 'none', targets: [] };
  }

  // 1. URLs in the trigger message always win — the user pointed at them.
  const triggerTargets = all.filter(t => t.source === 'trigger');
  if (triggerTargets.length > 0) {
    return capped({ mode: 'trigger_urls', targets: triggerTargets });
  }

  const normalized = normalizeTriggerText(params.triggerText);

  // 2. Selector qualifiers against the thread PRs.
  const numberSelectors = [...normalized.matchAll(SELECTOR_NUMBER_RE)].map(m => Number(m[1]));
  if (numberSelectors.length > 0) {
    const byNumber = all.filter(t => numberSelectors.includes(t.number));
    if (byNumber.length > 0) {
      return capped({ mode: 'selector', targets: byNumber, selector: numberSelectors.map(n => `#${n}`).join(',') });
    }
    return { mode: 'ambiguous', targets: [], candidates: all, selector: numberSelectors.map(n => `#${n}`).join(',') };
  }

  if (SELECTOR_ALL_RE.test(normalized)) {
    return capped({ mode: 'selector', targets: all, selector: 'all' });
  }

  const wantsMarketing = SELECTOR_MARKETING_RE.test(normalized);
  const withoutMarketing = normalized.replace(new RegExp(SELECTOR_MARKETING_RE.source, 'g'), ' ');
  const wantsWebExact = SELECTOR_WEB_EXACT_RE.test(withoutMarketing);
  const wantsFrontend = SELECTOR_FRONTEND_RE.test(withoutMarketing);
  const wantsApi = SELECTOR_API_RE.test(withoutMarketing);

  const selectedRepos = new Set<string>();
  if (wantsMarketing) selectedRepos.add('newton-marketing-web');
  if (wantsWebExact) selectedRepos.add('newton-web');
  else if (wantsFrontend) {
    // Generic "frontend"/"web" spans both frontends; the thread's actual PRs
    // narrow it down below.
    selectedRepos.add('newton-web');
    selectedRepos.add('newton-marketing-web');
  }
  if (wantsApi) selectedRepos.add('newton-api');

  if (selectedRepos.size > 0) {
    const selector = [...selectedRepos].join(',');
    const byRepo = all.filter(t => selectedRepos.has(t.repo));
    const distinctRepos = new Set(byRepo.map(t => t.repo));
    if (distinctRepos.size === 1) {
      // The selector plus the thread's PRs pin exactly one repo — review all
      // of that repo's PRs (preserves the multi-PR-same-repo behavior).
      return capped({ mode: 'selector', targets: byRepo, selector });
    }
    // Zero matching PRs (user named a repo with no PR here) or PRs from more
    // than one selected repo (e.g. "the web PR" with both frontend PRs in the
    // thread) — never guess; ask.
    return { mode: 'ambiguous', targets: [], candidates: all, selector };
  }

  // 3. A single distinct thread PR is unambiguous.
  if (all.length === 1) {
    return { mode: 'thread_single', targets: all };
  }

  // 4. Several thread PRs and nothing to pick by — never guess.
  return { mode: 'ambiguous', targets: [], candidates: all };
}

function capped(
  resolution: Omit<PrReviewTargetResolution, 'truncated'> & { targets: PrTarget[] },
): PrReviewTargetResolution {
  if (resolution.targets.length <= MAX_REVIEW_TARGETS) {
    return resolution;
  }
  return {
    ...resolution,
    targets: resolution.targets.slice(0, MAX_REVIEW_TARGETS),
    truncated: resolution.targets.slice(MAX_REVIEW_TARGETS),
  };
}
