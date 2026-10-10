import type { AppConfig } from '../types/contracts.js';

/**
 * Canonical repo keys. This union is the type backbone for every "which repo"
 * decision in the sidecar; the registry below is the data backbone. Adding a
 * fourth repo = add the key here, add its descriptor (the Record forces it),
 * add its config column (config.ts + lib.rs + Settings UI), and the rest of
 * the system picks it up through the lookups in this module.
 */
export const REPO_KEYS = ['newton-web', 'newton-api', 'newton-marketing-web'] as const;
export type RepoKey = (typeof REPO_KEYS)[number];

export interface RepoDescriptor {
  key: RepoKey;
  kind: 'frontend' | 'backend';
  /** Property on AppConfig.repoPaths that holds this repo's clone path. */
  configPathKey: 'newtonWeb' | 'newtonApi' | 'newtonMarketingWeb';
  /** app_settings column name — used in docs and error copy. */
  settingsColumn: string;
  githubSlug: string;
  /** Advisory only — runtime always discovers origin/HEAD. */
  expectedDefaultBranch: string;
  /**
   * Required repos fail config load when their path is blank. Optional repos
   * are simply disabled: never offered by classifiers or admin gates.
   */
  required: boolean;
  /** One-line description for prompts that enumerate the known repos. */
  description: string;
  /**
   * Hard per-repo rules injected into planner/coder/reviewer/verifier prompts
   * (belt-and-braces on top of the repo's own CLAUDE.md, which the backend
   * reads in the worktree). Empty = no extra block rendered.
   */
  guardrails: string[];
  /** Browser-QA caveats injected into the QA system prompt for this repo. */
  qaCaveats: string[];
  /** How this repo ships to production — consumed by the deploy workflow. */
  deploy:
    | { method: 'deploy-prod-skill' }
    | { method: 'github-actions'; stagingNote: string; prodCommand: string }
    | { method: 'none' };
}

export const REPO_REGISTRY: Record<RepoKey, RepoDescriptor> = {
  'newton-web': {
    key: 'newton-web',
    kind: 'frontend',
    configPathKey: 'newtonWeb',
    settingsColumn: 'newton_web_path',
    githubSlug: 'Newton-School/newton-web',
    expectedDefaultBranch: 'master',
    required: true,
    description: 'Product frontend — the logged-in app at my.newtonschool.co (Next.js Pages Router, React, Redux).',
    guardrails: [],
    qaCaveats: [],
    deploy: { method: 'deploy-prod-skill' },
  },
  'newton-api': {
    key: 'newton-api',
    kind: 'backend',
    configPathKey: 'newtonApi',
    settingsColumn: 'newton_api_path',
    githubSlug: 'Newton-School/newton-api',
    expectedDefaultBranch: 'master',
    required: true,
    description: 'Backend — Python/Django REST API: endpoints, models, business logic, background jobs.',
    guardrails: [],
    qaCaveats: [],
    deploy: { method: 'none' },
  },
  'newton-marketing-web': {
    key: 'newton-marketing-web',
    kind: 'frontend',
    configPathKey: 'newtonMarketingWeb',
    settingsColumn: 'newton_marketing_web_path',
    githubSlug: 'Newton-School/newton-marketing-web',
    expectedDefaultBranch: 'main',
    required: false,
    description:
      'Public marketing site — newtonschool.co landing pages migrated from Webflow ' +
      '(Next.js App Router, Tailwind, static export served behind a Cloudflare Worker).',
    guardrails: [
      'Base branch is `main`. Never edit `worker/**` or `.github/workflows/**` — the Cloudflare Worker router and CI are owned separately. Routing a page live happens via `worker/paths.js` and is a human handoff, not a code change.',
      "Keep `output: 'export'` in next.config.js — no route handlers, server actions, middleware, or anything else that breaks static export.",
      'No hardcoded newtonschool.co URLs outside `src/lib/url/` (ESLint-enforced); internal links stay relative.',
      'No new styled-components — Tailwind v4 + @newtonschool/grauity only.',
      'Images live on the CloudFront CDN (uploaded via the Django admin), never in `/public`. Always set explicit width/height on images — CLS must stay 0.',
      'This repo has NO test suite — do not add or run jest/vitest. Verification is `npm run typecheck` + `npm run lint` + `npm run build` (which must emit `out/`).',
      'Never run `npm run build` while a dev server is running — they share `.next` and corrupt each other.',
    ],
    qaCaveats: [
      'Static-export site: there are no server routes; every page is pre-rendered HTML hydrated client-side.',
      'Lead/OTP/reCAPTCHA endpoints are origin-locked and return 401 on localhost — route-mock them (and stub grecaptcha) instead of reporting form submissions as bugs.',
      '`*-temp` routes are deliberate noindex preview twins of live Webflow pages — not duplicates, not bugs.',
      'The Cloudflare Worker path-router is absent under `npm run dev`: every route serves locally even if not yet cut over in `worker/paths.js`. Changes under `worker/**` cannot be validated locally — say so in the report instead of guessing.',
      'These are conversion-critical landing pages — flag layout shift (CLS), broken mobile layouts, and obvious performance regressions.',
    ],
    deploy: {
      method: 'github-actions',
      stagingNote: 'staging auto-deploys on every push to `main` (staging-marketing-web.newtonschool.co)',
      prodCommand: 'gh workflow run deploy-prod.yml --ref main -f confirm=deploy',
    },
  },
};

export class RepoNotConfiguredError extends Error {
  constructor(public readonly key: RepoKey) {
    super(
      `Repo ${key} is not configured on this host — set ${REPO_REGISTRY[key].settingsColumn} in Watchtower settings.`,
    );
    this.name = 'RepoNotConfiguredError';
  }
}

export function getRepo(key: RepoKey): RepoDescriptor {
  return REPO_REGISTRY[key];
}

export function repoPathOrNull(config: AppConfig, key: RepoKey): string | null {
  const path = config.repoPaths[REPO_REGISTRY[key].configPathKey];
  return path && path.trim() ? path : null;
}

/** Resolve a repo's clone path, throwing when the repo is not configured. */
export function resolveRepoPath(config: AppConfig, key: RepoKey): string {
  const path = repoPathOrNull(config, key);
  if (!path) throw new RepoNotConfiguredError(key);
  return path;
}

export function isRepoEnabled(config: AppConfig, key: RepoKey): boolean {
  return repoPathOrNull(config, key) !== null;
}

/**
 * The repos routing is allowed to offer/select on this host. Classifier
 * options, admin-gate choices, grep paths, and prompt repo-lists must all
 * derive from this so a classifier can never pick a repo whose path lookup
 * would then throw mid-workflow.
 */
export function enabledRepoKeys(config: AppConfig): RepoKey[] {
  return REPO_KEYS.filter(key => isRepoEnabled(config, key));
}

export function enabledRepoPaths(config: AppConfig): Array<{ key: RepoKey; path: string }> {
  return enabledRepoKeys(config).map(key => ({ key, path: resolveRepoPath(config, key) }));
}

/** Map a GitHub repo name (PrContext.repo) to a registry key, if known. */
export function repoKeyFromGithubRepoName(repoName: string): RepoKey | null {
  const normalized = repoName.trim().toLowerCase();
  return REPO_KEYS.find(key => key === normalized) ?? null;
}

export function guardrailBlockFor(key: RepoKey): string {
  const rules = REPO_REGISTRY[key].guardrails;
  if (rules.length === 0) return '';
  return [
    `Repo-specific hard rules for ${key} (these override any prior habits or recalled conventions from other repos):`,
    ...rules.map(rule => `- ${rule}`),
  ].join('\n');
}

export function qaCaveatBlockFor(key: RepoKey): string {
  const caveats = REPO_REGISTRY[key].qaCaveats;
  if (caveats.length === 0) return '';
  return [`Repo-specific QA context for ${key}:`, ...caveats.map(caveat => `- ${caveat}`)].join('\n');
}

/** One line per enabled repo, for prompts that enumerate the known repos. */
export function describeEnabledRepos(config: AppConfig): string {
  return enabledRepoKeys(config)
    .map(key => `- ${key}: ${REPO_REGISTRY[key].description}`)
    .join('\n');
}

/**
 * Best-effort: which repo does a working directory belong to? Matches either
 * the configured clone itself or a workspace worktree derived from it
 * (worktrees live under `…/workspaces/<basename(clonePath)>/<threadTs>`).
 * Segment-bounded comparison, so `newton-marketing-web` never matches a
 * `newton-web` segment. Returns null for spanning roots (broad/combined cwd).
 */
export function repoKeyForWorkspacePath(cwd: string, config: AppConfig): RepoKey | null {
  for (const { key, path } of enabledRepoPaths(config)) {
    const basename = path.split('/').filter(Boolean).pop();
    if (!basename) continue;
    if (cwd === path || cwd.startsWith(`${path}/`)) return key;
    if (cwd.endsWith(`/${basename}`) || cwd.includes(`/${basename}/`)) return key;
  }
  return null;
}
