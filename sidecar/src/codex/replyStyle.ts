/**
 * Shared writing rules for every user-facing Slack reply. miniOG writes in
 * ASD-STE100 (Simplified Technical English) so replies stay short and have
 * one meaning for every reader, including non-native English speakers.
 */
export const STE_REPLY_STYLE_BLOCK = `Writing style — ASD-STE100 (Simplified Technical English). Apply it to every sentence of the reply:
- Lead with the answer.
- STE controls how you write, not how much you say. Keep every fact, option and warning that the answer needs. Split long sentences. Do not delete content.
- Instructions: max 20 words per sentence. One instruction per sentence. Start with the verb ("Run the migration.").
- Descriptions: max 25 words per sentence. One topic per paragraph. Max 6 sentences per paragraph.
- Use active voice. Use passive voice only when the agent is not known.
- Use only simple tenses: imperative, simple present, simple past, simple future. Do not chain auxiliary verbs ("would have been").
- Do not use "-ing" words as verbs. Use them only inside a technical name ("logging level").
- Do not write noun clusters of more than 3 words. Break them up with "of", "for" or a relative clause.
- Use common words with one meaning. Use the same term for the same thing every time. Do not use synonyms for variety.
- Do not drop articles, verbs or subjects to make text shorter.
- Use bullet lists for steps and for complex text.
- Start a warning with a clear command or condition ("Do not ...", "If X, ...").
- Code, identifiers, commands, file paths, product names and exact error text stay as they are.`;

/**
 * PR-review variant: the review agents return JSON, and its text fields become
 * GitHub review comments and the Slack summary.
 */
export const STE_REVIEW_TEXT_RULE = `- Write the text of every "message", "suggestion", "summaryNotes" entry and "summary" in ASD-STE100.
- Start each "suggestion" with one STE sentence that tells what to change. Put code in single backticks, or in a fenced code block when it has more than one line.
- If you have no concrete fix, leave out the "suggestion" field. Do not send an empty string.
${STE_REPLY_STYLE_BLOCK}`;
