import type { Fetcher } from './githubInventory.js';

/**
 * Whether the PRs named in the inbox are open, merged or closed. The triage agent
 * only reads Slack and can't tell, and an ask about a merged PR reads very
 * differently, so the app looks them up itself. A PR it can't read is left out
 * and shows no state, rather than a guess.
 */

export type PrState = 'open' | 'merged' | 'closed';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const CONCURRENCY = 6;

export async function fetchPrStates(params: {
  urls: string[];
  githubToken?: string;
  fetcher?: Fetcher;
}): Promise<Record<string, PrState>> {
  const fetcher = params.fetcher ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (params.githubToken) headers.Authorization = `Bearer ${params.githubToken}`;
  const urls = [...new Set(params.urls)];
  const states: Record<string, PrState> = {};
  for (let start = 0; start < urls.length; start += CONCURRENCY) {
    await Promise.all(
      urls.slice(start, start + CONCURRENCY).map(async url => {
        const match = PR_URL.exec(url);
        if (!match) return;
        try {
          const response = await fetcher(`https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`, {
            headers,
          });
          if (!response.ok) return;
          const pr = (await response.json()) as { state?: string; merged_at?: string | null };
          if (pr.merged_at) states[url] = 'merged';
          else if (pr.state === 'open' || pr.state === 'closed') states[url] = pr.state;
        } catch {
          // Shown without a state, which is all a failed lookup can honestly say.
        }
      }),
    );
  }
  return states;
}
