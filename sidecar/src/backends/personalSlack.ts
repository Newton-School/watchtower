import fs from 'node:fs';

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
 * So the run has two limits that work alone: deny rules for the built-ins and
 * every Slack tool that writes, and an allow-list of the exact Slack tools that
 * read. It gets its data in the prompt.
 *
 * `--tools ToolSearch` plus `--setting-sources project` left a run with no tools
 * at all (2026-11-02), Slack included, so neither is used. Without them an allow
 * rule in the user's settings would join this list, which `settingsProblem`
 * catches before a run starts.
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
    '--allowedTools',
    'ToolSearch',
    ...forEachServer(SLACK_READ_TOOLS),
    '--disallowedTools',
    ...BUILT_IN_TOOLS,
    ...forEachServer(SLACK_WRITE_TOOLS),
  ];
}

/**
 * What in the user's settings would widen the run: an allow rule for a connector
 * tool it wasn't given. Built-ins and Slack's writes don't count, since a deny
 * rule beats an allow rule. Undefined when nothing does, or there's no such file.
 */
export function settingsProblem(settingsPath: string): string | undefined {
  let allow: unknown;
  try {
    allow = (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { permissions?: { allow?: unknown } }).permissions
      ?.allow;
  } catch {
    return undefined;
  }
  if (!Array.isArray(allow)) return undefined;
  const readTools = new Set(forEachServer(SLACK_READ_TOOLS));
  const wider = allow.filter(
    (rule): rule is string =>
      typeof rule === 'string' && (rule === '*' || rule.startsWith('mcp__')) && !readTools.has(rule),
  );
  return wider.length > 0
    ? `${settingsPath} allows ${wider.join(', ')}, which would also apply to the run that reads your Slack. Remove it to use My day.`
    : undefined;
}
