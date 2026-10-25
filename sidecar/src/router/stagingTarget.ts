import type { NormalizedTask, PrTarget } from '../types/contracts.js';
import { namesStagingAsTarget } from './intentParser.js';

/**
 * Reading what a staging ask names (issue #702): a branch, main, or a pull
 * request. Pure, so the staging tool, the router and the resume of a parked
 * "which PR or branch?" all read a message the same way.
 */

export const MARKETING_REPO = 'newton-marketing-web';

/** Words that follow "branch" or make up a one-word reply but are not branch names. */
const NOT_BRANCHES = new Set([
  ...['to', 'on', 'onto', 'in', 'of', 'the', 'that', 'this', 'it', 'for', 'is', 'name', 'please', 'pls'],
  ...['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'no', 'nope', 'go', 'thanks', 'staging', 'stg'],
]);
const SLASH_WORDS = new Set(['and/or', 'either/or', 'w/o', 'n/a', 'i/o', 'on/off', 'yes/no', 'he/she', 'his/her']);
const BRANCH_TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]|[A-Za-z0-9]`;
/** A ref that is safe to pass to `gh` and to show in Slack as is. */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
const MARKETING_RE = /\b(?:marketing|newton-marketing-web|nmw|mweb)\b/;
/** Another app named. */
const OTHER_APP_RE = /\b(?:newton[- ]web|newton[- ]api|backend|the api|my\.newtonschool)\b/;
const STAGING = String.raw`(?:the\s+)?(?:marketing\s+)?(?:staging|stg)`;
/** main as what goes on staging, never main as a word in passing ("before I push to main"). */
const MAIN_TARGET_RES = [
  new RegExp(
    String.raw`\b(?:deploy|put|push|ship|restore|move|switch|bring|get)\s+(?:(?:the|marketing|newton-marketing-web)\s+)*(?:branch\s+)?(main|master)\s+(?:branch\s+)?(?:back\s+)?(?:to|on|onto|in)\s+${STAGING}\b`,
  ),
  new RegExp(String.raw`\b(?:staging|stg)\s+back\s+to\s+(main|master)\b`),
  new RegExp(String.raw`\b(?:reset|restore|switch|revert|put|bring)\s+${STAGING}\s+(?:back\s+)?to\s+(main|master)\b`),
  new RegExp(String.raw`^(main|master)\s+(?:back\s+)?(?:to|on|onto)\s+${STAGING}(?:\s+(?:please|pls|now))?$`),
];

/** The message as words: no mentions, links, channel references or "Sent using" footer. */
export function stagingPlainText(text: string): string {
  return text
    .replace(/\*sent using\*.*$/is, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface StagingAsk {
  /** "branch fix/hero", a backticked name, or (answering "which?") a reply that is only a name. */
  explicitBranch?: string;
  /** main is what should go on staging. */
  main: boolean;
  /** Bare `team/topic` words, which may just be words ("UI/UX"): each is checked on GitHub, in order. */
  looseBranches: string[];
  /** PRs named without a link: "PR #1484", "pull request 12"; a bare number only when answering "which?". */
  prNumbers: number[];
}

const clean = (name: string) => name.replace(/[.,;:!?)]+$/, '');
const MAIN_BRANCH_RE = /^(?:main|master)$/i;

/**
 * A reply that is only an answer to "which PR or branch?": a name, main, a
 * number or `#N`, with at most a lead-in word ("PR 1484", "branch fix/hero").
 */
function readAnswerOnly(plain: string): StagingAsk | undefined {
  const only =
    /^(?:(?:pr|pull request|branch|use|it'?s|its|the|try)\s+)?[`'"]?(#?[A-Za-z0-9][A-Za-z0-9._/-]*)[`'"]?[.!]?$/i.exec(
      plain,
    );
  if (!only) return undefined;
  const token = clean(only[1]);
  const ask: StagingAsk = { main: false, looseBranches: [], prNumbers: [] };
  const number = /^#?(\d{1,6})$/.exec(token);
  if (number) ask.prNumbers.push(Number(number[1]));
  else if (MAIN_BRANCH_RE.test(token)) ask.main = true;
  else if (!token.startsWith('#') && !NOT_BRANCHES.has(token.toLowerCase())) ask.explicitBranch = token;
  else return undefined;
  return ask;
}

/**
 * What a staging ask names. `answeringWhich`: the message is the reply to
 * "Which PR or branch should I put on staging?", where a bare name, number
 * or `#N` is the answer; anywhere else `#N` is as likely an issue or a colour.
 */
export function readStagingAsk(text: string, options: { answeringWhich?: boolean } = {}): StagingAsk {
  const plain = stagingPlainText(text);
  const lower = plain.toLowerCase();
  const ask: StagingAsk = { main: false, looseBranches: [], prNumbers: [] };

  if (options.answeringWhich) {
    const answer = readAnswerOnly(plain);
    if (answer) return answer;
  }

  const named = new RegExp(String.raw`\bbranch(?:\s+is)?[:\s]+[\`'"]?(${BRANCH_TOKEN})`, 'i').exec(plain);
  if (named && !NOT_BRANCHES.has(named[1].toLowerCase())) {
    const name = clean(named[1]);
    if (MAIN_BRANCH_RE.test(name)) ask.main = true;
    else ask.explicitBranch = name;
  }
  if (!ask.explicitBranch) {
    const ticked = /`([A-Za-z0-9][A-Za-z0-9._/-]*)`/.exec(plain);
    if (ticked && ticked[1].includes('/')) ask.explicitBranch = clean(ticked[1]);
  }
  if (MAIN_TARGET_RES.some(re => re.test(lower))) ask.main = true;

  for (const match of plain.matchAll(new RegExp(String.raw`(?:^|\s)(${BRANCH_TOKEN})(?=$|[\s,.!?;:)])`, 'g'))) {
    const token = clean(match[1]);
    if (!token.includes('/') || SLASH_WORDS.has(token.toLowerCase()) || !/[A-Za-z]/.test(token)) continue;
    if (token !== ask.explicitBranch && !ask.looseBranches.includes(token)) ask.looseBranches.push(token);
  }

  for (const match of plain.matchAll(/\b(?:pr|pull request)\s*#?\s*(\d{1,6})\b/gi)) {
    const number = Number(match[1]);
    if (!ask.prNumbers.includes(number)) ask.prNumbers.push(number);
  }
  return ask;
}

export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCH_RE.test(branch);
}

/** A ref safe to hand to `gh` and to show in Slack unescaped. */
export function isSafeRef(branch: string): boolean {
  return SAFE_REF_RE.test(branch) && !branch.includes('..');
}

/**
 * Whether a reply to "Which PR or branch should I put on staging?" is shaped
 * like an answer: a branch name, main, a PR number or `#N`, or only a PR link.
 * Such a reply goes straight back to the staging tool; anything else ("never
 * mind, review this PR") goes to the router.
 */
export function isStagingTargetAnswer(text: string): boolean {
  const withoutMentions = text.replace(/\*sent using\*.*$/is, ' ').replace(/<@[^>]+>/g, ' ');
  const links = withoutMentions.match(GITHUB_PR_URL_RE)?.length ?? 0;
  if (links > 0) {
    const rest = stagingPlainText(withoutMentions).toLowerCase();
    return /^(?:(?:this|that|use|it'?s|its|the|pr|branch|one|please|pls|here|it|is)\s*)*[.!]?$/.test(rest);
  }
  return readAnswerOnly(stagingPlainText(withoutMentions)) !== undefined;
}

/** The message names production: never a staging deploy, whatever was picked. */
export function mentionsProd(text: string): boolean {
  return /\b(?:prod|production)\b/.test(stagingPlainText(text).toLowerCase());
}

/** The message names another app, and not the marketing site. */
export function namesOtherApp(text: string): boolean {
  const lower = stagingPlainText(text).toLowerCase();
  return OTHER_APP_RE.test(lower) && !MARKETING_RE.test(lower);
}

export function isMarketingPr(pr: PrTarget, org: string): boolean {
  return pr.repo.toLowerCase() === MARKETING_REPO && pr.owner.toLowerCase() === org.toLowerCase();
}

/**
 * A staging ask the router read as a production deploy, that is the
 * marketing site's: it names staging as where it goes, and the marketing
 * site by name or by a PR in the message or thread, and no other app.
 */
export function isMarketingStagingAsk(task: NormalizedTask, org: string): boolean {
  const text = task.event.text ?? '';
  if (!namesStagingAsTarget(text) || namesOtherApp(text)) return false;
  const prs = task.prContexts ?? [];
  if (prs.some(pr => pr.source === 'trigger' && !isMarketingPr(pr, org))) return false;
  return MARKETING_RE.test(stagingPlainText(text).toLowerCase()) || prs.some(pr => isMarketingPr(pr, org));
}
