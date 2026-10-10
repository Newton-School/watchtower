import type { AppConfig, NormalizedTask } from '../types/contracts.js';

/**
 * Renders a workflow prompt template with context variables.
 *
 * Supported template variables:
 * - {{user_message}} — the user's original message text
 * - {{thread_ts}} — the Slack thread timestamp
 * - {{channel_id}} — the Slack channel ID
 * - {{user_id}} — the requesting user's Slack ID
 * - {{repo_web}} — path to newton-web repo
 * - {{repo_api}} — path to newton-api repo
 * - {{repo_marketing}} — path to newton-marketing-web repo ('' when not configured)
 */
export function renderPromptTemplate(template: string, task: NormalizedTask, config: AppConfig): string {
  return template
    .replace(/\{\{user_message\}\}/g, task.event.text)
    .replace(/\{\{thread_ts\}\}/g, task.event.threadTs)
    .replace(/\{\{channel_id\}\}/g, task.event.channelId)
    .replace(/\{\{user_id\}\}/g, task.event.userId)
    .replace(/\{\{repo_web\}\}/g, config.repoPaths.newtonWeb)
    .replace(/\{\{repo_api\}\}/g, config.repoPaths.newtonApi)
    .replace(/\{\{repo_marketing\}\}/g, config.repoPaths.newtonMarketingWeb ?? '');
}
