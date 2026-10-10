/**
 * Shared writing rules for user-facing text. miniOG writes in ASD-STE100
 * (Simplified Technical English) so replies stay short and have one meaning
 * for every reader, including non-native English speakers.
 */
const STE_LABEL = 'ASD-STE100 (Simplified Technical English, "STE")';

/** Sentence-level rules shared by Slack replies and PR review text. */
const STE_CORE_RULES = [
  '- STE controls how you write, not how much you say. Keep every fact, option and warning that the answer needs. Split long sentences. Do not delete content.',
  '- Instructions: max 20 words per sentence. One instruction per sentence. Start with the verb ("Run the migration.").',
  '- Descriptions: max 25 words per sentence.',
  '- Use active voice. Use passive voice only when the agent is not known.',
  '- Use only simple tenses: imperative, simple present, simple past, simple future. Do not chain auxiliary verbs ("would have been").',
  '- Do not use "-ing" words as verbs. They are fine as nouns or adjectives ("the missing index", "logging level").',
  '- Do not write noun clusters of more than 3 words. Break them up with "of", "for" or a relative clause.',
  '- Use common words with one meaning. Use the same term for the same thing every time. Do not use synonyms for variety.',
  '- Do not drop articles, verbs or subjects to make text shorter.',
  '- Code, identifiers, commands, file paths, product names and exact error text stay as they are. Exception: replace secrets, tokens, credentials, connection strings and personal data inside them with [redacted].',
].join('\n');

/** Full style block for free-form Slack replies. */
export const STE_REPLY_STYLE_BLOCK = `Writing style — ${STE_LABEL}. Apply it to every sentence of the reply:
- Lead with the answer.
${STE_CORE_RULES}
- One topic per paragraph. Max 6 sentences per paragraph.
- Use bullet lists for steps and for complex text.
- Start a warning with a clear command or condition ("Do not ...", "If X, ...").`;

/**
 * PR-review variant: the review agents return JSON, and its text fields become
 * GitHub review comments and the Slack summary. It leaves out the reply-only
 * layout rules so it does not compete with the JSON-only output contract.
 */
export const STE_REVIEW_TEXT_RULE = `Writing style for the JSON text fields — ${STE_LABEL}:
- These rules apply only to the text inside "message", "suggestion", "summaryNotes" entries and "summary". They do not change the JSON-only output rule above.
- These fields are posted to GitHub. Never copy secrets, tokens, credentials or personal data from the diff or from command output into them.
- Write each "message" as plain sentences, not as a bullet list.
- Start each "suggestion" with one STE sentence that tells what to change. Put code in single backticks, or in a fenced code block when it has more than one line.
- If you have no concrete fix, leave out the "suggestion" field. Do not send an empty string.
${STE_CORE_RULES}`;
