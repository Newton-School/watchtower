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
  /** GitHub's mergeable_state: clean, dirty (conflicts), behind, blocked, unstable, unknown. */
  mergeableState?: string;
  /** The latest review from each reviewer, worst first. */
  reviews: Array<{ login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' }>;
  /** Reviewers GitHub is still waiting on. */
  requestedReviewers: string[];
  baseRef?: string;
  headRef?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchPrFollowUpState(params: {
  owner: string;
  repo: string;
  number: number;
  githubToken?: string;
  fetcher?: Fetcher;
  logStep?: WorkflowStepLogger;
}): Promise<PrFollowUpState | undefined> {
  const { owner, repo, number, githubToken, logStep } = params;
  const fetcher = params.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  try {
    const prResponse = await fetcher(base, { headers, signal: AbortSignal.timeout(15_000) });
    if (!prResponse.ok) {
      logStep?.({
        stage: 'pr_followup.fetch_failed',
        level: 'WARN',
        message: `GitHub answered ${prResponse.status} for ${owner}/${repo}#${number}.`,
      });
      return undefined;
    }
    const pr = (await prResponse.json()) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    const state: PrFollowUpState['state'] =
      pr.merged === true || text(pr.merged_at) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    const requested = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
    const requestedReviewers = requested
      .map(entry => text((entry as Record<string, unknown>)?.login))
      .filter((login): login is string => Boolean(login));

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
