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
const MARKETING_DEPLOY_REF_RE = /\b(marketing|landing|webflow|wrangler|cloudflare|mweb|nmw|newton[- ]?marketing)\b/;

function normalizeDeployText(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Deterministic check: does the message ask to deploy newton-web to production?
 * This runs before the AI classifier so deploy requests are never misrouted.
 */
export function isDeployRequest(text: string): boolean {
  const normalized = normalizeDeployText(text);

  // Must contain a deploy verb
  if (!DEPLOY_VERB_RE.test(normalized)) return false;

  // A deploy ask that names the marketing site must NEVER fire the newton-web
  // production deploy — it belongs to the marketing (GitHub Actions) flow.
  if (MARKETING_DEPLOY_REF_RE.test(normalized)) return false;

  // Must reference production target
  const hasProdTarget = /\b(prod|production)\b/.test(normalized);
  // Must reference the app. NOTE: `newton school` deliberately dropped from
  // this list — with two frontends, "deploy the newton school site" is
  // genuinely ambiguous and must not deterministically mean newton-web.
  const hasAppRef = /\b(newton[- ]?web|frontend)\b/.test(normalized);

  // "deploy to prod" / "deploy prod" is unambiguous enough even without app name
  // "deploy newton-web" without "prod" is also valid (prod is the only deploy target)
  return hasProdTarget || hasAppRef;
}

/**
 * Deterministic check: does the message ask to deploy the MARKETING site
 * (newton-marketing-web)? Kept separate from isDeployRequest so the two
 * deploy mechanisms (newton-web prod skill vs marketing GitHub Actions
 * dispatch) can never be confused for each other.
 */
export function isMarketingDeployRequest(text: string): boolean {
  const normalized = normalizeDeployText(text);
  return DEPLOY_VERB_RE.test(normalized) && MARKETING_DEPLOY_REF_RE.test(normalized);
}

export function detectMention(
  text: string,
  config: AppConfig,
  channelType?: string,
): { detected: boolean; type: 'bot' | 'owner' | 'none' } {
  if (!text) {
    if (channelType === 'im') {
      return { detected: true, type: 'bot' };
    }
    return { detected: false, type: 'none' };
  }

  const botMention = `<@${config.botUserId}>`;
  if (text.includes(botMention)) {
    return { detected: true, type: 'bot' };
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

/**
 * Deterministic check: is the message asking for a PR review? Runs before
 * the AI classifier (pattern: isDeployRequest) so a message that carries
 * all its routing signal in plain text never depends on a CLI subprocess —
 * the issue #334 incident had "review <PR URL>" cascade into an
 * admin-clarify/cancel because the classifier call exited 1 (bug B).
 *
 * Tier 1 — a PR URL in the trigger message itself: fires when a review verb
 * is present, or when no conflicting change verb is present (so a bare URL
 * paste fires, but "fix the comments on <url>" falls through to the
 * classifier).
 * Tier 2 — review verb in the trigger, PR URL(s) elsewhere in the thread:
 * fires only when no conflicting change verb muddies the ask ("review and
 * fix X" is mixed intent — let the classifier decide).
 */
export function isPrReviewRequest(triggerText: string, threadTexts: string[] = []): boolean {
  if (!triggerText) return false;
  const normalized = triggerText
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  const hasReviewVerb = isReviewRequestVerb(normalized);
  const hasConflictingVerb = CONFLICTING_CHANGE_VERB_RE.test(normalized);

  if (GITHUB_PR_URL_TEST_RE.test(triggerText)) {
    return hasReviewVerb || !hasConflictingVerb;
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
  mention: { detected: boolean; type: 'bot' | 'owner' | 'none' },
  threadTexts: string[] = [],
): { intent: WorkflowIntent; miniogSubcommand?: MiniogSubcommand } {
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

  // Deterministic deploy detection — routed before the AI classifier. The
  // marketing check runs first: its tokens are disjoint from isDeployRequest's
  // (which explicitly excludes them), so a deploy ask resolves to exactly one
  // of the two deploy flows. deployWorkflow re-derives the target the same way.
  if (mention.detected && (isMarketingDeployRequest(event.text ?? '') || isDeployRequest(event.text ?? ''))) {
    return { intent: 'DEPLOY' };
  }

  // Deterministic PR-review detection — before the owner/default seeding so
  // owners get it too. Seeding PR_REVIEW here (reviewer tier) skips the AI
  // classifier in routeTask entirely: a "review <PR URL>" message routes
  // identically whether the classifier CLI is healthy or down (issue #334
  // bug B), and the access check evaluates reviewer tier directly with no
  // override for the confidence guardrail to hold.
  // Deterministic webapp-QA-on-PR detection — MUST run before the PR-review
  // gate below, which fires on any PR URL without a conflicting verb. "test
  // this PR <url>" means "browser-test the PR's running code", not "code-review
  // it"; this gate steers it to WEBAPP_QA while "review this PR" / a bare PR
  // paste still fall through to PR_REVIEW. prContext is populated by
  // normalizeTask regardless, so runWebappQa can resolve the PR downstream.
  if (mention.detected && mention.type === 'bot' && isWebappQaOnPrRequest(event.text ?? '')) {
    return { intent: 'WEBAPP_QA' };
  }

  if (mention.detected && mention.type === 'bot' && isPrReviewRequest(event.text ?? '', threadTexts)) {
    return { intent: 'PR_REVIEW' };
  }

  // Deterministic webapp-QA detection — before the owner/default seeding so
  // owners get it too. "QA the login flow on <url>" carries all its routing
  // signal in plain text (a QA verb + a non-PR/Metabase URL), so it skips the
  // AI classifier in routeTask and never misroutes to INVESTIGATION.
  if (mention.detected && mention.type === 'bot' && isWebappQaRequest(event.text ?? '')) {
    return { intent: 'WEBAPP_QA' };
  }

  // Intent classification (PR_REVIEW, INFORMATIONAL, etc.) is handled by the
  // AI classifier in routeTask. Here we set the pre-classifier default:
  // - Owners: OWNER_AUTOPILOT (preserves owner-only relaxed prompt path in implementationWorkflow).
  // - Non-owners: IMPLEMENTATION. Both intents map to the same required access level
  //   (builder) and the same downstream workflow, but the IMPLEMENTATION label avoids
  //   tagging non-owner jobs with an owner-implying name.
  //
  // Exception — Metabase URLs from non-owners seed as INFORMATIONAL. RCA of
  // Saksham's "explain this table" denial (2026-05-25 thread p1779707644097049)
  // showed that seeding IMPLEMENTATION here forces the AI classifier to *drop*
  // the tier (IMPLEMENTATION → INFORMATIONAL), which trips the access-drop
  // confidence guardrail at `router.classify.low_confidence_hold` when the
  // classifier lands below 0.75 confidence. Pre-seeding INFORMATIONAL avoids
  // the drop entirely; the guardrail allows upward overrides at any confidence
  // so a genuine "modify this Metabase query" request can still upgrade. Owners
  // are unaffected (their access check is bypassed), so we keep OWNER_AUTOPILOT.
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
    isOwnerAuthor,
    isCoreDevAuthor,
    intent: inferred.intent,
    prContext,
    prContexts: prContexts.length > 0 ? prContexts : undefined,
    miniogSubcommand: inferred.miniogSubcommand,
  };
}
