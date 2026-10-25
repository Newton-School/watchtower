import type { NormalizedTask, PrTarget } from '../types/contracts.js';
import { namesStagingAsTarget } from './intentParser.js';

/**
 * Reading what a staging ask names (issue #702): a branch, main, or a pull
 * request. Pure, so the staging tool, the router and the resume of a parked
 * "which PR or branch?" all read a message the same way.
 */

export const MARKETING_REPO = 'newton-marketing-web';

/** Words that follow "branch" but are not branch names. */
const NOT_BRANCHES = new Set([
  ...['to', 'on', 'onto', 'in', 'of', 'the', 'that', 'this', 'it', 'for', 'is', 'was', 'has', 'name', 'please', 'pls'],
  ...['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'no', 'nope', 'go', 'thanks', 'staging', 'stg', 'a', 'an', 'and'],
  // "the branch looks good": a verb after "branch" says something about it, it doesn't name it.
  ...['looks', 'seems', 'works', 'should', 'needs', 'got', 'now', 'still', 'passes', 'builds', 'can', 'will'],
]);
const SLASH_WORDS = new Set(['and/or', 'either/or', 'w/o', 'n/a', 'i/o', 'on/off', 'yes/no', 'he/she', 'his/her']);
const BRANCH_TOKEN = String.raw`[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]|[A-Za-z0-9]`;
/** A ref that is safe to pass to `gh` and to show in Slack as is. */
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** What makes a word look like a branch rather than a word: `fix/hero`, `hero-v2`, `ns_1489`. */
const REF_SIGNAL_RE = /[/_\d-]/;
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;
const MARKETING_RE = /\b(?:marketing|newton-marketing-web|nmw|mweb)\b/;
const MAIN_WORD_RE = /^(?:main|master)$/i;
const OTHER_APP = String.raw`(?:newton[- ]web|newton[- ]api|backend|api|my\.newtonschool(?:\.co)?)`;
/** Another app as where the deploy goes, not merely mentioned ("the api change is merged"). */
const OTHER_APP_TARGET_RES = [
  new RegExp(
    String.raw`\b(?:deploy|put|push|ship|release|get)\s+(?:(?:the|my|this|our|that)\s+)?${OTHER_APP}\b(?!\s+(?:is|was|has|are)\b)`,
  ),
  new RegExp(
    String.raw`\b(?:testing|test|staging|preview)\s+(?:link|url|env(?:ironment)?)\s+(?:for|of|on)\s+(?:(?:the|my|this|our)\s+)?${OTHER_APP}\b`,
  ),
  new RegExp(String.raw`\b${OTHER_APP}\s+(?:(?:to|on|onto)\s+(?:the\s+)?)?(?:staging|stg)\b`),
];
const STAGING = String.raw`(?:the\s+)?(?:marketing\s+)?(?:staging|stg)`;
/** main as what goes on staging, never main as a word in passing ("before I push to main"). */
const MAIN_TARGET_RES = [
  new RegExp(
    String.raw`\b(?:deploy|put|push|ship|restore|move|switch|bring|get)\s+(?:(?:the|marketing|newton-marketing-web)\s+)*(?:branch\s+)?(?:main|master)\s+(?:branch\s+)?(?:back\s+)?(?:to|on|onto|in)\s+${STAGING}\b`,
  ),
  new RegExp(String.raw`\b(?:staging|stg)\s+back\s+to\s+(?:main|master)\b`),
  new RegExp(String.raw`\b(?:reset|restore|switch|revert|put|bring)\s+${STAGING}\s+(?:back\s+)?to\s+(?:main|master)\b`),
  new RegExp(String.raw`^(?:main|master)\s+(?:back\s+)?(?:to|on|onto)\s+${STAGING}(?:\s+(?:please|pls|now))?$`),
];
/**
 * A time for later in the same clause: main is asked for then, not now
 * ("switch staging back to main tomorrow"). Only real times: "when you get a
 * chance", "then" or "the next person" are now.
 */
const LATER_RE =
  /\b(?:tomorrow|tonight|later|eod|end of (?:the )?day|this evening|next (?:week|month|sprint|monday|tuesday|wednesday|thursday|friday)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|after (?:lunch|the demo|the meeting|the call|qa)|once qa is (?:done|over|finished))\b/;

/** The message asks for a link to test something now ("give me a testing link"). */
const LINK_ASK_RE = /\b(?:testing|test|preview|staging)\s+(?:link|url)s?\b/;

export function asksForTestingLink(text: string): boolean {
  return LINK_ASK_RE.test(stagingPlainText(text).toLowerCase());
}

/** The message as words: no mentions, links, channel references or "Sent using" footer. */
export function stagingPlainText(text: string): string {
  return text
    .replace(/\*sent using\*.*$/is, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words a guard reads: no links, and no ref-shaped tokens (`fix/prod-banner`, `` `x` ``). */
function guardWords(text: string): string {
  return stagingPlainText(text)
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S*\/\S*/g, ' ')
    .toLowerCase();
}

export interface StagingAsk {
  /** A ref-like name after "branch", a backticked name, or (answering "which?") a reply that is only a ref. */
  explicitBranch?: string;
  /** main is what should go on staging. */
  main: boolean;
  /** main is asked for at a later time ("tomorrow"): nothing to deploy now. */
  mainLater?: boolean;
  /**
   * Names that may be words ("UI/UX", "the branch is ready"): each is checked
   * on GitHub, in order, and one that doesn't exist is passed over in silence.
   */
  looseBranches: string[];
  /** PRs named without a link: "PR #1484", "pull request 12"; a bare number only when answering "which?". */
  prNumbers: number[];
}

const clean = (name: string) => name.replace(/[.,;:!?)]+$/, '');
const emptyAsk = (): StagingAsk => ({ main: false, looseBranches: [], prNumbers: [] });

/**
 * A reply that is only an answer to "which PR or branch?", with a ref signal:
 * a PR number ("1484", "#1484", "PR1484"), main, a name with a slash, digit,
 * dash or underscore, a backticked name, or any name after "branch". A plain
 * word ("help", "stop", "both", "latest") is not one: it goes to the router.
 */
function readAnswerOnly(plain: string): StagingAsk | undefined {
  const text = plain.replace(/[.!]+$/, '').trim();
  const ask = emptyAsk();
  const number =
    /^(?:(?:use|it'?s|its|try|the)\s+)?(?:(?:pr|pull request)[\s-]*)?#?\s*(\d{1,6})(?:\s+(?:please|pls|one))?$/i.exec(
      text,
    );
  if (number) {
    ask.prNumbers.push(Number(number[1]));
    return ask;
  }
  if (/^(?:(?:use|it'?s|its|the|try)\s+)?(?:main|master)(?:\s+branch)?$/i.test(text)) {
    ask.main = true;
    return ask;
  }
  const afterBranch = /^(?:(?:use|try)\s+)?(?:the\s+)?branch\s*:?\s+[`'"]?([A-Za-z0-9][A-Za-z0-9._/-]*)[`'"]?$/i.exec(
    text,
  );
  if (afterBranch && !NOT_BRANCHES.has(afterBranch[1].toLowerCase()) && !/^\d+$/.test(afterBranch[1])) {
    if (MAIN_WORD_RE.test(afterBranch[1])) ask.main = true;
    else ask.explicitBranch = afterBranch[1];
    return ask;
  }
  const only = /^(?:(?:use|it'?s|its|try)\s+)?([`'"]?)([A-Za-z0-9][A-Za-z0-9._/-]*)\1$/i.exec(text);
  if (only && !/^\d+$/.test(only[2]) && (only[1] === '`' || REF_SIGNAL_RE.test(only[2]))) {
    ask.explicitBranch = only[2];
    return ask;
  }
  return undefined;
}

/** Whether the message asks for main on staging: now, later (a time in its clause), or not at all. */
function asksForMain(lower: string): 'now' | 'later' | undefined {
  for (const re of MAIN_TARGET_RES) {
    const match = re.exec(lower);
    if (!match) continue;
    const start = Math.max(...[',', ';', '.', '!', '?'].map(mark => lower.lastIndexOf(mark, match.index)));
    const rest = lower.slice(match.index + match[0].length);
    const end = rest.search(/[,;.!?]/);
    const clause = lower.slice(start + 1, match.index + match[0].length) + (end < 0 ? rest : rest.slice(0, end));
    return LATER_RE.test(clause) ? 'later' : 'now';
  }
  return undefined;
}

/**
 * What a staging ask names. `answeringWhich`: the message is the reply to
 * "Which PR or branch should I put on staging?", where a bare ref, number or
 * `#N` is the answer; anywhere else `#N` is as likely an issue or a colour.
 */
export function readStagingAsk(text: string, options: { answeringWhich?: boolean } = {}): StagingAsk {
  const plain = stagingPlainText(text);
  const lower = plain.toLowerCase();

  if (options.answeringWhich) {
    const answer = readAnswerOnly(plain);
    if (answer) return answer;
  }

  const ask = emptyAsk();
  const named = new RegExp(
    String.raw`\bbranch(?:\s+(name\s+is|is|was|has|called|named))?(\s*:\s*|\s+)([\`'"]?)(${BRANCH_TOKEN})\3`,
    'i',
  ).exec(plain);
  if (named && !NOT_BRANCHES.has(named[4].toLowerCase()) && !/^\d+$/.test(named[4])) {
    const name = clean(named[4]);
    // "branch redesign", "branch: fix", "branch `hero`" name a ref; after "branch
    // is/was/has" only a ref-shaped word does ("the branch is ready" does not).
    const describes = /^(?:is|was|has)$/i.test(named[1] ?? '');
    const refLike = !describes || named[2].includes(':') || named[3] !== '' || REF_SIGNAL_RE.test(name);
    if (MAIN_WORD_RE.test(name)) ask.main = true;
    else if (refLike) ask.explicitBranch = name;
    else ask.looseBranches.push(name);
  }
  if (!ask.explicitBranch) {
    const ticked = /`([A-Za-z0-9][A-Za-z0-9._/-]*)`/.exec(plain);
    if (ticked && ticked[1].includes('/')) ask.explicitBranch = clean(ticked[1]);
  }
  const main = asksForMain(lower);
  if (main === 'now') ask.main = true;
  else if (main === 'later') ask.mainLater = true;

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

/** Exactly `main`: a `Main` or `master` head is someone's branch, checked like any other. */
export function isMainBranch(branch: string): boolean {
  return branch === 'main';
}

/** A ref safe to hand to `gh` and to show in Slack unescaped. */
export function isSafeRef(branch: string): boolean {
  return SAFE_REF_RE.test(branch) && !branch.includes('..');
}

/**
 * Whether a reply to "Which PR or branch should I put on staging?" is shaped
 * like an answer: a ref (see `readAnswerOnly`) or only a PR link. Such a reply
 * goes straight back to the staging tool; anything else ("help", "never mind,
 * review this PR") goes to the router.
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

/**
 * The message names production: never a staging deploy, whatever was picked.
 * Not inside a link, a branch name (`fix/prod-banner`) or "pre-prod".
 */
export function mentionsProd(text: string): boolean {
  return /(?<![\w-])(?:prod|production)(?![\w-])/.test(guardWords(text));
}

/**
 * Another app is where the deploy goes ("deploy newton-web to staging",
 * "testing link for the api"), and the marketing site isn't named. Merely
 * mentioning one ("the api change is merged already") is not that.
 */
export function namesOtherApp(text: string): boolean {
  const words = guardWords(text);
  return OTHER_APP_TARGET_RES.some(re => re.test(words)) && !MARKETING_RE.test(words);
}

export function isMarketingPr(pr: PrTarget, org: string): boolean {
  return pr.repo.toLowerCase() === MARKETING_REPO && pr.owner.toLowerCase() === org.toLowerCase();
}

/** A report of something wrong with staging, not an ask to deploy to it. */
const PROBLEM_RE = /\b(?:fail(?:s|ed|ing|ure)?|broken|breaks?|stuck|errors?|issue|bug|why|not working|down)\b/;
/** A request to deploy to staging, as a verb ("can you deploy it to staging again?"), not the noun "the deploy". */
const STAGING_REQUEST_RE =
  /(?:^|[,;.!?]\s*|\b(?:can|could|would|will) you\s+|\bplease\s+|\bpls\s+|\bkindly\s+)(?:please\s+)?(?:re-?deploy|deploy|put|push|ship)\s+(?:[^\s,.;!?]+\s+){0,3}?(?:back\s+|again\s+)?(?:to|on|onto)\s+(?:the\s+)?(?:marketing\s+)?(?:staging|stg)\b/;

/**
 * A staging ask the router read as a production deploy, that is the
 * marketing site's: it names staging as where it goes, and the marketing
 * site by name or by a PR in the message or thread, no other app, and it
 * reports no problem ("the marketing deploy to staging failed") unless it
 * also asks for the deploy ("…can you deploy it to staging again?").
 */
export function isMarketingStagingAsk(task: NormalizedTask, org: string): boolean {
  const text = task.event.text ?? '';
  if (!namesStagingAsTarget(text) || namesOtherApp(text)) return false;
  const words = guardWords(text);
  if (PROBLEM_RE.test(words) && !STAGING_REQUEST_RE.test(words)) return false;
  const prs = task.prContexts ?? [];
  if (prs.some(pr => pr.source === 'trigger' && !isMarketingPr(pr, org))) return false;
  return MARKETING_RE.test(stagingPlainText(text).toLowerCase()) || prs.some(pr => isMarketingPr(pr, org));
}
