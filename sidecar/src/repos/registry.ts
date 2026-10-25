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

/**
 * Which pull requests count as content-only for a repo: copy, numbers and
 * asset links on pages, nothing else (issue #701). Such a PR may be merged on
 * the word of anyone who could have asked for the change. The paths only
 * narrow where a content-only change can be; `github/contentOnlyDiff.ts`
 * reads the files themselves.
 */
export interface ContentPolicy {
  /** Globs a content-only change may touch (`**` spans folders, `*` stays within one). */
  allow: string[];
  /** Globs it never touches, even inside `allow`. */
  deny: string[];
  /**
   * Markdown notes that never ship to the site (a feature's README.md or
   * design notes): a content-only PR may edit them, unread. Only `.md` files
   * matching these globs and not `deny`, and never agent instructions
   * (CLAUDE.md, AGENTS.md, skills), which later runs would read as orders.
   */
  notes: string[];
  /**
   * What the repo's own lint forbids in string literals. The repo has no CI
   * to catch it, so a changed value matching one would only fail at deploy.
   */
  lintForbidden: RegExp[];
  /** How miniOG merges such a PR. */
  mergeMethod: 'squash' | 'merge' | 'rebase';
}

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
    | {
        method: 'github-actions';
        /** Where staging is served. */
        stagingHost: string;
        /** How staging gets a build: told to whoever asks miniOG for a staging deploy, and to lookups. Plain text, no <, > or &. */
        stagingNote: string;
        prodCommand: string;
      }
    | { method: 'none' };
  /** Set for repos whose content-only PRs builders may merge; absent everywhere else. */
  contentPolicy?: ContentPolicy;
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
      "Never dispatch a GitHub Actions workflow (`deploy-staging.yml`, `deploy-prod.yml` or any other): a staging deploy replaces what a teammate may be testing, and deploys are a person's to run. If staging was asked for, say in the report how to deploy it.",
    ],
    qaCaveats: [
      'Static-export site: there are no server routes; every page is pre-rendered HTML hydrated client-side.',
      'Lead/OTP/reCAPTCHA endpoints are origin-locked and return 401 on localhost — route-mock them (and stub grecaptcha) instead of reporting form submissions as bugs.',
      '`*-temp` routes are deliberate noindex preview twins of live Webflow pages — not duplicates, not bugs.',
      'The Cloudflare Worker path-router is absent under `npm run dev`: every route serves locally even if not yet cut over in `worker/paths.js`. Changes under `worker/**` cannot be validated locally — say so in the report instead of guessing.',
      'These are conversion-critical landing pages — flag layout shift (CLS), broken mobile layouts, and obvious performance regressions.',
      'If the page under test is on staging-marketing-web.newtonschool.co: staging shows whichever branch was deployed there last, not necessarily `main`, so say that a difference from the main clone may come from that rather than reporting it as a bug.',
    ],
    deploy: {
      method: 'github-actions',
      // Manual since early Oct 2026: deploy-staging.yml is workflow_dispatch only and
      // takes any branch; staging keeps whatever was dispatched last.
      stagingHost: 'staging-marketing-web.newtonschool.co',
      stagingNote:
        'Staging deploys are manual: run *Deploy → staging* in GitHub Actions on your branch (`gh workflow run deploy-staging.yml --ref YOUR_BRANCH`). It replaces whatever is on staging now, so check nobody is testing there, and deploy `main` again when you are done.',
      prodCommand: 'gh workflow run deploy-prod.yml --ref main -f confirm=deploy',
    },
    contentPolicy: {
      allow: ['src/features/**', 'src/app/**', 'src/components/**'],
      // A coder often updates the feature's own notes alongside a copy edit.
      notes: ['src/features/**'],
      // eslint.config.mjs: no hardcoded site-host URLs in literals or templates.
      lintForbidden: [/newtonschool\.co/],
      deny: [
        'src/lib/**',
        'worker/**',
        '.github/**',
        // App-wide shells, server code and crawler files.
        'src/app/layout.tsx',
        'src/app/**/layout.tsx',
        'src/app/**/template.tsx',
        'src/app/**/error.tsx',
        'src/app/**/global-error.tsx',
        'src/app/api/**',
        'src/app/**/route.ts',
        'src/app/**/route.tsx',
        'src/app/robots.ts',
        'src/app/sitemap.ts',
        'src/app/manifest.ts',
        '**/api/**',
        '**/*-api.ts',
        '**/middleware*',
        // Forms, sign-in, sessions and state.
        '**/forms/**',
        '**/auth/**',
        '**/gate/**',
        '**/*gate*',
        '**/*session*',
        '**/*signup*',
        '**/*lead-form*',
        '**/*-lead.ts',
        '**/*-lead-*',
        '**/lead-*',
        '**/*popup*',
        '**/*nudge*',
        '**/*provider*',
        '**/*context*',
        '**/*config*',
        '**/store.ts',
        '**/*-store.ts',
        '**/*cookie*',
        '**/*storage*',
        '**/hooks/**',
        '**/use-*.ts',
        // Scripts, tracking and experiments.
        // (Globs ignore case, so no `*script*`: it would take description.tsx.)
        '**/script*',
        '**/*-script*',
        '**/*_script*',
        '**/*.script.*',
        '**/analytics*',
        '**/analytics*/**',
        '**/tracking/**',
        '**/*tracker*',
        '**/*tracking*',
        '**/tracked-*',
        '**/*attribution*',
        '**/events.ts',
        '**/*-events.ts',
        '**/*pixel*',
        '**/*utm*',
        '**/*gtag*',
        '**/*gtm*',
        '**/ads.ts',
        '**/*-ads.ts',
        '**/device-id*',
        '**/openpanel*',
        '**/*consent*',
        '**/instrumentation*',
        '**/*experiment*',
        '**/*experiment*/**',
        '**/*ab-test*',
        '**/*abtest*',
        '**/*feature-flag*',
        '**/flags.ts',
        '**/*bucket*',
        '**/funnel/**',
        // Routing, redirects, payments and sign-in codes.
        '**/*redirect*',
        '**/routes.ts',
        '**/*-routes.ts',
        '**/otp*',
        '**/*-otp*',
        '**/*_otp*',
        '**/*payment*',
        '**/*checkout*',
        '**/*razorpay*',
        '**/whatsapp.ts',
        // Settings, and files that render structured data as scripts.
        '**/env.ts',
        '**/env/**',
        '**/*constants*',
        '**/*json-ld*',
        '**/*jsonld*',
        '**/*structured-data*',
        '**/schema.ts',
        'src/app/**/sitemap.ts',
        'src/app/**/robots.ts',
        'src/app/**/opengraph-image*',
        'src/app/**/twitter-image*',
        '**/*.test.*',
        '**/*.spec.*',
      ],
      // The repo's ruleset requires a linear history.
      mergeMethod: 'squash',
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

/**
 * What miniOG says to a marketing staging deploy ask, from the router's gate
 * or the deploy workflow: it runs none, and this is how. Plain text.
 */
export function marketingStagingReply(): string {
  const deploy = REPO_REGISTRY['newton-marketing-web'].deploy;
  const note = deploy.method === 'github-actions' ? deploy.stagingNote : '';
  return ["I don't run staging deploys.", note].filter(Boolean).join(' ');
}

/**
 * One line per enabled repo, for prompts that enumerate the known repos. A
 * repo deployed through GitHub Actions also says how its staging works, in
 * the words the deploy workflow uses, so a lookup asked about it (where the
 * router sends staging deploy asks) answers from that rather than guessing.
 */
export function describeEnabledRepos(config: AppConfig): string {
  return enabledRepoKeys(config)
    .map(key => {
      const repo = REPO_REGISTRY[key];
      const deploy = repo.deploy;
      const staging =
        deploy.method === 'github-actions'
          ? ` Staging (${deploy.stagingHost}): ${deploy.stagingNote} Point people to that workflow; never dispatch it yourself.`
          : '';
      return `- ${key}: ${repo.description}${staging}`;
    })
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
