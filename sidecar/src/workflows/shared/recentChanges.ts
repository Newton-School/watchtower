import { execFile } from 'node:child_process';

/**
 * Recent commits near what a report names, read before an investigation
 * starts (issue #621). On 16 Oct three investigations in a row read code
 * that had already been fixed, never ran git, and concluded "cannot
 * reproduce"; the fourth found the fix, merged two days earlier, with one
 * `git log`. This hands the investigator that `git log` up front.
 *
 * What counts as "near": a file path written in the report, a page slug
 * from a newtonschool.co link, or a run of two to four words in the report
 * that is the name of a folder in the repo ("Agentic AI course" →
 * `src/features/agentic-ai-course`). Bounded on every side: a few folders
 * per repo, a short window, a fixed number of lines. Any git failure leaves
 * the block out; it never stops the investigation.
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
  /(?:^|[\s`'"(<|])((?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|mjs|py|md|json|css|scss|html|ya?ml))(?=$|[\s`'")>|:,.])/g;
const URL_RE = /https?:\/\/[^\s|>]+/g;
const GENERIC_SLUGS = new Set(['courses', 'course', 'pages', 'page', 'www', 'blog', 'apply', 'home']);

/** File paths, page slugs and two-to-four-word phrases (as slugs) a report mentions. */
export function reportCandidates(text: string): { paths: string[]; slugs: string[] } {
  const plain = text.replace(/<@[^>]+>/g, ' ');
  const paths = new Set<string>();
  for (const match of plain.matchAll(FILE_PATH_RE)) paths.add(match[1]);

  const slugs = new Set<string>();
  for (const url of plain.match(URL_RE) ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(url.replace(/[).,]+$/, ''));
    } catch {
      continue;
    }
    if (!/newtonschool\.co$/i.test(parsed.hostname)) continue;
    for (const segment of parsed.pathname.split('/')) {
      const slug = segment.toLowerCase();
      if (/^[a-z0-9][a-z0-9_-]{3,}$/.test(slug) && !GENERIC_SLUGS.has(slug)) slugs.add(slug);
    }
  }

  const words = plain
    .replace(URL_RE, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let size = 2; size <= 4; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      slugs.add(words.slice(start, start + size).join('-'));
    }
  }
  return { paths: [...paths], slugs: [...slugs] };
}

/**
 * The files and folders in a repo that the candidates name: a tracked file
 * whose path ends with a candidate path, and every folder whose name is a
 * candidate slug (a page's feature folder and its route folder are often
 * both). A folder inside another chosen folder adds nothing. At most a few.
 */
export function matchPathspecs(trackedFiles: string[], candidates: { paths: string[]; slugs: string[] }): string[] {
  const files = new Set<string>();
  for (const candidate of candidates.paths) {
    const hit = trackedFiles.find(file => file === candidate || file.endsWith(`/${candidate}`));
    if (hit) files.add(hit);
  }
  const dirs = new Set<string>();
  if (candidates.slugs.length > 0) {
    const wanted = new Set(candidates.slugs);
    for (const file of trackedFiles) {
      const parts = file.split('/');
      // The shallowest folder on this file's path whose name is wanted.
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (!wanted.has(parts[depth - 1].toLowerCase())) continue;
        dirs.add(parts.slice(0, depth).join('/'));
        break;
      }
    }
  }
  const chosenDirs = [...dirs].sort().filter((dir, _i, all) => !all.some(other => dir.startsWith(`${other}/`)));
  const inChosenDir = (file: string) => chosenDirs.some(dir => file.startsWith(`${dir}/`));
  return [...[...files].filter(file => !inChosenDir(file)), ...chosenDirs].slice(0, MAX_PATHSPECS_PER_REPO);
}

/**
 * A prompt block listing recent commits that touched what the report names,
 * per repo, or '' when there is nothing to show (no match, no commits, or git
 * failed).
 */
export async function recentChangesNear(params: {
  repos: Array<{ key: string; path: string }>;
  reportText: string;
  days?: number;
  maxLines?: number;
}): Promise<string> {
  const days = params.days ?? RECENT_CHANGES_DAYS;
  const maxLines = params.maxLines ?? RECENT_CHANGES_MAX_LINES;
  const candidates = reportCandidates(params.reportText);
  if (candidates.paths.length === 0 && candidates.slugs.length === 0) return '';

  const sections: string[] = [];
  let lines = 0;
  for (const repo of params.repos) {
    if (lines >= maxLines) break;
    try {
      const tracked = (await __recentChangesGit.run(['ls-files'], repo.path)).split('\n').filter(Boolean);
      const pathspecs = matchPathspecs(tracked, candidates);
      if (pathspecs.length === 0) continue;
      const log = await __recentChangesGit.run(
        [
          'log',
          `--since=${days}.days`,
          '--date=short',
          '--format=%h %ad %s',
          `-n`,
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
      if (commits.length === 0) continue;
      lines += commits.length;
      sections.push(`${repo.key} (${pathspecs.join(', ')}):\n${commits.map(commit => `- ${commit}`).join('\n')}`);
    } catch {
      // A repo git can't read adds nothing; the investigation goes on without it.
    }
  }
  if (sections.length === 0) return '';
  return `Recent changes near what was reported (git log, last ${days} days, newest first):\n${sections.join('\n')}\nCheck these first: a change merged before or after the report may explain the symptom or already fix it.`;
}

/** The same check for a lookup asked whether something is a bug or why it changed (issue #621). */
export const LOOKUP_RECENT_COMMITS_RULE =
  'When asked whether something is a bug, or why something changed or behaves as it does, and the current code does not show the problem, check the recent history before saying you cannot reproduce it: `cd <repo> && git log --since=<a few days before it was seen, or 14 days ago> --date=short --format="%h %ad %s" -- <files involved>`. If a recent commit explains it or already fixed it, say so with its short sha, date and PR number.';

/** The rule investigations follow before concluding a symptom can't be reproduced (issue #621). */
export const RECENT_COMMITS_RULE =
  'If the code or data does not reproduce the reported symptom, do not conclude "cannot reproduce" or "stale cache" yet. First run `git log --since=<a few days before the symptom date, or 14 days ago if unknown> --date=short --format="%h %ad %s" -- <files involved>` in the repo that owns them (`cd <repo> && git log …`), and `git show <sha>` on any commit that touches the behaviour. If a merged commit explains the symptom or already fixed it, say so in summary and rootCauseHypothesis with its short sha, date and PR number (from the subject), put it in evidence (file: the file it changed, snippet: "<sha> <subject>"), and use fixLocation "none" (already fixed on the default branch) unless another defect remains. If a git log form is refused, use the plain `git log --since=… -- <path>` form.';
