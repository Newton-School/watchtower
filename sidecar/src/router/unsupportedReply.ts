/**
 * The reply to an action none of miniOG's tools reach (issue #606).
 *
 * A request to grant permissions, set a reminder or file a ticket used to run
 * a full lookup, which took minutes to say what one line can. The router names
 * the action and, when it can tell, who or what can do it; this turns that
 * into the reply, posted with no agent run.
 */

/** Longer than this, a phrase from the model is more likely a paragraph than a name for the action. */
const MAX_PHRASE_CHARS = 120;

const HELP_POINTER = 'Mention me with "help" to see what I can do here.';

export const UNSUPPORTED_GENERIC_REPLY = `That's not something I can do: none of my tools reach it. ${HELP_POINTER}`;

/**
 * A phrase from the model, as one line with no closing punctuation. Undefined
 * when it is not safe to post: Slack markup (`<@U…>`, `<!here>`, `<https://…>`)
 * would mention, ping or link, and taking it out leaves a phrase that reads
 * wrong ("add  to the group").
 */
function cleanPhrase(raw: string | undefined): string | undefined {
  if (!raw || /[<>]|https?:\/\//i.test(raw)) return undefined;
  const text = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,]+$/, '')
    .trim();
  return text && text.length <= MAX_PHRASE_CHARS ? text : undefined;
}

/** "I can't grant access" and "To grant access" both become "grant access". */
function asVerbPhrase(phrase: string): string {
  const bare = phrase.replace(/^(i\s+)?(can['’]?t|cannot|can not)\b\s*/i, '').replace(/^to\s+/i, '');
  // "Grant access" starts a sentence in the model's mind; here it follows "I can't".
  return /^[A-Z][a-z]/.test(bare) ? bare[0].toLowerCase() + bare.slice(1) : bare;
}

export function unsupportedReply(decision: { cannot?: string; whoCan?: string }): string {
  const cannotPhrase = cleanPhrase(decision.cannot);
  const cannot = cannotPhrase ? asVerbPhrase(cannotPhrase) : undefined;
  const whoCan = cleanPhrase(decision.whoCan);
  if (!cannot) return UNSUPPORTED_GENERIC_REPLY;
  const who = whoCan ? ` ${whoCan[0].toUpperCase()}${whoCan.slice(1)} can help with that.` : '';
  return `I can't ${cannot}: none of my tools reach that.${who} ${HELP_POINTER}`;
}
