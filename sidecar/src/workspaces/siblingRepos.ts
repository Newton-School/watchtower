import type { AppConfig, WorkflowStepLogger } from '../types/contracts.js';
import { enabledRepoPaths, REPO_REGISTRY, type RepoKey } from '../repos/registry.js';
import { buildStaleCheckoutBlock, commits, isStaleCheckout, refreshRepoClones } from './staleCheckout.js';
import type { SharedRepoState } from './workspaceManager.js';

/**
 * The other repos a run in one repo's worktree may need to read (issue #610).
 *
 * Reviews and scoped investigations work in a fresh worktree of one repo, but
 * read the other repos from miniOG's shared clones, as of whenever those were
 * last fetched; the sandbox refuses an agent's `git fetch` there. A follow-up
 * review said a companion PR "holds one functional commit" three minutes
 * after its second commit landed, and a scoped investigation could not read
 * the other repo at all (a read-only run is refused reads outside its working
 * directory) and pointed its fix at the wrong endpoint.
 *
 * The sidecar now updates those clones before the run, all at once, and the
 * agent is told where each one is, how current it is, and to read another
 * pull request from GitHub. A clone that could not be updated is said to be
 * as of its last fetch; it never stops the run.
 */

export interface SiblingRepos {
  /** The other clones' paths, for a read-only run to be allowed to read them. */
  dirs: string[];
  /** What the agent is told about them; empty when there are none. */
  block: string;
}

/** What to say about a clone that may be old, with no newer tree to point at. */
const MAY_BE_OLD = 'if your answer depends on recent changes there, say the code you read may be out of date';

/** Where one clone is, as the end of its line in the block. */
function cloneStatus(state: SharedRepoState | null): string {
  if (!state) return `couldn't be checked against GitHub just now, so its files may be out of date; ${MAY_BE_OLD}`;
  const at = `${state.branch} @ ${state.head}${state.headDate ? ` (${state.headDate})` : ''}`;
  if (isStaleCheckout(state)) {
    return `its files are ${at}, ${commits(state.behind ?? 0)} behind ${state.upstream}: read ${state.upstream} instead (below)`;
  }
  if (state.staleReason === 'fetch_failed') {
    return `couldn't be refreshed; it is as of its last fetch${state.lastFetched ? ` on ${state.lastFetched}` : ''}: ${at}; ${MAY_BE_OLD}`;
  }
  if (state.staleReason === 'unverified') return `${at}; I couldn't confirm it is current with GitHub; ${MAY_BE_OLD}`;
  return `${at}, current with GitHub`;
}

/**
 * Bring the other configured repos' clones up to date and say how current
 * each one is. `mode: 'refresh'` fast-forwards them, for a run that reads
 * their files (a scoped investigation, as broad ones do); `mode: 'fetch'` only
 * updates origin's refs and leaves every checkout as it is (a review).
 */
export async function prepareSiblingRepos(params: {
  config: AppConfig;
  /** The repo the run has a fresh worktree of: left out. */
  currentRepoPath: string;
  mode: 'refresh' | 'fetch';
  stage: string;
  logStep?: WorkflowStepLogger;
}): Promise<SiblingRepos> {
  const { config, currentRepoPath, mode, stage, logStep } = params;
  const refreshed = await refreshRepoClones({
    config,
    stage,
    logStep,
    except: currentRepoPath,
    fetchOnly: mode === 'fetch',
  });
  if (refreshed.length === 0) return { dirs: [], block: '' };
  const keyOf = new Map<string, RepoKey>(enabledRepoPaths(config).map(repo => [repo.path, repo.key]));
  const slugOf = (repoPath: string): string | undefined => {
    const key = keyOf.get(repoPath);
    return key ? REPO_REGISTRY[key].githubSlug : undefined;
  };
  const lines = refreshed.map(({ name, path: repoPath, state }) => {
    const slug = slugOf(repoPath);
    return `- ${name}${slug ? ` (${slug} on GitHub)` : ''}: ${repoPath} — ${cloneStatus(state)}.`;
  });
  const exampleSlug = slugOf(refreshed[0].path) ?? '<owner>/<repo>';
  // Only the clones there is a newer tree to read: each line above already
  // says which ones may be old.
  const staleBlock = buildStaleCheckoutBlock(refreshed.filter(repo => isStaleCheckout(repo.state)));
  const block = [
    "OTHER REPOS — besides your working directory, you can read miniOG's clones of these repos. Read them; never edit them:",
    ...lines,
    `To read another pull request, in any repo, use \`gh pr view <number> --repo ${exampleSlug} --json commits,files\` or \`gh pr diff <number> --repo ${exampleSlug}\`. Both only read, so they are allowed even where other gh commands are not. Never judge a pull request from a local clone's branch: it can be behind GitHub.`,
    ...(staleBlock ? ['', staleBlock] : []),
  ].join('\n');
  return { dirs: refreshed.map(repo => repo.path), block };
}
