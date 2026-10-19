import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * What a daily look at one of miniOG's open PRs needs from GitHub
 * (issue #603): whether it is still open, how long it has been, whether it
 * merges cleanly, and whom it waits on.
 */
export interface PrFollowUpState {
  state: 'open' | 'merged' | 'closed';
  title?: string;
  createdAt?: string;
  draft?: boolean;
  /** GitHub's mergeable_state: clean, dirty (conflicts), behind, blocked, unstable, unknown. */
  mergeableState?: string;
  /** The latest review from each reviewer, worst first. */
  reviews: Array<{ login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' }>;
  /** Reviewers GitHub is still waiting on: logins, and teams as `team <slug>`. */
  requestedReviewers: string[];
  baseRef?: string;
  headRef?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** GitHub computes mergeability lazily: the first read after a push says `unknown`. */
const MERGEABILITY_RETRY_DELAY_MS = 2_500;

export async function fetchPrFollowUpState(params: {
  owner: string;
  repo: string;
  number: number;
  githubToken?: string;
  fetcher?: Fetcher;
  logStep?: WorkflowStepLogger;
  /** Test seam: the wait before re-reading an `unknown` mergeability. */
  retryDelayMs?: number;
}): Promise<PrFollowUpState | undefined> {
  const { owner, repo, number, githubToken, logStep } = params;
  const fetcher = params.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const readPr = async (): Promise<Record<string, unknown> | undefined> => {
    const response = await fetcher(base, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      logStep?.({
        stage: 'pr_followup.fetch_failed',
        level: 'WARN',
        message: `GitHub answered ${response.status} for ${owner}/${repo}#${number}.`,
        data: { status: response.status },
      });
      return undefined;
    }
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    let pr = await readPr();
    if (!pr) return undefined;
    if (pr.state === 'open' && (pr.mergeable === null || pr.mergeable_state === 'unknown')) {
      await new Promise(resolve => setTimeout(resolve, params.retryDelayMs ?? MERGEABILITY_RETRY_DELAY_MS));
      pr = (await readPr()) ?? pr;
    }
    const state: PrFollowUpState['state'] =
      pr.merged === true || text(pr.merged_at) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    const requested = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
    const requestedTeams = Array.isArray(pr.requested_teams) ? pr.requested_teams : [];
    const requestedReviewers = [
      ...requested.map(entry => text((entry as Record<string, unknown>)?.login)),
      ...requestedTeams.map(entry => {
        const slug = text((entry as Record<string, unknown>)?.slug) ?? text((entry as Record<string, unknown>)?.name);
        return slug ? `team ${slug}` : undefined;
      }),
    ].filter((name): name is string => Boolean(name));

    let reviews: PrFollowUpState['reviews'] = [];
    if (state === 'open') {
      const reviewsResponse = await fetcher(`${base}/reviews?per_page=100`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (reviewsResponse.ok) {
        const rows = (await reviewsResponse.json()) as Array<Record<string, unknown>>;
        const latest = new Map<string, PrFollowUpState['reviews'][number]['state']>();
        for (const row of rows) {
          const login = text((row.user as Record<string, unknown> | undefined)?.login);
          const reviewState = text(row.state);
          if (!login || !reviewState) continue;
          if (reviewState === 'APPROVED' || reviewState === 'CHANGES_REQUESTED') latest.set(login, reviewState);
          else if (reviewState === 'COMMENTED' && !latest.has(login)) latest.set(login, 'COMMENTED');
        }
        const rank = { CHANGES_REQUESTED: 0, COMMENTED: 1, APPROVED: 2 };
        reviews = [...latest.entries()]
          .map(([login, reviewState]) => ({ login, state: reviewState }))
          .sort((a, b) => rank[a.state] - rank[b.state]);
      }
    }
    return {
      state,
      title: text(pr.title),
      createdAt: text(pr.created_at),
      draft: pr.draft === true,
      mergeableState: text(pr.mergeable_state),
      reviews,
      requestedReviewers,
      baseRef: text((pr.base as Record<string, unknown> | undefined)?.ref),
      headRef: text((pr.head as Record<string, unknown> | undefined)?.ref),
    };
  } catch (error) {
    logStep?.({
      stage: 'pr_followup.fetch_failed',
      level: 'WARN',
      message: `Could not read ${owner}/${repo}#${number} from GitHub: ${String(error)}`,
    });
    return undefined;
  }
}
