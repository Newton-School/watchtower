import { fetchMergeState, fetchUnresolvedReviewThreadCount } from '../github/prReviewComments.js';
import type { Fetcher } from './githubInventory.js';

/**
 * Merge and Approve, from a button only the owner can press. Nothing else in My day can
 * do either: its agents have no token, and these only run on a request from the
 * app. Each is tied to the commit they saw, so a push after they looked stops it, and
 * GitHub enforces that itself. It only merges what's plainly ready; anything else
 * is theirs to look at on GitHub, where they can still merge it by hand.
 */

export type PrActionKind = 'merge' | 'approve';

/** Who currently has changes requested: each reviewer's latest say, ignoring plain comments. */
async function requestedChanges(
  fetcher: Fetcher,
  url: string,
  headers: Record<string, string>,
): Promise<string[] | undefined> {
  const response = await fetcher(url, { headers });
  if (!response.ok) return undefined;
  const reviews = (await response.json()) as Array<{ state?: string; user?: { login?: string } }>;
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (login && review.state && review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      latest.set(login, review.state);
    }
  }
  return [...latest].filter(([, state]) => state === 'CHANGES_REQUESTED').map(([login]) => login);
}

export interface PrActionRequest {
  kind: PrActionKind;
  url: string;
  /** The commit shown when the button was pressed. */
  head: string;
  allowedOrg: string;
  githubToken: string;
}

export interface PrActionResult {
  ok: boolean;
  message: string;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const API = 'https://api.github.com';
/**
 * Only what's plainly ready. BEHIND isn't: it's reported only where the branch rule
 * wants it up to date, and an admin's merge goes straight past that rule.
 */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);
const REQUEST_TIMEOUT_MS = 20_000;

const STATE_WORDS: Record<string, string> = {
  DIRTY: 'it has conflicts',
  UNSTABLE: 'its checks are failing or still running',
  BEHIND: 'its branch is behind the base, and the branch rules want it up to date',
  BLOCKED: "it's blocked by the branch rules (a required review or check)",
  DRAFT: "it's a draft",
  UNKNOWN: "GitHub hasn't worked out if it can merge yet, so try again in a minute",
};

interface Deps {
  fetcher?: Fetcher;
  readMergeState?: typeof fetchMergeState;
  readThreads?: typeof fetchUnresolvedReviewThreadCount;
}

async function githubError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? `GitHub said ${response.status}`;
  } catch {
    return `GitHub said ${response.status}`;
  }
}

/** A failure partway can mean it happened anyway, so it says to look, never that nothing was done. */
export async function runPrAction(request: PrActionRequest, deps: Deps = {}): Promise<PrActionResult> {
  try {
    return await act(request, deps);
  } catch (error) {
    return {
      ok: false,
      message: `Something went wrong during this, so check the PR on GitHub: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function act(request: PrActionRequest, deps: Deps): Promise<PrActionResult> {
  const { kind, url, head, allowedOrg, githubToken } = request;
  const given = deps.fetcher ?? fetch;
  // A hung call mustn't hold up every other button.
  const fetcher: Fetcher = (target, init) =>
    given(target, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const match = PR_URL.exec(url);
  if (!match) return { ok: false, message: "That isn't a PR link." };
  const [, owner, repo, numberText] = match;
  if (owner !== allowedOrg) return { ok: false, message: `${owner} isn't this org's GitHub, so nothing was done.` };
  if (!/^[0-9a-f]{40}$/.test(head))
    return { ok: false, message: "It doesn't say which commit to act on, so nothing was done." };
  const number = Number(numberText);
  const label = `${repo}#${number}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
  };

  const read = await fetcher(`${API}/repos/${owner}/${repo}/pulls/${number}`, { headers });
  if (!read.ok) return { ok: false, message: `Couldn't read ${label}, so nothing was done.` };
  const pr = (await read.json()) as {
    state?: string;
    merged?: boolean;
    head?: { sha?: string };
    user?: { login?: string };
  };
  if (pr.merged) return { ok: false, message: `${label} is already merged.` };
  if (pr.state !== 'open') return { ok: false, message: `${label} is closed, so nothing was done.` };
  if (pr.head?.sha !== head) {
    return { ok: false, message: `${label} has new commits since you looked, so nothing was done. Check them first.` };
  }

  if (kind === 'approve') {
    const response = await fetcher(`${API}/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event: 'APPROVE', commit_id: head }),
    });
    if (!response.ok) return { ok: false, message: `Couldn't approve ${label}: ${await githubError(response)}` };
    return { ok: true, message: `Approved ${label} at ${head.slice(0, 7)}.` };
  }

  const target = { owner, repo, pullNumber: number, githubToken };
  const state = await (deps.readMergeState ?? fetchMergeState)(target);
  const status = state?.isDraft ? 'DRAFT' : (state?.mergeStateStatus ?? 'UNKNOWN');
  if (!MERGEABLE_STATES.has(status)) {
    return { ok: false, message: `Didn't merge ${label}: ${STATE_WORDS[status] ?? `GitHub says ${status}`}.` };
  }
  if (state?.headSha && state.headSha !== head) {
    return { ok: false, message: `${label} has new commits since you looked, so nothing was done. Check them first.` };
  }
  // The rules may not require a review, but a person asking for changes still means not ready.
  const changesRequested = await requestedChanges(
    fetcher,
    `${API}/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    headers,
  );
  if (state?.reviewDecision === 'CHANGES_REQUESTED' || changesRequested === undefined || changesRequested.length > 0) {
    const who = changesRequested?.length ? ` by ${changesRequested.join(', ')}` : '';
    return {
      ok: false,
      message:
        changesRequested === undefined
          ? `Didn't merge ${label}: couldn't read its reviews.`
          : `Didn't merge ${label}: changes were requested${who}. Merge on GitHub if you mean to.`,
    };
  }
  const threads = await (deps.readThreads ?? fetchUnresolvedReviewThreadCount)(target);
  if (threads.failed || threads.incomplete) {
    return { ok: false, message: `Didn't merge ${label}: couldn't read its review threads.` };
  }
  if (threads.unresolvedCount > 0) {
    const count = threads.unresolvedCount;
    return {
      ok: false,
      message: `Didn't merge ${label}: ${count} review thread${count === 1 ? ' is' : 's are'} unresolved. Merge on GitHub if you mean to.`,
    };
  }

  const settings = await fetcher(`${API}/repos/${owner}/${repo}`, { headers });
  const repository = settings.ok
    ? ((await settings.json()) as { allow_squash_merge?: boolean; default_branch?: string })
    : undefined;
  if (!repository?.default_branch || state?.baseRef !== repository.default_branch) {
    return {
      ok: false,
      message: `Didn't merge ${label}: it goes into ${state?.baseRef ?? 'another branch'}, not ${repository?.default_branch ?? 'the default branch'}. Merge on GitHub if you mean to.`,
    };
  }
  const method = repository.allow_squash_merge === false ? 'merge' : 'squash';
  // `sha` makes GitHub itself refuse if anything was pushed after these checks.
  const merged = await fetcher(`${API}/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ sha: head, merge_method: method }),
  });
  if (!merged.ok) return { ok: false, message: `Didn't merge ${label}: ${await githubError(merged)}` };
  return { ok: true, message: `Merged ${label} at ${head.slice(0, 7)}.` };
}
