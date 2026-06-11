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

const GITHUB_PR_REGEX = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

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

/**
 * Deterministic check: does the message ask to deploy newton-web to production?
 * This runs before the AI classifier so deploy requests are never misrouted.
 */
export function isDeployRequest(text: string): boolean {
  const normalized = text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();

  // Must contain a deploy verb
  const hasDeployVerb = /\b(deploy|ship|release|push to prod|push prod)\b/.test(normalized);
  if (!hasDeployVerb) return false;

  // Must reference production target
  const hasProdTarget = /\b(prod|production)\b/.test(normalized);
  // Must reference the app (or be unambiguous enough with just "deploy prod")
  const hasAppRef = /\b(newton[- ]?web|newton[- ]?school|frontend)\b/.test(normalized);

  // "deploy to prod" / "deploy prod" is unambiguous enough even without app name
  // "deploy newton-web" without "prod" is also valid (prod is the only deploy target)
  return hasProdTarget || hasAppRef;
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

export function extractPrContext(texts: string[]): PrContext | undefined {
  for (const text of texts) {
    if (!text) {
      continue;
    }
    const matches = [...text.matchAll(GITHUB_PR_REGEX)];
    if (matches.length > 0) {
      const match = matches[0];
      return {
        url: match[0],
        owner: match[1],
        repo: match[2],
        number: Number(match[3]),
      };
    }
  }
  return undefined;
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

  // Deterministic deploy detection — routed before the AI classifier.
  if (mention.detected && isDeployRequest(event.text ?? '')) {
    return { intent: 'DEPLOY' };
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
  const prContext = extractPrContext([event.text, ...threadTexts]);
  const inferred = inferIntent(event, config, mention);

  return {
    event,
    mentionDetected: mention.detected,
    mentionType: mention.type,
    isOwnerAuthor,
    isCoreDevAuthor,
    intent: inferred.intent,
    prContext,
    miniogSubcommand: inferred.miniogSubcommand,
  };
}
