/**
 * "Stop" as a control message (issue #435).
 *
 * A stop has to reach a running job immediately, so it is recognised before
 * the queue and never routed. It is the one place a fixed vocabulary is
 * the right tool: like Esc in an editor, it must not depend on a model call.
 * The price of a false positive is a cancelled job, so the whole message has to
 * be a stop — "stop using X and add Y" is an instruction, not a stop.
 */

const STOP_PHRASES = new Set([
  'stop',
  'cancel',
  'abort',
  'halt',
  'no',
  'nope',
  'nevermind',
  'never mind',
  'stop it',
  'cancel it',
  'kill it',
  'stop this',
  'cancel this',
  'stop that',
  'cancel that',
  'stop now',
  'cancel now',
  'please stop',
  'stop please',
  'please cancel',
  'cancel please',
]);

const TASK_NOUN = '(?:task|job|run|review|pr review|deploy|deployment)';

const STOP_PATTERNS = [
  // "u can cancel ur task", "you can stop it"
  new RegExp(`^(?:u|you) can (?:stop|cancel)(?: (?:it|this|that|(?:ur|your|the|this|that) ${TASK_NOUN}))?$`),
  // "cancel the review", "please stop your task"
  new RegExp(`^(?:please )?(?:stop|cancel|abort) (?:ur|your|the|this|that) ${TASK_NOUN}(?: please)?$`),
  // "no deployment", "don't merge it"
  /^no (?:deploy|deployment|review|merge)$/,
  /^(?:dont|do not) (?:deploy|merge|review)(?: (?:it|this|that))?$/,
];

/**
 * The stop words a plan's approval gate reads (issue #598): everything above
 * except "no", which at a plan means "not this plan", not "drop the job".
 */
export const GATE_STOP_PHRASES: readonly string[] = [...STOP_PHRASES].filter(
  phrase => phrase !== 'no' && phrase !== 'nope',
);

/** The user ids a Slack message @-mentions, in order. */
export function slackMentionIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi)].map(match => match[1]);
}

/** Mentions, a forwarding app's "Sent using" footer, case and punctuation don't change what was said. */
export function normalizeControlText(text: string): string {
  return (
    text
      .replace(/\*sent using\*.*$/is, '')
      .replace(/<@[A-Z0-9]+(\|[^>]+)?>/g, ' ')
      .toLowerCase()
      // "don't" is one word; every other mark separates words.
      .replace(/['’‘]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function isStopCommand(text: string): boolean {
  const cleaned = normalizeControlText(text);
  if (!cleaned) return false;
  return STOP_PHRASES.has(cleaned) || STOP_PATTERNS.some(pattern => pattern.test(cleaned));
}

export type StopDecision =
  | { stop: true }
  | { stop: false; reason: 'not_addressed' | 'not_a_stop' | 'no_active_job' | 'not_allowed' };

/**
 * Whether this message stops the job running in its thread. It must be
 * addressed to the bot, be nothing but a stop, and come from the person who
 * asked for the job, an admin or an owner — a bystander cannot cancel
 * someone else's work.
 */
export function decideStop(params: {
  isBotMention: boolean;
  text: string;
  senderId: string;
  activeJob: { requestedBy?: string } | undefined;
  adminUserIds: string[];
  ownerUserIds: string[];
}): StopDecision {
  const { isBotMention, text, senderId, activeJob, adminUserIds, ownerUserIds } = params;
  if (!isBotMention) return { stop: false, reason: 'not_addressed' };
  if (!isStopCommand(text)) return { stop: false, reason: 'not_a_stop' };
  if (!activeJob) return { stop: false, reason: 'no_active_job' };
  const allowed =
    senderId === activeJob.requestedBy || adminUserIds.includes(senderId) || ownerUserIds.includes(senderId);
  return allowed ? { stop: true } : { stop: false, reason: 'not_allowed' };
}
