import { evaluateCapability } from '../access/control.js';
import { enabledRepoKeys } from '../repos/registry.js';
import type { AppConfig, DossierRole } from '../types/contracts.js';
import { TOOLS, type ToolId } from './toolRegistry.js';

/**
 * "@miniOG help", answered at once and for this person in this channel
 * (issue: suggestion 13). A help reply used to be a model run that described
 * miniOG in general. A PM in the product channel needs to read that they can
 * change copy on www pages and ask product questions; a developer in
 * #development needs reviews and change runs; a channel where a tool is not
 * enabled for them should say so instead of letting them find out by asking.
 */

/** A bare request for help, with miniOG's mention already stripped. */
export function isHelpRequest(message: string): boolean {
  const text = message
    .toLowerCase()
    .replace(/\*sent using\*.*$/is, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  return [
    /^(please )?help( me)?( out)?( please)?$/,
    /^what can you do( for me| here)?$/,
    /^what (all )?(do|can) you (do|help with)( here)?$/,
    /^how (can|do) (you|i) (help|use you|work with you)( me)?( here)?$/,
    /^what are you (able to do|for)$/,
    /^(show|list) (me )?(your )?(commands|capabilities|options)$/,
    /^(hi|hello|hey)[, ]+(what can you do|help)$/,
  ].some(pattern => pattern.test(text));
}

/** One line per tool, written for the person reading it rather than for the registry. */
const TOOL_LINES: Record<ToolId, { what: string; example: string } | undefined> = {
  answer: {
    what: 'Answer questions about the product, the code and the data',
    example: 'how does negative marking work for assessments?',
  },
  change_code: {
    what: 'Make a change and open a PR for it: copy, numbers, images, PDFs on www pages, or code',
    example: 'on https://www.newtonschool.co/…/placement change 93% to 98.3%',
  },
  investigate: {
    what: 'Look into a problem and report the cause',
    example: 'this student is marked eligible but cannot apply to roles',
  },
  review_pr: { what: 'Review a pull request and post the findings on it', example: 'review <PR link>' },
  qa_webapp: {
    what: 'Test a running page or a PR in a browser and report what I find',
    example: 'QA this PR in the browser',
  },
  deploy: { what: 'Deploy to production, with a typed confirmation', example: 'deploy newton-web to prod' },
  chat: undefined,
  dev_assist: undefined,
  dossier: undefined,
  stay_silent: undefined,
};

/** The order a reader sees the tools in, by who they are. */
const ORDER_BY_ROLE: Record<DossierRole | 'unknown', ToolId[]> = {
  pm: ['change_code', 'answer', 'investigate', 'review_pr', 'qa_webapp', 'deploy'],
  designer: ['change_code', 'review_pr', 'answer', 'qa_webapp', 'investigate', 'deploy'],
  ops: ['answer', 'investigate', 'change_code', 'review_pr', 'qa_webapp', 'deploy'],
  analyst: ['answer', 'investigate', 'change_code', 'review_pr', 'qa_webapp', 'deploy'],
  dev: ['review_pr', 'change_code', 'investigate', 'answer', 'qa_webapp', 'deploy'],
  unknown: ['answer', 'change_code', 'investigate', 'review_pr', 'qa_webapp', 'deploy'],
};

export function buildHelpReply(params: {
  config: AppConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  role?: DossierRole;
}): string {
  const { config, userId, channelId, channelType, role } = params;
  const marketing = enabledRepoKeys(config).includes('newton-marketing-web');
  const allowed: ToolId[] = [];
  const elsewhere: ToolId[] = [];
  const noAccess: ToolId[] = [];
  for (const id of ORDER_BY_ROLE[role ?? 'unknown']) {
    const tool = TOOLS.find(entry => entry.id === id);
    if (!tool || !TOOL_LINES[id]) continue;
    const decision = evaluateCapability({ config, userId, channelId, channelType, capability: tool.capability });
    if (decision.allowed) allowed.push(id);
    else if (decision.denyReason === 'CHANNEL_NOT_ENABLED') elsewhere.push(id);
    else noAccess.push(id);
  }

  const lines: string[] = [];
  const where = channelType === 'im' || channelType === 'mpim' ? 'here' : 'in this channel';
  if (allowed.length === 0) {
    lines.push(`I'm not set up for you ${where} yet. An admin can enable me; until then I can only answer this.`);
    return lines.join('\n');
  }
  lines.push(`Here's what I can do for you ${where}. Tag me with the ask in one message:`);
  for (const id of allowed) {
    const line = TOOL_LINES[id]!;
    const what = id === 'change_code' && !marketing ? 'Make a change and open a PR for it' : line.what;
    lines.push(`• *${what}.* _e.g. "${line.example}"_`);
  }
  if (elsewhere.length > 0) {
    lines.push(`Not ${where}, but enabled for you elsewhere: ${elsewhere.map(id => shortName(id)).join(', ')}.`);
  }
  if (noAccess.length > 0 && allowed.length > 0) {
    lines.push(`Admins only: ${noAccess.map(id => shortName(id)).join(', ')}.`);
  }
  lines.push('');
  lines.push(
    'Tips: for a page change, give me the URL and a screenshot of what to change. Say "stop" to cancel a run. Ask me about any PR with its link.',
  );
  return lines.join('\n');
}

function shortName(id: ToolId): string {
  switch (id) {
    case 'answer':
      return 'questions';
    case 'change_code':
      return 'changes';
    case 'investigate':
      return 'investigations';
    case 'review_pr':
      return 'PR reviews';
    case 'qa_webapp':
      return 'browser QA';
    case 'deploy':
      return 'deploys';
    default:
      return id;
  }
}
