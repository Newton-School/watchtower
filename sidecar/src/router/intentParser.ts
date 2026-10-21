import type {
  AppConfig,
  MiniogSubcommand,
  NormalizedTask,
  PrContext,
  SlackEventEnvelope,
  WorkflowIntent,
} from '../types/contracts.js';
import { getAdminUserIds } from '../access/control.js';
import { isDossierForgetField, isDossierRole } from '../state/dossierStore.js';
import { hasDevAssistPrefix, hasNaturalDevAssistAlias } from './devAssistParser.js';
import { extractAllPrContexts } from './prTargetResolver.js';

const GITHUB_PR_URL_TEST_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

// Matches Metabase URLs across deployments — official `metabase.com` and
// self-hosted instances whose hostname starts with `metabase` (e.g.
// `metabase-lierhfgoeiwhr.newtonschool.co`). Used to short-circuit the
// pre-classifier so "explain this table/query/dashboard" questions don't
// seed as IMPLEMENTATION and trip the access-drop confidence guardrail
// (see `router/taskRouter.ts` `router.classify.low_confidence_hold`).
const METABASE_URL_REGEX = /https?:\/\/(?:[a-z0-9-]+\.)*metabase[a-z0-9-]*\.[a-z][a-z0-9.-]+\//i;

export function containsMetabaseUrl(text: string | undefined | null): boolean {
  if (!text) return false;
  return METABASE_URL_REGEX.test(text);
}

const DEPLOY_VERB_RE = /\b(deploy|ship|release|push to prod|push prod)\b/;
// Tokens that pick the MARKETING deploy flow. Deliberately narrow: generic
// words like "landing" or "homepage" also describe newton-web product screens
// and would let an incidental mention hijack (or veto) a production deploy.
const MARKETING_DEPLOY_REF_RE = /\b(marketing|mweb|nmw|newton[- ]?marketing([- ]?web)?|webflow|wrangler|cloudflare)\b/;
// An explicitly named newton-web target always wins, even when marketing is
// mentioned incidentally ("deploy newton-web to prod — marketing needs the
// banner live").
const NEWTON_WEB_REF_RE = /\bnewton[- ]?web\b/;
// Targets that are genuinely ambiguous between the two frontends (NSAT/NST
// pages exist in both: public admission landing pages in marketing, the
// logged-in timeline/test flows in newton-web). A deploy ask naming only
// these must not deterministically fire EITHER prod deploy.
const AMBIGUOUS_DEPLOY_TARGET_RE = /\b(landing([- ]?pages?)?|homepage|newton[- ]?school|nsat|nst)\b/;

/**
 * Whether a deploy ask mentions staging and never prod or production. Such an
 * ask gets the staging instructions instead of a production deploy offer: if
 * staging was only context, the cost is one re-ask that says prod; if it was
 * the target, a production prompt would be in front of someone who wanted
 * staging. Links, link labels, channel references and mentions are removed
 * first, so their words never decide it, and "stage" does not count.
 */
export function mentionsStagingNotProd(text: string): boolean {
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase();
  return /\b(staging|stg)\b/.test(plain) && !/\b(prod|production)\b/.test(plain);
}

function normalizeDeployText(text: string): string {
  return (
    text
      .replace(/<@[^>]+>/g, ' ')
      // A link is not an instruction: a newton-web PR URL must not count as
      // naming the deploy target (issue #428). A Slack link keeps its label.
      .replace(/<https?:[^>|]*(?:\|([^>]*))?>/g, ' $1 ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim()
  );
}

export type DeployTarget = 'newton-web' | 'newton-marketing-web' | 'ambiguous';

/**
 * Deterministic deploy-target classification. This is the ONLY producer of
 * the DEPLOY intent (the AI intent classifier cannot emit DEPLOY), so every
 * deploy-shaped ask must resolve here — including the ambiguous ones.
 *
 * Precedence:
 * - Explicit signals for BOTH repos in one message ⇒ 'ambiguous'. Picking a
 *   winner is unsafe in both directions (either repo could be hijacked into
 *   a wrong production deploy by an incidental mention of the other).
 * - Exactly one explicit repo signal ⇒ that repo.
 * - Frontend-ambiguous nouns (landing/homepage/newton school/NSAT/NST) WITH a
 *   prod token ⇒ 'ambiguous' — never guess a prod deploy from those. Without
 *   a prod token they are not a deploy ask at all: deploy verbs double as
 *   ordinary chatter ("release the NSAT results page fix", "ship the
 *   homepage banner"), which must keep flowing to the normal classifier.
 * - Bare "deploy to prod" / "deploy the frontend" ⇒ newton-web (historical
 *   behavior; prod was the only deploy target before marketing existed).
 *
 * The deploy workflow resolves 'ambiguous' with config: hosts without the
 * marketing clone have exactly one deployable frontend and behave as before;
 * hosts with it get a clarify reply instead of a guessed production deploy.
 */
export function classifyDeployTarget(text: string): DeployTarget | null {
  const normalized = normalizeDeployText(text);
  if (!DEPLOY_VERB_RE.test(normalized)) return null;

  const namesNewtonWeb = NEWTON_WEB_REF_RE.test(normalized);
  const namesMarketing = MARKETING_DEPLOY_REF_RE.test(normalized);
  if (namesNewtonWeb && namesMarketing) return 'ambiguous';
  if (namesNewtonWeb) return 'newton-web';
  if (namesMarketing) return 'newton-marketing-web';

  const hasProdTarget = /\b(prod|production)\b/.test(normalized);
  if (AMBIGUOUS_DEPLOY_TARGET_RE.test(normalized)) {
    return hasProdTarget ? 'ambiguous' : null;
  }

  const hasAppRef = /\bfrontend\b/.test(normalized);
  return hasProdTarget || hasAppRef ? 'newton-web' : null;
}

/**
 * The deploy target, but only when the message leads with the deploy ask:
 * the verb has to be in its first sentence. Used where a deploy is about to
 * be allowed (see `mayDeploy`), which is stricter than seeding a hint.
 *
 * `classifyDeployTarget` alone finds "newton-web" and "deploy" anywhere, so
 * "could you review these two please? • newton-web <PR> *Deploy order:* …"
 * has a target by its lights (issue #428). A request that leads with something
 * else is not a deploy request, whatever its later lines mention.
 */
export function leadingDeployTarget(text: string): DeployTarget | null {
  const firstSentence =
    text
      .replace(/<@[^>]+>/g, ' ')
      .replace(/<https?:[^>|]*(?:\|([^>]*))?>/g, ' $1 ')
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[.?!\n•]+/)
      .map(part => part.trim())
      .find(part => part.length > 0) ?? '';
  if (!DEPLOY_VERB_RE.test(firstSentence.toLowerCase())) return null;
  return classifyDeployTarget(text);
}

/**
 * Deterministic check: does the message unambiguously ask to deploy
 * newton-web to production? Runs before the AI classifier so deploy requests
 * are never misrouted.
 */
export function isDeployRequest(text: string): boolean {
  return classifyDeployTarget(text) === 'newton-web';
}

/**
 * Deterministic check: does the message unambiguously ask to deploy the
 * MARKETING site (newton-marketing-web)? Kept separate from isDeployRequest
 * so the two deploy mechanisms (newton-web prod skill vs marketing GitHub
 * Actions dispatch) can never be confused for each other.
 */
export function isMarketingDeployRequest(text: string): boolean {
  return classifyDeployTarget(text) === 'newton-marketing-web';
}

export interface MentionInfo {
  detected: boolean;
  type: 'bot' | 'owner' | 'none';
  /**
   * The bot is mentioned, but only in passing: the message may be about miniOG
   * or addressed to someone else (issue #448). Still a bot mention; what
   * differs is that staying silent becomes a permitted answer.
   */
  reference?: boolean;
}

/** Words that, right before the bot's tag, make it a reference rather than an address. */
const REFERENCE_CUE_RE = /(?:^|[^a-z])(cc|fyi|by|from|per|as)\s*[:\-–—]?\s*$/i;
/** Other people's tags (and joiners) between a cue and the bot's tag: "cc: @a, @b and @miniOG". */
const TRAILING_TAGS_RE = /(?:\s|,|&|\band\b|<[@!][^>]+>)+$/i;
/** A message that opens by tagging a person or a user group. */
const LEADING_TAG_RE = /^[\s\-–—•*>]*<(?:@([A-Z0-9]+)|!subteam\^[^>]+)>/;

/**
 * True when every mention of the bot in `text` is a reference: a possessive
 * ("@miniOG's comments"), after a cue ("cc: @miniOG", "flagged by @miniOG",
 * "as @miniOG said"), or anywhere after another person's tag that opens the
 * message ("@owner I've resolved @miniOG's comments").
 *
 * "I've resolved @miniOG's comments, can you take a look?", written to the
 * owner, started a second review of a PR that had just been merged.
 */
export function isReferenceMention(text: string, botUserId: string): boolean {
  const token = `<@${botUserId}>`;
  if (!text.includes(token)) return false;

  const opening = text.match(LEADING_TAG_RE);
  if (opening && opening[1] !== botUserId) return true;

  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) {
    const after = text.slice(at + token.length);
    const before = text.slice(0, at).replace(TRAILING_TAGS_RE, '');
    const possessive = /^['’]s\b/i.test(after);
    if (!possessive && !REFERENCE_CUE_RE.test(before)) return false;
  }
  return true;
}

export function detectMention(text: string, config: AppConfig, channelType?: string): MentionInfo {
  if (!text) {
    if (channelType === 'im') {
      return { detected: true, type: 'bot' };
    }
    return { detected: false, type: 'none' };
  }

  const botMention = `<@${config.botUserId}>`;
  if (text.includes(botMention)) {
    // In a DM everything is addressed to the bot, however it is phrased.
    const reference = channelType !== 'im' && isReferenceMention(text, config.botUserId ?? '');
    return { detected: true, type: 'bot', ...(reference ? { reference } : {}) };
  }

  for (const ownerId of config.ownerSlackUserIds) {
    if (text.includes(`<@${ownerId}>`)) {
      return { detected: true, type: 'owner' };
    }
  }

  // In a direct message to the bot (channel_type=im), explicit mention markup is usually absent.
  // Treat any non-empty DM message as an implicit bot mention.
  if (channelType === 'im') {
    return { detected: true, type: 'bot' };
  }

  return { detected: false, type: 'none' };
}

/**
 * Back-compat single-PR view: the first PR URL across the given texts.
 * Multi-PR-aware callers should use `extractAllPrContexts` /
 * `resolvePrReviewTargets` (prTargetResolver.ts) instead — this picks one
 * URL with no knowledge of what the request asked for.
 */
export function extractPrContext(texts: string[]): PrContext | undefined {
  const [first] = extractAllPrContexts({ threadTexts: texts });
  if (!first) return undefined;
  return { url: first.url, owner: first.owner, repo: first.repo, number: first.number };
}

// Recognize "review" only as a request/imperative VERB, never as a noun. The
// old /\b(re-?review|review)\b/ matched any "review" (e.g. "undermining ur
// review"), tripping the deterministic PR_REVIEW gate on banter (RCA 2026-06-12,
// C01GRTNND8R/1781263290.623249).
const RE_REVIEW_RE = /\bre-?review\b/; // "re-review" is only ever a verb
const REVIEW_LEADIN = '(?:please|pls|plz|kindly|can|could|would|will|lets|you)';
// Objects that can only follow the VERB "review". Trailing \b on bare words so
// "review pr" doesn't match inside "review process"; URLs and "#123" carry
// their own delimiters.
const REVIEW_OBJECT =
  '(?:(?:this|it|that|again|the\\s+(?:pr|pull|frontend|backend|change|changes|diff|code)|prs?|pull)\\b|#\\d+|https?:\\/\\/)';
const REVIEW_VERB_OBJECT_RE = new RegExp('\\breview\\s+' + REVIEW_OBJECT);
// Bare imperative at START (after optional polite/modal lead-ins), with "review"
// as the final meaningful token: "review", "pls review", "can you review".
const REVIEW_BARE_IMPERATIVE_RE = new RegExp('^(?:' + REVIEW_LEADIN + '\\s+){0,3}review\\b\\s*$');

/**
 * True when "review" is used as a request/imperative VERB; false for noun usage
 * ("ur review", "great review", "thanks for the review"). `normalized` must be
 * mention-stripped + lowercased + whitespace-collapsed (as in isPrReviewRequest).
 */
function isReviewRequestVerb(normalized: string): boolean {
  return (
    RE_REVIEW_RE.test(normalized) ||
    REVIEW_VERB_OBJECT_RE.test(normalized) ||
    REVIEW_BARE_IMPERATIVE_RE.test(normalized)
  );
}

const CONFLICTING_CHANGE_VERB_RE =
  /\b(create|open|raise|fix|implement|merge|close|revert|rebase|update|address|resolve)\b/;

/** "review and merge", "review, approve, merge", "review & approve": a review ask with more after it. */
const REVIEW_THEN_MERGE_RE = /\breview\s*(?:,|&|\+|\/|\band\b|\bthen\b)\s*(?:approve|merge)\b/;

/** `<https://x|label>` and `<https://x>` → `https://x`, as the sender typed it. */
function unwrapSlackLinks(text: string): string {
  return text
    .replace(/<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The footer Slack adds to a message a person sends through the Claude app. */
const SENT_USING_FOOTER_RE = /\*sent using\*\s*<@[^>]+>\s*$/i;

/**
 * True when a message is nothing but mentions and pull-request links: a PR
 * pasted at miniOG with no words around it, which has only one reading.
 */
export function isBarePrPaste(triggerText: string): boolean {
  if (!GITHUB_PR_URL_TEST_RE.test(triggerText)) return false;
  const rest = triggerText
    .replace(SENT_USING_FOOTER_RE, ' ')
    // Slack's link form, with or without a label: <https://github.com/o/r/pull/1|label>
    .replace(/<https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+[^>]*>/g, ' ')
    .replace(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+[^\s<>|]*/g, ' ')
    // user, user-group and special mentions
    .replace(/<[@!][^>]+>/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return rest.length === 0;
}

/**
 * Deterministic check: is the message asking for a PR review? Runs before the
 * tool-router (pattern: isWebappQaRequest) so a message that carries all its
 * routing signal in plain text never depends on a CLI subprocess — the issue
 * #334 incident had "review <PR URL>" cascade into an admin-clarify/cancel
 * because a model call exited 1 (bug B).
 *
 * Tier 1 — a PR URL in the trigger message itself: fires on its two
 * unambiguous forms, a review verb with the URL, or a message that is
 * nothing but mentions and PR links. A PR link with anything else around it
 * (a question about the PR, a status update) is left to the tool-router: "no
 * change verb" used to make it a review, and a PM's four questions about a
 * merged PR got 13 inline review comments instead of answers (issue #447).
 * Tier 2 — review verb in the trigger, PR URL(s) elsewhere in the thread:
 * fires only when no conflicting change verb muddies the ask ("review and
 * fix X" is mixed intent — let the router decide).
 */
export function isPrReviewRequest(triggerText: string, threadTexts: string[] = []): boolean {
  if (!triggerText) return false;
  const normalized = triggerText
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  // Slack delivers a link as <https://…> or <https://…|label>. The verb test
  // looks for "review https://", so the brackets come off first: "review
  // <link>" is the plainest case for this gate.
  const verbText = unwrapSlackLinks(normalized);
  // "Review and merge" asks for a review first, whatever follows it. Left to
  // a model, the same sentence went to a review, to the change pipeline or to
  // nothing on different days (issue #430).
  const hasReviewVerb = isReviewRequestVerb(verbText) || REVIEW_THEN_MERGE_RE.test(verbText);
  const hasConflictingVerb = CONFLICTING_CHANGE_VERB_RE.test(normalized);

  if (GITHUB_PR_URL_TEST_RE.test(triggerText)) {
    return hasReviewVerb || isBarePrPaste(triggerText);
  }

  if (hasReviewVerb && !hasConflictingVerb) {
    return threadTexts.some(text => Boolean(text) && GITHUB_PR_URL_TEST_RE.test(text));
  }

  return false;
}

// Any http(s) URL. The QA gate narrows this to non-GitHub, non-Metabase
// targets so a PR link still routes to PR_REVIEW and a Metabase link to
// INFORMATIONAL.
const ANY_URL_RE = /https?:\/\/[^\s<>|]+/i;

// QA verbs — an explicit ask to exercise a running web app in a browser.
// Deliberately narrow (precision over recall): a bare "test it" with no URL
// or a "fix"/"build" ask falls through to the classifier / IMPLEMENTATION.
const QA_VERB_RE =
  /\b(qa|smoke[- ]?test|e2e|end[- ]?to[- ]?end|browser[- ]?test|test (?:the|this|that|out|flow|page|feature|login|signup|sign[- ]?up|checkout|form|ui)|verify (?:the|this) (?:flow|page|ui|feature|form)|click[- ]?through|walk through)\b/;

// A QA request mixed with a build/ship verb is ambiguous — let the classifier
// or IMPLEMENTATION own it rather than firing the deterministic QA gate.
const QA_CONFLICTING_VERB_RE = /\b(fix|implement|build|deploy|ship|merge|create|add|refactor|migrate)\b/;

/**
 * Returns the first http(s) URL in `text` that is a valid webapp-QA target —
 * i.e. not a GitHub PR URL (those belong to PR_REVIEW) and not a Metabase URL
 * (those belong to INFORMATIONAL). Trailing punctuation is trimmed.
 */
export function extractQaTargetUrl(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  const matches = text.match(new RegExp(ANY_URL_RE, 'gi')) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[)\]}.,!?'"]+$/, '');
    if (GITHUB_PR_URL_TEST_RE.test(url)) continue;
    if (containsMetabaseUrl(url)) continue;
    return url;
  }
  return undefined;
}

/**
 * Deterministic check: is the message asking miniOG to QA / browser-test a
 * running web app? Runs before the AI classifier (pattern: isPrReviewRequest /
 * isDeployRequest) so "QA the login flow on <url>" never misroutes to
 * INVESTIGATION or IMPLEMENTATION. Fires only when there is a QA verb AND a
 * non-PR, non-Metabase target URL in the trigger message, and no conflicting
 * build/ship verb.
 */
export function isWebappQaRequest(triggerText: string): boolean {
  if (!triggerText) return false;
  if (!extractQaTargetUrl(triggerText)) return false;
  const normalized = triggerText
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  if (QA_CONFLICTING_VERB_RE.test(normalized)) return false;
  return QA_VERB_RE.test(normalized);
}

/**
 * Deterministic check: is the message asking miniOG to browser-QA a GitHub PR
 * (vs. code-review it)? "test this PR <url>" should drive a browser against the
 * PR's running code, but a bare PR URL otherwise routes to PR_REVIEW. This gate
 * must run BEFORE `isPrReviewRequest` in `inferIntent` (a PR URL with no
 * conflicting verb makes that gate fire). Fires only on a QA verb + a GitHub PR
 * URL, with NO review verb (so "review this PR" stays PR_REVIEW) and NO
 * build/ship verb (so "test and fix this PR" falls through to implementation).
 */
export function isWebappQaOnPrRequest(triggerText: string): boolean {
  if (!triggerText) return false;
  if (!GITHUB_PR_URL_TEST_RE.test(triggerText)) return false;
  const normalized = triggerText
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  if (isReviewRequestVerb(normalized)) return false;
  if (QA_CONFLICTING_VERB_RE.test(normalized)) return false;
  return QA_VERB_RE.test(normalized);
}

/**
 * Parse a `/miniog <subcommand>` style message into a structured subcommand.
 * Returns null if the text is not a recognized dossier subcommand.
 *
 * Recognized forms (case-insensitive, leading bot mention tolerated):
 *   whoami
 *   set-role <pm|dev|designer|ops>
 *   forget <role|tone|notes|project_affinity|metrics|all> [confirm]
 */
const PINNED_FACT_MAX_CHARS = 280;

export function parseMiniogSubcommand(text: string): MiniogSubcommand | null {
  if (!text) return null;
  // Preserve case for value extraction (e.g. the freeform text after `remember`),
  // but use a lowercased copy for verb dispatch.
  // Also strip Slack's "*Sent using* <@bot>" attribution that some integrations
  // append to outgoing messages — otherwise it lands inside the user's
  // freeform `remember` text. Match before mention removal so the trailing
  // <@…> in the attribution is consumed first.
  const cleaned = text.replace(/\*Sent using\*[\s\S]*$/, '');
  const noMentions = cleaned.replace(/<@[^>]+>/g, ' ').trim();
  if (!noMentions) return null;
  const tokens = noMentions.split(/\s+/);
  const head = tokens[0]?.toLowerCase();

  if (head === 'whoami') return { kind: 'whoami' };

  if (head === 'memories') return { kind: 'memories' };

  if (head === 'handoff') {
    // `handoff [paste|file|link]` — package this thread's context for the
    // user's own Claude. Viewer-tier via MINIOG_DOSSIER routing, so PMs can
    // use it anywhere the bot is present. STRICT arity: a natural sentence
    // like "handoff the deployment to Shiv" must fall through to the
    // classifier, not dump a transcript.
    const format = tokens[1]?.toLowerCase();
    if (tokens.length === 1) return { kind: 'handoff', format: 'auto' };
    if (tokens.length === 2 && (format === 'paste' || format === 'file' || format === 'link')) {
      return { kind: 'handoff', format };
    }
    return null;
  }

  if (head === 'remember') {
    // Everything after the first word, original case preserved, capped.
    const rest = noMentions.slice(tokens[0].length).trim();
    if (!rest) return null;
    return { kind: 'remember', text: rest.slice(0, PINNED_FACT_MAX_CHARS) };
  }

  if (head === 'set-role') {
    const role = tokens[1]?.toLowerCase();
    if (role && isDossierRole(role)) return { kind: 'set-role', role };
    return null;
  }

  if (head === 'forget') {
    const field = tokens[1]?.toLowerCase();
    // `forget thread` / `forget this thread` tombstones the current thread in
    // the conversation store (transcript deleted, never re-captured). Gated
    // downstream to thread participants/admins, with a confirm step.
    if (field === 'thread' || (field === 'this' && tokens[2]?.toLowerCase() === 'thread')) {
      const confirmToken = field === 'thread' ? tokens[2] : tokens[3];
      return { kind: 'forget-thread', confirmed: confirmToken?.toLowerCase() === 'confirm' };
    }
    // `forget memory <id>` removes a specific pinned fact; lives alongside
    // the per-field clears handled below.
    if (field === 'memory') {
      if (tokens.length < 3) return null;
      const id = Number.parseInt(tokens[2], 10);
      if (!Number.isFinite(id) || id <= 0) return null;
      return { kind: 'forget-memory', id };
    }
    if (!field || !isDossierForgetField(field)) return null;
    if (field === 'all') {
      const confirmed = tokens[2]?.toLowerCase() === 'confirm';
      return { kind: 'forget', field: 'all', confirmed };
    }
    return { kind: 'forget', field, confirmed: true };
  }

  return null;
}

function inferIntent(
  event: SlackEventEnvelope,
  config: AppConfig,
  mention: MentionInfo,
  threadTexts: string[] = [],
): { intent: WorkflowIntent; miniogSubcommand?: MiniogSubcommand } {
  // A keyword gate acts without a second opinion, so it needs a direct address.
  // A mention in passing is left to the tool-router (issue #448).
  const directBotMention = mention.detected && mention.type === 'bot' && !mention.reference;
  // Dossier subcommands (whoami / set-role / forget) take precedence over every other route
  // when the bot is mentioned. They are read-only or operator-self-edit commands and
  // must not bleed into the AI classifier.
  if (mention.detected) {
    const sub = parseMiniogSubcommand(event.text ?? '');
    if (sub) return { intent: 'MINIOG_DOSSIER', miniogSubcommand: sub };
  }

  // Any explicit wt/watchtower prefix is always routed to dev-assist, even for owners.
  if (mention.detected && hasDevAssistPrefix(event.text ?? '')) {
    return { intent: 'DEV_ASSIST' };
  }

  // Natural-language status/capability prompts should route to dev-assist as lightweight aliases.
  if (mention.detected && hasNaturalDevAssistAlias(event.text ?? '')) {
    return { intent: 'DEV_ASSIST' };
  }

  // No deploy gate. The wording used to seed the DEPLOY workflow from here,
  // and "Deploy order: …" in a review request for a newton-web PR started the
  // production deploy workflow (issue #428). A deploy now starts only when the
  // tool-router reads the message as one and code finds the target at the
  // head of it (`mayDeploy`); the keywords reach the router as a hint.

  // Deterministic PR-review detection — before the owner/default seeding so
  // owners get it too. Seeding PR_REVIEW here (reviewer tier) does not wait
  // for the tool-router in routeTask: a "review <PR URL>" message routes
  // identically whether the model CLI is healthy or down (issue #334 bug B),
  // and the access check evaluates reviewer tier directly.
  // Deterministic webapp-QA-on-PR detection — MUST run before the PR-review
  // gate below, which fires on any PR URL without a conflicting verb. "test
  // this PR <url>" means "browser-test the PR's running code", not "code-review
  // it"; this gate steers it to WEBAPP_QA while "review this PR" / a bare PR
  // paste still fall through to PR_REVIEW. prContext is populated by
  // normalizeTask regardless, so runWebappQa can resolve the PR downstream.
  if (directBotMention && isWebappQaOnPrRequest(event.text ?? '')) {
    return { intent: 'WEBAPP_QA' };
  }

  if (directBotMention && isPrReviewRequest(event.text ?? '', threadTexts)) {
    return { intent: 'PR_REVIEW' };
  }

  // A review ask that tags the owner (or the core-dev group) instead of miniOG
  // gets the same gate, in its explicit forms and with the link in the message
  // itself. Left to a model call, the same "please review <PR>" was reviewed,
  // sent to the change pipeline or ignored on different days (issue #430).
  if (mention.detected && mention.type === 'owner' && isPrReviewRequest(event.text ?? '')) {
    return { intent: 'PR_REVIEW' };
  }

  // Deterministic webapp-QA detection — before the owner/default seeding so
  // owners get it too. "QA the login flow on <url>" carries all its routing
  // signal in plain text (a QA verb + a non-PR/Metabase URL), so it does not
  // wait for the tool-router in routeTask and never misroutes to INVESTIGATION.
  if (directBotMention && isWebappQaRequest(event.text ?? '')) {
    return { intent: 'WEBAPP_QA' };
  }

  // What the message asks for is decided by the tool-router in routeTask. The
  // seed set here is the label the job starts under and the access tier the
  // router's decision is compared against (the confidence floor in routeTask):
  // - Owners: OWNER_AUTOPILOT (preserves the owner-only relaxed prompt path in implementationWorkflow).
  // - Non-owners: IMPLEMENTATION. Both map to the same required access level
  //   (builder) and the same downstream workflow, but the IMPLEMENTATION label
  //   avoids tagging non-owner jobs with an owner-implying name.
  //
  // Exception — Metabase URLs from non-owners seed as INFORMATIONAL. RCA of an
  // "explain this table" denial (2026-05-25 thread p1779707644097049) showed
  // that seeding IMPLEMENTATION forces the decision to *drop* the tier
  // (IMPLEMENTATION → INFORMATIONAL), which tripped the access-drop confidence
  // floor when the confidence came in below 0.75. Seeding INFORMATIONAL avoids
  // the drop; upward overrides are allowed at any confidence, so a genuine
  // "modify this Metabase query" request can still upgrade. Owners are
  // unaffected (their access check is bypassed), so they keep OWNER_AUTOPILOT.
  if (mention.detected && mention.type === 'bot') {
    const isOwner = config.ownerSlackUserIds.includes(event.userId);
    if (isOwner) {
      return { intent: 'OWNER_AUTOPILOT' };
    }
    if (containsMetabaseUrl(event.text)) {
      return { intent: 'INFORMATIONAL' };
    }
    return { intent: 'IMPLEMENTATION' };
  }

  return { intent: 'UNKNOWN' };
}

export function normalizeTask(
  event: SlackEventEnvelope,
  config: AppConfig,
  threadTexts: string[] = [],
): NormalizedTask {
  const mention = detectMention(event.text, config, event.channelType);
  const isOwnerAuthor = config.ownerSlackUserIds.includes(event.userId);
  const isCoreDevAuthor = getAdminUserIds(config).includes(event.userId);
  const prContexts = extractAllPrContexts({ triggerText: event.text, threadTexts });
  const first = prContexts[0];
  const prContext = first ? { url: first.url, owner: first.owner, repo: first.repo, number: first.number } : undefined;
  const inferred = inferIntent(event, config, mention, threadTexts);

  return {
    event,
    mentionDetected: mention.detected,
    mentionType: mention.type,
    ...(mention.reference ? { mentionReference: true } : {}),
    isOwnerAuthor,
    isCoreDevAuthor,
    intent: inferred.intent,
    prContext,
    prContexts: prContexts.length > 0 ? prContexts : undefined,
    miniogSubcommand: inferred.miniogSubcommand,
  };
}
