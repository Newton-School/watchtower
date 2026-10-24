import { logger } from '../logging/logger.js';

/**
 * Fetch the count of unresolved review threads on a GitHub PR using the GraphQL API.
 * Returns { unresolvedCount: 0, totalThreads: 0 } on any failure so merge is never blocked by API errors.
 */
export async function fetchUnresolvedReviewThreadCount(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  githubToken: string;
}): Promise<{ unresolvedCount: number; totalThreads: number }> {
  const { owner, repo, pullNumber, githubToken } = params;
  const fallback = { unresolvedCount: 0, totalThreads: 0 };

  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { isResolved }
            totalCount
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { owner, repo, number: pullNumber } }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, owner, repo, pullNumber }, 'GitHub GraphQL request failed');
      return fallback;
    }

    const json = (await response.json()) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: { nodes?: Array<{ isResolved: boolean }>; totalCount?: number };
          };
        };
      };
    };

    const threads = json.data?.repository?.pullRequest?.reviewThreads;
    if (!threads?.nodes) return fallback;

    const totalThreads = threads.totalCount ?? threads.nodes.length;
    const unresolvedCount = threads.nodes.filter(t => !t.isResolved).length;
    return { unresolvedCount, totalThreads };
  } catch (err) {
    logger.warn({ error: String(err), owner, repo, pullNumber }, 'Failed to fetch PR review threads');
    return fallback;
  }
}

/** What branch protection says about merging a PR now (issue #605). */
export interface MergeState {
  /** REVIEW_REQUIRED, CHANGES_REQUESTED or APPROVED; absent when the branch requires no review. */
  reviewDecision?: string;
  /** BLOCKED, BEHIND, CLEAN, DIRTY, DRAFT, HAS_HOOKS, UNSTABLE or UNKNOWN. */
  mergeStateStatus?: string;
  isDraft?: boolean;
}

/** GitHub computes mergeability lazily: the first read after a push says UNKNOWN. */
const MERGE_STATE_RETRY_DELAY_MS = 2_000;

/**
 * Read a PR's merge state with its own GraphQL query, so that a failure here
 * can never empty the unresolved-comments count above, which gates merges.
 * An UNKNOWN state is read once more after a short wait. Undefined when
 * GitHub could not be read.
 */
export async function fetchMergeState(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  githubToken: string;
  /** Test seams. */
  fetcher?: typeof fetch;
  retryDelayMs?: number;
}): Promise<MergeState | undefined> {
  const { owner, repo, pullNumber, githubToken } = params;
  const fetcher = params.fetcher ?? fetch;
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewDecision
          mergeStateStatus
          isDraft
        }
      }
    }
  `;
  const read = async (): Promise<MergeState | undefined> => {
    const response = await fetcher('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${githubToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, repo, number: pullNumber } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status, owner, repo, pullNumber }, 'GitHub GraphQL merge-state request failed');
      return undefined;
    }
    const json = (await response.json()) as {
      data?: {
        repository?: {
          pullRequest?: { reviewDecision?: string | null; mergeStateStatus?: string | null; isDraft?: boolean } | null;
        } | null;
      };
    };
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return undefined;
    return {
      ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
      ...(pr.mergeStateStatus ? { mergeStateStatus: pr.mergeStateStatus } : {}),
      ...(typeof pr.isDraft === 'boolean' ? { isDraft: pr.isDraft } : {}),
    };
  };
  try {
    const first = await read();
    if (first?.mergeStateStatus !== 'UNKNOWN') return first;
    await new Promise(resolve => setTimeout(resolve, params.retryDelayMs ?? MERGE_STATE_RETRY_DELAY_MS));
    return (await read().catch(() => undefined)) ?? first;
  } catch (err) {
    logger.warn({ error: String(err), owner, repo, pullNumber }, 'Failed to fetch PR merge state');
    return undefined;
  }
}
