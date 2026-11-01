/**
 * Flags for the one kind of run that sees the owner's own Slack: My day's
 * triage (it reads the DMs and threads the bot token can't).
 *
 * The owner's Slack is a claude.ai connector, which the CLI only loads without
 * `--strict-mcp-config`, and that also loads every other connector the owner
 * has (issue #443). So nothing here may rely on what happens to be loaded.
 * Measured on the CLI, 2026-11-02:
 * - `--permission-mode dontAsk` with an allow-list refuses any connector tool
 *   off the list, with no deny rule needed;
 * - it still runs `Bash` for a read-only command, so the built-in tools have to
 *   be removed outright;
 * - a tool on `--disallowedTools` is gone from the run ("No such tool").
 *
 * The run therefore has three separate limits: `--tools` for the built-ins, a
 * deny rule for each built-in and each Slack tool that writes, and an allow-list
 * of the exact Slack tools that read. It gets its data in the prompt. Settings
 * files are skipped too: an allow rule added to the user's settings would
 * otherwise join this list without anyone noticing. It runs in an empty folder,
 * so there are no project settings to load instead.
 */

/** The connector's name in a headless session, and the plugin's in a terminal one. */
const SLACK_SERVERS = ['mcp__claude_ai_Slack', 'mcp__plugin_slack_slack'];

const SLACK_READ_TOOLS = [
  'slack_search_public_and_private',
  'slack_read_thread',
  'slack_read_channel',
  'slack_list_user_channels',
  'slack_read_user_profile',
  'slack_read_file',
];

const SLACK_WRITE_TOOLS = [
  'slack_send_message',
  'slack_send_message_draft',
  'slack_schedule_message',
  'slack_add_reaction',
  'slack_create_canvas',
  'slack_update_canvas',
  'slack_create_conversation',
  'slack_create_list',
  'slack_update_list',
  'slack_add_list_record',
  'slack_update_list_record',
  'slack_get_file_upload_url',
  'slack_complete_file_upload',
];

const BUILT_IN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'SendMessage',
  'Monitor',
];

function forEachServer(tools: string[]): string[] {
  return SLACK_SERVERS.flatMap(server => tools.map(tool => `${server}__${tool}`));
}

/** The whole permission setup of a run that reads the owner's Slack and can do nothing else. */
export function personalSlackReadArgs(): string[] {
  return [
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'project',
    '--tools',
    'ToolSearch',
    '--disable-slash-commands',
    '--allowedTools',
    'ToolSearch',
    ...forEachServer(SLACK_READ_TOOLS),
    '--disallowedTools',
    ...BUILT_IN_TOOLS,
    ...forEachServer(SLACK_WRITE_TOOLS),
  ];
}
