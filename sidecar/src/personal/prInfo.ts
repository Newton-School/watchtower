import type { Fetcher } from './githubInventory.js';

/**
 * What the inbox needs to know about each PR it names: whether it's open or merged,
 * the commit a button would act on, whether it's his own, and whether it's merged
 * but not live. The triage agent only reads Slack and can't tell any of this. A PR
 * it can't read is left out and offers nothing, rather than acting on a guess.
 */

export interface PrInfo {
  state: 'open' | 'merged' | 'closed';
  /** The commit a merge or approval is tied to. */
  head?: string;
  draft?: boolean;
  /** He wrote it: GitHub won't let him approve it. */
  mine?: boolean;
  /** Merged, in a repo the app can deploy, and not in production yet. */
  deployable?: boolean;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const CONCURRENCY = 6;
const API = 'https://api.github.com';

/** Repos with a production deploy behind the app's button. Only these can offer one. */
export const DEPLOY_ASKS: Record<string, string> = {
  'newton-web': 'deploy newton-web to prod',
  'newton-marketing-web': 'deploy marketing to prod',
};

type Reader = <T>(path: string, accept?: string) => Promise<T | undefined>;

/** The commit production runs for a repo, or nothing if it can't be read. */
async function productionCommit(owner: string, repo: string, read: Reader): Promise<string | undefined> {
  if (repo === 'newton-web') {
    const manifest = await read<string>(
      `/repos/${owner}/kubernetes-cluster-infra/contents/clusters/newton-core/prod/newton-web/deployment.yaml?ref=main`,
      'application/vnd.github.raw',
    );
    return typeof manifest === 'string' ? /\/newton-web:([0-9a-f]{40})\b/.exec(manifest)?.[1] : undefined;
  }
  if (repo === 'newton-marketing-web') {
    const runs = await read<{ workflow_runs?: Array<{ head_sha?: string }> }>(
      `/repos/${owner}/${repo}/actions/workflows/deploy-prod.yml/runs?status=success&per_page=1`,
    );
    return runs?.workflow_runs?.[0]?.head_sha;
  }
  return undefined;
}

export async function fetchPrInfo(params: {
  urls: string[];
  githubToken?: string;
  fetcher?: Fetcher;
}): Promise<Record<string, PrInfo>> {
  const fetcher = params.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (params.githubToken) headers.Authorization = `Bearer ${params.githubToken}`;
  const read: Reader = async <T>(path: string, accept?: string) => {
    const response = await fetcher(`${API}${path}`, { headers: { ...headers, ...(accept ? { Accept: accept } : {}) } });
    if (!response.ok) return undefined;
    return (accept ? ((await response.text()) as T) : ((await response.json()) as T)) as T;
  };

  const login = await read<{ login?: string }>('/user')
    .then(user => user?.login)
    .catch(() => undefined);
  const production = new Map<string, Promise<string | undefined>>();
  const urls = [...new Set(params.urls)];
  const info: Record<string, PrInfo> = {};

  const lookUp = async (url: string) => {
    const match = PR_URL.exec(url);
    if (!match) return;
    const [, owner, repo, number] = match;
    try {
      const pr = await read<{
        state?: string;
        merged_at?: string | null;
        merge_commit_sha?: string | null;
        draft?: boolean;
        head?: { sha?: string };
        user?: { login?: string };
        base?: { ref?: string; repo?: { default_branch?: string } };
      }>(`/repos/${owner}/${repo}/pulls/${number}`);
      if (!pr) return;
      const state = pr.merged_at ? 'merged' : pr.state === 'open' || pr.state === 'closed' ? pr.state : undefined;
      if (!state) return;
      const entry: PrInfo = { state, head: pr.head?.sha, draft: Boolean(pr.draft), mine: pr.user?.login === login };
      const onDefault = pr.base?.ref && pr.base.ref === pr.base.repo?.default_branch;
      if (state === 'merged' && pr.merge_commit_sha && onDefault && DEPLOY_ASKS[repo]) {
        const key = `${owner}/${repo}`;
        if (!production.has(key))
          production.set(
            key,
            productionCommit(owner, repo, read).catch(() => undefined),
          );
        const live = await production.get(key);
        if (live) {
          // `ahead` or `identical`: production has the merge. Anything else doesn't, as far as can be told.
          const compare = await read<{ status?: string }>(
            `/repos/${owner}/${repo}/compare/${pr.merge_commit_sha}...${live}`,
          );
          entry.deployable = compare?.status === 'behind' || compare?.status === 'diverged';
        }
      }
      info[url] = entry;
    } catch {
      // Shown with nothing to press, which is all a failed lookup can honestly offer.
    }
  };

  for (let start = 0; start < urls.length; start += CONCURRENCY) {
    await Promise.all(urls.slice(start, start + CONCURRENCY).map(lookUp));
  }
  return info;
}
