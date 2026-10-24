import { logger } from '../logging/logger.js';

export interface MergeChecks {
  unresolvedCount: number;
  totalThreads: number;
  /** REVIEW_REQUIRED, CHANGES_REQUESTED or APPROVED; absent when the branch requires no review. */
  reviewDecision?: string;
  /** BLOCKED, CLEAN, DIRTY, BEHIND, UNSTABLE, DRAFT, UNKNOWN… (GitHub computes it lazily). */
  mergeStateStatus?: string;
}

/**
 * Fetch the count of unresolved review threads on a GitHub PR using the GraphQL API,
 * with what branch protection says about merging it now (issue #605).
 * Returns { unresolvedCount: 0, totalThreads: 0 } on any failure so merge is never blocked by API errors.
 */
export async function fetchUnresolvedReviewThreadCount(params: {
  owner: string;
  repo: string;
  pullNumber: number;
  githubToken: string;
}): Promise<MergeChecks> {
  const { owner, repo, pullNumber, githubToken } = params;
  const fallback = { unresolvedCount: 0, totalThreads: 0 };

  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewDecision
          mergeStateStatus
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
            reviewDecision?: string | null;
            mergeStateStatus?: string | null;
            reviewThreads?: { nodes?: Array<{ isResolved: boolean }>; totalCount?: number };
          };
        };
      };
    };

    const pullRequest = json.data?.repository?.pullRequest;
    const threads = pullRequest?.reviewThreads;
    if (!pullRequest || !threads?.nodes) return fallback;

    const totalThreads = threads.totalCount ?? threads.nodes.length;
    const unresolvedCount = threads.nodes.filter(t => !t.isResolved).length;
    return {
      unresolvedCount,
      totalThreads,
      ...(pullRequest.reviewDecision ? { reviewDecision: pullRequest.reviewDecision } : {}),
      ...(pullRequest.mergeStateStatus ? { mergeStateStatus: pullRequest.mergeStateStatus } : {}),
    };
  } catch (err) {
    logger.warn({ error: String(err), owner, repo, pullNumber }, 'Failed to fetch PR review threads');
    return fallback;
  }
}
