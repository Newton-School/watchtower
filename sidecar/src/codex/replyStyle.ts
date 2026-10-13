/**
 * Shared writing rules for user-facing text. miniOG writes in ASD-STE100
 * (Simplified Technical English) so each sentence is short and has one meaning
 * for every reader, including non-native English speakers.
 */
const STE_LABEL = 'ASD-STE100 (Simplified Technical English, "STE")';

/** Sentence-level rules shared by every variant. */
const STE_CORE_RULES = [
  '- STE controls how you write each sentence. Other rules in this prompt control the length, the tone and the output format, and they win over STE.',
  '- If the text must be short, leave out whole points. Do not drop articles, verbs or subjects to make text shorter.',
  '- Keep every fact, option and warning that the answer needs. Split long sentences. Do not remove content only to meet a sentence limit.',
  '- Instructions: max 20 words per sentence. One instruction per sentence. Start with the verb ("Run the migration.").',
  '- Descriptions: max 25 words per sentence.',
  '- Use active voice. Use passive voice only when the doer of the action is not known.',
  '- Use only simple tenses: imperative, simple present, simple past, simple future. Do not chain auxiliary verbs ("would have been").',
  '- Do not use "-ing" words as verbs. They are fine as nouns or adjectives ("the missing index", "logging level").',
  '- Do not write noun clusters of more than 3 words. Break them up with "of", "for" or a relative clause.',
  '- Use common words with one meaning. Use the same term for the same thing every time. Do not use synonyms for variety.',
  '- Code, identifiers, commands, file paths, product names and exact error text stay as they are. Exception: replace secrets, tokens, passwords and connection strings inside them with [redacted]. Also replace personal data that the user did not ask for. Never change a file path.',
].join('\n');

/**
 * Sentence rules only, for prompts whose text goes into a JSON field or is
 * cleaned before it is posted (lines that start with "-" are dropped, text is
 * wrapped in Slack emphasis). The layout rules of the reply block would break
 * that text.
 */
export const STE_CORE_STYLE_BLOCK = `Writing style — ${STE_LABEL}. Apply it to every sentence of user-facing text:
${STE_CORE_RULES}`;

/** Full style block for free-form Slack replies that are posted as written. */
export const STE_REPLY_STYLE_BLOCK = `Writing style — ${STE_LABEL}. Apply it to every sentence of the reply:
- Lead with the answer.
${STE_CORE_RULES}
- One topic per paragraph. Max 6 sentences per paragraph.
- Use bullet lists for steps and for complex text.
- Start a warning with a clear command or condition ("Do not ...", "If X, ...").`;

/**
 * PR-review variant: the review agents return JSON, and its text fields become
 * GitHub review comments. It leaves out the reply-only layout rules so it does
 * not compete with the JSON-only output contract.
 */
export const STE_REVIEW_TEXT_RULE = `Writing style for the JSON text fields — ${STE_LABEL}:
- These rules apply only to the text inside "message", "suggestion" and "summaryNotes" entries. They do not change the JSON-only output rule.
- These fields are posted to GitHub. Replace secrets, tokens, passwords, connection strings and personal data from the diff or from command output with [redacted].
- If this prompt tells you to start a text with "Still open: ", "Regressed: " or "Addressed since last review: ", keep that prefix exactly. Write the rest of the text in STE.
- Write each "message" as plain sentences, not as a bullet list.
- Write each "suggestion" on one line. Start with one STE sentence that tells what to change. Put code in single backticks. Do not use code fences or line breaks.
- If you have no concrete fix, leave out the "suggestion" field. Do not send an empty string.
${STE_CORE_RULES}`;
