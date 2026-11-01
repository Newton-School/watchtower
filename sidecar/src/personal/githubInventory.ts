/**
 * What GitHub holds for the owner since a time: review requests, comments that
 * mention him, and reviewers' asks on his open PRs. The nightly triage gets this
 * as data, so it never needs a shell.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface OwnPrAsk {
  kind: 'thread' | 'automated_finding' | 'changes_requested' | 'comment';
  author?: string;
  path?: string;
  url: string;
  createdAt: string;
  body?: string;
  inWindow: boolean;
}

export interface GithubInventory {
  login?: string;
  reviewRequests: Array<{ repo: string; number: number; url: string; title: string; author?: string; draft: boolean }>;
  mentions: Array<{
    repo: string;
    number: number;
    url: string;
    title: string;
    author?: string;
    createdAt: string;
    body: string;
  }>;
  ownOpen: Array<{ repo: string; number: number; url: string; title: string; viaMiniog: boolean; asks: OwnPrAsk[] }>;
  /** Open PRs of his with no ask in the window, counted only. */
  otherOpenPrs: number;
  errors: string[];
}

const API = 'https://api.github.com';
const MAX_SEARCH_PAGES = 5;
const BODY_LIMIT = 800;
const OWN_PR_CONCURRENCY = 6;
const BOT_LOGINS = new Set([
  'github-actions',
  'dependabot',
  'coderabbitai',
  'sonarcloud',
  'codecov',
  'vercel',
  'copilot',
]);
/** A finding Watchtower posts from the owner's own account: "**[SECURITY — HIGH]** …". */
const AUTOMATED_FINDING = /^\s*\*\*\[[A-Z][A-Z /&-]*?\s+[—–-]+\s+(CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/;
const VIA_MINIOG = /^\[[^\]]+ via miniOG\]/;

const OWN_PR_QUERY = `
query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $n) {
      number title url
      commits(last: 1) { nodes { commit { committedDate } } }
      reviews(last: 40) { nodes { author { login } state submittedAt url } }
      reviewThreads(first: 100) { nodes { isResolved path
        comments(first: 40) { nodes { author { login } body createdAt url } } } }
      comments(last: 40) { nodes { author { login } body createdAt url } }
    }
  }
}`;

interface SearchItem {
  number: number;
  html_url: string;
  title: string;
  draft?: boolean;
  created_at: string;
  body?: string | null;
  repository_url: string;
  user?: { login?: string };
  pull_request?: unknown;
}

interface Comment {
  html_url: string;
  created_at: string;
  body?: string | null;
  user?: { login?: string };
}

interface OwnPrDetail {
  repository: {
    pullRequest: {
      number: number;
      title: string;
      url: string;
      commits: { nodes: Array<{ commit: { committedDate?: string } }> };
      reviews: {
        nodes: Array<{ author?: { login?: string } | null; state: string; submittedAt: string; url: string }>;
      };
      reviewThreads: {
        nodes: Array<{
          isResolved: boolean;
          path?: string;
          comments: {
            nodes: Array<{ author?: { login?: string } | null; body?: string; createdAt: string; url: string }>;
          };
        }>;
      };
      comments: { nodes: Array<{ author?: { login?: string } | null; body?: string; createdAt: string; url: string }> };
    };
  };
}

function isBot(login: string | undefined): boolean {
  const lower = (login ?? '').toLowerCase();
  return lower.endsWith('[bot]') || BOT_LOGINS.has(lower);
}

function repoOf(item: SearchItem): string {
  return item.repository_url.split('/repos/')[1] ?? '';
}

/** A reviewer's asks on a PR of his: what someone else said last and he hasn't answered. */
export function ownPrAsks(detail: OwnPrDetail['repository']['pullRequest'], login: string, since: string): OwnPrAsk[] {
  const asks: Array<Omit<OwnPrAsk, 'inWindow'>> = [];
  for (const thread of detail.reviewThreads.nodes) {
    const comments = thread.comments.nodes;
    const first = comments[0];
    const last = comments[comments.length - 1];
    if (thread.isResolved || !first || !last) continue;
    const lastLogin = last.author?.login;
    const firstLogin = first.author?.login;
    if (lastLogin !== login && !isBot(lastLogin)) {
      asks.push({
        kind: 'thread',
        author: lastLogin,
        path: thread.path,
        url: last.url,
        createdAt: last.createdAt,
        body: last.body,
      });
    } else if (comments.length === 1 && firstLogin === login && AUTOMATED_FINDING.test(first.body ?? '')) {
      asks.push({
        kind: 'automated_finding',
        author: lastLogin,
        path: thread.path,
        url: last.url,
        createdAt: last.createdAt,
        body: last.body,
      });
    }
  }
  const lastCommitAt = detail.commits.nodes[0]?.commit.committedDate;
  const latestByReviewer = new Map<string, OwnPrDetail['repository']['pullRequest']['reviews']['nodes'][number]>();
  for (const review of detail.reviews.nodes) {
    const author = review.author?.login;
    // A later comment doesn't take back a request for changes: GitHub still shows it.
    if (author && author !== login && review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      latestByReviewer.set(author, review);
    }
  }
  for (const [author, review] of latestByReviewer) {
    if (review.state === 'CHANGES_REQUESTED' && (!lastCommitAt || review.submittedAt > lastCommitAt)) {
      asks.push({ kind: 'changes_requested', author, url: review.url, createdAt: review.submittedAt });
    }
  }
  for (const comment of detail.comments.nodes) {
    const author = comment.author?.login;
    if (author === login || isBot(author) || !lastCommitAt || comment.createdAt <= lastCommitAt) continue;
    asks.push({ kind: 'comment', author, url: comment.url, createdAt: comment.createdAt, body: comment.body });
  }
  return asks.map(ask => ({
    ...ask,
    body: ask.body?.slice(0, BODY_LIMIT),
    inWindow: ask.createdAt >= since,
  }));
}

export async function collectGithubInventory(params: {
  sinceIso: string;
  githubToken?: string;
  fetcher?: Fetcher;
}): Promise<GithubInventory> {
  const { sinceIso, githubToken } = params;
  const fetcher = params.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  const inventory: GithubInventory = { reviewRequests: [], mentions: [], ownOpen: [], otherOpenPrs: 0, errors: [] };

  const getJson = async <T>(url: string): Promise<T> => {
    const response = await fetcher(url, { headers });
    if (!response.ok) throw new Error(`GitHub ${response.status} for ${url.replace(API, '')}`);
    return (await response.json()) as T;
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await fetcher(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`);
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (!payload.data) throw new Error(`GitHub GraphQL: ${payload.errors?.[0]?.message ?? 'no data'}`);
    return payload.data;
  };
  const search = async (query: string): Promise<SearchItem[]> => {
    const items: SearchItem[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
      const url = `${API}/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;
      const result = await getJson<{ items?: SearchItem[]; total_count?: number }>(url);
      items.push(...(result.items ?? []));
      if (!result.items?.length || items.length >= (result.total_count ?? 0)) break;
    }
    return items;
  };
  /** One broken section must not lose the others: it becomes a gap in the report. */
  const section = async (name: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      inventory.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let login: string | undefined;
  await section('who am I', async () => {
    login = (await getJson<{ login?: string }>(`${API}/user`)).login;
  });
  inventory.login = login;
  if (!login) return inventory;
  const owner = login;

  await section('review requests', async () => {
    const items = await search(`is:pr is:open review-requested:${owner} archived:false`);
    inventory.reviewRequests = items.map(item => ({
      repo: repoOf(item),
      number: item.number,
      url: item.html_url,
      title: item.title,
      author: item.user?.login,
      draft: Boolean(item.draft),
    }));
  });

  await section('mentions', async () => {
    const handle = `@${owner.toLowerCase()}`;
    const items = await search(`mentions:${owner} is:open updated:>=${sinceIso.slice(0, 10)} archived:false`);
    for (const item of items) {
      const repo = repoOf(item);
      // One PR's comments failing must not lose the mentions on the others.
      await section(`mentions on ${repo}#${item.number}`, async () => {
        const stamp = encodeURIComponent(sinceIso);
        const comments = await getJson<Comment[]>(
          `${API}/repos/${repo}/issues/${item.number}/comments?since=${stamp}&per_page=100`,
        );
        const inline = item.pull_request
          ? await getJson<Comment[]>(`${API}/repos/${repo}/pulls/${item.number}/comments?since=${stamp}&per_page=100`)
          : [];
        const texts = [
          { html_url: item.html_url, created_at: item.created_at, body: item.body, user: item.user },
          ...comments,
          ...inline,
        ];
        for (const text of texts) {
          const author = text.user?.login;
          if (author === owner || isBot(author) || text.created_at < sinceIso) continue;
          if (!(text.body ?? '').toLowerCase().includes(handle)) continue;
          inventory.mentions.push({
            repo,
            number: item.number,
            url: text.html_url,
            title: item.title,
            author,
            createdAt: text.created_at,
            body: (text.body ?? '').slice(0, BODY_LIMIT),
          });
        }
      });
    }
  });

  await section('your open PRs', async () => {
    const items = await search(`is:pr is:open author:${owner} archived:false`);
    for (let start = 0; start < items.length; start += OWN_PR_CONCURRENCY) {
      await Promise.all(
        items.slice(start, start + OWN_PR_CONCURRENCY).map(item =>
          section(`${repoOf(item)}#${item.number}`, async () => {
            const [repoOwner, repo] = repoOf(item).split('/');
            const data = await graphql<OwnPrDetail>(OWN_PR_QUERY, { owner: repoOwner, repo, n: item.number });
            const detail = data.repository.pullRequest;
            const asks = ownPrAsks(detail, owner, sinceIso);
            if (!asks.some(ask => ask.inWindow)) {
              inventory.otherOpenPrs += 1;
              return;
            }
            inventory.ownOpen.push({
              repo: repoOf(item),
              number: detail.number,
              url: detail.url,
              title: detail.title,
              viaMiniog: VIA_MINIOG.test(detail.title),
              asks,
            });
          }),
        ),
      );
    }
  });

  return inventory;
}
