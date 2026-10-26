import { execFile } from 'node:child_process';

/**
 * Recent commits near what a report names, read before an investigation
 * starts (issue #621). On 16 Oct three investigations in a row read code
 * that had already been fixed, never ran git, and concluded "cannot
 * reproduce"; the fourth found the fix, merged two days earlier, with one
 * `git log`. This hands the investigator that `git log` up front.
 *
 * What counts as "near", strongest first: a file path written in the report,
 * a page slug from a newtonschool.co link, then a run of two to four words in
 * the report that is the name of a folder in the repo ("Agentic AI course" →
 * `src/features/agentic-ai-course`). A name match can be a coincidence, so the
 * block says it is a hint. Bounded on every side: a few pathspecs per repo, a
 * short window, a fixed number of lines. Any git failure leaves the block out;
 * it never stops the investigation.
 */

export const RECENT_CHANGES_DAYS = 14;
export const RECENT_CHANGES_MAX_LINES = 20;
const MAX_PATHSPECS_PER_REPO = 3;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const __recentChangesGit: { run: GitRunner } = {
  run: (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
};

const FILE_PATH_RE =
  /(?:^|[\s`'"(<|])((?:[\w.()[\]-]+\/)+[\w.()[\]-]+\.(?:tsx?|jsx?|mjs|py|md|json|css|scss|html|ya?ml))(?=$|[\s`'")>|:,.])/g;
const URL_RE = /https?:\/\/[^\s|>]+/g;
/** Link path segments that name a kind of page, not a page. */
const GENERIC_SLUGS = new Set([
  'courses',
  'course',
  'pages',
  'page',
  'www',
  'blog',
  'apply',
  'home',
  'admin',
  'user',
  'users',
  'change',
  'add',
  'edit',
  'delete',
  'assets',
  'images',
  'image',
  'static',
  'public',
  'dashboard',
  'profile',
  'login',
  'signup',
  'api',
  'v1',
  'v2',
]);
/** Folders whose name matching a phrase in a report says nothing about the report. */
const SKIPPED_FOLDERS = new Set([
  'public',
  'static',
  'templates',
  'tests',
  'test',
  '__tests__',
  'docs',
  'node_modules',
  'vendor',
  'external',
  'migrations',
  'fixtures',
]);

export type CandidateKind = 'path' | 'link' | 'words';
export interface Candidate {
  kind: CandidateKind;
  /** A file path as written, or a slug (lowercase, `-` between words). */
  value: string;
  /** What the report said, shown beside the match so a wrong one is visible. */
  phrase: string;
}

/** Folder-name form of a slug or folder name: lowercase, `_` read as `-`. */
function slugKey(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}

/**
 * File paths, page slugs from newtonschool.co links, and two-to-four-word runs
 * (as slugs) a report mentions, strongest first: paths, then link slugs, then
 * longer word runs before shorter ones.
 */
export function reportCandidates(text: string): Candidate[] {
  const plain = text.replace(/<@[^>]+>/g, ' ');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate) => {
    const key = candidate.kind === 'path' ? `path:${candidate.value}` : `slug:${candidate.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const match of plain.matchAll(FILE_PATH_RE)) add({ kind: 'path', value: match[1], phrase: match[1] });

  for (const url of plain.match(URL_RE) ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(url.replace(/[).,]+$/, ''));
    } catch {
      continue;
    }
    if (!/newtonschool\.co$/i.test(parsed.hostname)) continue;
    for (const segment of parsed.pathname.split('/')) {
      const slug = slugKey(segment);
      // A page slug has words joined by - or _; a single word is a kind of page.
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(slug) || GENERIC_SLUGS.has(slug)) continue;
      add({ kind: 'link', value: slug, phrase: segment });
    }
  }

  // Word runs from the prose only: a path's or a link's words are already above.
  const words = plain
    .replace(URL_RE, ' ')
    .replace(FILE_PATH_RE, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let size = 4; size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const run = words.slice(start, start + size);
      add({ kind: 'words', value: run.join('-'), phrase: run.join(' ') });
    }
  }
  return candidates;
}

export interface PathspecMatch {
  pathspec: string;
  candidate: Candidate;
}

function isSkippedFolder(name: string): boolean {
  return name.startsWith('.') || name.startsWith('_') || SKIPPED_FOLDERS.has(name.toLowerCase());
}

/**
 * The files and folders in a repo that the candidates name, strongest first: a
 * tracked file whose path ends with a candidate path, then every folder whose
 * name is a candidate slug (a page's feature folder and its route folder are
 * often both). Folders under hidden, underscore, asset, test or docs folders
 * are not matched. A file inside a kept folder is covered by it. At most a few.
 */
export function matchPathspecs(trackedFiles: string[], candidates: Candidate[]): PathspecMatch[] {
  const ranked: PathspecMatch[] = [];
  const pathCandidates = candidates.filter(candidate => candidate.kind === 'path');
  for (const candidate of pathCandidates) {
    const hit = trackedFiles.find(file => file === candidate.value || file.endsWith(`/${candidate.value}`));
    if (hit) ranked.push({ pathspec: hit, candidate });
  }

  const slugCandidates = candidates.filter(candidate => candidate.kind !== 'path');
  if (slugCandidates.length > 0) {
    const order = new Map(slugCandidates.map((candidate, index) => [candidate.value, index]));
    const dirs = new Map<string, { index: number; candidate: Candidate }>();
    for (const file of trackedFiles) {
      const parts = file.split('/');
      // The shallowest folder on this file's path whose name is wanted, unless
      // a folder above it is one that says nothing about the report.
      for (let depth = 1; depth < parts.length; depth += 1) {
        const name = parts[depth - 1];
        if (isSkippedFolder(name)) break;
        const index = order.get(slugKey(name));
        if (index === undefined) continue;
        const dir = parts.slice(0, depth).join('/');
        if (!dirs.has(dir)) dirs.set(dir, { index, candidate: slugCandidates[index] });
        break;
      }
    }
    const folders = [...dirs.entries()].sort((a, b) => a[1].index - b[1].index || a[0].localeCompare(b[0]));
    for (const [dir, { candidate }] of folders) ranked.push({ pathspec: dir, candidate });
  }

  const kept: PathspecMatch[] = [];
  for (const match of ranked) {
    if (kept.length >= MAX_PATHSPECS_PER_REPO) break;
    if (kept.some(other => match.pathspec.startsWith(`${other.pathspec}/`))) continue;
    // A kept file inside this folder is covered by it.
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i].pathspec.startsWith(`${match.pathspec}/`)) kept.splice(i, 1);
    }
    kept.push(match);
  }
  return kept;
}

export interface RecentChangesRepoResult {
  repo: string;
  pathspecs: string[];
  commits: number;
}

export interface RecentChanges {
  /** The prompt block, or '' when there is nothing to show. */
  block: string;
  /** Every repo where something in the report matched, with or without commits, for the job log. */
  matched: RecentChangesRepoResult[];
}

async function logRevision(repoPath: string): Promise<string> {
  // A shared clone can sit behind its upstream; what was merged is upstream.
  try {
    const upstream = (
      await __recentChangesGit.run(['rev-parse', '--verify', '--quiet', '@{upstream}'], repoPath)
    ).trim();
    if (upstream) return upstream;
  } catch {
    // No upstream: the checkout itself.
  }
  return 'HEAD';
}

/**
 * Recent commits that touched what the report names, per repo, as a prompt
 * block marked as hints. Empty block when nothing matched, nothing changed in
 * the window, or git failed.
 */
export async function recentChangesNear(params: {
  repos: Array<{ key: string; path: string }>;
  reportText: string;
  days?: number;
  maxLines?: number;
}): Promise<RecentChanges> {
  const days = params.days ?? RECENT_CHANGES_DAYS;
  const maxLines = params.maxLines ?? RECENT_CHANGES_MAX_LINES;
  const candidates = reportCandidates(params.reportText);
  const matched: RecentChangesRepoResult[] = [];
  if (candidates.length === 0) return { block: '', matched };

  const sections: string[] = [];
  let lines = 0;
  for (const repo of params.repos) {
    if (lines >= maxLines) break;
    try {
      const tracked = (await __recentChangesGit.run(['ls-files'], repo.path)).split('\n').filter(Boolean);
      const matches = matchPathspecs(tracked, candidates);
      if (matches.length === 0) continue;
      const pathspecs = matches.map(match => match.pathspec);
      const revision = await logRevision(repo.path);
      const log = await __recentChangesGit.run(
        [
          'log',
          revision,
          '--no-merges',
          `--since=${days}.days`,
          '--date=short',
          '--format=%h %cd %s',
          '-n',
          String(maxLines - lines),
          '--',
          ...pathspecs,
        ],
        repo.path,
      );
      const commits = log
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, maxLines - lines);
      matched.push({ repo: repo.key, pathspecs, commits: commits.length });
      if (commits.length === 0) continue;
      lines += commits.length;
      const where = matches.map(match => `${match.pathspec} ("${match.candidate.phrase}")`).join(', ');
      sections.push(`${repo.key}: ${where}\n${commits.map(commit => `- ${commit}`).join('\n')}`);
    } catch {
      // A repo git can't read adds nothing; the investigation goes on without it.
    }
  }
  if (sections.length === 0) return { block: '', matched };
  return {
    block: `Recent commits in folders and files whose names match words in the report (git log, last ${days} days, newest first, merges left out). These are unchecked hints: matched by name, they may be unrelated. Use one only if its diff touches the reported behaviour.\n${sections.join('\n')}`,
    matched,
  };
}

/** The same check for a lookup asked whether something is a bug or why it changed (issue #621). */
export const LOOKUP_RECENT_COMMITS_RULE =
  'When asked whether something is a bug, or why something changed or behaves as it does, and the current code does not show the problem, check the recent history before saying you cannot reproduce it: `cd <repo> && git log --since=<a few days before it was seen, or 14 days ago> --no-merges --date=short --format="%h %cd %s" -- <files involved>`. If a recent commit explains it, already fixed it, or changed it on purpose, say so with its short sha, date and PR number.';

/** The rule investigations follow before concluding a symptom can't be reproduced (issue #621). */
export const RECENT_COMMITS_RULE = [
  'If the code or data does not reproduce the reported symptom, do not conclude "cannot reproduce" or "stale cache" yet. First read the recent history of the files involved: `cd <repo> && git log --since=<a few days before the symptom date, or 14 days ago if unknown> --no-merges --date=short --format="%h %cd %s" -- <files involved>`, then `git show <sha>` on any commit that touches the behaviour. Then:',
  '- a merged commit already fixed the bug → fixLocation "none" (already fixed on the default branch);',
  '- a commit changed the behaviour on purpose (a requested copy, price or rule change) → fixLocation "none" (works as intended), and cite the commit;',
  '- a commit introduced the problem (a regression) → fixLocation "repo", and name that commit as the cause.',
  'Cite such a commit in evidence: file = a file it changed, line = 0 unless you opened that exact line (never invent one), why = "<sha> <subject>, merged <date>". In summary give the date it was merged; for newton-web add that it is live once deployed (its production deploys are manual). If a git log form is refused, use the plain `git log --since=… -- <path>` form.',
].join('\n');
